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

/**
 * Når klarteksten vinder, skal kiloprisen regnes om.
 *
 * Tolerancen tillader 5 % afstand mellem den oplyste pakkestørrelse og den
 * udledte, og vælger vi klarteksten, har vi netop sagt, at REMA's egen
 * compare_unit_price er regnet på en anden pakke end den, vi skriver ned.
 * Beholdt vi den, ville unit_price og pack_price/pack_qty være to forskellige
 * tal på den samme række — og recipe_costs regner i begge.
 */
test('REMA: klartekstens pakke bestemmer også kiloprisen', () => {
  const p = parseRemaProduct({
    name: 'NOGET KØD',
    underline: '500 GR. / REMA 1000',
    // 25 / 52 = 0,4808 kg — 3,8 % fra de 500 g, altså inden for tolerancen.
    prices: [{ price: 25, compare_unit: 'kg', compare_unit_price: 52 }],
  });
  near(p.pack_qty, 0.5);
  // 25 kr for 500 g er 50 kr/kg, ikke 52.
  near(p.unit_price, 50);
  near(p.unit_price, p.pack_price / p.pack_qty);
});

test('REMA: er klarteksten for langt væk, gælder regnestykket — og kædens kilopris', () => {
  const p = parseRemaProduct({
    name: 'NOGET ANDET KØD',
    // 1 kg oplyst, men 25/52 = 0,48 kg: 52 % ved siden af, så klarteksten
    // er en anden pakke end den, prisen gælder.
    underline: '1 KG. / REMA 1000',
    prices: [{ price: 25, compare_unit: 'kg', compare_unit_price: 52 }],
  });
  near(p.pack_qty, 0.481);
  near(p.unit_price, 52);
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
  // 29,95 for 400 g er 74,875 kr/kg. REMA selv siger 74,88 — deres eget tal
  // er afrundet, og rækken skal bære det, pakken faktisk koster pr. kilo.
  near(p.unit_price, 74.875);
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

// ── Den anden liste: prisen er ikke pr. kilo af varen ────────────────────────
//
// To forskellige slags fejl, to lister. Den første svarer på "er det den
// vare?" — TORSKEROGN er ikke torsk. Den anden svarer på "er tallet varens
// kilopris?": produktet ER varen, men vægten, prisen er regnet på, er også
// noget andet. Det er samme invariant, som fik opgave 1 til at droppe
// stk→kg-omregningen: unit_price skal betyde kroner pr. kilo AF VAREN, ellers
// kan rækken ikke sammenlignes med de andre kæders rækker.

const { wrongPriceBasis } = require(path.join(__dirname, '..', 'src', 'prices', 'rema.js'));

const basis = (product, key, name) => wrongPriceBasis(product, `${key} ${name || key}`);

test('en pose blandede grøntsager er ikke varens kilopris', () => {
  // 18,50 kr/kg for BLOMKÅLSBLANDING — men vægten er også broccoli og gulerod.
  assert.equal(basis({ name: 'BLOMKÅLSBLANDING', underline: '700 GR. / REMA 1000' }, 'blomkaal', 'Blomkål').label, 'blanding');
  assert.equal(basis({ name: 'BROCCOLIBLANDING', underline: '600 GR. / REMA 1000' }, 'broccoli', 'Broccoli').label, 'blanding');
  // Men en blanding, der KUN er varen, er varen. Derfor kræver mønstret et
  // bogstav foran: "-blanding" som sammensat ord, ikke "blanding" som ord.
  assert.equal(basis({ name: 'MIN EGEN BLANDING TE', underline: '200 GR. / FREDSTED' }, 'the', 'Te'), null);
});

test('olien i glasset vejer med', () => {
  assert.equal(basis({ name: 'LAKS I OLIVENOLIE', underline: '110 GR. / MUNKEBO' }, 'laks', 'Laks').label, 'i olie');
  assert.equal(basis({ name: 'HVIDLØG KRYDDEROLIE', underline: '290 GR. / REMA 1000' }, 'hvidloeg', 'Hvidløg').label, 'i olie');
  // Samme 290 g glas, andet navn. Uden den ville afvisningen af det første
  // bare rykke matchet én linje ned til det andet.
  assert.equal(basis({ name: 'HVIDLØG I CHILI', underline: '290 GR. / REMA 1000' }, 'hvidloeg', 'Hvidløg').label, 'i olie');
  // Er varen selv en olie, er hele vægten varen.
  assert.equal(basis({ name: 'KOKOSOLIE', underline: '250 ML. / INSPIRING FOOD' }, 'kokosolie', 'Kokosolie'), null);
});

test('lage og vand står IKKE på listen — og det er et valg', () => {
  // Lagen vejer også med, men dåsen er den normale form for tun, muslinger,
  // oliven, kapers, cornichoner, bønner og asparges. De andre kæders rækker
  // på de varer er den samme slags dåse, så sammenligneligheden — som er hele
  // formålet — er i behold. Kasserede vi dem, mistede ti varer deres eneste
  // pris for at vinde en nøjagtighed, ingen kan bruge til noget.
  assert.equal(basis({ name: 'TUN I VAND', underline: '140 GR. / REMA 1000' }, 'tun', 'Tun'), null);
  assert.equal(basis({ name: 'MUSLINGER I LAGE', underline: '115 GR. / BORNHOLMS' }, 'muslinger', 'Muslinger'), null);
  assert.equal(basis({ name: 'GRØNNE OLIVEN', underline: '200 GR. / REMA 1000' }, 'oliven', 'Oliven'), null);
});

test('kød strakt med grøntsager er ikke kød pr. kilo', () => {
  assert.equal(basis({ name: 'HK. OKSEKØD, 35% GRØNT', underline: '400 GR. / REMA 1000' }, 'oksekoed', 'Oksekød').label, 'strækket');
  // Men "grønne" og "grøntsager" er ikke det samme ord: mønstret må ikke
  // ramme DEN GRØNNE SLAGTER eller en underline med "fyldt med grøntsager".
  assert.equal(basis({ name: 'HK. OKSEKØD 8-12%', underline: '400 GR. / REMA 1000' }, 'oksekoed', 'Oksekød'), null);
  assert.equal(basis({ name: 'KYLLINGEBRYST M/CHILI', underline: '100 GR. / DEN GRØNNE SLAGTER' }, 'kyllingebryst', 'Kyllingebryst'), null);
});

test('en madspildskasse er en ryddepris, ikke en normalpris', () => {
  // Begge var BILLIGSTE match på deres vare. PÆRER I BK. MADSPILD gav 18
  // kr/kg mod 20 for almindelige pærer, MINI GULERØDDER 10 mod 12.
  assert.equal(basis({ name: 'PÆRER I BK. MADSPILD', underline: '1 KG. / HOLLAND KL.2' }, 'paere', 'Pære').label, 'madspild');
  assert.equal(basis({ name: 'MINI GULERØDDER', underline: '500 GR. / DANMARK KL. 2 STOP MADSPILD' }, 'gulerod', 'Gulerod').label, 'madspild');
  assert.equal(basis({ name: 'GULERØDDER', underline: '1 KG. / DANMARK KL. 1' }, 'gulerod', 'Gulerod'), null);
});

test('de to lister blander sig ikke i hinandens arbejde', () => {
  // En forkert VARE er ikke et forkert vægtgrundlag, og omvendt. Står de to
  // slags i samme liste, kan man ikke se, hvilken slags fejl der vokser.
  assert.equal(derail({ name: 'BLOMKÅLSBLANDING', underline: '700 GR. / REMA 1000' }, 'blomkaal', 'Blomkål'), null);
  assert.equal(basis({ name: 'SKINKESALAT', underline: '250 GR. / REMA 1000' }, 'skinke', 'Skinke'), null);
});

// ── Den effektive pris ───────────────────────────────────────────────────────
//
// Tilbudsprisen skrives ALDRIG ned i item_prices. De to lever i hver sin
// tabel, og valget mellem dem træffes her, ved opslaget: så falder prisen
// tilbage af sig selv, når tilbuddet udløber, og historikken er intakt.

const OFFERS = new Map([['kartofler|11deC', {
  item_key: 'kartofler', chain_id: '11deC', base_qty: 2, base_unit: 'kg',
  price: 12, unit_price: 6,
}]]);
const NORMALS = new Map([['kartofler|11deC', [
  { item_key: 'kartofler', chain_id: '11deC', pack_qty: 2, pack_unit: 'kg',
    pack_price: 15.95, unit_price: 7.975, source: 'manual' },
]]]);

test('tilbud slår normalpris, når det er billigere', () => {
  const p = engine.effectivePrice('kartofler', '11deC', { offers: OFFERS, normals: NORMALS });
  near(p.unit_price, 6);
  assert.equal(p.on_offer, true);
  assert.equal(p.source, 'offer');
  near(p.pack_qty, 2);
  assert.equal(p.pack_unit, 'kg');
  near(p.pack_price, 12);
});

test('normalprisen gælder, når der ikke er tilbud', () => {
  const p = engine.effectivePrice('kartofler', '11deC', { offers: new Map(), normals: NORMALS });
  near(p.unit_price, 7.975);
  assert.equal(p.on_offer, false);
  assert.equal(p.source, 'manual');
});

test('et dyrere "tilbud" overskriver ikke normalprisen', () => {
  // Den klassiske avis-fælde: tilbudspris = normalpris. Vi tager den billigste.
  const dyrt = new Map([['kartofler|11deC', { base_qty: 2, base_unit: 'kg', price: 20, unit_price: 10 }]]);
  const p = engine.effectivePrice('kartofler', '11deC', { offers: dyrt, normals: NORMALS });
  near(p.unit_price, 7.975);
  assert.equal(p.on_offer, false);
});

test('ingen pris i kæden giver null, ikke nul', () => {
  assert.equal(engine.effectivePrice('kartofler', 'ukendt', { offers: new Map(), normals: new Map() }), null);
});

test('en hyldepris slår et gæt, også når gættet er billigere', () => {
  // Målt i data.db: boef hos REMA har begge dele. Gættet er bygget af
  // TILBUDSpriser og er derfor systematisk for lavt — det er ikke en
  // normalpris, bare det laveste varen har været nede på.
  const normals = new Map([['boef|11deC', [
    { pack_qty: 0.5,  pack_unit: 'kg', pack_price: 99.95, unit_price: 199.9,  source: 'derived' },
    { pack_qty: 0.36, pack_unit: 'kg', pack_price: 79,    unit_price: 219.44, source: 'api:rema' },
  ]]]);
  const p = engine.effectivePrice('boef', '11deC', { offers: new Map(), normals });
  near(p.unit_price, 219.44);
  assert.equal(p.source, 'api:rema');
});

test('en indtastet pris slår både API og gæt', () => {
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 8,     unit_price: 8,     source: 'derived' },
    { pack_qty: 2, pack_unit: 'kg', pack_price: 15.95, unit_price: 7.975, source: 'manual' },
  ]]]);
  assert.equal(engine.effectivePrice('kartofler', '11deC',
    { offers: new Map(), normals }).source, 'manual');
});

