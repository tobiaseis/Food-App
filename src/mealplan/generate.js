'use strict';

/**
 * Madplan ud fra denne uges tilbud – SQLite-siden.
 *
 * Selve reglerne bor i `public/engine.js`, som også kører i browseren. Denne
 * fil har én opgave: hente de tre ting, motoren skal bruge, ud af databasen.
 *
 *   1. TILBUDSKORTET   billigste aktive tilbud pr. varetype – kun i de
 *                      butikker brugeren har valgt som sine (favoritter).
 *   2. NORMALPRISER    hvad varetypen normalt koster pr. kg/l, så en
 *                      besparelse kan regnes, og så ingredienser UDEN tilbud
 *                      stadig kan prissættes.
 *   3. OPSKRIFTERNE    med ingredienser, taksonomi-nøgle og mængde.
 *
 * Favoritbutikkerne er hele pointen med opsætningen: en madplan bygget på
 * tilbud fra femten kæder på tværs af landet er ikke en madplan, man kan
 * handle efter. Har man Rema og Netto i nærheden, er det dem, planen skal
 * bygges af.
 */

const path = require('node:path');

const { getDb, getSetting } = require('../db');
const taxonomy = require('../lib/taxonomy');
const { gramsOf } = require('../recipes/classify');
const { getBaseline } = require('../price/history');

// Motoren ligger i public/, fordi browseren også skal kunne indlæse den.
// Vi kræver den ind derfra i stedet for at kopiere den – to kopier af de
// samme regler ville før eller siden komme til at være uenige.
const engine = require(path.join(__dirname, '..', '..', 'public', 'engine.js'));

const TIERS = {
  healthy: { column: 'score_healthy', label: 'Sund & proteinrig (lavt kulhydrat)' },
  classic: { column: 'score_classic', label: 'Klassisk hverdagsmad' },
  premium: { column: 'score_premium', label: 'Gourmet' },
};

const DAYS = engine.DAYS;

// Prishistorik ældre end dette regnes ikke med i normalprisen.
const HORIZON_DAYS = 400;

// ── 1. Tilbudskortet ─────────────────────────────────────────────────────────

/**
 * Billigste aktive tilbud pr. varetype, målt i kr/kg (eller kr/l), begrænset
 * til de valgte kæder. Det er dette kort, opskrifterne matches imod.
 */
function activeOfferMap({ chainIds = null, at = new Date() } = {}) {
  const db = getDb();
  const now = at.toISOString();

  const params = [now, now];
  let sql = `
    SELECT o.id AS offer_id, o.product_id, o.chain_id, c.name AS chain, o.heading,
           o.price, o.pre_price, o.unit_price, o.base_unit, o.base_qty,
           o.image, o.run_till, p.taxonomy_key, p.name AS product_name, p.category
      FROM offers o
      JOIN products p ON p.id = o.product_id
      JOIN chains   c ON c.id = o.chain_id
     WHERE p.taxonomy_key IS NOT NULL
       AND o.unit_price IS NOT NULL
       AND (o.run_from IS NULL OR o.run_from <= ?)
       AND (o.run_till IS NULL OR o.run_till >= ?)`;

  if (chainIds && chainIds.length) {
    sql += ` AND o.chain_id IN (${chainIds.map(() => '?').join(',')})`;
    params.push(...chainIds);
  }
  sql += ' ORDER BY o.unit_price ASC';

  const map = new Map();
  for (const row of db.prepare(sql).all(...params)) {
    // Drikkevarer, slik og non-food kan ikke bære en ret. De skal heller ikke
    // kunne tælle med som "råvare på tilbud".
    if (!taxonomy.isMealCapable(row.taxonomy_key)) continue;
    if (map.has(row.taxonomy_key)) continue;

    const baseline = getBaseline(row.product_id, row.base_unit);
    map.set(row.taxonomy_key, { ...row, normal_unit_price: baseline?.median ?? null });
  }
  return map;
}

/**
 * Samme kort, men delt op PR. KÆDE – ét billigste tilbud pr. varetype pr. kæde.
 *
 * Det er formen, Supabase-indekset har, fordi favoritbutikkerne først er kendt
 * i browseren: den henter rækkerne for sine egne kæder og reducerer dem til ét
 * kort på nøjagtig samme måde som `activeOfferMap` gør her.
 */
function chainOfferIndex({ at = new Date() } = {}) {
  const db = getDb();
  const now = at.toISOString();

  const rows = db.prepare(`
    SELECT o.id AS offer_id, o.product_id, o.chain_id, o.heading,
           o.price, o.unit_price, o.base_unit, o.image, o.run_till,
           p.taxonomy_key, p.name AS product_name
      FROM offers o
      JOIN products p ON p.id = o.product_id
     WHERE p.taxonomy_key IS NOT NULL
       AND o.unit_price IS NOT NULL
       AND (o.run_from IS NULL OR o.run_from <= ?)
       AND (o.run_till IS NULL OR o.run_till >= ?)
     ORDER BY o.unit_price ASC
  `).all(now, now);

  const baselines = new Map();
  const index = new Map();
  for (const row of rows) {
    if (!taxonomy.isMealCapable(row.taxonomy_key)) continue;
    const k = `${row.taxonomy_key}|${row.chain_id}`;
    if (index.has(k)) continue;                       // sorteret billigst først

    const bk = `${row.product_id}|${row.base_unit}`;
    if (!baselines.has(bk)) baselines.set(bk, getBaseline(row.product_id, row.base_unit));
    index.set(k, { ...row, normal_unit_price: baselines.get(bk)?.median ?? null });
  }
  return [...index.values()];
}

