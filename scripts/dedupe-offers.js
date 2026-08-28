'use strict';

/**
 * Fjerner dubletter i offers – og lægger den unikke nøgle på, der forhindrer
 * dem i at komme igen.
 *
 *   node scripts/dedupe-offers.js [--dry-run]
 *
 * Baggrunden: flere kæder udgiver den samme tilbudsavis én gang pr. region.
 * ABC Lavpris lå med 16 identiske aviser, så hver eneste vare stod 16 gange i
 * "Alle tilbud". Aviserne har hver deres catalog_id, og hvert tilbud sit eget
 * offer id, så UNIQUE(external_id) fangede dem ikke.
 *
 * Den naturlige nøgle er, hvad der rent faktisk gør et tilbud til ét tilbud:
 * kæde + overskrift + beskrivelse + pris + løbetid. To rækker med den nøgle er
 * det samme tilbud, uanset hvilken avis de kom fra.
 *
 * Ved valg af den række, der skal overleve, foretrækkes:
 *   1. en rigtig SI-enhed (kg/l) frem for "stk" – kilden angiver af og til
 *      samme flaske vin som "0,75 l" i én avis og "1 stk" i en anden, og kun
 *      den første giver en brugbar kilopris
 *   2. en udregnet kilopris frem for ingen
 *   3. det laveste id, så kørslen er forudsigelig
 */

const path = require('node:path');
const { getDb } = require('../src/db');

const DRY = process.argv.includes('--dry-run');

// Nøglen skrives ét sted og bruges både til oprydningen og til indekset.
const KEY_COLS = ['chain_id', 'heading', 'description', 'price', 'run_from', 'run_till'];
const keyExpr = (t = '') => KEY_COLS
  .map((c) => (c === 'chain_id' || c === 'heading' || c === 'price'
    ? `${t}${c}`
    : `IFNULL(${t}${c}, '')`))
  .join(" || '|' || ");

/**
 * Trin 0: ret teksten, før den sammenlignes.
 *
 * Den samme beskrivelse står med linjeskift i én avis og med mellemrum i den
 * næste – layoutet er forskelligt, teksten er den samme. Uden det her slipper
 * en fjerdedel af dubletterne igennem nøglen. Ingest gør nu det samme (se
 * `flat` i src/ingest/run.js), så det her kun er en oprydning i det, der
 * allerede ligger.
 */
function normaliseText(db) {
  const rows = db.prepare('SELECT id, heading, description FROM offers').all();
  const flat = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim());

  const upd = db.prepare('UPDATE offers SET heading = ?, description = ? WHERE id = ?');
  let touched = 0;
  db.transaction(() => {
    for (const r of rows) {
      const h = flat(r.heading) || '';
      const d = r.description == null ? null : flat(r.description);
      if (h !== r.heading || d !== r.description) { upd.run(h, d, r.id); touched++; }
    }
  })();
  return touched;
}

function main() {
  const db = getDb();

  // Indekset skal væk, mens teksten rettes: to rækker kan blive ens undervejs,
  // og så ville UPDATE fejle mod en nøgle, oprydningen er ved at gøre gyldig.
  db.exec('DROP INDEX IF EXISTS idx_offers_natural');

  const touched = normaliseText(db);
  if (touched) console.log(`${touched} rækker fik renset overskrift/beskrivelse`);

  const before = db.prepare('SELECT COUNT(*) n FROM offers').get().n;

  // Vinderen pr. gruppe. ORDER BY spejler prioriteringen i doku'et ovenfor.
  const keepers = db.prepare(`
    SELECT MIN(id) AS any_id, ${keyExpr()} AS k,
           (SELECT o2.id FROM offers o2
             WHERE ${keyExpr('o2.')} = ${keyExpr('offers.')}
             ORDER BY (o2.si_symbol IS NOT NULL) DESC,
                      (o2.unit_price IS NOT NULL) DESC,
                      o2.id ASC
             LIMIT 1) AS keep_id,
           COUNT(*) AS n
      FROM offers
     GROUP BY k
    HAVING n > 1
  `).all();

  const doomed = [];
  const remap = [];              // [dubletId, beholdtId]
  for (const g of keepers) {
    const ids = db.prepare(`SELECT id FROM offers WHERE ${keyExpr()} = ?`).all(g.k).map((r) => r.id);
    for (const id of ids) {
      if (id === g.keep_id) continue;
      doomed.push(id);
      remap.push([id, g.keep_id]);
    }
  }

  console.log(`${before} tilbud · ${keepers.length} dubletgrupper · ${doomed.length} rækker skal væk`);

  const perChain = db.prepare(`
    SELECT c.name, COUNT(*) n FROM offers o JOIN chains c ON c.id = o.chain_id
     WHERE o.id IN (SELECT value FROM json_each(?)) GROUP BY c.name ORDER BY n DESC
  `).all(JSON.stringify(doomed));
  for (const r of perChain) console.log(`  ${String(r.name).padEnd(16)} ${String(r.n).padStart(5)}`);

  if (DRY) { console.log('\n--dry-run: intet skrevet.'); return; }

  const run = db.transaction(() => {
    // Notifikationerne peger på et konkret tilbud, og offer_id er ON DELETE
    // CASCADE. Uden det her ville brugerens ulæste beskeder forsvinde sammen
    // med dubletten. UNIQUE(watch_id, offer_id) kan kollidere, når to
    // notifikationer for samme overvågning pegede på hver sin dublet – den
    // overflødige ryger med i DELETE bagefter.
    const move = db.prepare('UPDATE OR IGNORE notifications SET offer_id = ? WHERE offer_id = ?');
    for (const [dup, keep] of remap) move.run(keep, dup);

    const del = db.prepare('DELETE FROM offers WHERE id = ?');
    for (const id of doomed) del.run(id);
  });
  run();

  // Nøglen lægges på til sidst: indekset kan først oprettes, når dubletterne
  // er væk. Fra nu af fejler et gentaget tilbud allerede i INSERT.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_offers_natural
        ON offers(chain_id, heading, IFNULL(description, ''), price,
                  IFNULL(run_from, ''), IFNULL(run_till, ''))
  `);

  const after = db.prepare('SELECT COUNT(*) n FROM offers').get().n;
  console.log(`\n${before} → ${after} tilbud (${before - after} dubletter fjernet)`);
  console.log('idx_offers_natural oprettet – aviser udgivet pr. region tæller nu kun én gang.');
}

main();
