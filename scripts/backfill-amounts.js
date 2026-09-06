'use strict';

/**
 * Udfylder item_key, amount og optional på de eksisterende ingredienslinjer.
 *
 * item_key er indtil videre en kopi af taxonomy_key — de peger på samme
 * nøgler. Linjer uden nøgle slås op igen, fordi taksonomien har fået nye
 * varer siden de blev skrevet.
 *
 *   npm run backfill:amounts
 */

const { getDb } = require('../src/db');
const taxonomy  = require('../src/lib/taxonomy');
const { amountOf } = require('../src/lib/units');

// Kun det, kilden selv har markeret som valgfrit.
//
// "to serve" og "til pynt" fristede, men de beskriver HVORDAN varen bruges,
// ikke OM den skal købes: "4 seeded burger buns, to serve" er retten, og
// "1 tbsp sesame seeds plus extra to serve" har en grundmængde, der skal med.
// Begge dele ville forsvinde fra indkøbslisten.
//
// "evt." er kun valgfri først i linjen. Inde i linjen kvalificerer den et
// valg om noget, man køber alligevel: "800 g kartofler - evt. nye".
//
// Retningen er bevidst: flager vi for lidt, køber man en vare for meget.
// Flager vi for meget, står man i køkkenet uden burgerboller.
const OPTIONAL_RE = /\(optional\)|\boptional\b|\bif you like\b|^\s*evt\.?\s|^\s*eventuelt\b|^\s*valgfri/i;

function main() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, raw, qty, unit, ingredient, taxonomy_key FROM recipe_ingredients'
  ).all();

  const upd = db.prepare(
    'UPDATE recipe_ingredients SET item_key = ?, amount = ?, optional = ? WHERE id = ?'
  );

  let keyed = 0, amounts = 0, optional = 0, rekeyed = 0;

  const run = db.transaction(() => {
    for (const r of rows) {
      let key = r.taxonomy_key;
      if (!key) {
        // Taksonomien er vokset siden linjen blev skrevet — prøv igen.
        const hit = taxonomy.lookup(r.ingredient) || taxonomy.lookup(r.raw);
        if (hit) { key = hit.entry.key; rekeyed++; }
      }

      const item = key ? taxonomy.get(key) : null;
      // Nøglen sendes med, selvom varen også gør det: uden den falder
      // stykvarer tilbage til 100 g, hvis seedet har misset piece_g — og et
      // løg på 100 g i stedet for 110 fejler ikke, det bliver bare forkert.
      const amount = item
        ? amountOf({ qty: r.qty, unit: r.unit, item_key: key }, item)
        : null;
      const opt = OPTIONAL_RE.test(r.raw || '') ? 1 : 0;

      if (key)    keyed++;
      if (amount != null) amounts++;
      if (opt)    optional++;

      upd.run(key, amount, opt, r.id);
    }
  });
  run();

  console.log(`linjer: ${rows.length}`);
  console.log(`  med item_key: ${keyed} (heraf ${rekeyed} nye match)`);
  console.log(`  med amount:   ${amounts}`);
  console.log(`  optional:     ${optional}`);
}

main();
