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
const { DEFAULT_PIECE_G } = require('../lib/units');
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
 * Billigste aktive tilbud pr. varetype PR. KÆDE, målt i kr/kg (eller kr/l),
 * begrænset til de valgte kæder. Nøglen er `vare|kæde`. Det er dette kort,
 * opskrifterne matches imod — motoren reducerer det selv til ét tilbud pr.
 * vare, når den kun spørger "er varen på tilbud et sted?".
 *
 * Forarbejdede varer holdes ude: "indbagte rejer" er ikke rejer, og en
 * opskrift på hele vannamei-rejer bliver ikke bedre af, at der er tilbud på
 * en frostret med butterdej. De findes stadig under "Alle tilbud".
 */
function activeOfferMap({ chainIds = null, at = new Date() } = {}) {
  const db = getDb();
  const now = at.toISOString();

  const params = [now, now];
  let sql = `
    SELECT o.id AS offer_id, o.product_id, o.chain_id, c.name AS chain, o.heading,
           o.price, o.pre_price, o.unit_price, o.base_unit, o.base_qty,
           o.image, o.run_till, p.item_key, p.name AS product_name, p.category
      FROM offers o
      JOIN products p ON p.id = o.product_id
      JOIN chains   c ON c.id = o.chain_id
     WHERE p.item_key IS NOT NULL
       AND COALESCE(p.prepared, 0) = 0
       AND o.unit_price IS NOT NULL
       AND (o.run_from IS NULL OR o.run_from <= ?)
       AND (o.run_till IS NULL OR o.run_till >= ?)`;

  if (chainIds && chainIds.length) {
    sql += ` AND o.chain_id IN (${chainIds.map(() => '?').join(',')})`;
    params.push(...chainIds);
  }
  sql += ' ORDER BY o.unit_price ASC';

  // Samme lokale cache som i `chainOfferIndex`: `getBaseline` slår op i 400
  // dages historik og cacher ikke selv, og siden nøglen blev `vare|kæde`, er
  // der én række pr. kæde i stedet for én pr. vare. Uden dette blev opslaget
  // kaldt 484 gange i stedet for 87 på en travl uge — midt på webserverens
  // requestvej. Målt på data.db, uge 35: 1.130 ms → 401 ms for tyve kald.
  const baselines = new Map();
  const map = new Map();
  for (const row of db.prepare(sql).all(...params)) {
    // Drikkevarer, slik og non-food kan ikke bære en ret. De skal heller ikke
    // kunne tælle med som "råvare på tilbud".
    if (!taxonomy.isMealCapable(row.item_key)) continue;

    // Nøglen er vare OG kæde. Med varen alene beholdt kortet kun det billigste
    // tilbud PÅ TVÆRS af kæderne, og så kan man ikke bagefter spørge, hvad
    // varen koster i den enkelte butik — hverken for at vælge kæde eller for
    // at holde tilbuddet op mod kædens egen normalpris i `effectivePrice`.
    // Samme nøgleform som `chainOfferIndex` og som normalpriserne.
    const k = `${row.item_key}|${row.chain_id}`;
    if (map.has(k)) continue;                          // sorteret billigst først

    const bk = `${row.product_id}|${row.base_unit}`;
    if (!baselines.has(bk)) baselines.set(bk, getBaseline(row.product_id, row.base_unit));
    map.set(k, { ...row, normal_unit_price: baselines.get(bk)?.median ?? null });
  }
  return map;
}

/**
 * Samme udvalg som `activeOfferMap`, men som en FLAD LISTE – ét billigste
 * tilbud pr. varetype pr. kæde, uden kædefilter.
 *
 * Det er formen, Supabase-indekset har, fordi favoritbutikkerne først er kendt
 * i browseren: den henter rækkerne, filtrerer på sine egne kæder og bygger
 * kortet dér. De to funktioner deler nøgleformen `vare|kæde` med vilje.
 */
