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

// ── Decimalkommaet: den fejl, en dansk fil er lettest at lave ────────────────
//
// `15,95` i stedet for `15.95` giver SYV celler i stedet for seks. Blev de
// overskydende bare kasseret, ville pack_price blive 15 og observed_at '95' —
// og `new Date('95')` er en gyldig dato (31-12-1994). Ingen fejl, ingen
// advarsel: bare en pris, der er 6 % forkert, på det mest betroede niveau
// basen har. Begge ender skal lukkes, for hver for sig er de begge blinde.

test('CSV-parseren afviser en linje med et decimalkomma i prisen', () => {
  const csv = [
    'item_key,chain_slug,pack_qty,pack_unit,pack_price,observed_at',
    'kartofler,rema1000,2,kg,15,95,2026-09-15',
  ].join('\n');

  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].error, 'skulle være afvist');
  assert.match(rows[0].error, /linje 2/);
  // Beskeden skal sige, hvad man gør ved det — ikke bare at noget er galt.
  assert.match(rows[0].error, /15\.95/);
  assert.match(rows[0].error, /decimalkomma/);
  assert.equal(rows[0].row, undefined);
});

test('CSV-parseren afviser også en linje med for FÅ celler', () => {
  const csv = [
    'item_key,chain_slug,pack_qty,pack_unit,pack_price,observed_at',
    'kartofler,rema1000,2,kg,15.95',
  ].join('\n');
  const rows = parseCsv(csv);
  assert.ok(rows[0].error);
  assert.match(rows[0].error, /linje 2/);
  assert.match(rows[0].error, /5 felter/);
});

test('importøren kræver observed_at på formen ÅÅÅÅ-MM-DD', () => {
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const at = (observed_at) => parsePriceRow({ item_key: 'kartofler', chain_slug: 'rema1000',
    pack_qty: '2', pack_unit: 'kg', pack_price: '15.95', observed_at },
    { items, chains, line: 2 });

  // Resten af et decimalkomma, hvis celletællingen skulle svigte. new Date('95')
  // er 31-12-1994 og ville aldrig blive opdaget.
  assert.match(at('95').error, /observed_at/);
  // new Date('2026') er 1. januar 2026. En dato uden dag er ikke en observation.
  assert.match(at('2026').error, /observed_at/);
  assert.match(at('15-09-2026').error, /observed_at/);
  assert.match(at('2026-9-15').error, /observed_at/);
  // Et umuligt datoformat skal stadig falde, selv når mønstret passer.
  assert.match(at('2026-02-30').error, /findes ikke/);
  // Og den rigtige form går igennem.
  assert.equal(at('2026-09-15').error, undefined);
});

test('importøren afviser en observation i fremtiden', () => {
  // valid_until regnes fra observed_at. En dato i 2099 ville give en pris, der
  // aldrig udløber, og som arbejdslisten aldrig beder om igen.
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const r = parsePriceRow({ item_key: 'kartofler', chain_slug: 'rema1000', pack_qty: '2',
    pack_unit: 'kg', pack_price: '15.95', observed_at: '2099-01-01' },
    { items, chains, line: 2 });
  assert.match(r.error, /fremtiden/);
});

test('importørens enhedsfejl giver et råd, der passer til varens enhed', () => {
  // "400 g skal skrives som 0.4 kg" er meningsløst for et æg, der tælles i stk.
  const items = new Map([
    ['aeg', { key: 'aeg', class: 'fresh', category: 'eggs', base_unit: 'stk' }],
    ['floede', { key: 'floede', class: 'fresh', category: 'dairy', base_unit: 'l' }],
  ]);
  const chains = new Map([['rema1000', '11deC']]);
  const egg = parsePriceRow({ item_key: 'aeg', chain_slug: 'rema1000', pack_qty: '10',
    pack_unit: 'kg', pack_price: '30', observed_at: '2026-09-15' }, { items, chains, line: 2 });
  assert.match(egg.error, /stk/);
  assert.doesNotMatch(egg.error, /400 g/);

  const fl = parsePriceRow({ item_key: 'floede', chain_slug: 'rema1000', pack_qty: '250',
    pack_unit: 'ml', pack_price: '9.5', observed_at: '2026-09-15' }, { items, chains, line: 3 });
  assert.match(fl.error, /0\.25 l/);
});

