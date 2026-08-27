'use strict';

/**
 * "Følg en vare" + notifikationer.
 *
 * En overvågning kan være bundet til en varetype fra taksonomien (fx skyr),
 * hvilket er langt mere præcist end en tekstsøgning: den fanger også
 * "Cheasy skyr" og "Skyr med vanilje", men ikke "skyrpandekager"-annoncer.
 * Er varen ukendt for taksonomien, falder vi tilbage på fritekstsøgning.
 *
 * Der oprettes kun én notifikation pr. (overvågning, tilbud), så gentagne
 * kørsler i samme uge ikke spammer.
 */

const { getDb, getSetting } = require('../db');
const taxonomy = require('../lib/taxonomy');
const { assessRow } = require('../price/history');
const { distanceKm } = require('../ingest/tjek');

// Hvor meget under normalprisen en vare skal være, før det tæller som et
// tilbud værd at forstyrre nogen med. Kan overskrives pr. overvågning.
const DEFAULT_MIN_DISCOUNT = 0.05;

// ── Overvågninger ────────────────────────────────────────────────────────────

function createWatch({
  label, query, chainIds = [], maxKm = null,
  minDiscount = null, maxUnitPrice = null,
} = {}) {
  const db = getDb();
  const q = String(query || label || '').trim();
  if (!q) throw new Error('En overvågning kræver en søgetekst');

  // Bind til en varetype hvis muligt – det giver præcise match.
  const hit = taxonomy.lookup(q);

  const info = db.prepare(`
    INSERT INTO watches (label, query, taxonomy_key, chain_ids, max_km, min_discount, max_unit_price, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    String(label || (hit ? hit.entry.name : q)).trim(),
    q,
    hit ? hit.entry.key : null,
    JSON.stringify(chainIds || []),
    maxKm, minDiscount, maxUnitPrice,
    new Date().toISOString()
  );

  return db.prepare('SELECT * FROM watches WHERE id = ?').get(info.lastInsertRowid);
}

function listWatches({ activeOnly = false } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT w.*,
           (SELECT COUNT(*) FROM notifications n WHERE n.watch_id = w.id) AS notif_count,
           (SELECT COUNT(*) FROM notifications n WHERE n.watch_id = w.id AND n.read_at IS NULL) AS unread
      FROM watches w
     ${activeOnly ? 'WHERE w.active = 1' : ''}
     ORDER BY w.created_at DESC
  `).all().map((w) => ({ ...w, chain_ids: JSON.parse(w.chain_ids || '[]') }));
}

function deleteWatch(id) {
  return getDb().prepare('DELETE FROM watches WHERE id = ?').run(id).changes > 0;
}

// ── Butiksafstand ────────────────────────────────────────────────────────────

/** Nærmeste butik i en kæde, målt fra brugerens hjemmeadresse. */
function nearestStore(chainId, home) {
  if (!home || home.lat == null || home.lng == null) return null;
  const db = getDb();
  const stores = db.prepare(
    'SELECT id, name, city, zip, lat, lng FROM stores WHERE chain_id = ? AND lat IS NOT NULL'
  ).all(chainId);
  if (!stores.length) return null;

  let best = null;
  for (const s of stores) {
    const km = distanceKm(home.lat, home.lng, s.lat, s.lng);
    if (!best || km < best.km) best = { ...s, km: Math.round(km * 10) / 10 };
  }
  return best;
}

// ── Matchning ────────────────────────────────────────────────────────────────

/** Aktive tilbud der rammer en overvågning. */
function candidateOffers(watch, { at = new Date() } = {}) {
  const db = getDb();
  const now = at.toISOString();
  // watch kan komme direkte fra databasen (JSON-tekst) eller fra listWatches,
  // som allerede har parset feltet.
  const chainIds = Array.isArray(watch.chain_ids)
    ? watch.chain_ids
    : JSON.parse(watch.chain_ids || '[]');

  const where = [
    '(o.run_from IS NULL OR o.run_from <= ?)',
    '(o.run_till IS NULL OR o.run_till >= ?)',
  ];
  const params = [now, now];

  if (watch.taxonomy_key) {
    where.push('p.taxonomy_key = ?');
    params.push(watch.taxonomy_key);
  } else {
    // Fritekst: match på overskrift eller produktnavn
    where.push('(LOWER(o.heading) LIKE ? OR LOWER(p.name) LIKE ?)');
    const like = `%${String(watch.query).toLowerCase()}%`;
    params.push(like, like);
  }

  if (chainIds.length) {
    where.push(`o.chain_id IN (${chainIds.map(() => '?').join(',')})`);
    params.push(...chainIds);
  }
  if (watch.max_unit_price != null) {
    where.push('o.unit_price IS NOT NULL AND o.unit_price <= ?');
    params.push(watch.max_unit_price);
  }

  return db.prepare(`
    SELECT o.*, p.name AS product_name, p.taxonomy_key, c.name AS chain_name
      FROM offers o
      JOIN products p ON p.id = o.product_id
      JOIN chains   c ON c.id = o.chain_id
     WHERE ${where.join(' AND ')}
     ORDER BY o.unit_price ASC NULLS LAST
     LIMIT 200
  `).all(...params);
}

