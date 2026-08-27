'use strict';

/**
 * Bygger en ugentlig madplan ud fra dette uges tilbud.
 *
 * Fremgangsmåde:
 *   1. Find alle AKTIVE tilbud og reducér dem til billigste tilbud pr.
 *      varetype (kr/kg), evt. begrænset til udvalgte kæder.
 *   2. Scor hver opskrift på hvor stor en del af dens ingredienser, der er
 *      på tilbud lige nu – basisvarer som salt og olie tæller ikke med.
 *   3. Vægt sammen med opskriftens score i det ønskede spor
 *      (sund & proteinrig / klassisk / gourmet).
 *   4. Vælg 7 retter grådigt, men tving variation frem, så ugen ikke ender
 *      som kylling syv dage i træk.
 *
 * Pris og besparelse estimeres pr. portion ud fra ingrediensmængder ×
 * tilbudspris, med varens normalpris (median) som reference.
 */

const { getDb } = require('../db');
const taxonomy = require('../lib/taxonomy');
const { gramsOf } = require('../recipes/classify');
const { getBaseline } = require('../price/history');
const { isoWeek } = require('../lib/normalize');

const TIERS = {
  healthy: { column: 'score_healthy', label: 'Sund & proteinrig (lavt kulhydrat)' },
  classic: { column: 'score_classic', label: 'Klassisk hverdagsmad' },
  premium: { column: 'score_premium', label: 'Gourmet' },
};

const DAYS = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];

// ── Tilbud pr. varetype ──────────────────────────────────────────────────────

/**
 * Billigste aktive tilbud pr. varetype, målt i kr/kg (eller kr/l).
 * Det er dette kort, opskrifterne matches imod.
 */
