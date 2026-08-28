'use strict';

/**
 * Prishistorik og "er det egentlig et tilbud?".
 *
 * Der er tre uafhængige mål på, om en pris er god. Vi bruger dem alle, fordi
 * de dækker hinandens huller:
 *
 *   1. FØRPRIS      – avisens egen "før/nu". Præcis, men kun oplyst i ~9 % af
 *                     tilbuddene, så den kan ikke stå alene.
 *   2. PÅ TVÆRS     – samme varetype i andre kæder lige nu. Virker fra dag ét
 *                     og afslører den klassiske "tilbud" til normalpris.
 *   3. OVER TID     – samme varetype i samme kæde tidligere uger. Bliver
 *                     stærkere for hver uges ingest.
 *
 * Alt regnes på `unit_price` (kr/kg eller kr/l), aldrig på stykprisen –
 * ellers sammenligner man 400 g med 1 kg.
 */

const { getDb } = require('../db');

const HORIZON_DAYS = 400;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(n) { return Math.round(n * 1000) / 10; }

/**
 * Alle observationer af en varetype over tid, nyeste sidst.
 * Dette ER prishistorikken – hver tilbudsavis er et datapunkt.
 */
function getHistory(productId, { chainId = null, baseUnit = null, limit = 400 } = {}) {
  const db = getDb();
  const params = [productId];
  let sql = `
    SELECT o.id, o.chain_id, c.name AS chain_name, o.heading,
           o.price, o.pre_price, o.unit_price, o.base_unit, o.base_qty,
           o.run_from, o.run_till, o.week, o.year, o.observed_at
      FROM offers o
      JOIN chains c ON c.id = o.chain_id
     WHERE o.product_id = ? AND o.unit_price IS NOT NULL`;
  if (chainId)  { sql += ' AND o.chain_id = ?'; params.push(chainId); }
  if (baseUnit) { sql += ' AND o.base_unit = ?'; params.push(baseUnit); }
  sql += ' ORDER BY COALESCE(o.run_from, o.observed_at) ASC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Referencepris for en varetype: hvad koster den "normalt" pr. kg/l?
 * Medianen er robust over for enkeltstående ekstremtilbud.
 */
function getBaseline(productId, baseUnit, { excludeOfferId = null } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - HORIZON_DAYS * 86400000).toISOString();

  const rows = db.prepare(`
    SELECT o.id, o.chain_id, o.unit_price, o.week, o.year
      FROM offers o
     WHERE o.product_id = ? AND o.base_unit = ?
       AND o.unit_price IS NOT NULL AND o.unit_price > 0
       AND COALESCE(o.run_from, o.observed_at) >= ?
       ${excludeOfferId ? 'AND o.id != ?' : ''}
  `).all(...[productId, baseUnit, since, ...(excludeOfferId ? [excludeOfferId] : [])]);

  if (!rows.length) return null;

  // Én stemme pr. kæde pr. uge.
  //
  // Uden dette bliver medianen ubrugelig: nogle kæder udgiver den samme vare i
  // 16 forskellige aviser samtidig, og så trækker én kædes pris medianen ned
  // mod sig selv – hvorefter et reelt tilbud ser ud som "normal pris".
  // Vi bruger kædens billigste pris i ugen som dens observation.
  const byChainWeek = new Map();
  for (const r of rows) {
    const key = `${r.chain_id}|${r.year}-${r.week}`;
    const prev = byChainWeek.get(key);
    if (prev == null || r.unit_price < prev) byChainWeek.set(key, r.unit_price);
  }

  const prices = [...byChainWeek.values()];
  // Distinkte ISO-uger – IKKE distinkte datoer. Kæder starter deres aviser på
  // forskellige ugedage, så datoer ville få én uges data til at ligne mange.
  const weeks = new Set(rows.map((r) => `${r.year}-${r.week}`));

  return {
    median: median(prices),
    min: Math.min(...prices),
    max: Math.max(...prices),
    samples: prices.length,
    raw_samples: rows.length,
    chains: new Set(rows.map((r) => r.chain_id)).size,
    periods: weeks.size,
  };
}

/**
 * Bedømmer ét tilbud.
 *
 * `verdict` er bevidst konservativ: uden sammenligningsgrundlag siger vi
 * "ukendt" frem for at kalde noget et godt tilbud, vi ikke kan bakke op.
 */
function assessOffer(offerId) {
  const db = getDb();
  const offer = db.prepare(`
    SELECT o.*, p.name AS product_name, p.taxonomy_key, c.name AS chain_name
      FROM offers o
      JOIN products p ON p.id = o.product_id
      JOIN chains c   ON c.id = o.chain_id
     WHERE o.id = ?
  `).get(offerId);
  if (!offer) return null;

  return assessRow(offer);
}

