'use strict';

/**
 * Udfylder item_key, amount og optional på de eksisterende ingredienslinjer.
 *
 * Opslaget er ubetinget: hver linje slås op på ny mod taksonomien, uanset om
 * den allerede har en item_key fra en tidligere kørsel. Før opgave 9 slog
 * scriptet kun op, når feltet var tomt, og var derfor blindt for
 * omklassificeringer — opgave 8 ramte netop det: seks varer flyttede fra
 * essential til deres egen post, og 6.212 rækker (20 % af alle
 * ingredienslinjer) beholdt den gamle nøgle, indtil den blev nulstillet i
 * hånden. Taksonomien er facit, ikke rækken – slår vi kun op på tomme felter,
 * kan en vare aldrig flytte sig igen.
 *
 *   npm run backfill:amounts
 */

const { getDb } = require('../src/db');
const taxonomy  = require('../src/lib/taxonomy');
const { amountOfLine } = require('../src/lib/units');
// Parserens egen regel og ikke en kopi. Her stod en, der manglede
// "(valgfri)", så "100 g bacon (valgfri)" fra en dansk udgave blev gjort
// obligatorisk igen hver nat — backfill:amounts kører efter recipes:import.
// Hvad der tæller som valgfrit, og hvorfor, står ved OPTIONAL_RE i extract.js.
const { OPTIONAL_RE } = require('../src/recipes/extract');

/** Er linjen valgfri? 1/0, som kolonnen gemmer den. */
const lineOptional = (raw) => (OPTIONAL_RE.test(raw || '') ? 1 : 0);

function main() {
  const db = getDb();
  // item_key hentes med, ikke fordi opslaget skal springes over når den er
  // sat (det må den netop ikke), men som facit for rekeyed-tællingen nedenfor:
  // uden den kan vi ikke se, om den friske nøgle er en ÆNDRING.
  const rows = db.prepare(
    'SELECT id, raw, qty, unit, ingredient, item_key FROM recipe_ingredients'
  ).all();

  const upd = db.prepare(
    'UPDATE recipe_ingredients SET item_key = ?, amount = ?, optional = ? WHERE id = ?'
  );

  let keyed = 0, amounts = 0, optional = 0, rekeyed = 0;

  const run = db.transaction(() => {
    for (const r of rows) {
      // Taksonomien er facit, ikke rækken. Slår vi kun op på tomme felter,
      // kan en vare aldrig flytte sig igen — og opgave 8 viste, at de gør.
      const hit = taxonomy.lookup(r.ingredient) || taxonomy.lookup(r.raw);
      const key = hit ? hit.entry.key : null;

      const item = key ? taxonomy.get(key) : null;
      // Nøglen sendes med, selvom varen også gør det: uden den falder
      // stykvarer tilbage til 100 g, hvis seedet har misset piece_g — og et
      // løg på 100 g i stedet for 110 fejler ikke, det bliver bare forkert.
      const amount = item
        ? amountOfLine({ raw: r.raw, qty: r.qty, unit: r.unit, item_key: key }, item)
        : null;
      const opt = lineOptional(r.raw);

      if (key)    keyed++;
      // Tælles som "linjer hvis nøgle ændrede sig", ikke "linjer der fik en
      // nøgle": null → nøgle og nøgle-A → nøgle-B tæller begge med, nøgle-A →
      // nøgle-A gør ikke. Det er det tal, der viser om en omklassificering i
      // taksonomien rent faktisk slår igennem på allerede udtrukne rækker.
      if (key !== r.item_key) rekeyed++;
      if (amount != null) amounts++;
      if (opt)    optional++;

      upd.run(key, amount, opt, r.id);
    }
  });
  run();

  console.log(`linjer: ${rows.length}`);
  console.log(`  med item_key: ${keyed} (heraf ${rekeyed} med ændret nøgle)`);
  console.log(`  med amount:   ${amounts}`);
  console.log(`  optional:     ${optional}`);
}

// Kun som script: testen henter lineOptional uden at røre basen.
if (require.main === module) main();

module.exports = { lineOptional };
