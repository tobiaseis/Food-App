'use strict';

const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');

const { ensureNaturalKey } = require('./dedupe');

const DB_PATH     = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(_db);

  return _db;
}

/**
 * Tilføjer kolonner der er kommet til efter en database blev oprettet.
 * CREATE TABLE IF NOT EXISTS rører ikke eksisterende tabeller, så nye felter
 * skal lægges på eksplicit.
 */
function migrate(db) {
  const added = [
    ['recipes', 'score_healthy', 'REAL'],
    ['recipes', 'score_classic', 'REAL'],
    ['recipes', 'score_premium', 'REAL'],
    ['products', 'fat_grade', 'TEXT'],
    ['products', 'organic', 'INTEGER DEFAULT 0'],
    ['products', 'prepared', 'INTEGER DEFAULT 0'],
    ['products', 'item_key', 'TEXT'],
    ['recipe_ingredients', 'item_key', 'TEXT'],
    ['recipe_ingredients', 'amount',   'REAL'],
    ['recipe_ingredients', 'optional', 'INTEGER DEFAULT 0'],
    // Kom til med prisplanen. En base, der allerede har item_prices fra før
    // kolonnen fandtes, skal have den lagt på — CREATE TABLE IF NOT EXISTS i
    // schema.sql rører ikke tabellen.
    ['item_prices', 'n_obs', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, column, type] of added) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  // Kopiér nøglen videre FØR den droppes. En base fra før opgave 9 (fx et
  // release-asset, der endnu ikke er kørt igennem seed:items/backfill:amounts)
  // har kun taxonomy_key udfyldt, aldrig item_key. Uden denne linje mister
  // ÉT åbn af en sådan base alle 26.242 koblinger stille og roligt: kolonnen
  // forsvinder i samme migrering, item_key er allerede oprettet (tom, ovenfor)
  // men aldrig fyldt, og loadRecipes() ser bagefter 0 opskrifter med ≥3
  // varer. Fundet ved at åbne en kopi af data.db.pre-items og sammenligne
  // taxonomy_key-antal før/efter. Kør uanset om item_key allerede har data,
  // så en delvist opdateret arbejdskopi ikke får overskrevet ægte linjer:
  // WHERE item_key IS NULL gør kopieringen idempotent og ufarlig at gentage.
  const cols0 = db.prepare('PRAGMA table_info(recipe_ingredients)').all().map((c) => c.name);
  if (cols0.includes('taxonomy_key')) {
    db.exec(`
      UPDATE recipe_ingredients SET item_key = taxonomy_key
       WHERE item_key IS NULL AND taxonomy_key IS NOT NULL
    `);
  }

  // products.taxonomy_key blev ikke omdøbt i plan 1. Samme information, to
  // navne, og prisplanen joiner offers -> products -> items igen og igen.
  //
  // Indekset skal væk FØRST og lægges på igen bagefter: SQLite nægter at
  // droppe en kolonne, der stadig er indekseret — nøjagtig samme fælde som
  // idx_ri_tax nedenfor. Indekset beholder sit gamle NAVN med vilje: schema.sql
  // køres før migrate() ved hver åbning, og et nyt navn dér ville forsøge at
  // indeksere item_key på en base, hvor kolonnen endnu ikke er lagt på.
  {
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    if (cols.includes('taxonomy_key')) {
      db.exec(`UPDATE products SET item_key = taxonomy_key
                WHERE item_key IS NULL AND taxonomy_key IS NOT NULL`);
      db.exec('DROP INDEX IF EXISTS idx_products_tax');
      db.exec('ALTER TABLE products DROP COLUMN taxonomy_key');
      db.exec('CREATE INDEX IF NOT EXISTS idx_products_tax ON products(item_key)');
    }
  }

  // Informationen bor nu i items.class og i amount. Droppes til sidst, så en
  // delvist opdateret arbejdskopi ikke mister data undervejs.
  //
  // idx_ri_tax skal væk FØRST: SQLite nægter at droppe en kolonne, der stadig
  // er indekseret ("error in index idx_ri_tax after drop column: no such
  // column: taxonomy_key") — verificeret mod den sqlite3-version, better-
  // sqlite3 bundler her. is_staple har intet indeks og er ikke ramt.
  db.exec('DROP INDEX IF EXISTS idx_ri_tax');
  for (const col of ['is_staple', 'taxonomy_key']) {
    const cols = db.prepare('PRAGMA table_info(recipe_ingredients)').all().map((c) => c.name);
    if (cols.includes(col)) db.exec(`ALTER TABLE recipe_ingredients DROP COLUMN ${col}`);
  }

  // Rydder dubletter og lægger den naturlige nøgle på. Første åbning af en
  // base fra før nøglen tager et øjeblik; derefter er det ét opslag.
  ensureNaturalKey(db, console.log);
}

/** Læser en indstilling; falder tilbage til `fallback`. */
function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

module.exports = { getDb, getSetting, setSetting, DB_PATH };
