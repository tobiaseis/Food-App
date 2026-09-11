'use strict';

/**
 * Forbereder en dedikeret testdatabase, så `npm test` aldrig rører `data.db`.
 *
 * Køres som `pretest` (npm's livscyklus-hook) – FØR `node --test` starter
 * sine samtidige workere. Sætningen af `DB_PATH` sker her i node, ikke i
 * skallen, så scriptet virker ens under cmd.exe, PowerShell og bash: der er
 * ingen `VAR=værdi kommando`-syntaks, der kan fejle stille under cmd.exe.
 *
 * Sekventiel kørsel i ÉN proces er hele pointen: `getDb()` opretter/migrerer
 * `test.db` (samme skema som `data.db`), og hvis `items` er tom, sås den fra
 * `SEED` – ellers falder `src/lib/taxonomy.js`s `index()` tilbage til `SEED`
 * på BEGGE sider af testen "seed-vejen og database-vejen giver samme varer"
 * (test/items.test.js), og den består uden reelt at sammenligne noget. Sås
 * dette fra flere samtidige `node --test`-workere i stedet, ville racen fra
 * `data.db` (se task-9-report.md) bare flytte sig til `test.db`.
 *
 *   npm test        (kører automatisk via pretest)
 *   npm run seed:test-db   (kan også køres alene)
 */
const path = require('node:path');

process.env.DB_PATH = path.join(__dirname, '..', 'test.db');

const { getDb } = require('../src/db');

const db = getDb();
const itemCount = db.prepare('SELECT COUNT(*) c FROM items').get().c;

if (itemCount === 0) {
  // Samme seed-script som data.db bruger, krævet direkte i stedet for som
  // underproces: ingen skal involveret, og getDb()'s modul-singleton
  // genbruger forbindelsen, vi allerede har åbnet til test.db ovenfor.
  require('./seed-items');
} else {
  console.log(`test.db er allerede sået (${itemCount} varer) – springer over`);
}
