'use strict';

/**
 * Lægger image, lang, keywords, fetched_at og sidens næring (tal) på de danske udgaver, der blev
 * skrevet, før rewrite.js selv skrev dem.
 *
 * import-da.js opretter en ret, som release-basen ikke kender (en ny kilde i
 * den natlige kørsel), og skal bruge de felter til det. For de eksisterende
 * udgaver står de i data.db; kun de MANGLENDE felter lægges på, så en kørsel
 * to gange giver ingen ændring, og et felt, nogen har rettet i filen, bliver
 * stående. Intet skrives til databasen (den åbnes skrivebeskyttet).
 *
 * Filen skrives i samme form som rewrite.js (to mellemrum, linjeskift til
 * sidst), og felterne står lige efter source_lines — samme plads som
 * editionRecord giver dem — så diffen kun er de nye linjer.
 *
 *   node scripts/backfill-edition-meta.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../src/db');
const { EDITION_DIR } = require('../src/recipes/edition');

const FIELDS = ['image', 'lang', 'keywords', 'fetched_at', 'nutrition'];

/** Udgaven med de manglende felter fra `row` (en række fra recipes). Originalen røres ikke. */
function withMeta(ed, row) {
  const add = {};
  for (const f of FIELDS) {
    if (f in ed) continue;
    if (f === 'nutrition') {
      // Kun sidens egen næring (nutrition_src 'site'); et skøn genskabes af
      // reclassify og hører ikke hjemme i udgaven. Pr. rækkens portionsantal.
      if (row.nutrition_src === 'site' && (row.kcal != null || row.protein_g != null)) {
        add.nutrition = {
          per_servings: row.servings > 0 ? row.servings : 1,
          kcal: row.kcal ?? null, protein_g: row.protein_g ?? null,
          carbs_g: row.carbs_g ?? null, fat_g: row.fat_g ?? null,
        };
      }
      continue;
    }
    // Udgaver er altid danske, uanset hvad basen kaldte retten før udgaven.
    add[f] = f === 'lang' ? 'da' : (row[f] ?? null);
  }
  if (!Object.keys(add).length) return ed;
  const out = {};
  let placed = false;
  const place = () => { Object.assign(out, add); placed = true; };
  for (const [k, v] of Object.entries(ed)) {
    out[k] = v;
    if (!placed && k === 'source_lines') place();
  }
  if (!placed) {
    // Uden source_lines: efter yield_count, ellers sidst.
    const rebuilt = {};
    for (const [k, v] of Object.entries(ed)) {
      rebuilt[k] = v;
      if (!placed && k === 'yield_count') { Object.assign(rebuilt, add); placed = true; }
    }
    if (!placed) Object.assign(rebuilt, add);
    return rebuilt;
  }
  return out;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name))
      : d.name.endsWith('.json') ? [path.join(dir, d.name)] : []))
    .sort();
}

function main({ dir = EDITION_DIR, dbPath = DB_PATH } = {}) {
  const db = new Database(dbPath, { readonly: true });
  const get = db.prepare('SELECT image, keywords, fetched_at, servings, kcal, protein_g, carbs_g, fat_g, nutrition_src FROM recipes WHERE url = ?');
  const stats = { written: 0, unchanged: 0, noRecipe: 0, handEdited: 0 };
  const noRecipe = [], handEdited = [];
  for (const file of listFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const ed = JSON.parse(text);
    // En fil, der ikke står i rewrite.js' format (håndrettet), omformateres aldrig.
    // På Windows med core.autocrlf=true har filen CRLF, men scripts skriver LF. Normaliserer
    // til LF før sammenligning så udgaver i standardformat opdateres selvom de har CRLF.
    if (`${JSON.stringify(ed, null, 2)}\n` !== text.replace(/\r\n/g, '\n')) { stats.handEdited++; handEdited.push(file); continue; }
    const row = get.get(ed.url);
    if (!row) { stats.noRecipe++; noRecipe.push(`${file} (${ed.url})`); continue; }
    const next = `${JSON.stringify(withMeta(ed, row), null, 2)}\n`;
    if (next === text) { stats.unchanged++; continue; }
    fs.writeFileSync(file, next);
    stats.written++;
  }
  db.close();
  console.log(`${stats.written} udgaver fik image/lang/keywords/fetched_at/næring · `
    + `${stats.unchanged} havde dem allerede · ${stats.noRecipe} uden ret i basen · `
    + `${stats.handEdited} sprunget over (ikke i standardformat)`);
  for (const f of handEdited) console.log(`  ikke i standardformat: ${f}`);
  for (const f of noRecipe) console.log(`  uden ret i basen: ${f}`);
  return stats;
}

if (require.main === module) main();

module.exports = { withMeta, main };
