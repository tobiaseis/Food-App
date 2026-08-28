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
const plans = require('../mealplan/generate');
const { generatePlan, savePlan } = plans;
const taxonomy = require('../lib/taxonomy');
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

/**
 * Madplans-indekset: det, browseren skal bruge for selv at bygge en plan af
 * netop DE butikker, brugeren har valgt.
 *
 * Selve planen kan ikke forudberegnes længere. Femten kæder giver 32.767
 * mulige favorit-kombinationer, og hvilken af dem der er brugerens, ved kun
 * browseren. Til gengæld er de opslagstabeller, planen bygges af, små: ~550
 * tilbudsrækker og ~2.100 opskrifter. Dem henter frontenden hjem én gang og
 * kører `public/engine.js` på – præcis den samme motor, som kører her.
 */
function collectPlanIndex(log) {
  const offerIndex = plans.chainOfferIndex().map((o) => ({
    taxonomy_key: o.taxonomy_key,
    chain_id: o.chain_id,
    offer_id: o.offer_id,
    product_id: o.product_id,
    product_name: o.product_name,
    heading: o.heading,
    price: o.price,
    unit_price: o.unit_price,
    base_unit: o.base_unit,
    normal_unit_price: o.normal_unit_price,
    image: o.image,
    run_till: iso(o.run_till),
  }));

  // Navne kommer fra taksonomien, priser fra historikken. Uden navnene ville
  // indkøbslisten i browseren vise nøgler som "hakkede_tomater".
  const prices = plans.normalPriceMap();
  const taxonomyPrices = taxonomy.TAXONOMY
    .filter((t) => taxonomy.isMealCapable(t.key))
    .map((t) => {
      const p = prices.get(t.key);
      return {
        taxonomy_key: t.key,
        name: t.name,
        unit_price: p ? p.unit_price : null,
        base_unit: p ? p.base_unit : null,
        samples: p ? p.samples : 0,
      };
    });

  // Basisvarer og ikke-mad ryger ud her frem for i browseren: motoren ser
  // alligevel bort fra dem, og de fylder en fjerdedel af nyttelasten.
  const skip = (i) => i.staple || ['drink', 'snack', 'nonfood'].includes(i.cat);
  const recipeIndex = plans.loadRecipes({})
    .map((r) => ({
      recipe_id: r.id,
      title: r.title,
      url: r.url,
      image: r.image,
      source: r.source,
      source_name: r.source_name,
      servings: r.servings,
      total_minutes: r.total_minutes,
      kcal: r.kcal,
      protein_g: r.protein_g,
      carbs_g: r.carbs_g,
      nutrition_src: r.nutrition_src,
      score_healthy: r.score_healthy,
      score_classic: r.score_classic,
      score_premium: r.score_premium,
      unknown_main: !!r.unknown_main,
      items: r.items.filter((i) => !skip(i)).map((i) => ({
        key: i.key, cat: i.cat, grams: i.grams == null ? null : Math.round(i.grams),
      })),
    }))
    .filter((r) => r.items.length >= 2);

  log(`  madplans-indeks: ${offerIndex.length} tilbudsrækker · ${taxonomyPrices.length} varetyper · ${recipeIndex.length} opskrifter`);
  return { offerIndex, taxonomyPrices, recipeIndex };
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
  `).all().map((n) => {
    const w = byId.get(n.watch_id);
    const row = {
      ...n,
      device_id: w?.device_id || 'unknown',
      created_at: iso(n.created_at),
    };
    // user_id kommer først med, når supabase/auth.sql er kørt. Feltet tages
    // med, hvis kolonnen findes (select=* ville så give den, også som null),
    // og udelades ellers – en upsert med en kolonne, der ikke findes, ville
    // vælte hele den natlige kørsel for alle, der ikke har migreret endnu.
    if (w && 'user_id' in w) row.user_id = w.user_id;
    return row;
  });

  log(`  ${created.length} nye notifikationer`);
  return notifications;
}

// ── Push ─────────────────────────────────────────────────────────────────────

/**
 * Tabeller der er fuldstændig afledt af data.db, i barn→forælder-rækkefølge.
 *
 * De ryddes før indsættelsen i stedet for at blive upsertet ovenpå, fordi
 * products.id, offers.id og recipes.id er AUTOINCREMENT i SQLite. De er altså
 * lokale løbenumre, ikke stabile nøgler: bygges basen forfra – fx hvis
 * release-assetet mangler i Actions – får de samme varer nye id'er. En upsert
 * på id ville så lægge hele kataloget ind én gang til under nye numre, og i
 * praksis vælte på UNIQUE(slug) med en 409 på første vare der allerede fandtes.
 *
 * De rigtige nøgler er products.slug, offers.external_id og recipes.url, men de
 * kan ikke bruges som on_conflict-mål: så ville id'et blive opdateret, mens
 * offers og price_stats stadig peger på det gamle, og fremmednøglerne knækker.
 * At udskifte hele det afledte lag er både enklere og mere korrekt – det fjerner
 * samtidig udløbne tilbud, som ellers ville hobe sig op i Supabase for evigt.
 *
 * chains og stores står udenfor: deres id'er kommer fra Tjek og er stabile.
 */
const DERIVED = [
  ['meal_plans',    'tier=not.is.null'],
  ['recipe_index',  'recipe_id=not.is.null'],
  ['offer_index',   'taxonomy_key=not.is.null'],
  ['deals',        'offer_id=not.is.null'],
  ['price_series', 'product_id=not.is.null'],
  ['price_stats',  'product_id=not.is.null'],
  ['offers',       'id=not.is.null'],   // cascader til notifications
  ['recipes',      'id=not.is.null'],
  ['products',     'id=not.is.null'],
];

/**
 * To markeringer på notifications er brugerens/systemets, ikke data.db's:
 *
 *   read_at    har brugeren set beskeden
 *   pushed_at  har vi sendt den som push
 *
 * Begge ville gå tabt hver nat: notifications hænger på offers med ON DELETE
 * CASCADE og ryger med, når tilbuddene udskiftes ovenfor. For read_at ville
 * det betyde et ulæst-tal, der poppede op igen; for pushed_at ville det
 * betyde, at HVER notifikation blev sendt som push forfra hver eneste nat.
 *
 * Tilstanden huskes derfor på (watch_id, tilbuddets external_id) – begge er
 * stabile, hvor id'erne netop ikke er.
 */
const STATE_COLUMNS = ['read_at', 'pushed_at'];

async function saveNotificationState(log) {
  const rows = await sb.selectAll('notifications', {
    select: `watch_id,${STATE_COLUMNS.join(',')},offers(external_id)`,
    query: 'or=(read_at.not.is.null,pushed_at.not.is.null)',
  });
  const seen = new Map();
  for (const r of rows) {
    const ext = r.offers && r.offers.external_id;
    if (!ext) continue;
    seen.set(`${r.watch_id}|${ext}`, { read_at: r.read_at, pushed_at: r.pushed_at });
  }
  if (seen.size) log(`  husker tilstand på ${seen.size} notifikationer`);
  return seen;
}

async function restoreNotificationState(seen, model, log) {
  if (!seen.size || !model.notifications.length) return;

  const extById = new Map(model.offers.map((o) => [o.id, o.external_id]));

  for (const column of STATE_COLUMNS) {
    const groups = new Map();             // watch_id + tidsstempel → offer_id'er
    for (const n of model.notifications) {
      const prev = seen.get(`${n.watch_id}|${extById.get(n.offer_id)}`);
      const value = prev && prev[column];
      if (!value) continue;
      const k = `${n.watch_id}|${value}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n.offer_id);
    }
    if (!groups.size) continue;

    let n = 0;
    for (const [k, offerIds] of groups) {
      const [watchId, value] = k.split('|');
      await sb.patch(
        `notifications?watch_id=eq.${watchId}&offer_id=in.(${offerIds.join(',')})`,
        { [column]: value },
      );
      n += offerIds.length;
    }
    log(`  genskabte ${column} på ${n} notifikationer`);
  }
}

