'use strict';

/**
 * Fylder items + item_synonyms fra seed-arrayet i src/lib/taxonomy.js.
 *
 * Idempotent: kan køres igen efter en rettelse i seed-data uden at duplikere.
 * Synonymer slettes og skrives forfra pr. vare, så et fjernet synonym også
 * forsvinder i basen.
 *
 *   npm run seed:items
 */

const { getDb } = require('../src/db');
const { SEED } = require('../src/lib/taxonomy');
const { PIECE_G } = require('../src/lib/units');

// base_unit er kurateret på posten selv (opgave 2). Kg er standarden, fordi
// langt de fleste varer vejes — en liste over undtagelser her ville være et
// andet sted at holde ved lige end der, hvor varen defineres.
const baseUnitFor = (entry) => entry.base_unit || 'kg';

function main() {
  const db = getDb();

  const upsertItem = db.prepare(`
    INSERT INTO items (key, name, category, class, keeps, base_unit, piece_g,
                       density_g_ml, protein_per_100g, kcal_per_100g,
                       carbs_per_100g, fat_grades, premium)
    VALUES (@key, @name, @category, @class, @keeps, @base_unit, @piece_g,
            @density_g_ml, @protein_per_100g, @kcal_per_100g,
            @carbs_per_100g, @fat_grades, @premium)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name, category = excluded.category, class = excluded.class,
      keeps = excluded.keeps, base_unit = excluded.base_unit,
      piece_g = excluded.piece_g, density_g_ml = excluded.density_g_ml,
      protein_per_100g = excluded.protein_per_100g,
      kcal_per_100g = excluded.kcal_per_100g,
      carbs_per_100g = excluded.carbs_per_100g,
      fat_grades = excluded.fat_grades, premium = excluded.premium
  `);
  const clearSyn  = db.prepare('DELETE FROM item_synonyms WHERE item_key = ?');
  const insertSyn = db.prepare(
    'INSERT OR IGNORE INTO item_synonyms (item_key, lang, text) VALUES (?, ?, ?)'
  );

  // En vare, der er fjernet eller omdøbt i SEED, skal også forsvinde fra
  // basen. Uden det bliver den et spøgelse: all() returnerer den, lookup()
  // matcher den, og sync/build.js sender den videre til browseren som en
  // indkøbslinje — uden at noget fejler. Opgave 8 redigerer SEED kraftigt,
  // så det er ikke et teoretisk hjørne.
  const dropGone = db.prepare(
    'DELETE FROM items WHERE key NOT IN (SELECT value FROM json_each(?))'
  );

  let removed = 0;
  const run = db.transaction(() => {
    for (const e of SEED) {
      upsertItem.run({
        key: e.key, name: e.name, category: e.cat,
        class: e.class, keeps: e.keeps,
        base_unit: baseUnitFor(e),
        piece_g: PIECE_G[e.key] ?? null,
        density_g_ml: e.density_g_ml ?? null,
        protein_per_100g: e.p ?? null,
        kcal_per_100g: e.kcal ?? null,
        carbs_per_100g: e.c ?? null,
        fat_grades: e.fatGrades ? 1 : 0,
        premium: e.premium ? 1 : 0,
      });
      clearSyn.run(e.key);
      for (const s of e.da || []) insertSyn.run(e.key, 'da', s.toLowerCase());
      for (const s of e.en || []) insertSyn.run(e.key, 'en', s.toLowerCase());
    }
    // ON DELETE CASCADE på item_synonyms rydder synonymerne med.
    removed = dropGone.run(JSON.stringify(SEED.map((e) => e.key))).changes;
  });
  run();

  const items = db.prepare('SELECT count(*) c FROM items').get().c;
  const syns  = db.prepare('SELECT count(*) c FROM item_synonyms').get().c;
  console.log(`items: ${items} · synonymer: ${syns} · slettet: ${removed}`);

  // Basen skal spejle SEED præcist. Gør den ikke det, er noget gået galt i en
  // transaktion, og en forkert vareliste er værre end ingen.
  if (items !== SEED.length) {
    throw new Error(`items=${items} men SEED har ${SEED.length} varer`);
  }
}

main();
