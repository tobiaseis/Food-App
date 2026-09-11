'use strict';

/**
 * Peger testsuiten på en dedikeret testdatabase, FØR noget andet indlæses.
 *
 * `src/lib/taxonomy.js`s `index()` kalder `getDb()` som sit første forsøg
 * (falder kun tilbage til seed-data, hvis `items`-tabellen er tom), og
 * `src/db/index.js` kører `schema.sql` + `migrate()` ved hver åbning. Uden
 * dette rammer enhver test, der bruger taksonomien (`items.test.js`,
 * `mealplan.test.js`, `normalize.test.js`, m.fl.), den RIGTIGE `data.db` –
 * og `migrate()`s DDL-trin kan race mod `node --test`s samtidige workere.
 * Det er sådan `is_staple`/`taxonomy_key` blev droppet på produktionsdata i
 * opgave 9, før den friske sikkerhedskopi var taget (se task-9-report.md).
 *
 * Indlæst via `node -r` i `package.json`s `test`-script, så env-variablen
 * sættes af NODE SELV, inden nogen testfil (og dermed `src/db/index.js`)
 * overhovedet kræves ind. Det virker ens under cmd.exe, PowerShell og bash,
 * fordi der ikke er nogen skal-specifik `VAR=værdi kommando`-syntaks
 * involveret her.
 *
 * `test.db` forberedes (skema + seed) af `scripts/seed-test-db.js`, som
 * køres som `pretest` – SEKVENTIELT, i én proces, før `node --test` spawner
 * sine samtidige workere. Havde denne fil selv seedet basen, ville hver
 * worker gøre det samtidigt, og racen ville bare flytte sig til `test.db`.
 */
const path = require('node:path');

if (!process.env.DB_PATH) {
  process.env.DB_PATH = path.join(__dirname, '..', '..', 'test.db');
}
