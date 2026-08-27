'use strict';

/**
 * Genberegner enhedspriser og vare-identitet for allerede hentede tilbud.
 *
 * De rå felter fra Tjek ligger i basen, så en rettelse i normaliseringen kan
 * slå igennem på hele historikken uden at hente noget igen.
 *
 *   node src/ingest/recompute.js
 */

const { getDb } = require('../db');
const norm = require('../lib/normalize');

function recompute({ relinkProducts = true, log = console.log } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, product_id, heading, description, price,
           size_from, size_to, unit_symbol, si_symbol, si_factor,
           pieces_from, pieces_to, unit_price, base_unit
      FROM offers
  `).all();

  const updatePrice = db.prepare(`
    UPDATE offers SET base_qty = ?, base_unit = ?, unit_price = ?, size_is_range = ?
     WHERE id = ?
  `);
  const updateProduct = db.prepare('UPDATE offers SET product_id = ? WHERE id = ?');
  const findProduct = db.prepare('SELECT id FROM products WHERE slug = ?');
  const insertProduct = db.prepare(`
    INSERT INTO products (slug, name, category, taxonomy_key, fat_grade, organic,
                          protein_per_100g, kcal_per_100g, created_at)
    VALUES (@slug, @name, @category, @taxonomy_key, @fat_grade, @organic,
            @protein_per_100g, @kcal_per_100g, @created_at)
  `);

  let priceChanged = 0, cleared = 0, productChanged = 0;

  const run = db.transaction(() => {
    for (const r of rows) {
      // Genskab den form computeUnitPrice forventer
      const shape = {
        pricing: { price: r.price },
        description: r.description,
        quantity: {
          unit: { symbol: r.unit_symbol, si: { symbol: r.si_symbol, factor: r.si_factor } },
          size: { from: r.size_from, to: r.size_to },
          pieces: { from: r.pieces_from, to: r.pieces_to },
        },
      };
      const up = norm.computeUnitPrice(shape);

      if (up.unit_price !== r.unit_price || up.base_unit !== r.base_unit) {
        updatePrice.run(up.base_qty, up.base_unit, up.unit_price, up.size_is_range, r.id);
        priceChanged++;
        if (up.unit_price == null && r.unit_price != null) cleared++;
      }

      if (relinkProducts) {
        const identity = norm.productIdentity(r.heading, r.description);
        let prod = findProduct.get(identity.slug);
        if (!prod) {
          insertProduct.run({ ...identity, created_at: new Date().toISOString() });
          prod = findProduct.get(identity.slug);
        }
        if (prod.id !== r.product_id) { updateProduct.run(prod.id, r.id); productChanged++; }
      }
    }

    // Ryd varetyper op, der ikke længere har tilbud
    db.prepare('DELETE FROM products WHERE id NOT IN (SELECT DISTINCT product_id FROM offers WHERE product_id IS NOT NULL)').run();
  });
  run();

  log(`${rows.length} tilbud gennemgået`);
  log(`  ${priceChanged} fik ny enhedspris (${cleared} nulstillet som utroværdige)`);
  log(`  ${productChanged} blev koblet til en anden varetype`);
  log(`  ${db.prepare('SELECT COUNT(*) n FROM products').get().n} varetyper tilbage`);

  return { rows: rows.length, priceChanged, cleared, productChanged };
}

if (require.main === module) recompute();

module.exports = { recompute };