test('et tilbud konkurrerer på pris alene — også mod en hyldepris', () => {
  // Rangordenen gælder MELLEM normalpriser. Et tilbud er ikke et gæt på, hvad
  // varen koster; det er en pris, man faktisk kan betale i denne uge, og
  // derfor vinder det, så snart det er billigere end det bedste alternativ.
  const normals = new Map([['boef|11deC', [
    { pack_qty: 0.36, pack_unit: 'kg', pack_price: 79, unit_price: 219.44, source: 'api:rema' },
  ]]]);
  const offers = new Map([['boef|11deC', { base_qty: 0.4, base_unit: 'kg', price: 40, unit_price: 100 }]]);
  const p = engine.effectivePrice('boef', '11deC', { offers, normals });
  near(p.unit_price, 100);
  assert.equal(p.on_offer, true);
});

test('inden for samme kilde vinder den billigste pakke', () => {
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 12,    unit_price: 12,    source: 'manual' },
    { pack_qty: 2, pack_unit: 'kg', pack_price: 15.95, unit_price: 7.975, source: 'manual' },
  ]]]);
  const p = engine.effectivePrice('kartofler', '11deC', { offers: new Map(), normals });
  near(p.unit_price, 7.975);
  near(p.pack_qty, 2);
});

/**
 * Billigst pr. enhed er ikke billigst for behovet.
 *
 * effectivePrice vælger den række, der er billigst PR. KG, og indtil denne
 * runde var det den eneste, der kom ud: kalderne skrev `choosePack(n,
 * [price])`, og så kunne choosePack pr. konstruktion ikke vælge noget. Med to
 * pakkestørrelser på samme niveau er forskellen målbar — 1 kg til 8 kr mod en
 * 5 kg-pose til 25 med 4 kg til overs. Testen fejler mod den gamle kode.
 *
 * Ingen af de 620 (vare, kæde)-par i basen har to pakker på deres bedste
 * niveau i dag, så fejlen kunne ikke ses på data — men data/item_prices.csv
 * tager imod den anden pakkestørrelse uden en advarsel.
 */
