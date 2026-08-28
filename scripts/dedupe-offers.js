'use strict';

/**
 * Viser og fjerner dubletter i offers.
 *
 *   node scripts/dedupe-offers.js --dry-run   # vis hvad der ville ske
 *   node scripts/dedupe-offers.js             # kør oprydningen
 *
 * Til daglig behøver ingen køre den: getDb() rydder selv op og lægger nøglen
 * på, første gang en base uden den åbnes – se src/db/dedupe.js. Scriptet er
 * til at kigge efter i sømmene med, og til at rydde op i hånden, hvis nøglen
 * på et tidspunkt skulle fjernes igen.
 *
 * Reglerne står ét sted, i src/db/dedupe.js. Den her fil er kun skallen.
 */

const { getDb } = require('../src/db');
const dedupe = require('../src/db/dedupe');

const DRY = process.argv.includes('--dry-run');

function main() {
  if (!DRY) {
    // getDb() kører migreringen selv. Så er der ikke to veje til det samme.
    const db = getDb();
    const n = db.prepare('SELECT COUNT(*) n FROM offers').get().n;
    console.log(`${n} tilbud · nøglen er på plads`);
    return;
  }

  // --dry-run: åbn uden om migreringen, så basen ikke ændres af at blive set på.
  const Database = require('better-sqlite3');
  const { DB_PATH } = require('../src/db');
  const db = new Database(DB_PATH, { readonly: true });

  if (dedupe.hasIndex(db)) {
    console.log('Nøglen findes allerede – der er ingen dubletter at fjerne.');
    return;
  }

  const before = db.prepare('SELECT COUNT(*) n FROM offers').get().n;
  const { groups, remap } = dedupe.findDuplicates(db);
  console.log(`${before} tilbud · ${groups} dubletgrupper · ${remap.length} rækker ville ryge`);

  if (remap.length) {
    const doomed = remap.map(([dup]) => dup);
    const perChain = db.prepare(`
      SELECT c.name, COUNT(*) n FROM offers o JOIN chains c ON c.id = o.chain_id
       WHERE o.id IN (SELECT value FROM json_each(?)) GROUP BY c.name ORDER BY n DESC
    `).all(JSON.stringify(doomed));
    for (const r of perChain) console.log(`  ${String(r.name).padEnd(16)} ${String(r.n).padStart(5)}`);
  }

  console.log('\n--dry-run: intet skrevet. Bemærk at tallet er FØR tekstnormalisering,');
  console.log('så den rigtige kørsel fjerner typisk flere.');
}

main();