// ── stk-loftet: en anden størrelsesorden end kiloloftet ──────────────────────

test('stk-loftet kasserer køkkenudstyr, der står som brød', () => {
  // Målt i basen: "Bodum brødkasse" 99, "Holm brødform" 79, "Køkkenchef
  // brødrister" 79 — alle koblet på varen brod, alle pr. stk. Ægte brød i
  // samme base topper ved 35 kr/stk.
  assert.equal(engine.isPlausiblePrice('bakery', 99, 'stk'), false);
  assert.equal(engine.isPlausiblePrice('bakery', 79, 'stk'), false);
  assert.equal(engine.isPlausiblePrice('bakery', 159.95, 'stk'), false);
  assert.equal(engine.isPlausiblePrice('bakery', 35, 'stk'), true);
  // tortilla ligger målt på 60 kr/stk for en pakke. Loftet skal lige rumme den.
  assert.equal(engine.isPlausiblePrice('bakery', 60, 'stk'), true);
});

test('stk-loftet for æg er 10 kr, ikke kilobåndets loft', () => {
  // Ægte æg ligger på 2,90-3,60 kr/stk. Et æg til 32 kr er en fejlkobling.
  assert.equal(engine.isPlausiblePrice('eggs', 3.6, 'stk'), true);
  assert.equal(engine.isPlausiblePrice('eggs', 2.9, 'stk'), true);
  assert.equal(engine.isPlausiblePrice('eggs', 32, 'stk'), false);
});

