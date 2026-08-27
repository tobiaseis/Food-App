'use strict';

/**
 * Bygger read-modellen og skubber den til Supabase.
 *
 * Dette er hele pointen med opsætningen: al tung beregning sker HER, mod en
 * lokal SQLite-fil med nul latenstid. Én madplan kræver ~3.200 enkeltopslag
 * og tager 183 ms lokalt; de samme opslag mod en fjern Postgres ville tage
 * op mod et minut og aldrig kunne køre i en serverless funktion.
 *
 * Supabase modtager derfor kun resultater – færdige madplaner, færdig
 * prisstatistik, færdige vurderinger – og frontenden laver simple SELECTs.
 *
 *   node src/sync/build.js            # byg og push
 *   node src/sync/build.js --dry-run  # byg og vis hvad der ville blive sendt
 */

const { getDb, setSetting } = require('../db');
const sb = require('./supabase');
const { generatePlan, savePlan } = require('../mealplan/generate');
const { getBaseline, weeklySeries, assessRow } = require('../price/history');
const { topDeals } = require('../server');
const watchLib = require('../watch/notify');
const { isoWeek } = require('../lib/normalize');

const PLAN_VARIANTS = 4;          // "Ny plan" skifter mellem disse
const TIERS = ['healthy', 'classic', 'premium'];

const iso = (v) => (v ? new Date(v).toISOString() : null);

// ── Udtræk fra SQLite ────────────────────────────────────────────────────────

function collectCatalog(db) {
  const chains = db.prepare('SELECT id, name, slug, logo, color, website FROM chains').all();

  const products = db.prepare(`
    SELECT id, slug, name, category, taxonomy_key, fat_grade, organic FROM products
  `).all().map((p) => ({ ...p, organic: p.organic ? 1 : 0 }));

  const offers = db.prepare(`
    SELECT id, external_id, product_id, chain_id, heading, description,
           price, pre_price, unit_price, base_unit, base_qty, image,
           run_from, run_till, week, year, observed_at
      FROM offers
  `).all().map((o) => ({
    ...o,
    run_from: iso(o.run_from),
    run_till: iso(o.run_till),
    observed_at: iso(o.observed_at),
  }));

  const stores = db.prepare('SELECT id, chain_id, name, street, city, zip, lat, lng FROM stores').all();

  const recipes = db.prepare(`
    SELECT id, url, title, source_name, image, servings, total_minutes,
           kcal, protein_g, carbs_g, nutrition_src, tier
      FROM recipes
  `).all();

  return { chains, products, offers, stores, recipes };
}

/** Normalpris og ugeserie pr. varetype – frontenden skal ikke regne medianer. */
function collectPriceModel(db, log) {
  const combos = db.prepare(`
    SELECT product_id, base_unit, COUNT(*) n
      FROM offers
     WHERE unit_price IS NOT NULL AND product_id IS NOT NULL
     GROUP BY product_id, base_unit
    HAVING COUNT(*) >= 2
  `).all();

  const stats = [];
  const series = [];

  for (const c of combos) {
    const b = getBaseline(c.product_id, c.base_unit);
    if (!b || b.median == null) continue;
    stats.push({
      product_id: c.product_id,
      base_unit: c.base_unit,
      median: b.median,
      min_price: b.min,
      max_price: b.max,
      samples: b.samples,
      chains: b.chains,
      periods: b.periods,
    });

    for (const p of weeklySeries(c.product_id, c.base_unit)) {
      series.push({
        product_id: c.product_id,
        base_unit: c.base_unit,
        period: p.period,
        median: p.median,
        min_price: p.min,
        max_price: p.max,
        n: p.n,
      });
    }
  }

  log(`  prisstatistik: ${stats.length} varetyper · ${series.length} ugepunkter`);
  return { stats, series };
}