/**
 * Kører alle aktive overvågninger og danner notifikationer for nye træf.
 * Returnerer de notifikationer, der faktisk blev oprettet.
 */
function runWatches({ at = new Date(), log = null } = {}) {
  const db = getDb();
  const home = {
    lat: getSetting('home_lat', null),
    lng: getSetting('home_lng', null),
  };

  const insert = db.prepare(`
    INSERT INTO notifications (watch_id, offer_id, reason, unit_price, discount, nearest_km, nearest_store, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(watch_id, offer_id) DO NOTHING
  `);

  const created = [];
  const watches = listWatches({ activeOnly: true });
  const storeCache = new Map();

  for (const watch of watches) {
    // Samme vare i samme kæde optræder i flere aviser. Behold kun det
    // billigste træf, ellers får man den samme besked fem gange.
    const seen = new Set();

    for (const offer of candidateOffers(watch, { at })) {
      const dedupeKey = `${offer.chain_id}|${offer.product_id}`;
      if (seen.has(dedupeKey)) continue;

      const assessment = assessRow(offer);

      // Uden eksplicit krav gælder et gulv på 5 %: at stå i avisen er ikke
      // nok, hvis varen koster det samme som altid. Netop dét er forskellen
      // på "tilbud" og tilbud.
      const floor = watch.min_discount != null ? watch.min_discount : DEFAULT_MIN_DISCOUNT;
      if (assessment.discount != null && assessment.discount < floor) continue;
      if (assessment.discount == null && watch.min_discount != null) continue;

      seen.add(dedupeKey);

      let km = null, storeName = null;
      if (home.lat != null) {
        const cacheKey = offer.chain_id;
        if (!storeCache.has(cacheKey)) storeCache.set(cacheKey, nearestStore(offer.chain_id, home));
        const store = storeCache.get(cacheKey);
        if (store) {
          km = store.km;
          storeName = [store.name, store.city].filter(Boolean).join(', ');
          if (watch.max_km != null && km > watch.max_km) continue;
        } else if (watch.max_km != null) {
          continue;                                  // ingen kendt butik → kan ikke garantere afstand
        }
      }

      const reason = assessment.discount == null
        ? 'På tilbud nu'
        : assessment.discount >= 0
          ? `${assessment.discount_pct} % under normalprisen`
          : `${Math.abs(assessment.discount_pct)} % over normalprisen`;

      const info = insert.run(
        watch.id, offer.id, reason,
        offer.unit_price, assessment.discount, km, storeName,
        new Date().toISOString()
      );

      if (info.changes > 0) {
        created.push({
          watch_id: watch.id, watch_label: watch.label,
          offer_id: offer.id, heading: offer.heading, chain: offer.chain_name,
          price: offer.price, unit_price: offer.unit_price, base_unit: offer.base_unit,
          verdict: assessment.verdict, discount_pct: assessment.discount_pct,
          nearest_km: km, nearest_store: storeName,
        });
        if (log) log(`  [${watch.label}] ${offer.chain_name}: ${offer.heading} – ${reason}`);
      }
    }
  }

  return created;
}

// ── Notifikationer ───────────────────────────────────────────────────────────

function listNotifications({ unreadOnly = false, limit = 100 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT n.*, w.label AS watch_label, w.taxonomy_key,
           o.heading, o.price, o.base_unit, o.image, o.run_till,
           c.name AS chain_name, p.name AS product_name
      FROM notifications n
      JOIN watches w ON w.id = n.watch_id
      JOIN offers  o ON o.id = n.offer_id
      JOIN chains  c ON c.id = o.chain_id
      JOIN products p ON p.id = o.product_id
     ${unreadOnly ? 'WHERE n.read_at IS NULL' : ''}
     ORDER BY n.created_at DESC, n.discount DESC
     LIMIT ?
  `).all(limit);
}

function markRead(ids) {
  const db = getDb();
  const now = new Date().toISOString();
  if (!ids || !ids.length) {
    return db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now).changes;
  }
  const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL');
  const tx = db.transaction((list) => list.reduce((n, id) => n + stmt.run(now, id).changes, 0));
  return tx(ids);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'add') {
    const w = createWatch({ label: rest.join(' '), query: rest.join(' ') });
    console.log(`Følger nu "${w.label}"${w.taxonomy_key ? ` (varetype: ${w.taxonomy_key})` : ' (fritekst)'}`);
  } else if (cmd === 'list') {
    for (const w of listWatches()) {
      console.log(`#${w.id}  ${w.label.padEnd(20)} ${w.taxonomy_key || '(fritekst)'}  ${w.unread} ulæste`);
    }
  } else if (cmd === 'rm') {
    console.log(deleteWatch(parseInt(rest[0], 10)) ? 'Slettet' : 'Ikke fundet');
  } else {
    console.log('Kører overvågninger...');
    const created = runWatches({ log: console.log });
    console.log(`\n${created.length} nye notifikationer`);
  }
}

module.exports = {
  createWatch, listWatches, deleteWatch,
  runWatches, candidateOffers, nearestStore,
  listNotifications, markRead,
};
