'use strict';

/**
 * data/rema-prices.csv -> item_prices, som 'api:rema'.
 *
 * Det er sådan REMA's hyldepriser når frem til den natlige kørsel. Den henter
 * sin database fra en release og kontakter aldrig REMA; uden denne indlæsning
 * havde produktionen 273 fuldt prissatte opskrift-kæde-par i stedet for 7.302,
 * og version 1's skøn fandtes kun på den maskine, der havde hentet priserne.
 *
 * Filen skrives af `npm run prices:rema` og committes. Lagringen er den samme
 * som hentningens (src/prices/rema-store.js), så en række ser ens ud, uanset
 * om den kom fra REMA i dag eller fra filen i nat.
 *
 *   npm run prices:import-rema
 */

const path = require('node:path');
const { getDb } = require('../src/db');
const { readRemaCsv, storeRemaRows, overwrittenNote, REMA_CSV } = require('../src/prices/rema-store');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

function main() {
  const rows = readRemaCsv();
  if (!rows.length) {
    // Ingen fil er ikke det samme som ingen priser. Rør intet, og sig det.
    console.log(`ingen REMA-priser i ${path.relative(process.cwd(), REMA_CSV)} — basen er ikke rørt`);
    return;
  }
  const db = getDb();
  try {
    const rema = db.prepare("SELECT id FROM chains WHERE slug = 'rema1000'").get();
    if (!rema) throw new Error("kæden 'rema1000' findes ikke i chains");
    // Filen er altid en HEL runde (prices:rema skriver den kun sådan), så
    // indlæsningen rydder de gamle api:rema-rækker først.
    const { dropped, ok, unknown, overwritten } = storeRemaRows(db, rema.id, rows,
      { clean: true, validUntilFor: engine.validUntilFor });
    console.log(`REMA: ryddede ${dropped} · skrev ${ok} af ${rows.length}`
      + (ok + unknown < rows.length ? ` (${rows.length - ok - unknown} afvist: en indtastet pris står på samme pakke)` : '')
      + (unknown ? ` · ${unknown} sprunget over (ikke længere i kataloget, eller blevet essential)` : '')
      + overwrittenNote(overwritten));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('indlæsning af REMA-priser afbrudt:', err.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