test('effectivePrice bærer hele det vindende niveau med ud som packs', () => {
  const normals = new Map([['kartofler|TST', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 8,  unit_price: 8, source: 'manual' },
    { pack_qty: 5, pack_unit: 'kg', pack_price: 25, unit_price: 5, source: 'manual' },
  ]]]);
  const p = engine.effectivePrice('kartofler', 'TST',
    { offers: new Map(), normals, baseUnit: 'kg' });

  // Vinderen er stadig den billigste pr. kilo — rangordenen er uændret.
  near(p.unit_price, 5);
  near(p.pack_qty, 5);

  // Men begge pakker er med, så choosePack har noget at vælge imellem.
  assert.equal(p.packs.length, 2);
  assert.deepEqual(p.packs.map((x) => x.pack_qty).sort((a, b) => a - b), [1, 5]);

  // Og valget falder ud som det skal: 1 kg købes som 1 kg til 8 kr.
  const pack = engine.choosePack(1, p.packs, { keeps: 'keeps' });
  near(pack.pack_qty, 1);
  near(pack.cost, 8);
  near(pack.leftover, 0);

  // Sådan så det ud før: den gamle kaldeform køber 5 kg-posen til 25 kr og
  // kalder de 4 kg til overs for spild.
  const gammel = engine.choosePack(1, [p], { keeps: 'keeps' });
  near(gammel.cost, 25);
  near(gammel.leftover, 4);

  // Og storposen vinder stadig, når behovet er stort nok til den.
  near(engine.choosePack(5, p.packs, { keeps: 'keeps' }).cost, 25);
});

test('packs rummer kun vinderens eget niveau — ikke gæt, udløb eller anden enhed', () => {
  const now = new Date('2026-09-16T00:00:00Z');
  const normals = new Map([['kartofler|TST', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 8,  unit_price: 8, source: 'manual',
      valid_until: '2027-01-01T00:00:00.000Z' },
    { pack_qty: 5, pack_unit: 'kg', pack_price: 25, unit_price: 5, source: 'manual',
      valid_until: '2027-01-01T00:00:00.000Z' },
    // Et gæt er ikke en pakke, nogen har set på en hylde.
    { pack_qty: 10, pack_unit: 'kg', pack_price: 30, unit_price: 3, source: 'derived',
      valid_until: '2027-01-01T00:00:00.000Z' },
    // En udløben pris er ikke en pakke, man kan købe i dag.
    { pack_qty: 3, pack_unit: 'kg', pack_price: 9, unit_price: 3, source: 'manual',
      valid_until: '2026-01-01T00:00:00.000Z' },
    // Og kg-pakker og stk-pakker kan ikke sammenlignes. Rækken er dyrere end
    // vinderen, så den taber allerede på pris — men den har samme kilde og
    // samme friskhed, og uden enhedsfiltret ville den stå i packs og kunne
    // vinde pakkevalget for et behov målt i kilo. `baseUnit` er med vilje
    // ikke sendt med her: det er netop dét tilfælde, filtret findes for.
    { pack_qty: 12, pack_unit: 'stk', pack_price: 72, unit_price: 6, source: 'manual',
      valid_until: '2027-01-01T00:00:00.000Z' },
  ]]]);
  const p = engine.effectivePrice('kartofler', 'TST', { offers: new Map(), normals, now });
  assert.deepEqual(p.packs.map((x) => x.pack_qty).sort((a, b) => a - b), [1, 5]);
  for (const x of p.packs) assert.equal(x.pack_unit, 'kg');
});

test('et tilbud er én pakke — men bærer feltet, så kalderne kan være ens', () => {
  const p = engine.effectivePrice('kartofler', '11deC', { offers: OFFERS, normals: NORMALS });
  assert.equal(p.source, 'offer');
  assert.equal(p.packs.length, 1);
  near(p.packs[0].pack_qty, 2);
  near(p.packs[0].pack_price, 12);
  // Kopi og ikke rækken selv: prisen skal kunne sendes gennem JSON.
  assert.ok(JSON.stringify(p).length > 0);
});

test('en gyldig pris slår en udløben — men kun på samme niveau', () => {
  // Rækkefølgen er kilde, så friskhed, så pris. En udløben hyldepris er
  // stadig en hyldepris: den skal slå et gæt, der blev skrevet i går.
  const now = new Date('2026-09-16T00:00:00Z');
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 9,  unit_price: 9,  source: 'api:rema',
      valid_until: '2026-01-01T00:00:00.000Z' },                       // udløbet
    { pack_qty: 1, pack_unit: 'kg', pack_price: 11, unit_price: 11, source: 'api:rema',
      valid_until: '2027-01-01T00:00:00.000Z' },                       // gyldig
    { pack_qty: 1, pack_unit: 'kg', pack_price: 5,  unit_price: 5,  source: 'derived',
      valid_until: '2027-01-01T00:00:00.000Z' },                       // gyldigt gæt
  ]]]);
  const p = engine.effectivePrice('kartofler', '11deC', { offers: new Map(), normals, now });
  near(p.unit_price, 11);
  assert.equal(p.stale, false);

  // Findes KUN den udløbne på det gode niveau, vinder den stadig over gættet.
  const kun = new Map([['kartofler|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 9, unit_price: 9, source: 'api:rema',
      valid_until: '2026-01-01T00:00:00.000Z' },
    { pack_qty: 1, pack_unit: 'kg', pack_price: 5, unit_price: 5, source: 'derived',
      valid_until: '2027-01-01T00:00:00.000Z' },
  ]]]);
  const q = engine.effectivePrice('kartofler', '11deC', { offers: new Map(), normals: kun, now });
  near(q.unit_price, 9);
  assert.equal(q.source, 'api:rema');
  assert.equal(q.stale, true);
});

