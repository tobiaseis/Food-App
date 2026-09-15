'use strict';

/**
 * Tests for normalpriser og pakkeregning.
 *
 * Den centrale regel: en pris uden en pakkestørrelse kan ikke bruges. Man
 * køber ikke en halv pose kartofler, og hele planens madspilds-optimering
 * hviler på at kende pakken, ikke kun kiloprisen.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));
const boot = require(path.join(__dirname, '..', 'scripts', 'bootstrap-prices.js'));

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('validUntilFor følger varens klasse', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // fresh: 3 måneder. baseline: 6. Essentials prissættes aldrig.
  near(Date.parse(engine.validUntilFor('fresh', new Date(t0))) - t0, 90 * 86400000);
  near(Date.parse(engine.validUntilFor('baseline', new Date(t0))) - t0, 180 * 86400000);
  assert.equal(engine.validUntilFor('essential', new Date(t0)), null);
});

// ── migrate(): den vej, der aldrig kører i CI ────────────────────────────────
//
// `pretest` bygger test.db frisk fra schema.sql, hvor taxonomy_key aldrig har
// eksisteret — så omdøbningen i migrate() bliver i praksis aldrig afprøvet af
// suiten. I plan 1 var det netop en utestet migrationsvej, der slettede 26.242
// nøgler. Testen bygger derfor en base med den GAMLE form og kører den igennem.

/**
 * Åbner en base gennem den rigtige getDb() med et andet DB_PATH.
 *
 * src/db/index.js læser DB_PATH ÉN gang ved indlæsning og cacher forbindelsen,
 * så modulet skal ud af require-cachen for at pege et nyt sted hen. Både
 * variablen og cachen sættes tilbage bagefter — resten af suiten skal blive
 * ved med at ramme test.db.
 */
function openThroughGetDb(dbPath) {
  // Værnet er ikke paranoia: DB_PATH mod data.db eller en data.db.*-kopi ville
  // lade migrate() ændre produktionsdata og rullebackup'erne. Kun tmpdir.
  assert.ok(path.resolve(dbPath).startsWith(path.resolve(os.tmpdir())),
    'testbasen skal ligge i os.tmpdir()');

  const prev = process.env.DB_PATH;
  const id = require.resolve(path.join(__dirname, '..', 'src', 'db'));
  process.env.DB_PATH = dbPath;
  delete require.cache[id];
  try {
    return require(path.join(__dirname, '..', 'src', 'db')).getDb();
  } finally {
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
    delete require.cache[id];
  }
}