/** Ugens fund med færdig vurdering. */
function collectDeals(log) {
  const rows = topDeals({ limit: 100 });
  const deals = rows
    .map((r) => {
      const a = assessRow({ ...r });
      return {
        offer_id: r.id,
        product_id: r.product_id,
        verdict: a.verdict,
        discount_pct: a.discount_pct,
        confidence: a.confidence,
        is_cheapest: !!a.is_cheapest,
      };
    })
    .filter((d) => d.discount_pct != null && d.discount_pct > 0)
    .sort((a, b) => b.discount_pct - a.discount_pct)
    .map((d, i) => ({ ...d, rank: i + 1 }));

  log(`  ugens fund: ${deals.length} reelle tilbud`);
  return deals;
}

/** Madplaner i flere varianter, så "Ny plan" kan skifte uden at regne. */
function collectPlans(log) {
  const { week, year } = isoWeek(new Date());
  const plans = [];

  for (const tier of TIERS) {
    for (let variant = 0; variant < PLAN_VARIANTS; variant++) {
      const plan = generatePlan({
        tier,
        seed: year * 1000 + week * 10 + variant,
        // Varianterne skal adskille sig fra hinanden, ikke kun fra sidste uge
        avoidRecentWeeks: variant === 0 ? 4 : 0,
      });
      if (plan.error || !plan.days.length) continue;

      plan.shopping_list = require('../mealplan/generate').shoppingList(plan);
      if (variant === 0) { try { savePlan(plan); } catch { /* historik er ikke kritisk */ } }

      plans.push({
        tier, week, year, variant,
        est_cost: plan.est_cost,
        est_savings: plan.est_savings,
        payload: plan,
      });
    }
    log(`  madplan ${tier}: ${plans.filter((p) => p.tier === tier).length} varianter`);
  }
  return plans;
}

// ── Overvågninger: Supabase → lokal → notifikationer → Supabase ─────────────

/**
 * Brugerens overvågninger skrives fra frontenden til Supabase. De hentes hjem,
 * evalueres mod den lokale database (hvor prishistorikken ligger) og
 * notifikationerne sendes tilbage.
 */
async function syncWatches(db, log) {
  const remote = await sb.selectAll('watches', { select: '*', order: 'id.asc' });
  log(`  hentede ${remote.length} overvågninger fra Supabase`);
  if (!remote.length) return [];

  // Genopbyg de lokale overvågninger med Supabase' egne id'er, så
  // notifikationerne kan sendes tilbage med den rigtige reference.
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM watches').run();

  const ins = db.prepare(`
    INSERT INTO watches (id, label, query, taxonomy_key, chain_ids, max_km,
                         min_discount, max_unit_price, active, created_at)
    VALUES (@id, @label, @query, @taxonomy_key, @chain_ids, @max_km,
            @min_discount, @max_unit_price, @active, @created_at)
  `);
  const byId = new Map();
  const tx = db.transaction((rows) => {
    for (const w of rows) {
      ins.run({
        id: w.id,
        label: w.label,
        query: w.query,
        taxonomy_key: w.taxonomy_key,
        chain_ids: JSON.stringify(w.chain_ids || []),
        max_km: w.max_km,
        min_discount: w.min_discount,
        max_unit_price: w.max_unit_price,
        active: w.active === false ? 0 : 1,
        created_at: w.created_at || new Date().toISOString(),
      });
      byId.set(w.id, w);
    }
  });
  tx(remote);

  // Hjemadresse pr. overvågning – bruges til afstand til nærmeste butik
  const anyHome = remote.find((w) => w.home_lat != null && w.home_lng != null);
  if (anyHome) {
    setSetting('home_lat', anyHome.home_lat);
    setSetting('home_lng', anyHome.home_lng);
  }

  const created = watchLib.runWatches();
  const notifications = db.prepare(`
    SELECT n.watch_id, n.offer_id, n.reason, n.unit_price, n.discount,
           n.nearest_km, n.nearest_store, n.created_at
      FROM notifications n
  `).all().map((n) => ({
    ...n,
    device_id: byId.get(n.watch_id)?.device_id || 'unknown',
    created_at: iso(n.created_at),
  }));

  log(`  ${created.length} nye notifikationer`);
  return notifications;
}