test('et tilbud uden brugbar pakke er ikke en pris', () => {
  // base_qty er den pakke, tilbuddet gælder. Uden den kan hverken
  // pakkeafrundingen eller kurveprisen i opgave 5 regne på rækken, og et nul
  // ville se ud som en gratis vare frem for som en manglende oplysning.
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 2, pack_unit: 'kg', pack_price: 15.95, unit_price: 7.975, source: 'manual' },
  ]]]);
  const uden = new Map([['kartofler|11deC', { base_qty: null, base_unit: 'kg', price: 4, unit_price: 2 }]]);
  const p = engine.effectivePrice('kartofler', '11deC', { offers: uden, normals });
  assert.equal(p.on_offer, false);
  near(p.unit_price, 7.975);
});

test('effectivePrice er ren — samme kort ind, samme svar ud', () => {
  // Reglen skal kunne køre i browseren, og den må ikke have en skjult vej til
  // basen. `now` er en parameter med en standardværdi, ikke et opslag i uret
  // midt i en sammenligning.
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 2, pack_unit: 'kg', pack_price: 15.95, unit_price: 7.975, source: 'manual' },
  ]]]);
  const a = engine.effectivePrice('kartofler', '11deC', { offers: OFFERS, normals });
  const b = engine.effectivePrice('kartofler', '11deC', { offers: OFFERS, normals });
  assert.deepEqual(a, b);
  assert.ok(engine.effectivePrice('kartofler', '11deC', { offers: new Map(), normals }));
});

test('ukendt kilde taber til alle de kendte', () => {
  // En fremtidig source — 'api:salling' den dag Salling åbner — må ikke
  // umærkeligt komme forrest i rangordenen, bare fordi den ikke står i
  // tabellen. Den er ukendt, og ukendt hører bagest.
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 4, unit_price: 4, source: 'api:ukendt' },
    { pack_qty: 1, pack_unit: 'kg', pack_price: 9, unit_price: 9, source: 'derived' },
  ]]]);
  assert.equal(engine.effectivePrice('kartofler', '11deC',
    { offers: new Map(), normals }).source, 'derived');
});

test('kr/stk sammenlignes ikke med kr/kg — tilbuddet forkastes', () => {
  // Tilbuddets `base_unit` er AVISENS enhed, ikke varens: de to er forskellige
  // i 973 af 2.376 tilbudsrækker i data.db, og 130 vare|kæde-par har et tilbud
  // i en anden enhed end deres normalpris.
  //
  // Målt på blomkaal|11deC: avisen sælger ÉT blomkål til 12 kr, item_prices
  // har en INDTASTET pris på 18 kr/KG. 12 < 18, så uden enhedsvagten vandt
  // tilbuddet — og den højeste tillidskilde i hele rangordenen blev kastet
  // væk for et tal, der ikke måler det samme. item_prices holder invarianten
  // med en TRIGGER (src/db/schema.sql); her er der ingen base at spørge.
  const normals = new Map([['blomkaal|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 18, unit_price: 18, source: 'manual' },
  ]]]);
  const offers = new Map([['blomkaal|11deC',
    { base_qty: 1, base_unit: 'stk', price: 12, unit_price: 12 }]]);
  const p = engine.effectivePrice('blomkaal', '11deC', { offers, normals });
  near(p.unit_price, 18);
  assert.equal(p.pack_unit, 'kg');
  assert.equal(p.source, 'manual');
  assert.equal(p.on_offer, false);
});

test('enhedsvagten går også den anden vej — kg-tilbud mod stk-normalpris', () => {
  // brod|0b1e8 i data.db: tilbuddet er 26,67 kr/KG (0,75 kg til 20 kr),
  // normalprisen 29 kr/STK. Vagten må ikke kun være skrevet for stk-tilbud —
  // så ville halvdelen af de 130 par stadig sammenligne æbler med pærer.
  const normals = new Map([['brod|0b1e8', [
    { pack_qty: 1, pack_unit: 'stk', pack_price: 29, unit_price: 29, source: 'derived' },
  ]]]);
  const offers = new Map([['brod|0b1e8',
    { base_qty: 0.75, base_unit: 'kg', price: 20, unit_price: 26.67 }]]);
  const p = engine.effectivePrice('brod', '0b1e8', { offers, normals });
  near(p.unit_price, 29);
  assert.equal(p.pack_unit, 'stk');
  assert.equal(p.on_offer, false);
});

test('samme enhed: det billigere tilbud vinder stadig', () => {
  // Kontrolprøven. Uden den kunne enhedsvagten bestå de to ovenstående ved
  // simpelthen at forkaste ethvert tilbud.
  const normals = new Map([['brod|0b1e8', [
    { pack_qty: 1, pack_unit: 'stk', pack_price: 29, unit_price: 29, source: 'derived' },
  ]]]);
  const offers = new Map([['brod|0b1e8',
    { base_qty: 1, base_unit: 'stk', price: 20, unit_price: 20 }]]);
  const p = engine.effectivePrice('brod', '0b1e8', { offers, normals });
  near(p.unit_price, 20);
  assert.equal(p.on_offer, true);
  assert.equal(p.source, 'offer');
});

// ── baseUnit-vagten ──────────────────────────────────────────────────────────
//
// Sammenligningen ovenfor kasserer kun en forkert enhed, når der ER to
// kandidater. Er der kun én, slap den igennem i avisens enhed — og 257
// (vare, kæde)-par i data.db er præcis den sag: et tilbud i en anden enhed
// end varens og ingen normalpris at måle det mod. Opskriftsprisen i opgave 6
// ganger `behov × unit_price`, og et behov i stk ganget med en kilopris er
// ikke en pris, det er et tal.