test('stk-loftet rører ikke kg-varerne i samme kategori', () => {
  // Det er hele grunden til, at loftet står i sin egen tabel. 'eggs' rummer
  // aeggeblomme og aeggehvide, der sælges pr. KG — et loft på 10 kr ville
  // kassere enhver rigtig pris på dem.
  assert.equal(engine.isPlausiblePrice('eggs', 90, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('eggs', 180, 'kg'), true);
  // Og brød solgt pr. kg (rugbrød i løsvægt) måles stadig mod bakery-båndet.
  assert.equal(engine.isPlausiblePrice('bakery', 120, 'kg'), true);
});

test('grain-gulvet sidder under den billigste ægte kornpris', () => {
  // Den billigste ægte korn-observation i basen er præcis 5,00 kr/kg
  // (MADVÆRKET havregryn). Med et gulv på 5 sad grænsen oven på en rigtig
  // pris; en øre den anden vej havde kasseret den.
  assert.equal(engine.isPlausiblePrice('grain', 5, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('grain', 4.5, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('grain', 1.5, 'kg'), false);
});

test('isPlausiblePrice afviser Infinity og NaN', () => {
  // Infinity slipper igennem HVER eneste sammenligning uden at kaste og ville
  // lande i en REAL NOT NULL CHECK(x > 0) uden et ord.
  assert.equal(engine.isPlausiblePrice('veg', Infinity, 'kg'), false);
  assert.equal(engine.isPlausiblePrice('veg', Infinity, 'stk'), false);
  assert.equal(engine.isPlausiblePrice('veg', NaN, 'kg'), false);
  assert.equal(engine.isPlausiblePrice('veg', -Infinity, 'kg'), false);
});

test('drink-loftet lader kaffe og te passere', () => {
  // Målt i basen: Nescafé instant 421 kr/kg og te op til 450 er ægte
  // hyldepriser — tørvægt, ikke sodavand. Kasseres de, forsvinder to varer,
  // der findes i hver eneste butik.
  assert.equal(engine.isPlausiblePrice('drink', 450, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('drink', 421.33, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('drink', 799, 'kg'), false);
});

test('drink-loftet bliver på 600, selv om ægte te ligger over', () => {
  // Tebreve målt hos REMA når 835 kr/kg, og de er ægte. Loftet følger dem
  // alligevel ikke: en Melitta kaffemaskine til 799 ligger i samme interval,
  // og en kaffemaskine gemt som tepris er værre end en manglende tepris —
  // ingenting gør opmærksom på en forkert normalpris. Det er et bevidst valg,
  // ikke en glemt grænse, og derfor følger 'drink' ikke pantry op på 900.
  assert.equal(engine.isPlausiblePrice('drink', 835, 'kg'), false);
  assert.equal(engine.isPlausiblePrice('drink', 799, 'kg'), false);
});

test('pantry- og snack-loftet rummer nødder og krydderier', () => {
  // Målt hos REMA og alle ægte: pinjekerner 455-480 kr/kg, pistaciekerner
  // 480, stødt kardemomme 590, husblas 512. Med loftet på 400 blev
  // pinjekerner ACCEPTERET til 400 og FORKASTET til 455 — samme vare i samme
  // butik, med grænsen tværs gennem en rigtig fordeling.
  assert.equal(engine.isPlausiblePrice('pantry', 455, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('pantry', 480, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('pantry', 590, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('pantry', 512, 'kg'), true);
  assert.equal(engine.isPlausiblePrice('snack', 480, 'kg'), true);
  // Loftet er stadig et værn mod størrelsesordener: en tierfejl fanges.
  assert.equal(engine.isPlausiblePrice('pantry', 5900, 'kg'), false);
  assert.equal(engine.isPlausiblePrice('snack', 4800, 'kg'), false);
});

test('priceBandFor giver de tal, isPlausiblePrice faktisk brugte', () => {
  // Fejlbeskederne læses af den, der skal rette filen. Står kilobåndets tal på
  // en stk-række, leder man efter en fejl, der ikke findes.
  assert.deepEqual(engine.priceBandFor('bakery', 'stk'), [0, 60]);
  assert.deepEqual(engine.priceBandFor('bakery', 'kg'), [5, 200]);
  // En kategori uden et stk-loft falder tilbage på kilobåndets loft.
  assert.deepEqual(engine.priceBandFor('fruit', 'stk'), [0, 200]);
  assert.equal(engine.priceBandFor('ukendt_kategori', 'kg'), null);
});

// ── Enhedsinvarianten, som databasen selv håndhæver ──────────────────────────
//
// pack_unit SKAL være varens base_unit. Reglen stod kun i JavaScript, ét sted
// pr. skriver: bootstrap-prices.js, import-prices.js, og opgave 3's
// REMA-klient bliver den tredje. En regel, tre programmer skal huske, er ikke
// en regel. Triggerne i schema.sql gør den til en, basen ikke kan komme uden om.

const { reportOrphans } = require(path.join(__dirname, '..', 'scripts', 'import-prices.js'));

/** En tom base med ét item, én kæde og skemaet påført af den rigtige getDb(). */
function freshPriceDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `madplan-${label}-`));
  const db = openThroughGetDb(path.join(dir, 'priser.db'));
  db.prepare("INSERT INTO chains (id, name, slug) VALUES ('11deC', 'REMA 1000', 'rema1000')").run();
  db.prepare(`INSERT INTO items (key, name, category, class, keeps, base_unit)
              VALUES ('aeg', 'Æg', 'eggs', 'fresh', 'keeps', 'stk')`).run();
  db.prepare(`INSERT INTO items (key, name, category, class, keeps, base_unit)
              VALUES ('kartofler', 'Kartofler', 'veg', 'baseline', 'pantry', 'kg')`).run();
  return db;
}

const INSERT_PRICE = `
  INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit, pack_price,
                           unit_price, source, observed_at, valid_until)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

test('basen selv nægter en pack_unit, der ikke er varens base_unit', () => {
  const db = freshPriceDb('trigger');
  try {
    const ins = db.prepare(INSERT_PRICE);
    // aeg tælles i stk. 'kg' må ikke kunne skrives, uanset hvem der skriver.
    assert.throws(
      () => ins.run('aeg', '11deC', 10, 'kg', 30, 3, 'manual', '2026-09-15', '2026-12-14'),
      /base_unit/,
    );
    // Den rigtige enhed går igennem — triggeren må ikke stå i vejen for arbejdet.
    ins.run('aeg', '11deC', 10, 'stk', 30, 3, 'manual', '2026-09-15', '2026-12-14');
    ins.run('kartofler', '11deC', 2, 'kg', 15.95, 7.975, 'manual', '2026-09-15', '2027-03-14');
    assert.equal(db.prepare('SELECT count(*) c FROM item_prices').get().c, 2);

    // En UPDATE er den anden vej ind. Uden BEFORE UPDATE ville en
    // ON CONFLICT DO UPDATE kunne sætte enheden skævt bagefter.
    assert.throws(
      () => db.prepare("UPDATE item_prices SET pack_unit = 'kg' WHERE item_key = 'aeg'").run(),
      /base_unit/,
    );
    assert.equal(
      db.prepare("SELECT pack_unit FROM item_prices WHERE item_key = 'aeg'").get().pack_unit,
      'stk',
    );
  } finally {
    db.close();
  }
});

// ── En slettet CSV-linje sletter ikke prisen ─────────────────────────────────

test('importøren viser de indtastede priser, filen ikke længere nævner', () => {
  // Importøren indsætter og opdaterer kun — med vilje: en halvt gemt fil må
  // ikke kunne slette rigtige priser. Men så skal forskellen VISES, ellers
  // bliver en forkert pris stående for evigt på det mest betroede niveau.
  const db = freshPriceDb('orphan');
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(' '));
  try {
    db.prepare(INSERT_PRICE)
      .run('kartofler', '11deC', 2, 'kg', 15.95, 7.975, 'manual', '2026-09-15', '2027-03-14');
    // Et gæt er ikke en indtastet pris og skal ikke nævnes her.
    db.prepare(INSERT_PRICE)
      .run('aeg', '11deC', 10, 'stk', 30, 3, 'derived', '2026-09-15', '2026-12-14');

    // Filen nævner stadig rækken: ingen besked.
    reportOrphans(db, [{ item_key: 'kartofler', chain_id: '11deC', pack_qty: 2, pack_unit: 'kg' }]);
    assert.equal(said.length, 0, 'en række, der står i filen, er ikke forældreløs');

    // Linjen er slettet (eller kommenteret ud): rækken skal nævnes ved navn.
    reportOrphans(db, []);
    const out = said.join('\n');
    assert.match(out, /kartofler/);
    assert.match(out, /rema1000/);
    assert.doesNotMatch(out, /aeg/, "et 'derived'-gæt hører ikke til her");
  } finally {
    console.log = log;
    db.close();
  }
});

test('importøren afviser to linjer, der rammer den samme række', () => {
  // Nøglen er (vare, kæde, pakke). To linjer med samme nøgle sloges om den
  // samme række, og ON CONFLICT lod den sidste vinde uden et ord — den, der
  // skrev begge, gik derfra i troen på, at den første stod i basen.
  const { flagDuplicates } = require(path.join(__dirname, '..', 'scripts', 'import-prices.js'));
  const csv = [
    'item_key,chain_slug,pack_qty,pack_unit,pack_price,observed_at',
    'kartofler,rema1000,2,kg,15.95,2026-09-15',
    'kartofler,rema1000,2,kg,17.95,2026-09-15',
    'kartofler,rema1000,1,kg,9.95,2026-09-15',
  ].join('\n');
  const rows = parseCsv(csv);
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const parsed = flagDuplicates(
    rows.map((r) => parsePriceRow(r.row, { items, chains, line: r.line })), rows);

  assert.equal(parsed[0].error, undefined);
  // Den anden linje er dubletten, og beskeden skal pege på BEGGE linjer.
  assert.match(parsed[1].error, /linje 3/);
  assert.match(parsed[1].error, /linje 2/);
  // En anden pakkestørrelse er en anden række og altså ikke en dublet.
  assert.equal(parsed[2].error, undefined);
});

// ── REMA-klienten: pakkestørrelsen, der ikke står som et tal ─────────────────
//
// REMA er den eneste af de 14 kæder, der kan hentes automatisk, og svaret
// oplyser ikke pakkestørrelsen direkte. Den udledes af pris ÷ kilopris og
// krydstjekkes mod `underline`. Testene bruger ægte svar fra API-undersøgelsen,
// ikke opdigtede — feltnavnene er kædens, ikke vores.

const { parseRemaProduct, packFromUnderline } =
  require(path.join(__dirname, '..', 'src', 'prices', 'rema.js'));

test('REMA-svar til pris og pakkestørrelse', () => {
  // Ægte svar fra api.digital.rema1000.dk, gengivet i API-undersøgelsen.
  const p = parseRemaProduct({
    name: 'SKRÆLLE KARTOFLER',
    underline: '2 KG. / DANMARK KL. 1',
    prices: [{ price: 18, compare_unit: 'kg', compare_unit_price: 9 }],
  });
  assert.equal(p.pack_unit, 'kg');
  near(p.pack_qty, 2);
  near(p.pack_price, 18);
  near(p.unit_price, 9);
});

test('REMA: pakkestørrelse udledes også når underline ikke siger den', () => {
  const p = parseRemaProduct({
    name: 'HAKKET OKSEKØD 4-7%',
    underline: 'DANSK',
    prices: [{ price: 25.95, compare_unit: 'kg', compare_unit_price: 64.88 }],
  });
  near(p.pack_qty, 0.4);       // 25.95 / 64.88
  assert.equal(p.pack_unit, 'kg');
});

test('REMA: styk-varer får ingen vægt påduttet', () => {
  const p = parseRemaProduct({
    name: 'ØKOLOGISKE ÆG M/L 10 STK.',
    underline: '10 STK.',
    prices: [{ price: 32.95, compare_unit: 'stk', compare_unit_price: 3.295 }],
  });
  assert.equal(p.pack_unit, 'stk');
  near(p.pack_qty, 10);
});

test('REMA: et svar uden sammenligningspris kan ikke bruges', () => {
  assert.equal(parseRemaProduct({ name: 'X', prices: [{ price: 10 }] }), null);
});

// ── Kampagneprisen er ikke normalprisen ──────────────────────────────────────
//
// `prices` er ikke ét tal. Er varen på tilbud i denne uge, står kampagneprisen
// FØRST og hyldeprisen bagefter. item_prices er normalprisen, og den effektive
// pris er coalesce(aktivt tilbud, normalpris) — skrev vi kampagneprisen ind
// som normalpris, ville ugens rabat blive varens nye normale niveau, og
// forskellen forsvinde ud af regnestykket uden at nogen kunne se det.

test('REMA: tilbudsprisen står først, men det er hyldeprisen, vi skal have', () => {
  // Ægte svar: HK. OKSEKØD, 35% GRØNT stod med begge priser samme dag.
  const p = parseRemaProduct({
    name: 'HK. OKSEKØD, 35% GRØNT',
    underline: '400 GR. / REMA 1000',
    prices: [
      { price: 29, compare_unit: 'kg', compare_unit_price: 72.5,
        is_campaign: true, is_advertised: true },
      { price: 29.95, compare_unit: 'kg', compare_unit_price: 74.88 },
    ],
  });
  near(p.pack_price, 29.95);
  near(p.unit_price, 74.88);
});

test('REMA: en vare, der KUN har en kampagnepris, har ingen normalpris at give', () => {
  assert.equal(parseRemaProduct({
    name: 'ET ELLER ANDET',
    prices: [{ price: 10, compare_unit: 'kg', compare_unit_price: 25, is_campaign: true }],
  }), null);
});

test('REMA: is_advertised alene er ikke et tilbud', () => {
  // "DANSK HEL LAKSEFILET" er med i avisen til sin almindelige hyldepris.
  // Kasserede vi den, mistede vi varer, der bare er reklameret for.
  const p = parseRemaProduct({
    name: 'DANSK HEL LAKSEFILET',
    underline: '600 GR. / REMA 1000',
    prices: [{ price: 99, compare_unit: 'kg', compare_unit_price: 165, is_advertised: true }],
  });
  near(p.unit_price, 165);
  near(p.pack_qty, 0.6);
});

test('underline skrives "400 GR.", ikke "400 G."', () => {
  // REMA staver gram "GR." og liter "LTR." — og krydstjekket mod regnestykket
  // virker kun, hvis mønstret kender deres stavemåde.
  near(packFromUnderline('400 GR. / REMA 1000', 'kg'), 0.4);
  near(packFromUnderline('1 LTR. / ARLA', 'l'), 1);
  near(packFromUnderline('2 KG. / DANMARK KL. 1', 'kg'), 2);
  near(packFromUnderline('10 STK. / STR. M/L', 'stk'), 10);
  // Enheden skal passe til VARENS enhed. "1 LTR." på en kg-vare er ikke en
  // pakkestørrelse, vi kan bruge — så falder vi tilbage på regnestykket.
  assert.equal(packFromUnderline('1 LTR. / ARLA', 'kg'), null);
  assert.equal(packFromUnderline('1 BAKKE / SE VAREN', 'kg'), null);
});

// ── Produktnavne-listen: taksonomien alene er ikke nok ───────────────────────
//
// Taksonomien slår produktnavnet op og finder varens ord i det, og det er
// netop fælden: KATTEMAD, FISK & REJER slår op til rejer. Målt på en rigtig
// tørkørsel stod syv sådanne blandt de accepterede match — alle sammen den
// BILLIGSTE pris på varen, fordi et forarbejdet produkt oftest er billigere
// pr. kilo end råvaren selv. Derfor er en løs matchning ikke bare upræcis;
// den trækker systematisk den forkerte pris ind.
//
// Alle produkter herunder er ægte svar fra REMA, gemt med --save-raw.

const { derailingWord } = require(path.join(__dirname, '..', 'src', 'prices', 'rema.js'));

/** Som scriptet kalder den: varens nøgle og navn er varens egne ord. */
const derail = (product, key, name) => derailingWord(product, `${key} ${name || key}`);

test('de syv fejlmatch fra tørkørslen forkastes', () => {
  // Præcis de syv, der stod som accepterede match, før listen fandtes.
  assert.equal(derail({ name: 'KATTEMAD, FISK & REJER' }, 'rejer').label, 'dyrefoder');
  assert.equal(derail({ name: 'TRØFFELKUGLER', underline: '210 GR. / ROMKARAMEL' }, 'troffel').label, 'kugler');
  assert.equal(derail({ name: 'YMERDRYS' }, 'ymer').label, 'drys');
  assert.equal(derail({ name: 'KARTOFFEL-PORRE SUPPE' }, 'porre').label, 'suppe');
  assert.equal(derail({ name: 'TORSKEROGN' }, 'torsk').label, 'rogn');
  assert.equal(derail({ name: 'SKINKESALAT' }, 'skinke').label, 'salat');
  assert.equal(derail({ name: 'SUPPEHORN' }, 'suppe', 'Suppe').label, 'horn');
});

test('varen må gerne være den ting, ordet beskriver', () => {
  // Uden undtagelsen ville stramningen tage de eneste RIGTIGE match fra netop
  // de varer, hvis navn er ordet: en suppe er det bedste match på `suppe`.
  assert.equal(derail({ name: 'HØNSEKØDSSUPPE', underline: '1000 GR. / REMA 1000' }, 'suppe', 'Suppe'), null);
  assert.equal(derail({ name: 'ØKO. SALAT MIX', underline: '75 GR. / ITALIEN KL. 1' }, 'salat', 'Salat'), null);
  // Rognen er varen selv, og nøglen bærer ordet.
  assert.equal(derail({ name: 'SORT STENBIDERROGN' }, 'stenbiderrogn', 'Stenbiderrogn'), null);
  // Og en almindelig råvare røres ikke.
  assert.equal(derail({ name: 'SKRÆLLE KARTOFLER', underline: '2 KG. / DANMARK KL. 1' }, 'kartofler', 'Kartofler'), null);
  assert.equal(derail({ name: 'HAKKET SPINAT', underline: '750 GR. / REMA 1000' }, 'spinat', 'Spinat'), null);
  assert.equal(derail({ name: 'KYLLINGEBRYSTFILET', underline: '650 GR. / REMA 1000' }, 'kyllingebryst', 'Kyllingebryst'), null);
});

test('mærket i underline afslører kattemaden, som navnet ikke gør', () => {
  // "SELECTION LAKS" til 58,82 kr/kg var BILLIGSTE match på laks — og er
  // kattemad fra SHEBA. Ingenting i navnet siger det; kun mærket gør.
  assert.equal(derail({ name: 'SELECTION LAKS', underline: '85 GR. / SHEBA' }, 'laks').label, 'dyrefoder');
  assert.equal(derail({ name: 'POÉSIE KALKUN', underline: '85 GR. / VITAKRAFT' }, 'kalkun').label, 'dyrefoder');
  assert.equal(derail({ name: 'LAKS MED KATTEMYNTE', underline: '30 GR. / MEATY CAT' }, 'laks').label, 'dyrefoder');
  // Samme mekanisme for mejerivaren med frugtens navn: det er ARLA og CHEASY
  // i underline, der siger, at "PÆRE/BANAN" er yoghurt og ikke pærer.
  assert.equal(derail({ name: 'PÆRE/BANAN', underline: '1000 GR. / ARLA, YOGHURT LACTOFREEE' }, 'paere').label, 'mejeri');
  assert.equal(derail({ name: 'PASSION & BANAN', underline: '1000 GR. / CHEASY SKYR' }, 'banan').label, 'mejeri');
  // Men skyr må selvfølgelig gerne være skyr.
  assert.equal(derail({ name: 'SKYR NATUREL', underline: '1000 GR. / REMA 1000' }, 'skyr', 'Skyr'), null);
});

test('mayonnaisesalaten fanges, selv om varen SELV er salat', () => {
  // ITALIENSK SALAT koster 36,50 kr/kg og et hoved salat 133. Undtagelsen
  // ovenfor slipper den generelle `salat`-regel forbi for varen `salat`, så
  // pålægssalaterne skal nævnes ved navn — ellers ville varen salat få en
  // fjerdedel af sin rigtige pris.
  assert.equal(derail({ name: 'ITALIENSK SALAT', underline: '300 GR. / REMA 1000' }, 'salat', 'Salat').label, 'mayosalat');
  assert.equal(derail({ name: 'ÆGGESALAT', underline: '150 GR. / K-SALAT' }, 'salat', 'Salat').label, 'mayosalat');
  assert.equal(derail({ name: 'KARRY SALAT', underline: '200 GR. / MAYO' }, 'salat', 'Salat').label, 'mayosalat');
  // Og rosinerne, man drysser på salaten, er ikke salat.
  assert.equal(derail({ name: 'SALAT ROSINER', underline: '450 GR. / REMA 1000' }, 'salat', 'Salat').label, 'salatdrys');
  // Rosiner i sig selv er stadig tørret frugt.
  assert.equal(derail({ name: 'ROSINER', underline: '250 GR. / REMA 1000' }, 'toerret_frugt', 'Tørret frugt'), null);
});

test('lasagneplader er pasta, en lasagne er en færdigret', () => {
  // Den samme undtagelse står i taxonomy.js. Uden den ville listen kassere
  // en helt almindelig pose pasta.
  assert.equal(derail({ name: 'LASAGNEPLADER', underline: '250 GR. / PASTA DI MARIA' }, 'pasta', 'Pasta'), null);
  assert.equal(derail({ name: 'PASTA BOLOGNESE', underline: '185 GR. / LOVEMADE' }, 'pasta', 'Pasta').label, 'færdigret');
});

test('ordet skal slutte et dansk ord', () => {
  // Uden det negative lookahead ville `horn` ramme HORNFISK og `dej` "dejlig".
  assert.equal(derail({ name: 'HORNFISK' }, 'fisk', 'Fisk'), null);
  assert.equal(derail({ name: 'DEJLIG FERSKEN' }, 'fersken', 'Fersken'), null);
  // Og SUPPEHORN fanges af `horn`, ikke af `suppe`: ordet "suppe" fortsætter
  // ind i det næste ord, og så er det ikke en suppe, der er tale om.
  assert.equal(derail({ name: 'SUPPEHORN' }, 'pasta', 'Pasta').label, 'horn');
});

test('listen er kurateret — den forkaster ikke en ren råvare', () => {
  // Kontrolprøve fra tørkørslen: de match, der ER rigtige, skal blive.
  const ok = [
    [{ name: 'ÆBLER I POSE', underline: '1.5 KG. / LAND/KL.: SE VAREN' }, 'aeble', 'Æble'],
    [{ name: 'HK. OKSEKØD, 35% GRØNT', underline: '400 GR. / REMA 1000' }, 'oksekoed', 'Oksekød'],
    [{ name: 'PINJEKERNER', underline: '30 GR. / NATURENS LÆKKERIER' }, 'pinjekerner', 'Pinjekerner'],
    [{ name: 'GRÆSK FETAOST', underline: '200 GR. / THESSALIA' }, 'feta', 'Feta'],
    [{ name: 'MIN EGEN BLANDING TE', underline: '200 GR. / FREDSTED' }, 'the', 'Te'],
    [{ name: 'TORSKEFILETER', underline: '225 GR. / REMA 1000, DANSK' }, 'torsk', 'Torsk'],
  ];
  for (const [product, key, name] of ok) {
    assert.equal(derail(product, key, name), null, `${product.name} skulle ikke forkastes`);
  }
});