// ── 2. Normalpriser pr. varetype ─────────────────────────────────────────────

const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Normalpris pr. varetype – på tværs af kæder og uger.
 *
 * Bruges dér, hvor produkt-niveauet er for fint: en opskrift beder om
 * "hakket oksekød", ikke om en bestemt fedtprocent fra en bestemt kæde. Som i
 * `price/history.js` tælles ÉN pris pr. kæde pr. uge, ellers trækker de kæder,
 * der udgiver samme vare i seksten aviser, medianen ned mod sig selv.
 */
function normalPriceMap() {
  const db = getDb();
  const since = new Date(Date.now() - HORIZON_DAYS * 86400000).toISOString();

  const rows = db.prepare(`
    SELECT p.taxonomy_key, o.base_unit, o.chain_id, o.year, o.week,
           MIN(o.unit_price) AS unit_price, p.name AS name
      FROM offers o
      JOIN products p ON p.id = o.product_id
     WHERE p.taxonomy_key IS NOT NULL
       AND o.unit_price IS NOT NULL AND o.unit_price > 0
       AND o.base_unit IN ('kg', 'l')
       AND COALESCE(o.run_from, o.observed_at) >= ?
     GROUP BY p.taxonomy_key, o.base_unit, o.chain_id, o.year, o.week
  `).all(since);

  const buckets = new Map();
  for (const r of rows) {
    const k = `${r.taxonomy_key}|${r.base_unit}`;
    if (!buckets.has(k)) {
      buckets.set(k, { key: r.taxonomy_key, base_unit: r.base_unit, name: r.name, prices: [] });
    }
    buckets.get(k).prices.push(r.unit_price);
  }

  // En varetype kan findes i både kg og l (fx fløde). Den enhed med flest
  // observationer er den, opskrifterne i praksis skal prissættes efter.
  const best = new Map();
  for (const b of buckets.values()) {
    const prev = best.get(b.key);
    if (prev && prev.samples >= b.prices.length) continue;
    best.set(b.key, {
      unit_price: median(b.prices),
      base_unit: b.base_unit,
      name: b.name,
      samples: b.prices.length,
    });
  }
  return best;
}

// ── 3. Opskrifterne ──────────────────────────────────────────────────────────

/**
 * Opskrifter med ingredienserne oversat til motorens format.
 *
 * `tier` angivet  → kun opskrifter i det spor, med `tier_score` sat.
 * `tier` udeladt  → alle opskrifter, med alle tre spor-scorer. Det er den
 *                   form, Supabase-indekset skrives i, hvor sporet først
 *                   vælges i browseren.
 *
 * `is_staple` læses fra basen, men taksonomien får det sidste ord: udvides
 * listen over basisvarer, skal det virke med det samme – ikke først efter en
 * `npm run reclassify`.
 */
function loadRecipes({ tier = null, minTierScore = 0.35 } = {}) {
  const db = getDb();
  const column = tier ? TIERS[tier].column : null;
  const params = column ? [minTierScore] : [];

  const rows = db.prepare(`
    SELECT id, title, url, image, source, source_name, servings, total_minutes,
           kcal, protein_g, carbs_g, nutrition_src,
           score_healthy, score_classic, score_premium
      FROM recipes
     ${column ? `WHERE ${column} >= ?` : ''}
     ${column ? `ORDER BY ${column} DESC` : ''}
  `).all(...params);

  const byId = new Map(rows.map((r) => [r.id, {
    ...r,
    tier_score: column ? r[column] : null,
    items: [],
    unknown_main: false,
  }]));
  if (!byId.size) return [];

  // Ét opslag frem for ét pr. opskrift: 30.000 rækker ad gangen er hurtigere
  // end 2.000 forespørgsler, og planen skal kunne regnes på et øjeblik.
  const ingredients = db.prepare(`
    SELECT ri.recipe_id, ri.raw, ri.ingredient, ri.taxonomy_key, ri.is_staple, ri.qty, ri.unit
      FROM recipe_ingredients ri
      ${column ? `JOIN recipes r ON r.id = ri.recipe_id WHERE r.${column} >= ?` : ''}
     ORDER BY ri.recipe_id, ri.position
  `).all(...params);

  for (const ing of ingredients) {
    const recipe = byId.get(ing.recipe_id);
    if (!recipe) continue;

    if (!ing.taxonomy_key) {
      // Ingrediens vi ikke kender. Ligner den kød eller fisk, kan retten ikke
      // planlægges troværdigt – se `hintsAtMainIngredient`.
      if (taxonomy.hintsAtMainIngredient(ing.raw)) recipe.unknown_main = true;
      continue;
    }

    const entry = taxonomy.get(ing.taxonomy_key);
    recipe.items.push({
      key: ing.taxonomy_key,
      cat: entry?.cat ?? null,
      staple: Boolean(ing.is_staple) || taxonomy.isStaple(ing.taxonomy_key),
      grams: gramsOf(ing),
      ingredient: ing.ingredient || entry?.name || ing.taxonomy_key,
    });
  }

  return [...byId.values()].filter((r) => r.items.length >= 3);
}