test('uden normalpris forkastes et tilbud i den forkerte enhed', () => {
  // brod|71c90, levende i data.db: avisen sælger brød til 9,90 kr/KG, varen
  // måles i STK. Uden vagten blev 9,90 læst som kr/stk, og et brød kostede
  // en tredjedel af, hvad det gør. Svaret skal være null — vi kender ikke
  // prisen i den kæde — ikke et tal, der ser rigtigt ud.
  const offers = new Map([['brod|71c90',
    { base_qty: 0.75, base_unit: 'kg', price: 7.43, unit_price: 9.9 }]]);
  assert.equal(
    engine.effectivePrice('brod', '71c90', { offers, normals: new Map(), baseUnit: 'stk' }),
    null,
  );
  // Og kontrolprøven: uden `baseUnit` kan funktionen ikke vide det, og den
  // gamle adfærd står uændret. Vagten er et tilvalg, ikke en ny standard.
  assert.ok(engine.effectivePrice('brod', '71c90', { offers, normals: new Map() }));
});

test('uden tilbud forkastes en normalpris i den forkerte enhed', () => {
  // Den anden gren. `item_prices` har en TRIGGER mod netop det her, så basen
  // kan ikke levere rækken i dag — men browseren bygger sit kort af JSON, og
  // vagten må ikke kun være skrevet for tilbudssiden.
  const normals = new Map([['aeg|11deC', [
    { pack_qty: 0.6, pack_unit: 'kg', pack_price: 30, unit_price: 50, source: 'manual' },
  ]]]);
  assert.equal(
    engine.effectivePrice('aeg', '11deC', { offers: new Map(), normals, baseUnit: 'stk' }),
    null,
  );
});

test('baseUnit kasserer kun den forkerte kandidat, ikke hele opslaget', () => {
  // Det ville være for nemt at bestå de to ovenstående ved at svare null,
  // så snart noget er i den forkerte enhed. Her er tilbuddet forkert og
  // normalprisen rigtig: svaret er normalprisen.
  const normals = new Map([['aeg|11deC', [
    { pack_qty: 10, pack_unit: 'stk', pack_price: 32.95, unit_price: 3.295, source: 'api:rema' },
  ]]]);
  const offers = new Map([['aeg|11deC',
    { base_qty: 0.6, base_unit: 'kg', price: 20, unit_price: 33.33 }]]);
  const p = engine.effectivePrice('aeg', '11deC', { offers, normals, baseUnit: 'stk' });
  near(p.unit_price, 3.295);
  assert.equal(p.pack_unit, 'stk');
  assert.equal(p.on_offer, false);

  // Og med den rigtige enhed på begge sider vinder tilbuddet stadig.
  const rigtigt = new Map([['aeg|11deC',
    { base_qty: 10, base_unit: 'stk', price: 25, unit_price: 2.5 }]]);
  const q = engine.effectivePrice('aeg', '11deC',
    { offers: rigtigt, normals, baseUnit: 'stk' });
  near(q.unit_price, 2.5);
  assert.equal(q.on_offer, true);
});

test('en source, der findes på Object.prototype, er stadig ukendt', () => {
  // `SOURCE_RANK['constructor']` gav en Function gennem prototypekæden, og
  // `?? UKENDT` fyrer aldrig på en Function — rækken kom forrest i stedet for
  // bagest og slog `derived`. Basens CHECK holder værdien ude i dag, men
  // rangordenen skal ikke hvile på den.
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 4, unit_price: 4, source: 'constructor' },
    { pack_qty: 1, pack_unit: 'kg', pack_price: 9, unit_price: 9, source: 'derived' },
  ]]]);
  assert.equal(engine.effectivePrice('kartofler', '11deC',
    { offers: new Map(), normals }).source, 'derived');

  // Og rangordenen eksporteres — den må ikke kunne skrives udefra.
  assert.ok(Object.isFrozen(engine.SOURCE_RANK), 'SOURCE_RANK skal være frosset');
});

test('effectivePrice tåler et almindeligt objekt og et manglende kort', () => {
  // `cheapestPerItem` og `scoreRecipe` tager begge former; browserens kort
  // kommer fra JSON. effectivePrice kastede på et objekt og på et manglende
  // tredje argument.
  const p = engine.effectivePrice('kartofler', '11deC', {
    offers: { 'kartofler|11deC': { base_qty: 2, base_unit: 'kg', price: 12, unit_price: 6 } },
    normals: { 'kartofler|11deC': [
      { pack_qty: 2, pack_unit: 'kg', pack_price: 15.95, unit_price: 7.975, source: 'manual' }] },
  });
  near(p.unit_price, 6);
  assert.equal(engine.effectivePrice('kartofler', '11deC'), null);
});

// ── Tilbudskortets nøgleform ─────────────────────────────────────────────────

test('cheapestPerItem reducerer vare|kæde til ét tilbud pr. vare', () => {
  // `activeOfferMap()` nøgler nu på vare OG kæde, så opgave 8 kan vælge butik.
  // Opskriftsscoringen spørger stadig kun "er varen på tilbud et sted?", og
  // motoren skal selv kunne reducere kortet — ellers ville hvert eneste
  // opslag i scoreRecipe ramme forbi.
  const offers = new Map([
    ['kartofler|A', { chain_id: 'A', unit_price: 9, offer_id: 1 }],
    ['kartofler|B', { chain_id: 'B', unit_price: 6, offer_id: 2 }],
    ['laks|A',      { chain_id: 'A', unit_price: 80, offer_id: 3 }],
  ]);
  const byItem = engine.cheapestPerItem(offers);
  assert.equal(byItem.size, 2);
  assert.equal(byItem.get('kartofler').offer_id, 2);
  assert.equal(byItem.get('laks').offer_id, 3);
});

test('cheapestPerItem lader et kort nøglet på varen alene gå uændret igennem', () => {
  // Browserens `offerMapFor` nøgler stadig på varen alene. Begge former skal
  // kunne bæres, indtil opgave 8 flytter også den — ellers får skyen og den
  // lokale server hver sin madplan af de samme tilbud.
  const offers = new Map([['kartofler', { unit_price: 6, offer_id: 7 }]]);
  const byItem = engine.cheapestPerItem(offers);
  assert.equal(byItem.get('kartofler').offer_id, 7);
});