// ── Push ─────────────────────────────────────────────────────────────────────

async function push(model, log) {
  const t = (name, rows, opts) => {
    log(`  → ${name}: ${rows.length}`);
    return sb.upsert(name, rows, { ...opts, log });
  };

  // Rækkefølgen respekterer fremmednøglerne
  await t('chains', model.chains, { onConflict: 'id' });
  await t('products', model.products, { onConflict: 'id' });
  await t('stores', model.stores, { onConflict: 'id' });
  await t('offers', model.offers, { onConflict: 'id', chunk: 400 });
  await t('recipes', model.recipes, { onConflict: 'id' });
  await t('price_stats', model.priceStats, { onConflict: 'product_id,base_unit' });
  await t('price_series', model.priceSeries, { onConflict: 'product_id,base_unit,period', chunk: 400 });

  // Ugens fund erstattes helt – gamle rækker er ikke længere aktuelle
  await sb.del('deals', 'offer_id=gt.0');
  await t('deals', model.deals, { onConflict: 'offer_id' });

  await t('meal_plans', model.plans, { onConflict: 'tier,year,week,variant', chunk: 12 });

  if (model.notifications.length) {
    await t('notifications', model.notifications, { onConflict: 'watch_id,offer_id' });
  }

  await sb.upsert('sync_state', [{
    key: 'last_build',
    value: model.summary,
    updated_at: new Date().toISOString(),
  }], { onConflict: 'key' });
}

// ── Hovedkørsel ──────────────────────────────────────────────────────────────

async function build({ dryRun = false, log = console.log } = {}) {
  const db = getDb();
  const started = Date.now();

  log('Bygger read-model fra lokal SQLite...');
  const catalog = collectCatalog(db);
  log(`  katalog: ${catalog.offers.length} tilbud · ${catalog.products.length} varetyper · ${catalog.recipes.length} opskrifter`);

  const { stats: priceStats, series: priceSeries } = collectPriceModel(db, log);
  const deals = collectDeals(log);
  const plans = collectPlans(log);

  let notifications = [];
  if (!dryRun && sb.isConfigured()) {
    log('Synkroniserer overvågninger...');
    notifications = await syncWatches(db, log);
  }

  const { week, year } = isoWeek(new Date());
  const summary = {
    at: new Date().toISOString(),
    week, year,
    offers: catalog.offers.length,
    products: catalog.products.length,
    recipes: catalog.recipes.length,
    deals: deals.length,
    plans: plans.length,
    notifications: notifications.length,
  };

  const model = { ...catalog, priceStats, priceSeries, deals, plans, notifications, summary };

  const payloadMb = (JSON.stringify(model).length / 1048576).toFixed(1);
  log(`Read-model klar: ${payloadMb} MB`);

  if (dryRun) {
    log('\n--dry-run: intet sendt. Tabeller der ville blive skrevet:');
    for (const [k, v] of Object.entries({
      chains: catalog.chains, products: catalog.products, stores: catalog.stores,
      offers: catalog.offers, recipes: catalog.recipes,
      price_stats: priceStats, price_series: priceSeries, deals, meal_plans: plans,
    })) log(`  ${k.padEnd(14)} ${v.length}`);
    return { model, pushed: false };
  }

  sb.assertConfigured();
  log('Sender til Supabase...');
  await push(model, log);

  log(`\nFærdig på ${Math.round((Date.now() - started) / 1000)} s`);
  return { model, pushed: true };
}

if (require.main === module) {
  build({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((err) => { console.error('\n[FEJL]', err.message); process.exit(1); });
}

module.exports = { build, collectCatalog, collectPriceModel, collectDeals, collectPlans };