function activeOfferMap({ chainIds = null, at = new Date() } = {}) {
  const db = getDb();
  const now = at.toISOString();

  const params = [now, now];
  let sql = `
    SELECT o.id, o.product_id, o.chain_id, c.name AS chain_name, o.heading,
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
    if (!map.has(row.taxonomy_key)) map.set(row.taxonomy_key, row);
  }
  return map;
}

// ── Scoring af én opskrift ───────────────────────────────────────────────────

const baselineCache = new Map();
function cachedBaseline(productId, baseUnit) {
  const k = `${productId}|${baseUnit}`;
  if (!baselineCache.has(k)) baselineCache.set(k, getBaseline(productId, baseUnit));
  return baselineCache.get(k);
}

/**
 * Hvor meget af opskriften er på tilbud, og hvad koster den cirka?
 */
function scoreRecipe(recipe, ingredients, offerMap) {
  const relevant = ingredients.filter((i) => i.taxonomy_key && !i.is_staple);
  const considered = relevant.length || 1;

  const matched = [];
  let estCost = 0, estSavings = 0, pricedIngredients = 0;

  const seen = new Set();
  for (const ing of relevant) {
    if (seen.has(ing.taxonomy_key)) continue;
    seen.add(ing.taxonomy_key);

    const offer = offerMap.get(ing.taxonomy_key);
    const grams = gramsOf(ing);
    // Kun vægt-/rumfangsbaserede tilbud kan prissættes pr. mængde.
    const qtyInBase = grams && offer && (offer.base_unit === 'kg' || offer.base_unit === 'l')
      ? grams / 1000
      : null;

    if (offer) {
      const baseline = cachedBaseline(offer.product_id, offer.base_unit);
      const normal = baseline?.median ?? null;

      let cost = null, saving = null;
      if (qtyInBase != null) {
        cost = qtyInBase * offer.unit_price;
        if (normal != null && normal > offer.unit_price) saving = qtyInBase * (normal - offer.unit_price);
      }

      if (cost != null) { estCost += cost; pricedIngredients++; }
      if (saving != null) estSavings += saving;

      matched.push({
        taxonomy_key: ing.taxonomy_key,
        name: offer.product_name,
        ingredient: ing.ingredient,
        offer_id: offer.id,
        chain: offer.chain_name,
        chain_id: offer.chain_id,
        heading: offer.heading,
        price: offer.price,
        unit_price: offer.unit_price,
        base_unit: offer.base_unit,
        normal_unit_price: normal,
        grams: grams ? Math.round(grams) : null,
        est_cost: cost != null ? Math.round(cost * 100) / 100 : null,
        est_saving: saving != null ? Math.round(saving * 100) / 100 : null,
        image: offer.image,
      });
    } else if (grams) {
      // Ikke på tilbud – prissæt til normalpris, hvis vi kender den.
      const db = getDb();
      const prod = db.prepare('SELECT id FROM products WHERE taxonomy_key = ? LIMIT 1').get(ing.taxonomy_key);
      if (prod) {
        const baseline = cachedBaseline(prod.id, 'kg');
        if (baseline?.median) { estCost += (grams / 1000) * baseline.median; pricedIngredients++; }
      }
    }
  }

  const coverage = matched.length / considered;
  const servings = recipe.servings && recipe.servings > 0 ? recipe.servings : 4;

  return {
    matched,
    match_count: matched.length,
    considered,
    coverage: Math.round(coverage * 100) / 100,
    est_cost: Math.round(estCost * 100) / 100,
    est_cost_per_serving: Math.round((estCost / servings) * 100) / 100,
    est_savings: Math.round(estSavings * 100) / 100,
    priced_ingredients: pricedIngredients,
  };
}

// ── Planlægning ──────────────────────────────────────────────────────────────

/** Rettens "hovedråvare" – bruges til at sikre variation hen over ugen. */
function mainProtein(ingredients) {
  const order = ['fish', 'meat', 'poultry', 'legume', 'eggs', 'cheese'];
  for (const cat of order) {
    for (const ing of ingredients) {
      if (!ing.taxonomy_key) continue;
      if (taxonomy.get(ing.taxonomy_key)?.cat === cat) return ing.taxonomy_key;
    }
  }
  return null;
}

/** Lille deterministisk PRNG, så et givet seed altid giver samme plan. */
function seededNoise(seed, id) {
  let h = (seed ^ (id * 2654435761)) >>> 0;
  h ^= h << 13; h >>>= 0;
  h ^= h >> 17;
  h ^= h << 5;  h >>>= 0;
  return (h % 1000) / 1000;                        // 0…1
}

/** Opskrifter brugt i de seneste ugers planer – de skal vige for nye. */
function recentlyUsedRecipes(tier, weeksBack) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT i.recipe_id
      FROM meal_plan_items i
      JOIN meal_plans p ON p.id = i.plan_id
     WHERE p.created_at >= ?
  `).all(new Date(Date.now() - weeksBack * 7 * 86400000).toISOString());
  return new Set(rows.map((r) => r.recipe_id));
}