/**
 * Serversidens del af den nye nøgleform.
 *
 * Ingen test rørte `activeOfferMap()`, så suiten bestod uændret, hvis nøglen
 * var forkert — eller hvis `base_qty` faldt ud af `chainOfferIndex()`s SELECT,
 * som er præcis den vej, tilbuddene forsvandt i browseren: `offer.base_qty`
 * blev `undefined`, `undefined > 0` er falsk, og effectivePrice så aldrig et
 * tilbud. Serveren virkede videre, fordi `activeOfferMap()` havde kolonnen.
 *
 * Basen er en frisk fil i tmpdir, ikke `test.db`: testfilerne kører som
 * samtidige processer mod samme `test.db`, og fem indsatte tilbudsrækker
 * ville flytte tallene under `sync.test.js`.
 */
function freshPlans(dbPath) {
  const ids = ['src/db', 'src/price/history', 'src/mealplan/generate']
    .map((m) => require.resolve(path.join(__dirname, '..', m)));
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  for (const id of ids) delete require.cache[id];
  try {
    // `close` skal med ud: getDb() cacher forbindelsen i modulet, og på
    // Windows kan filen ikke slettes, mens håndtaget står åbent.
    const dbMod = require(path.join(__dirname, '..', 'src', 'db'));
    return {
      plans: require(path.join(__dirname, '..', 'src', 'mealplan', 'generate')),
      close: () => dbMod.getDb().close(),
    };
  } finally {
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
    for (const id of ids) delete require.cache[id];
  }
}

