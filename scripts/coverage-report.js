'use strict';

/**
 * Hvor mange opskrifter kan prissættes, og hvad står i vejen?
 *
 * "Prissætbar" = hver ikke-essentiel, ikke-valgfri ingrediens har en item_key.
 * Rapporten er arbejdslisten for synonym-arbejdet: den øverste blokker er
 * altid den næste, det bedst kan betale sig at tilføje.
 *
 *   npm run coverage
 */

const { getDb } = require('../src/db');

function main() {
  const db = getDb();

  const rows = db.prepare(`
    SELECT ri.recipe_id, ri.ingredient, ri.item_key, ri.amount,
           i.class AS item_class
      FROM recipe_ingredients ri
      LEFT JOIN items i ON i.key = ri.item_key
     WHERE COALESCE(ri.optional, 0) = 0
  `).all();

  const byRecipe = new Map();
  for (const r of rows) {
    if (!byRecipe.has(r.recipe_id)) byRecipe.set(r.recipe_id, []);
    byRecipe.get(r.recipe_id).push(r);
  }

  // En linje blokerer, hvis den hverken er essential eller kendt.
  const blocks = (r) => r.item_class !== 'essential' && !r.item_key;

  let priceable = 0, withAmount = 0;
  const blockers = new Map();

  for (const [, ings] of byRecipe) {
    const bad = ings.filter(blocks);
    if (!bad.length) {
      priceable++;
      if (ings.every((r) => r.item_class === 'essential' || r.amount != null)) withAmount++;
    }
    for (const r of bad) {
      const name = (r.ingredient || '').toLowerCase().trim();
      if (name) blockers.set(name, (blockers.get(name) || 0) + 1);
    }
  }

  console.log(`opskrifter:            ${byRecipe.size}`);
  console.log(`  prissætbare:         ${priceable}`);
  console.log(`  heraf med alle mængder: ${withAmount}`);
  console.log(`distinkte blokkere:    ${blockers.size}`);
  console.log('\nTop 40 blokkere — næste synonym-arbejde:');
  [...blockers]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .forEach(([name, n]) => console.log(String(n).padStart(5), name));
}

main();
