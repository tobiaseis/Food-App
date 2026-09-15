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

test('stk-tilbud på en kg-vare omregnes — og de blokerede gør ikke', () => {
  const items = new Map([
    ['blomkaal', { key: 'blomkaal', base_unit: 'kg', piece_g: 500 }],
    ['selleri',  { key: 'selleri',  base_unit: 'kg', piece_g: 40 }],
  ]);
  const rows = [
    { item_key: 'blomkaal', chain_id: '11deC', base_unit: 'stk', unit_price: 12, base_qty: 1 },
    { item_key: 'selleri',  chain_id: '11deC', base_unit: 'stk', unit_price: 12, base_qty: 1 },
  ];

  const { rows: out, blocked } = boot.convertPieceOffers(rows, items);
  assert.equal(out.length, 1);
  assert.equal(out[0].item_key, 'blomkaal');
  assert.equal(out[0].base_unit, 'kg');
  near(out[0].unit_price, 24);        // 12 kr / 0,5 kg
  near(out[0].base_qty, 0.5);

  // selleri er holdt ude med vilje: piece_g = 40 g er én stang, ikke bundtet,
  // og 300 kr/kg er ikke en butikspris. Den skal rapporteres, ikke skrives.
  assert.ok(blocked.has('selleri'));
  assert.equal(blocked.get('selleri').prices.length, 1);
  near(blocked.get('selleri').prices[0], 300);
});