test('activeOfferMap nøgler på vare|kæde — ét tilbud pr. par', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madplan-offermap-'));
  const dbPath = path.join(dir, 'offermap.db');
  const db = openThroughGetDb(dbPath);          // skema + migrate, som i drift

  const at = new Date('2026-09-16T12:00:00Z');
  const from = '2026-09-10T00:00:00Z';
  const till = '2026-09-30T00:00:00Z';

  db.prepare("INSERT INTO chains (id, name, slug) VALUES ('TST1', 'Testkæde 1', 'tst1')").run();
  db.prepare("INSERT INTO chains (id, name, slug) VALUES ('TST2', 'Testkæde 2', 'tst2')").run();
  const prod = db.prepare(`INSERT INTO products (slug, name, category, item_key, created_at)
                           VALUES (?, ?, ?, ?, ?)`);
  const pKart = prod.run('t-kartofler', 'Kartofler', 'produce', 'kartofler', from).lastInsertRowid;
  const pKyll = prod.run('t-kyllingebryst', 'Kyllingebryst', 'meat', 'kyllingebryst', from).lastInsertRowid;

  const offer = db.prepare(`
    INSERT INTO offers (external_id, product_id, chain_id, heading, price,
                        base_qty, base_unit, unit_price, run_from, run_till, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  offer.run('t-k1-billig', pKart, 'TST1', 'Kartofler 2 kg', 12, 2, 'kg',  6, from, till, from);
  offer.run('t-k1-dyr',    pKart, 'TST1', 'Kartofler 1 kg',  9, 1, 'kg',  9, from, till, from);
  offer.run('t-k2',        pKart, 'TST2', 'Kartofler 2 kg',  8, 2, 'kg',  4, from, till, from);
  offer.run('t-y1',        pKyll, 'TST1', 'Kyllingebryst',  50, 1, 'kg', 50, from, till, from);
  offer.run('t-y2',        pKyll, 'TST2', 'Kyllingebryst',  60, 1, 'kg', 60, from, till, from);
  db.close();

  const { plans, close } = freshPlans(dbPath);
  const map = plans.activeOfferMap({ at });

  // Nøglen er vare OG kæde — begge dele, hver gang.
  for (const k of map.keys()) {
    assert.ok(k.includes('|'), `nøglen "${k}" mangler kæden`);
    assert.equal(k.split('|').length, 2, `nøglen "${k}" har ikke formen vare|kæde`);
  }
  assert.deepEqual([...map.keys()].sort(),
    ['kartofler|TST1', 'kartofler|TST2', 'kyllingebryst|TST1', 'kyllingebryst|TST2']);

  // Ét tilbud pr. par: den dyre kartoffelrække i TST1 er væk, men TST1's egen
  // pris er i behold ved siden af TST2's billigere. Nøglet på varen alene
  // ville kortet være halveret til to rækker — og spørgsmålet "hvad koster
  // varen i DENNE butik" kunne ikke stilles.
  assert.equal(map.size, 4);
  assert.equal(new Set([...map.keys()].map((k) => k.split('|')[0])).size, 2);
  near(map.get('kartofler|TST1').unit_price, 6);
  near(map.get('kartofler|TST2').unit_price, 4);
  assert.equal(map.get('kartofler|TST1').chain_id, 'TST1');

  // Pakken skal med hele vejen ud — ellers er tilbuddet ikke en pris.
  for (const [k, o] of map) assert.ok(o.base_qty > 0, `${k} mangler base_qty`);

  // Samme krav til den FLADE liste, browseren får. Det var her kolonnen
  // manglede: serveren virkede, browseren tabte hvert eneste tilbud.
  const index = plans.chainOfferIndex({ at });
  assert.equal(index.length, 4);
  for (const row of index) {
    assert.ok(row.base_qty > 0, `${row.item_key}|${row.chain_id} mangler base_qty`);
    assert.ok(row.base_unit, 'base_unit skal med');
  }

  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Normalpriserne, som opskriftsprisen henter dem.
 *
 * Værdien skal være en LISTE. Vælges rækken allerede i SQL'en, er valget
 * truffet af en sortering, der hverken kender rangordenen mellem kilder,
 * behovet eller varens holdbarhed — og både `effectivePrice` og `choosePack`
 * står tilbage med ét tal, de ikke selv har valgt.
 */
test('normalPricesFor grupperer alle rækker pr. vare|kæde', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madplan-normals-'));
  const dbPath = path.join(dir, 'normals.db');
  const db = openThroughGetDb(dbPath);

  db.prepare("INSERT INTO chains (id, name, slug) VALUES ('TST1', 'Testkæde 1', 'tst1')").run();
  db.prepare("INSERT INTO chains (id, name, slug) VALUES ('TST2', 'Testkæde 2', 'tst2')").run();
  const item = db.prepare(`INSERT INTO items (key, name, category, class, keeps, base_unit)
                           VALUES (?, ?, ?, ?, ?, ?)`);
  item.run('kartofler', 'Kartofler', 'veg', 'baseline', 'keeps', 'kg');
  item.run('aeg', 'Æg', 'eggs', 'fresh', 'keeps', 'stk');

  const price = db.prepare(`
    INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit, pack_price,
                             unit_price, source, observed_at, valid_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-15T00:00:00Z', '2027-03-14T00:00:00Z')`);
  price.run('kartofler', 'TST1', 1, 'kg', 12,    12,    'derived');
  price.run('kartofler', 'TST1', 2, 'kg', 15.95, 7.975, 'manual');
  price.run('kartofler', 'TST2', 2, 'kg', 18,    9,     'manual');
  price.run('aeg',       'TST1', 10, 'stk', 32.95, 3.295, 'api:rema');
  db.close();

  const { plans, close } = freshPlans(dbPath);
  try {
    const all = plans.normalPricesFor();
    assert.deepEqual([...all.keys()].sort(), ['aeg|TST1', 'kartofler|TST1', 'kartofler|TST2']);

    // Begge pakkestørrelser skal med — ellers kan effectivePrice ikke vælge
    // efter kilde og choosePack ikke efter behov.
    const kart = all.get('kartofler|TST1');
    assert.equal(kart.length, 2);
    assert.deepEqual(kart.map((r) => r.source).sort(), ['derived', 'manual']);
    for (const r of kart) {
      assert.ok(r.pack_qty > 0 && r.pack_price > 0 && r.unit_price > 0);
      assert.equal(r.pack_unit, 'kg');
      assert.ok(r.valid_until, 'valid_until skal med — effectivePrice måler udløb på den');
    }

    // Og kortet skal kunne begrænses til de valgte kæder: jobbet kører én
    // kæde ad gangen, og TST2's priser må ikke dukke op i TST1's regnestykke.
    const kun1 = plans.normalPricesFor(['TST1']);
    assert.deepEqual([...kun1.keys()].sort(), ['aeg|TST1', 'kartofler|TST1']);

    // Formen er den, effectivePrice faktisk slår op i.
    const p = engine.effectivePrice('kartofler', 'TST1',
      { offers: new Map(), normals: kun1, baseUnit: 'kg' });
    near(p.unit_price, 7.975);
    assert.equal(p.source, 'manual');
  } finally {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Opskriftsprisen ──────────────────────────────────────────────────────────
//
// `costRecipe` er ren og tager sine kort med ind, så de tre fælder i denne
// opgave kan efterprøves uden en base. Alle tre har det samme mønster: de
// giver et FOR LAVT tal og en FOR HØJ dækning, og budget-sporet sorterer
// netop efter de to.

const { costRecipe } = require(path.join(__dirname, '..', 'scripts', 'recompute-recipe-costs.js'));

// `category` er med, fordi et 'optional'-flag ikke skal tros på en hovedprotein.
const COST_ITEMS = new Map([
  ['kyllingebryst', { key: 'kyllingebryst', class: 'fresh',    keeps: 'perishable', base_unit: 'kg',  category: 'poultry' }],
  ['kartofler',     { key: 'kartofler',     class: 'baseline', keeps: 'keeps',      base_unit: 'kg',  category: 'veg' }],
  ['aeg',           { key: 'aeg',           class: 'fresh',    keeps: 'keeps',      base_unit: 'stk', category: 'eggs' }],
  ['brod',          { key: 'brod',          class: 'fresh',    keeps: 'perishable', base_unit: 'stk', category: 'bakery' }],
  ['salt',          { key: 'salt',          class: 'essential', keeps: 'pantry',    base_unit: 'kg',  category: 'pantry' }],
]);

const COST_NORMALS = new Map([
  ['kyllingebryst|TST', [{ pack_qty: 1, pack_unit: 'kg', pack_price: 70, unit_price: 70, source: 'manual' }]],
  ['kartofler|TST',     [{ pack_qty: 2, pack_unit: 'kg', pack_price: 15.95, unit_price: 7.975, source: 'manual' }]],
  ['aeg|TST',           [{ pack_qty: 10, pack_unit: 'stk', pack_price: 32.95, unit_price: 3.295, source: 'api:rema' }]],
]);

const line = (key, amount, extra = {}) => ({
  key, amount, weight: COST_ITEMS.get(key).base_unit === 'stk' ? amount * 0.058 : amount,
  optional: false, ...extra,
});

test('en ret prissættes på mængde × enhedspris, og pakkerne rundes op', () => {
  const r = { id: 1, title: 'Kylling med kartofler',
    items: [line('kyllingebryst', 0.6), line('kartofler', 0.5), line('salt', 0.005)] };
  const c = costRecipe(r, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS });

  // 0,6 kg kylling à 70 + 0,5 kg kartofler à 7,975. Saltet er essential og
  // tæller hverken i prisen eller i nævneren.
  near(c.cost, 0.6 * 70 + 0.5 * 7.975);
  // Men man køber ikke en halv pose: 1 kg kylling + én 2 kg-pose kartofler.
  near(c.cost_packs, 70 + 15.95);
  assert.ok(c.cost_packs > c.cost, 'hele pakker kan ikke koste mindre end behovet');
  assert.equal(c.coverage, 1);
  assert.equal(c.priceable, 1);
});

/**
 * Og hele vejen igennem costRecipe: pakkevalget skal nå ud i cost_packs.
 *
 * Det er den samme fejl som i effectivePrice-testen ovenfor, men på det sted,
 * hvor tallet ender i en tabel og bliver til budget-sporets rækkefølge.
 */
test('cost_packs vælger pakkestørrelse, når niveauet har flere', () => {
  const normals = new Map([['kartofler|TST', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 8,  unit_price: 8, source: 'manual' },
    { pack_qty: 5, pack_unit: 'kg', pack_price: 25, unit_price: 5, source: 'manual' },
  ]]]);
  const r = { id: 9, title: 'Kartofler alene', items: [line('kartofler', 1)] };
  const c = costRecipe(r, 'TST', { offers: new Map(), normals, items: COST_ITEMS });

  // `cost` er proportional og måles på den billigste pr. kilo — uændret.
  near(c.cost, 5);
  // `cost_packs` køber 1 kg-posen til 8 kr og ikke 5 kg-posen til 25.
  near(c.cost_packs, 8);
});

