'use strict';

/**
 * Et kvalificeret gæt på normalprisen, gratis og med det samme.
 *
 * For en vare med tilbudshistorik er den HØJESTE observerede kr/kg tættere
 * på normalprisen end medianen: det er den uge, hvor rabatten var mindst.
 * Det er ikke rigtigt — det er et udgangspunkt, der er bedre end ingenting,
 * og det markeres som 'derived', så arbejdslisten sætter det forrest.
 *
 * Kun 113 af de 190 varer, der skal prissættes, har overhovedet historik.
 * De øvrige 77 skal indtastes. Scriptet siger hvor mange.
 *
 *   npm run prices:bootstrap
 */

const { getDb } = require('../src/db');
const path = require('node:path');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

// Tilbud ældre end dette siger intet om prisen i dag.
const HORIZON_DAYS = 400;
// Den højeste observation kan være en fejllæsning. 90-percentilen er robust
// mod den ene ekstremværdi og stadig tæt på "mindst rabatterede uge".
const PERCENTILE = 0.9;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

function main() {
  const db = getDb();
  const since = new Date(Date.now() - HORIZON_DAYS * 86400000).toISOString();

  // Én observation pr. (vare, kæde, uge): den samme vare optræder flere gange
  // i samme avis, og uden grupperingen vægter en travl uge tungere.
  const rows = db.prepare(`
    SELECT p.item_key, o.chain_id, o.base_unit, o.year, o.week,
           MIN(o.unit_price) AS unit_price,
           MIN(o.base_qty)   AS base_qty
      FROM offers o
      JOIN products p ON p.id = o.product_id
      JOIN items    i ON i.key = p.item_key
     WHERE p.item_key IS NOT NULL
       AND i.class <> 'essential'
       AND COALESCE(p.prepared, 0) = 0
       AND o.unit_price IS NOT NULL AND o.unit_price > 0
       AND o.base_qty  IS NOT NULL AND o.base_qty  > 0
       AND o.base_unit = i.base_unit
       AND COALESCE(o.run_from, o.observed_at) >= ?
     GROUP BY p.item_key, o.chain_id, o.base_unit, o.year, o.week
  `).all(since);

  const buckets = new Map();
  for (const r of rows) {
    const k = `${r.item_key}|${r.chain_id}`;
    if (!buckets.has(k)) {
      buckets.set(k, { item_key: r.item_key, chain_id: r.chain_id,
                       base_unit: r.base_unit, prices: [], packs: [] });
    }
    buckets.get(k).prices.push(r.unit_price);
    buckets.get(k).packs.push(r.base_qty);
  }

  const items = new Map(db.prepare('SELECT key, class, base_unit FROM items').all()
    .map((i) => [i.key, i]));

  const ins = db.prepare(`
    INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit,
                             pack_price, unit_price, source, observed_at, valid_until)
    VALUES (@item_key, @chain_id, @pack_qty, @pack_unit,
            @pack_price, @unit_price, 'derived', @observed_at, @valid_until)
    ON CONFLICT(item_key, chain_id, pack_qty, pack_unit) DO UPDATE SET
      pack_price = excluded.pack_price, unit_price = excluded.unit_price,
      observed_at = excluded.observed_at, valid_until = excluded.valid_until
     -- Et gæt må aldrig overskrive en rigtig pris.
     WHERE item_prices.source = 'derived'
  `);

  const now = new Date();
  let written = 0;
  const run = db.transaction(() => {
    for (const b of buckets.values()) {
      const item = items.get(b.item_key);
      if (!item) continue;
      const unitPrice = percentile([...b.prices].sort((a, z) => a - z), PERCENTILE);
      // Den hyppigste pakkestørrelse i kæden er den, man reelt møder.
      const counts = new Map();
      for (const q of b.packs) counts.set(q, (counts.get(q) || 0) + 1);
      const packQty = [...counts.entries()].sort((a, z) => z[1] - a[1])[0][0];
      if (!unitPrice || !packQty) continue;

      ins.run({
        item_key: b.item_key, chain_id: b.chain_id,
        pack_qty: packQty, pack_unit: b.base_unit,
        pack_price: Math.round(unitPrice * packQty * 100) / 100,
        unit_price: Math.round(unitPrice * 100) / 100,
        observed_at: now.toISOString(),
        valid_until: engine.validUntilFor(item.class, now),
      });
      written++;
    }
  });
  run();

  const priceable = db.prepare("SELECT count(*) c FROM items WHERE class <> 'essential'").get().c;
  const covered = db.prepare('SELECT count(DISTINCT item_key) c FROM item_prices').get().c;
  console.log(`rækker skrevet: ${written}`);
  console.log(`varer med mindst én pris: ${covered} af ${priceable}`);
  console.log(`mangler helt: ${priceable - covered} — de skal i data/item_prices.csv`);
}

main();