/** Samme bedømmelse, men på en allerede hentet række (undgår N+1). */
function assessRow(offer) {
  const signals = [];
  let discount = null;
  let basis = null;

  // 1. Avisens egen førpris
  if (offer.pre_price && offer.price && offer.pre_price > offer.price) {
    const d = (offer.pre_price - offer.price) / offer.pre_price;
    signals.push({ kind: 'pre_price', discount: d,
      label: `${pct(d)} % under førprisen (${offer.pre_price} kr)` });
    discount = d; basis = 'pre_price';
  }

  const baseline = offer.unit_price != null
    ? getBaseline(offer.product_id, offer.base_unit, { excludeOfferId: offer.id })
    : null;

  if (baseline && baseline.median > 0) {
    const d = (baseline.median - offer.unit_price) / baseline.median;
    const unit = offer.base_unit;
    signals.push({
      kind: baseline.periods > 1 ? 'history' : 'cross_chain',
      discount: d,
      label: d >= 0
        ? `${pct(d)} % under normalprisen (median ${baseline.median.toFixed(2)} kr/${unit})`
        : `${pct(-d)} % OVER normalprisen (median ${baseline.median.toFixed(2)} kr/${unit})`,
      baseline,
    });
    // Historik/tværsnit vinder over førpris, som ofte er kunstigt høj.
    if (discount == null || baseline.samples >= 3) { discount = d; basis = baseline.periods > 1 ? 'history' : 'cross_chain'; }
  }

  const isCheapest = baseline && offer.unit_price != null && offer.unit_price <= baseline.min;

  let verdict = 'unknown';
  if (discount != null && baseline && baseline.samples >= 2) {
    if (discount >= 0.25 || (isCheapest && discount >= 0.15)) verdict = 'great';
    else if (discount >= 0.10) verdict = 'good';
    else if (discount > -0.05) verdict = 'fair';
    else verdict = 'poor';
  } else if (discount != null && basis === 'pre_price') {
    verdict = discount >= 0.20 ? 'good' : 'fair';
  }

  const confidence = !baseline ? 'none'
    : baseline.periods >= 3 ? 'high'
    : baseline.samples >= 5 ? 'medium'
    : 'low';

  return {
    offer_id: offer.id,
    verdict,
    discount,
    discount_pct: discount == null ? null : pct(discount),
    basis,
    confidence,
    is_cheapest: !!isCheapest,
    baseline,
    signals,
  };
}

/**
 * Prissammenligning på tværs af kæder for én varetype, lige nu.
 * Dette er svaret på "er 35 kr for hakket oksekød billigt?".
 */
function compareChains(productId, { activeOnly = true, baseUnit = null } = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const params = [productId];
  // Kun samme enhed må stilles op mod hinanden. 1,20 kr/stk og 105 kr/l
  // i samme tabel er meningsløst og får den dyre vare til at se billig ud.
  const unitFilter = baseUnit ? 'AND o.base_unit = ?' : '';
  if (baseUnit) params.push(baseUnit);
  if (activeOnly) params.push(now);

  const rows = db.prepare(`
    SELECT o.id, o.chain_id, c.name AS chain_name, c.logo, c.color,
           o.heading, o.price, o.pre_price, o.unit_price, o.base_unit,
           o.base_qty, o.run_from, o.run_till, o.image
      FROM offers o
      JOIN chains c ON c.id = o.chain_id
     WHERE o.product_id = ? AND o.unit_price IS NOT NULL
       ${unitFilter}
       ${activeOnly ? 'AND (o.run_till IS NULL OR o.run_till >= ?)' : ''}
     ORDER BY o.unit_price ASC
  `).all(...params);

  // Behold billigste tilbud pr. kæde
  const best = new Map();
  for (const r of rows) if (!best.has(r.chain_id)) best.set(r.chain_id, r);
  return [...best.values()].sort((a, b) => a.unit_price - b.unit_price);
}

/** Ugentlige medianer til grafen på produktsiden. */
function weeklySeries(productId, baseUnit) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.year, o.week, o.unit_price, o.chain_id
      FROM offers o
     WHERE o.product_id = ? AND o.base_unit = ? AND o.unit_price IS NOT NULL
     ORDER BY o.year, o.week
  `).all(productId, baseUnit);

  const buckets = new Map();
  for (const r of rows) {
    const k = `${r.year}-${String(r.week).padStart(2, '0')}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r.unit_price);
  }
  return [...buckets.entries()].map(([period, prices]) => ({
    period,
    median: Math.round(median(prices) * 100) / 100,
    min: Math.round(Math.min(...prices) * 100) / 100,
    max: Math.round(Math.max(...prices) * 100) / 100,
    n: prices.length,
  }));
}

module.exports = {
  getHistory, getBaseline, assessOffer, assessRow,
  compareChains, weeklySeries, median,
};