test('en stk-vare prissættes på stykantallet, ikke på rollevægten', () => {
  // `weight` er æggene omregnet til kilo, så assignRoles kan sammenligne
  // 6 æg med 0,4 kg kylling. Prisen er kr/STK, og de to tal må ikke bytte
  // plads: 6 × 3,295 = 19,77 kr, mens vægten ville give 6 × 0,058 × 3,295
  // = 1,15 kr. 748 opskrifter har mindst én stk-vare, så fejlen ville ramme
  // en tredjedel af korpusset og altid i samme retning — for billigt.
  const r = { id: 2, title: 'Omelet', items: [line('aeg', 6)] };
  const c = costRecipe(r, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS });
  near(c.cost, 6 * 3.295);
  // Én 10-pakke dækker de seks.
  near(c.cost_packs, 32.95);
  assert.equal(c.priceable, 1);
});

test('ukendte ingredienser tæller i nævneren og gør retten uprissætbar', () => {
  const r = { id: 3, title: 'Ret med to ukendte',
    items: [line('kyllingebryst', 0.6), line('kartofler', 0.5), line('aeg', 2)] };
  const uden = costRecipe(r, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS });
  assert.equal(uden.priceable, 1);

  // Samme ret, men to linjer taksonomien ikke kender. De når aldrig ind i
  // `items`, så uden `unknown` ville den stå som fuldt prissat med en pris,
  // der mangler to ingredienser.
  const med = costRecipe(r, 'TST',
    { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS, unknown: 2 });
  near(med.cost, uden.cost);                 // prisen er den samme …
  near(med.coverage, 3 / 5);                 // … men vi ved mindre, end vi troede
  assert.equal(med.priceable, 0);
});

test('valgfri linjer koster intet og gør ikke retten uprissætbar', () => {
  // "evt. et skvæt fløde" købes ikke. Havde den talt med, ville en ret med
  // en evt.-linje, vi ikke har pris på, stå som uprissætbar — og en, vi HAR
  // pris på, blive dyrere end kurven.
  const r = { id: 4, title: 'Ret med evt.',
    items: [line('kyllingebryst', 0.6),
            line('brod', 2, { optional: true })] };   // brod har ingen pris
  const c = costRecipe(r, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS });
  near(c.cost, 0.6 * 70);
  assert.equal(c.coverage, 1);
  assert.equal(c.priceable, 1);
});

test('et tilbud i den forkerte enhed prissætter ikke retten', () => {
  // brod hos Min Købmand: 9,90 kr/KG på en vare, der måles i STK, og ingen
  // normalpris at falde tilbage på. Uden baseUnit-vagten kostede to brød
  // 19,80 kr og retten stod som fuldt prissat.
  const r = { id: 5, title: 'Brød og æg', items: [line('brod', 2), line('aeg', 2)] };
  const offers = new Map([['brod|TST', { base_qty: 0.75, base_unit: 'kg', price: 7.43, unit_price: 9.9 }]]);
  const c = costRecipe(r, 'TST', { offers, normals: COST_NORMALS, items: COST_ITEMS });
  near(c.cost, 2 * 3.295);                   // kun æggene
  near(c.coverage, 0.5);
  assert.equal(c.priceable, 0);
});

test('en ret uden noget at købe er ikke en gratis ret', () => {
  // Kun essentials tilbage: 0 af 0. Uden vagten ville 0/0 blive NaN eller
  // coverage = 1, og retten stå øverst i budget-sporet til 0 kr.
  const r = { id: 6, title: 'Kun krydderier', items: [line('salt', 0.01)] };
  const c = costRecipe(r, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS });
  near(c.cost, 0);
  assert.equal(c.coverage, 0);
  assert.equal(c.priceable, 0);
});

test('en hovedprotein er aldrig valgfri, uanset flaget', () => {
  // "4 chicken breasts (skinless, if you like)" — OPTIONAL_RE matcher
  // "if you like" midt i linjen, og flaget fjerner linjen fra BÅDE prisen og
  // nævneren. Retten stod derfor som basens billigste prissatte ret til
  // 0,08 kr med coverage 1. Kyllingen skal med, selv om linjen er flaget.
  const r = { id: 7, title: 'Bagt kyllingebryst',
    items: [line('kyllingebryst', 0.6, { optional: true }), line('kartofler', 0.5)] };
  const c = costRecipe(r, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS });
  near(c.cost, 0.6 * 70 + 0.5 * 7.975);
  assert.equal(c.coverage, 1);   // 2 af 2, ikke 1 af 1
  assert.equal(c.priceable, 1);

  // Og reglen gælder KUN kød, fjerkræ og fisk: et valgfrit brød er stadig
  // valgfrit, ellers ville "evt. et skvæt fløde" blive købt.
  const b = { id: 8, title: 'Med evt. brød',
    items: [line('kyllingebryst', 0.6), line('brod', 2, { optional: true })] };
  near(costRecipe(b, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS }).cost,
    0.6 * 70);
});

test('samme vare på to linjer køber én pakke, ikke to', () => {
  // "1 lemon, zested" og "zest of 1 lemon" er den samme citron. 1.086 af de
  // 2.224 opskrifter har mindst én vare på flere linjer, og rundes hver linje
  // op for sig, betaler cost_packs for den samme pose to gange.
  const r = { id: 9, title: 'Kartofler to gange',
    items: [line('kartofler', 0.5), line('kartofler', 0.5)] };
  const c = costRecipe(r, 'TST', { offers: new Map(), normals: COST_NORMALS, items: COST_ITEMS });
  near(c.cost, 1 * 7.975);
  near(c.cost_packs, 15.95);          // én 2 kg-pose dækker begge linjer
  assert.ok(c.cost_packs >= c.cost, 'hele pakker kan ikke koste mindre end behovet');
  // Nævneren tæller stadig linjer: begge er kendte, så dækningen er hel.
  assert.equal(c.coverage, 1);
});