/** Opskrifter brugt i de seneste ugers planer – de skal vige for nye. */
function recentlyUsedRecipes(weeksBack) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT i.recipe_id
      FROM meal_plan_items i
      JOIN meal_plans p ON p.id = i.plan_id
     WHERE p.created_at >= ?
  `).all(new Date(Date.now() - weeksBack * 7 * 86400000).toISOString());
  return new Set(rows.map((r) => r.recipe_id));
}

/** Brugerens favoritbutikker, hvis der ikke er givet nogen med kaldet. */
function favoriteChainIds() {
  const saved = getSetting('favorite_chains', null);
  return Array.isArray(saved) && saved.length ? saved : null;
}

function chainNamesFor(chainIds) {
  if (!chainIds || !chainIds.length) return null;
  const db = getDb();
  return db.prepare(
    `SELECT name FROM chains WHERE id IN (${chainIds.map(() => '?').join(',')}) ORDER BY name`
  ).all(...chainIds).map((r) => r.name);
}

// ── Sammensætning ────────────────────────────────────────────────────────────

function generatePlan({
  tier = 'classic',
  // null = ikke angivet → brug de gemte favoritter. [] = udtrykkeligt alle kæder.
  chainIds = null,
  days = 7,
  minTierScore = 0.35,
  at = new Date(),
  // Uden variation ville samme uge give samme syv retter hver gang.
  // `seed` gør "Ny plan" til en reel omrokering, og retter fra de seneste
  // ugers planer trykkes ned, så ugerne ikke ligner hinanden.
  seed = 0,
  avoidRecentWeeks = 4,
  variety = 0.18,
} = {}) {
  if (!TIERS[tier]) throw new Error(`Ukendt spor: ${tier}`);

  const chains = chainIds === null ? favoriteChainIds()
    : (chainIds.length ? chainIds : null);

  const offers = activeOfferMap({ chainIds: chains, at });
  const recipes = loadRecipes({ tier, minTierScore });

  if (!recipes.length) {
    return {
      tier, days: [], chain_ids: chains,
      error: 'Ingen opskrifter matcher sporet endnu – kør opskrifts-crawleren først.',
    };
  }

  const plan = engine.buildPlan({
    tier,
    tierLabel: TIERS[tier].label,
    recipes,
    offers,
    normalPrices: normalPriceMap(),
    days,
    seed,
    variety,
    recentIds: avoidRecentWeeks > 0 ? recentlyUsedRecipes(avoidRecentWeeks) : null,
    chainIds: chains,
    chainNames: chainNamesFor(chains),
    at,
  });

  return plan;
}

// ── Persistering ─────────────────────────────────────────────────────────────

function savePlan(plan) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO meal_plans (tier, week, year, created_at, est_cost, est_savings, chains)
      VALUES (@tier, @week, @year, @created_at, @est_cost, @est_savings, @chains)
      ON CONFLICT(tier, week, year) DO UPDATE SET
        created_at = excluded.created_at, est_cost = excluded.est_cost,
        est_savings = excluded.est_savings, chains = excluded.chains
    `).run({
      tier: plan.tier, week: plan.week, year: plan.year,
      created_at: plan.generated_at, est_cost: plan.est_cost,
      est_savings: plan.est_savings, chains: JSON.stringify(plan.chain_ids || []),
    });

    const row = db.prepare('SELECT id FROM meal_plans WHERE tier=? AND week=? AND year=?')
      .get(plan.tier, plan.week, plan.year);
    db.prepare('DELETE FROM meal_plan_items WHERE plan_id = ?').run(row.id);

    const ins = db.prepare(`
      INSERT INTO meal_plan_items (plan_id, day, recipe_id, matched_json, match_count, est_cost, est_savings)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of plan.days) {
      ins.run(row.id, d.day, d.recipe.id, JSON.stringify(d.matched), d.match_count, d.est_cost, d.est_savings);
    }
    return row.id;
  });
  return tx();
}

module.exports = {
  generatePlan, savePlan,
  shoppingList: engine.shoppingList,
  activeOfferMap, chainOfferIndex, normalPriceMap, loadRecipes,
  favoriteChainIds, chainNamesFor,
  TIERS, DAYS, engine,
};