function chainOfferIndex({ at = new Date() } = {}) {
  const db = getDb();
  const now = at.toISOString();

  const rows = db.prepare(`
    SELECT o.id AS offer_id, o.product_id, o.chain_id, o.heading,
           o.price, o.unit_price, o.base_unit, o.base_qty, o.image, o.run_till,
           p.item_key, p.name AS product_name
      FROM offers o
      JOIN products p ON p.id = o.product_id
     WHERE p.item_key IS NOT NULL
       AND COALESCE(p.prepared, 0) = 0
       AND o.unit_price IS NOT NULL
       AND (o.run_from IS NULL OR o.run_from <= ?)
       AND (o.run_till IS NULL OR o.run_till >= ?)
     ORDER BY o.unit_price ASC
  `).all(now, now);

  const baselines = new Map();
  const index = new Map();
  for (const row of rows) {
    if (!taxonomy.isMealCapable(row.item_key)) continue;
    const k = `${row.item_key}|${row.chain_id}`;
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
    SELECT p.item_key, o.base_unit, o.chain_id, o.year, o.week,
           MIN(o.unit_price) AS unit_price, p.name AS name
      FROM offers o
      JOIN products p ON p.id = o.product_id
     WHERE p.item_key IS NOT NULL
       AND COALESCE(p.prepared, 0) = 0
       AND o.unit_price IS NOT NULL AND o.unit_price > 0
       AND o.base_unit IN ('kg', 'l')
       AND COALESCE(o.run_from, o.observed_at) >= ?
     GROUP BY p.item_key, o.base_unit, o.chain_id, o.year, o.week
  `).all(since);

  const buckets = new Map();
  for (const r of rows) {
    const k = `${r.item_key}|${r.base_unit}`;
    if (!buckets.has(k)) {
      buckets.set(k, { key: r.item_key, base_unit: r.base_unit, name: r.name, prices: [] });
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

/**
 * Normalpriserne fra `item_prices`, grupperet pr. (vare, kæde).
 *
 * Nøglen er `vare|kæde` — samme form som tilbudskortet, så `effectivePrice()`
 * kan slå begge op med den samme streng.
 *
 * Værdien er en LISTE, ikke én række. Et par kan have flere pakkestørrelser
 * og flere kilder, og både rangordenen i `effectivePrice` og pakkevalget i
 * `choosePack` skal se dem alle: vælges rækken allerede her, er valget truffet
 * af en SQL-sortering, der hverken kender behovet eller varens holdbarhed.
 *
 * `normalPriceMap()` ovenfor er noget andet og bliver stående: den er en
 * median af TILBUDSpriser pr. varetype på tværs af kæder, og bruges til at
 * vise en besparelse. Denne er hyldeprisen i den enkelte butik.
 */
function normalPricesFor(chainIds = null) {
  const db = getDb();
  let sql = `SELECT item_key, chain_id, pack_qty, pack_unit, pack_price,
                    unit_price, source, valid_until
               FROM item_prices`;
  const params = [];
  if (chainIds && chainIds.length) {
    sql += ` WHERE chain_id IN (${chainIds.map(() => '?').join(',')})`;
    params.push(...chainIds);
  }

  const map = new Map();
  for (const r of db.prepare(sql).all(...params)) {
    const k = `${r.item_key}|${r.chain_id}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// ── 3. Opskrifterne ──────────────────────────────────────────────────────────

/**
 * Rollevægt: amount omregnet til et tal, der kan sammenlignes på tværs af
 * varens enhed. `amount` for en stk-vare er et STYKANTAL (fx 6 æg), og for en
 * kg/l-vare en MASSE/RUMFANG (fx 0,5 kg kylling) – de to tal er ikke
 * sammenlignelige som de står. `engine.js`s `assignRoles` afgør en opskrifts
 * hovedråvare ved at sammenligne netop disse tal, og `aeg` (æg) er samtidig
 * `base_unit: 'stk'` OG i `MAIN_CATS` (kategorien `eggs`) – uden dette regner
 * "2 stk æg" for MERE end "0,4 kg kylling", fordi 2 > 0,4 som rene tal, og en
 * kyllingeret bliver planlagt op om ægget i stedet. Fundet ved gennemregning
 * af hele korpusset (287 af 2.224 opskrifter fik en anden hovedråvare, 200 af
 * dem endte med æg som ENESTE hovedråvare) – ikke en teoretisk bekymring.
 *
 * `amount` selv røres ikke: indkøbslisten og prisberegningen skal stadig
 * kunne vise/regne på det ægte stykantal, ikke en omregnet vægt.
 */
function weightFor(entry, amount) {
  if (entry == null || amount == null) return null;
  if (entry.base_unit === 'stk') return (amount * (entry.piece_g ?? DEFAULT_PIECE_G)) / 1000;
  return amount;
}

/**
 * Opskrifter med ingredienserne oversat til motorens format.
 *
 * `tier` angivet  → kun opskrifter i det spor, med `tier_score` sat.
 * `tier` udeladt  → alle opskrifter, med alle tre spor-scorer. Det er den
 *                   form, Supabase-indekset skrives i, hvor sporet først
 *                   vælges i browseren.
 *
 * `essential` regnes hver gang frisk ud fra taksonomien (`items.class`), aldrig
 * fra en gemt kolonne: udvides listen over basisvarer, skal det virke med det
 * samme – ikke først efter en `npm run reclassify`.
 */
function loadRecipes({ tier = null, minTierScore = 0.35 } = {}) {
  const db = getDb();
  const column = tier ? TIERS[tier].column : null;
  const params = column ? [minTierScore] : [];

  const rows = db.prepare(`
    SELECT id, title, url, image, source, source_name, lang, servings, total_minutes,
           kcal, protein_g, carbs_g, nutrition_src, keywords,
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
    unknown_count: 0,
  }]));
  if (!byId.size) return [];

  // Ét opslag frem for ét pr. opskrift: 30.000 rækker ad gangen er hurtigere
  // end 2.000 forespørgsler, og planen skal kunne regnes på et øjeblik.
  //
  // item_key/amount (opgave 9): amount er allerede regnet om til varens egen
  // enhed (kg/l/stk) af backfill-amounts.js/parseIngredient, så der skal ikke
  // længere kaldes gramsOf() her – kolonnen ER facit.
  const ingredients = db.prepare(`
    SELECT ri.recipe_id, ri.raw, ri.ingredient, ri.item_key, ri.amount, ri.optional
      FROM recipe_ingredients ri
      ${column ? `JOIN recipes r ON r.id = ri.recipe_id WHERE r.${column} >= ?` : ''}
     ORDER BY ri.recipe_id, ri.position
  `).all(...params);

  for (const ing of ingredients) {
    const recipe = byId.get(ing.recipe_id);
    if (!recipe) continue;

    if (!ing.item_key) {
      // Ingrediens vi ikke kender. Ligner den kød eller fisk, kan retten ikke
      // planlægges troværdigt – se `hintsAtMainIngredient`.
      if (taxonomy.hintsAtMainIngredient(ing.raw)) recipe.unknown_main = true;
      // Og den TÆLLES. Linjen når aldrig ind i recipe.items, så motoren kan
      // ikke selv se, at den findes – og en ret, hvor tre fjerdedele af
      // ingredienserne er usynlige, ser gratis ud for madplanen. 678 af de
      // 2.224 opskrifter har mindst én. De valgfri tælles ikke med: "evt. et
      // skvæt fløde" købes ikke, og en ukendt evt.-linje skal ikke kunne gøre
      // retten uprissætbar. Samme regel som recipe_costs' coverage.
      if (!ing.optional) recipe.unknown_count = (recipe.unknown_count || 0) + 1;
      continue;
    }

    const entry = taxonomy.get(ing.item_key);
    recipe.items.push({
      key: ing.item_key,
      // entry.category, ikke seedets korte entry.cat (opgave 3: taxonomy.get()
      // returnerer nu en baserække). Feltet bæres hele vejen ud i
      // recipe_index og bruges i browseren af IGNORED_CATS/hasMainCourse til
      // at afgøre, om retten er en MIDDAG — var det null, kunne en sodavand
      // blive hovedråvare. (src/sync/build.js filtrerede indtil fix-runden
      // også drink/snack/nonfood-LINJER væk på feltet; det gør den ikke
      // længere — man køber vinen til gryden. Se kommentaren dér.)
      cat: entry?.category ?? null,
      essential: taxonomy.isEssential(ing.item_key),
      amount: ing.amount,
      weight: weightFor(entry, ing.amount),
      // "evt. et skvæt fløde" skal kunne udelades af indkøbslisten. Flaget
      // sættes af parseIngredient ved indlæsningen og bæres helt ud til
      // browseren — src/sync/build.js lægger det samme felt i sin payload,
      // for motoren kører begge steder og kan kun holde én regel.
      optional: Boolean(ing.optional),
      ingredient: ing.ingredient || entry?.name || ing.item_key,
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
  // `shoppingList` re-eksporteres IKKE. Den hed sådan indtil opgave 8 og tog
  // en buildPlan alene; nu kræver den en kontekst med items, priser og kæder,
  // og fordi hvert felt har en standardværdi, ville et gammelt kald
  // `plans.shoppingList(plan)` ikke kaste — det ville returnere tomme lister,
  // og app.js ville tegne ingenting. De to nye lister hentes fra `engine`,
  // som også er eksporteret herunder, så navnet ikke kan bruges i vanvare.
  offerShoppingList: engine.offerShoppingList,
  activeOfferMap, chainOfferIndex, normalPriceMap, normalPricesFor, loadRecipes,
  favoriteChainIds, chainNamesFor,
  TIERS, DAYS, engine,
};