test('migrate() omdøber products.taxonomy_key uden at tabe nøgler', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madplan-migrate-'));
  const dbPath = path.join(dir, 'gammel.db');

  // Basen som den så ud FØR omdøbningen: kolonnen hedder taxonomy_key, og
  // idx_products_tax står på den.
  const Database = require('better-sqlite3');
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE products (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      category     TEXT,
      taxonomy_key TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_products_tax ON products(taxonomy_key);
  `);
  raw.prepare(`INSERT INTO products (slug, name, category, taxonomy_key, created_at)
               VALUES (?, ?, ?, ?, ?)`)
    .run('hakket-oksekoed', 'Hakket oksekød', 'meat', 'hakket_oksekoed', '2026-01-01T00:00:00Z');
  raw.close();

  const db = openThroughGetDb(dbPath);
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  assert.ok(cols.includes('item_key'), 'item_key skal findes efter migrering');
  assert.ok(!cols.includes('taxonomy_key'), 'taxonomy_key skal være droppet');

  const row = db.prepare("SELECT item_key FROM products WHERE slug = 'hakket-oksekoed'").get();
  assert.equal(row.item_key, 'hakket_oksekoed', 'nøglen skal være kopieret, ikke tabt');

  const idx = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_products_tax'").get();
  assert.ok(idx, 'indekset skal ligge der igen — under sit gamle navn');
  assert.match(idx.sql, /item_key/);
  db.close();

  // Anden åbning: migreringen er idempotent og må ikke røre noget.
  const db2 = openThroughGetDb(dbPath);
  const cols2 = db2.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  assert.deepEqual(cols2, cols);
  assert.equal(
    db2.prepare("SELECT item_key FROM products WHERE slug = 'hakket-oksekoed'").get().item_key,
    'hakket_oksekoed');
  db2.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── bootstrap-prices: estimatoren og filtret ─────────────────────────────────

test('leastDiscounted tager næsthøjeste, men kun når der er nok at vælge imellem', () => {
  // Med tre eller flere observationer kan den øverste være en fejllæsning og
  // kasseres. Med to ville det efterlade medianen, og så er gættet et andet.
  assert.equal(boot.leastDiscounted([1, 2, 3]), 2);
  assert.equal(boot.leastDiscounted([1, 2]), 2);
  assert.equal(boot.leastDiscounted([]), null);
});

test('outlier-filtret kasserer fejlkoblingen og lader estimatoren vælge 11', () => {
  // Fløde til 10-12 kr/l, og så "Cerave moisturising lotion" til 300.
  const rows = [10, 11, 12, 300].map((p, i) => ({
    item_key: 'floede', chain_id: '11deC', base_unit: 'l',
    year: 2026, week: 30 + i, unit_price: p, base_qty: 0.25,
  }));

  const { kept, rejected } = boot.rejectMislinks(rows);
  assert.equal(rejected.length, 1);
  near(rejected[0].unit_price, 300);
  assert.equal(kept.length, 3);

  const pick = boot.leastDiscounted(kept.map((r) => r.unit_price).sort((a, z) => a - z));
  near(pick, 11);
});

// ── CSV-importøren ───────────────────────────────────────────────────────────

const { parsePriceRow, parseCsv } = require(path.join(__dirname, '..', 'scripts', 'import-prices.js'));

test('importøren afviser en pakkeenhed, der ikke er varens egen', () => {
  // 400 g hakket oksekød skal ind som 0.4 kg. Med 'g' ville unit_price
  // blive 0,08 kr/g og alle sammenligninger med tilbud skride.
  const items = new Map([['hakket_oksekoed', { key: 'hakket_oksekoed', class: 'fresh', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const bad = parsePriceRow(
    { item_key: 'hakket_oksekoed', chain_slug: 'rema1000', pack_qty: '400',
      pack_unit: 'g', pack_price: '32', observed_at: '2026-09-15' },
    { items, chains, line: 2 },
  );
  assert.ok(bad.error, 'skulle være afvist');
  assert.match(bad.error, /pack_unit/);
  // Fejlen skal pege på linjen i filen. En prisliste rettes i en editor.
  assert.match(bad.error, /linje 2/);
});

test('importøren afviser ukendt vare og ukendt kæde', () => {
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const a = parsePriceRow({ item_key: 'findes_ikke', chain_slug: 'rema1000', pack_qty: '1',
    pack_unit: 'kg', pack_price: '10', observed_at: '2026-09-15' }, { items, chains, line: 2 });
  assert.match(a.error, /item_key/);

  // En stavefejl i kædenavnet må ikke ende som en pris i en tilfældig kæde.
  const b = parsePriceRow({ item_key: 'kartofler', chain_slug: 'rema_1000', pack_qty: '1',
    pack_unit: 'kg', pack_price: '10', observed_at: '2026-09-15' }, { items, chains, line: 3 });
  assert.match(b.error, /chain_slug/);
});

test('importøren afviser en essential', () => {
  // Salt og peber står i skabet. En pris på dem er hverken rigtig eller forkert
  // — den er bare støj i en liste, der skal vise, hvad der mangler.
  const items = new Map([['salt', { key: 'salt', class: 'essential', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const r = parsePriceRow({ item_key: 'salt', chain_slug: 'rema1000', pack_qty: '1',
    pack_unit: 'kg', pack_price: '10', observed_at: '2026-09-15' }, { items, chains, line: 2 });
  assert.match(r.error, /essential/);
});

test('importøren regner unit_price og valid_until selv', () => {
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const row = parsePriceRow(
    { item_key: 'kartofler', chain_slug: 'rema1000', pack_qty: '2',
      pack_unit: 'kg', pack_price: '15.95', observed_at: '2026-09-15' },
    { items, chains, line: 2 },
  );
  assert.equal(row.error, undefined);
  near(row.unit_price, 7.975);
  // baseline = 180 dage
  assert.equal(row.valid_until.slice(0, 10), '2027-03-14');
});

test('CSV-parseren tæller linjer som filen, ikke som rækkerne', () => {
  // Kommentarer og tomme linjer filtreres væk, før rækkerne læses. Tælles der
  // så bare 1, 2, 3, peger enhver fejlbesked på den forkerte linje — og en
  // prisliste rettes i en editor, hvor linjenummeret er det eneste, man har.
  const csv = [
    '# en kommentar',
    '',
    'item_key,chain_slug,pack_qty,pack_unit,pack_price,observed_at',
    'kartofler,rema1000,2,kg,15.95,2026-09-15',
    '# en kommentar midt i',
    'floede,netto,0.25,l,9.50,2026-09-15',
  ].join('\n');

  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].line, 4);
  assert.equal(rows[1].line, 6);
  assert.equal(rows[0].row.item_key, 'kartofler');
  assert.equal(rows[1].row.chain_slug, 'netto');
});

test('importøren afviser en række med for få kolonner', () => {
  // En række, der mangler observed_at, må ikke blive til "ikke en dato" —
  // den skal sige, hvad der mangler.
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const r = parsePriceRow({ item_key: 'kartofler', chain_slug: 'rema1000', pack_qty: '2',
    pack_unit: 'kg', pack_price: '15.95' }, { items, chains, line: 7 });
  assert.match(r.error, /observed_at/);
  assert.match(r.error, /linje 7/);
});

// ── isPlausiblePrice: det bånd, medianen ikke kan se ─────────────────────────
//
// Outlier-filtret i bootstrappen måler en vare mod dens EGEN median. Er ALLE
// varens observationer forkerte, ER medianen fejlen, og filtret er blindt.
// Båndet kommer udefra og fanger netop den slags.

test('isPlausiblePrice afviser det, der ikke kan være mad', () => {
  // appelsins eneste stk-"tilbud" er "Orange ilddæmon", 1999,20 kr — legetøj.
  assert.equal(engine.isPlausiblePrice('fruit', 14280, 'kg'), false);
  // 250 kr/kg selleri findes ikke i nogen butik.
  assert.equal(engine.isPlausiblePrice('veg', 250, 'kg'), false);
  // Og den klassiske tastefejl: 1500 skrevet i stedet for 15,00.
  assert.equal(engine.isPlausiblePrice('veg', 1500, 'kg'), false);
});

test('isPlausiblePrice lader en dyr, men ægte vare passere', () => {
  // Oksemørbrad omkring 400 kr/kg. Båndet skal fange en fejlkobling, ikke
  // en dyr udskæring.
  assert.equal(engine.isPlausiblePrice('meat', 400, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('cheese', 320, 'kg'), true);
});

test('isPlausiblePrice fanger IKKE en 2-3x fejl — og det er med vilje', () => {
  // porre står målt til 80 kr/kg mod 25-40 i virkeligheden. 80 ligger inden
  // for veg-båndet [2, 150], og det SKAL det: asparges og friske krydderurter
  // koster virkelig det. Et bånd, der fangede porre, ville kassere dem.
  // Båndet er et værn mod størrelsesordener, ikke en priskontrol.
  assert.equal(engine.isPlausiblePrice('veg', 80, 'kg'), true);
});

test('isPlausiblePrice svarer null, når kategorien er ukendt', () => {
  // "Ved det ikke" og "nej" er to forskellige svar. En kalder, der ikke kan
  // skelne dem, ville kassere hver eneste vare i en ny kategori.
  assert.equal(engine.isPlausiblePrice('ukendt_kategori', 42, 'kg'), null);
  assert.equal(engine.isPlausiblePrice(undefined, 42, 'kg'), null);
  // Kendt kategori, men et tal der ikke er en pris: det er et nej.
  assert.equal(engine.isPlausiblePrice('veg', 0, 'kg'), false);
});

test('isPlausiblePrice har kun et loft for stk', () => {
  // 'stk' siger intet om mængden — ét æble og én kasse æbler er begge "1 stk",
  // så en undergrænse ville kassere den billige af dem.
  assert.equal(engine.isPlausiblePrice('fruit', 1, 'stk'), true);
  assert.equal(engine.isPlausiblePrice('fruit', 1, 'kg'), false);
  assert.equal(engine.isPlausiblePrice('fruit', 1999.2, 'stk'), false);
});

test('importøren afviser en pris uden for båndet', () => {
  const items = new Map([['appelsin',
    { key: 'appelsin', class: 'fresh', category: 'fruit', base_unit: 'kg' }]]);
  const chains = new Map([['bilka', '93f13']]);
  const r = parsePriceRow({ item_key: 'appelsin', chain_slug: 'bilka', pack_qty: '0.14',
    pack_unit: 'kg', pack_price: '1999.20', observed_at: '2026-09-15' },
    { items, chains, line: 2 });
  assert.ok(r.error, 'skulle være afvist');
  assert.match(r.error, /linje 2/);
  assert.match(r.error, /usandsynlig/);
});

test('importøren slipper en vare uden kategori igennem', () => {
  // isPlausiblePrice svarer null for en ukendt kategori, og null er ikke et
  // nej. En vare, vi ikke har et bånd for, skal stadig kunne prissættes.
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const r = parsePriceRow({ item_key: 'kartofler', chain_slug: 'rema1000', pack_qty: '2',
    pack_unit: 'kg', pack_price: '15.95', observed_at: '2026-09-15' }, { items, chains, line: 2 });
  assert.equal(r.error, undefined);
});

// ── Arbejdslisten: rækkefølgen ER pointen ────────────────────────────────────

const worklist = require(path.join(__dirname, '..', 'scripts', 'price-worklist.js'));

test('arbejdslisten sorterer efter hvor lidt vi ved', () => {
  // 349 af de 548 afledte rækker hviler på ÉN observation. Et gæt bygget på ét
  // tilfældigt tilbud er næsten intet værd; et bygget på fem er et rimeligt
  // gæt. Står de i samme bunke, bruger et menneske sin tid det forkerte sted.
  const rank = (r) => worklist.bucketOf(r).rank;
  assert.ok(rank({ source: null }) < rank({ source: 'derived', n_obs: 1 }));
  assert.ok(rank({ source: 'derived', n_obs: 1 }) < rank({ source: 'derived', n_obs: 5 }));
  assert.ok(rank({ source: 'derived', n_obs: 5 }) < rank({ source: 'manual', n_obs: 0 }));

  const rows = [
    { key: 'c', source: 'manual',  n_obs: 0, valid_until: '2026-01-01' },
    { key: 'b', source: 'derived', n_obs: 5, valid_until: '2027-01-01' },
    { key: 'a', source: 'derived', n_obs: 1, valid_until: '2027-01-01' },
    { key: 'm', source: null,      n_obs: 0, valid_until: null },
  ];
  assert.deepEqual(worklist.sortByUncertainty(rows).map((r) => r.key), ['m', 'a', 'b', 'c']);
});

test('arbejdslisten stiller den ældste udløbne manual forrest i sin egen bunke', () => {
  // Inden for samme bunke er den ældste dato den, der har stået længst uset.
  const rows = [
    { key: 'ny',     source: 'manual', n_obs: 0, valid_until: '2026-06-01' },
    { key: 'gammel', source: 'manual', n_obs: 0, valid_until: '2025-01-01' },
  ];
  assert.deepEqual(worklist.sortByUncertainty(rows).map((r) => r.key), ['gammel', 'ny']);
});
