'use strict';

const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');

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
  ];
  for (const [table, column, type] of added) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