async function push(model, log) {
  const t = (name, rows, opts) => {
    log(`  → ${name}: ${rows.length}`);
    return sb.upsert(name, rows, { ...opts, log });
  };

  const notifState = await saveNotificationState(log);

  log('  rydder afledte tabeller...');
  for (const [table, filter] of DERIVED) await sb.del(table, filter);

  // Indsættelsen går den modsatte vej: forælder før barn.
  await t('chains', model.chains, { onConflict: 'id' });
  await t('products', model.products, { onConflict: 'id' });
  await t('stores', model.stores, { onConflict: 'id' });
  await t('offers', model.offers, { onConflict: 'id', chunk: 400 });
  await t('recipes', model.recipes, { onConflict: 'id' });
  await t('price_stats', model.priceStats, { onConflict: 'product_id,base_unit' });
  await t('price_series', model.priceSeries, { onConflict: 'product_id,base_unit,period', chunk: 400 });
  await t('deals', model.deals, { onConflict: 'offer_id' });
  await t('meal_plans', model.plans, { onConflict: 'tier,year,week,variant', chunk: 12 });

  // Madplans-indekset. offer_index peger på chains, så det skal efter dem.
  await t('offer_index', model.offerIndex, { onConflict: 'taxonomy_key,chain_id', chunk: 400 });
  await t('taxonomy_prices', model.taxonomyPrices, { onConflict: 'taxonomy_key' });
  await t('recipe_index', model.recipeIndex, { onConflict: 'recipe_id', chunk: 200 });

  if (model.notifications.length) {
    await t('notifications', model.notifications, { onConflict: 'watch_id,offer_id' });
  }
  await restoreNotificationState(notifState, model, log);

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
  const planIndex = collectPlanIndex(log);
  const weekPlans = collectPlans(log);

  let notifications = [];
  if (!dryRun && sb.isConfigured()) {
    log('Synkroniserer overvågninger...');
    notifications = await syncWatches(db, log);
  }

  // Aktive tilbud pr. kæde. Frontenden viser tallet ved siden af hver kæde i
  // favorit-vælgeren – man skal kunne se, hvad man får ud af at vælge den til.
  const chainOffers = {};
  for (const row of db.prepare(`
    SELECT chain_id, COUNT(*) n FROM offers
     WHERE (run_from IS NULL OR run_from <= @now) AND (run_till IS NULL OR run_till >= @now)
     GROUP BY chain_id
  `).all({ now: new Date().toISOString() })) chainOffers[row.chain_id] = row.n;

  const { week, year } = isoWeek(new Date());
  const summary = {
    at: new Date().toISOString(),
    week, year,
    chain_offers: chainOffers,
    offers: catalog.offers.length,
    products: catalog.products.length,
    recipes: catalog.recipes.length,
    deals: deals.length,
    plans: weekPlans.length,
    plan_recipes: planIndex.recipeIndex.length,
    plan_offers: planIndex.offerIndex.length,
    notifications: notifications.length,
  };

  const model = {
    ...catalog, priceStats, priceSeries, deals,
    plans: weekPlans,
    offerIndex: planIndex.offerIndex,
    taxonomyPrices: planIndex.taxonomyPrices,
    recipeIndex: planIndex.recipeIndex,
    notifications, summary,
  };

  const payloadMb = (JSON.stringify(model).length / 1048576).toFixed(1);
  log(`Read-model klar: ${payloadMb} MB`);

  if (dryRun) {
    log('\n--dry-run: intet sendt. Tabeller der ville blive skrevet:');
    for (const [k, v] of Object.entries({
      chains: catalog.chains, products: catalog.products, stores: catalog.stores,
      offers: catalog.offers, recipes: catalog.recipes,
      price_stats: priceStats, price_series: priceSeries, deals, meal_plans: weekPlans,
      offer_index: planIndex.offerIndex, taxonomy_prices: planIndex.taxonomyPrices,
      recipe_index: planIndex.recipeIndex,
    })) log(`  ${k.padEnd(16)} ${v.length}`);
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

module.exports = {
  build, push, collectCatalog, collectPriceModel, collectDeals, collectPlans, collectPlanIndex,
};