function generatePlan({
  tier = 'classic',
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
  const db = getDb();
  baselineCache.clear();

  const offerMap = activeOfferMap({ chainIds, at });
  const column = TIERS[tier].column;

  const candidates = db.prepare(`
    SELECT * FROM recipes
     WHERE ${column} >= ?
       AND (SELECT COUNT(*) FROM recipe_ingredients ri WHERE ri.recipe_id = recipes.id) >= 3
     ORDER BY ${column} DESC
     LIMIT 1200
  `).all(minTierScore);

  if (!candidates.length) {
    return { tier, days: [], error: 'Ingen opskrifter matcher sporet endnu – kør opskrifts-crawleren først.' };
  }

  const getIngredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY position');

  const recentlyUsed = avoidRecentWeeks > 0 ? recentlyUsedRecipes(tier, avoidRecentWeeks) : new Set();

  const scored = [];
  for (const r of candidates) {
    const ingredients = getIngredients.all(r.id);
    const s = scoreRecipe(r, ingredients, offerMap);
    if (s.match_count === 0) continue;                    // intet på tilbud → ikke relevant

    const tierScore = r[column] ?? 0;
    // Tilbudsdækning vejer tungest – det er hele pointen med planen – men
    // sporet skal stadig kunne skubbe en ret ud, hvis den ikke passer.
    let total = 0.55 * s.coverage + 0.35 * tierScore + 0.10 * Math.min(s.est_savings / 40, 1);

    // Var retten med i en af de sidste ugers planer, skal den vige for en ny.
    const repeat = recentlyUsed.has(r.id);
    if (repeat) total -= 0.22;

    // Støj bryder uafgjorte kandidater op, så to kørsler ikke giver samme uge.
    // Feltet af gode kandidater er stort; forskellen i kvalitet mellem nr. 7
    // og nr. 25 er lille, mens forskellen i oplevet variation er stor.
    total += seededNoise(seed, r.id) * variety;

    scored.push({
      recipe: r, ingredients, score: s, tierScore, total,
      repeat, main: mainProtein(ingredients),
    });
  }

  scored.sort((a, b) => b.total - a.total);

  // Grådigt valg med variation: samme hovedråvare højst to gange, og samme
  // ret aldrig to gange.
  const chosen = [];
  const mainCount = new Map();
  for (const pass of [2, 99]) {
    for (const cand of scored) {
      if (chosen.length >= days) break;
      if (chosen.some((c) => c.recipe.id === cand.recipe.id)) continue;
      const used = mainCount.get(cand.main) || 0;
      if (cand.main && used >= pass) continue;
      chosen.push(cand);
      mainCount.set(cand.main, used + 1);
    }
    if (chosen.length >= days) break;
  }

  const totalCost = chosen.reduce((a, c) => a + c.score.est_cost, 0);
  const totalSavings = chosen.reduce((a, c) => a + c.score.est_savings, 0);

  return {
    tier,
    tier_label: TIERS[tier].label,
    generated_at: new Date().toISOString(),
    ...isoWeek(at),
    chain_ids: chainIds,
    seed,
    offers_available: offerMap.size,
    candidates_scored: scored.length,
    est_cost: Math.round(totalCost * 100) / 100,
    est_savings: Math.round(totalSavings * 100) / 100,
    days: chosen.map((c, i) => ({
      day: i,
      day_name: DAYS[i % 7],
      recipe: {
        id: c.recipe.id,
        title: c.recipe.title,
        url: c.recipe.url,
        image: c.recipe.image,
        source: c.recipe.source,
        source_name: c.recipe.source_name,
        servings: c.recipe.servings,
        total_minutes: c.recipe.total_minutes,
        kcal: c.recipe.kcal,
        protein_g: c.recipe.protein_g,
        carbs_g: c.recipe.carbs_g,
        nutrition_src: c.recipe.nutrition_src,
      },
      tier_score: c.tierScore,
      ...c.score,
    })),
  };
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

/** Samlet indkøbsliste for en plan, grupperet efter butik. */
function shoppingList(plan) {
  const byChain = new Map();
  const extras = new Map();

  for (const day of plan.days) {
    for (const m of day.matched) {
      if (!byChain.has(m.chain)) byChain.set(m.chain, new Map());
      const items = byChain.get(m.chain);
      const prev = items.get(m.taxonomy_key);
      if (prev) {
        prev.grams += m.grams || 0;
        prev.est_cost += m.est_cost || 0;
        prev.est_saving += m.est_saving || 0;
        prev.used_in.push(day.recipe.title);
      } else {
        items.set(m.taxonomy_key, {
          name: m.name, heading: m.heading, chain: m.chain,
          price: m.price, unit_price: m.unit_price, base_unit: m.base_unit,
          grams: m.grams || 0, est_cost: m.est_cost || 0, est_saving: m.est_saving || 0,
          image: m.image, used_in: [day.recipe.title],
        });
      }
    }
    // Ingredienser uden tilbud – skal stadig købes
    for (const ing of day.unmatched || []) extras.set(ing, true);
  }

  return {
    on_offer: [...byChain.entries()].map(([chain, items]) => ({
      chain,
      items: [...items.values()].sort((a, b) => b.est_saving - a.est_saving),
      total: Math.round([...items.values()].reduce((a, i) => a + i.est_cost, 0) * 100) / 100,
      savings: Math.round([...items.values()].reduce((a, i) => a + i.est_saving, 0) * 100) / 100,
    })).sort((a, b) => b.savings - a.savings),
  };
}

module.exports = { generatePlan, savePlan, shoppingList, activeOfferMap, scoreRecipe, TIERS, DAYS };
