'use strict';

/**
 * Lægger `source_lines` — kildesidens antal ingredienslinjer — på de danske
 * udgaver, der blev skrevet, før rewrite.js selv skrev feltet.
 *
 * import-da.js måler udgavens linjer mod kildens for at fange opfundne
 * delopskrifter. Uden feltet målte den mod basens linjer, og de er ofte færre
 * end sidens (#643 softice: 9 på siden, 4 i basen): 128 af de 376 udgaver, der
 * blev holdt tilbage, var den falske alarm.
 *
 * Kun TALLET flyttes fra tmp/kilder/ til data/opskrifter/ — kildens tekst
 * forlader ikke maskinen. En udgave uden kildefil springes over. Filen skrives
 * i samme form, som rewrite.js skriver den (JSON.stringify med to mellemrum og
 * et linjeskift til sidst), så diffen kun er den ene linje.
 *
 *   node scripts/backfill-source-lines.js
 */

const fs = require('fs');
const path = require('path');
const { EDITION_DIR, SOURCE_DIR } = require('../src/recipes/edition');

/**
 * Udgaven med `source_lines` lige efter `yield_count` — samme plads som
 * rewrite.js' editionRecord giver feltet. Står det der allerede, beholder det
 * sin plads. Originalen røres ikke.
 */
function withSourceLines(ed, n) {
  if ('source_lines' in ed) return { ...ed, source_lines: n };
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(ed)) {
    out[k] = v;
    if (k === 'yield_count') { out.source_lines = n; placed = true; }
  }
  if (!placed) out.source_lines = n;
  return out;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name))
      : d.name.endsWith('.json') ? [path.join(dir, d.name)] : []))
    .sort();
}

function main() {
  const stats = { written: 0, unchanged: 0, noSource: 0 };
  for (const file of listFiles(EDITION_DIR)) {
    // Samme relative sti: data/opskrifter/<kilde>/<slug>.json ↔ tmp/kilder/<kilde>/<slug>.json.
    const twin = path.join(SOURCE_DIR, path.relative(EDITION_DIR, file));
    if (!fs.existsSync(twin)) { stats.noSource++; continue; }
    const src = JSON.parse(fs.readFileSync(twin, 'utf8'));
    if (!Array.isArray(src.ingredients)) { stats.noSource++; continue; }
    const text = fs.readFileSync(file, 'utf8');
    const ed = JSON.parse(text);
    const next = `${JSON.stringify(withSourceLines(ed, src.ingredients.length), null, 2)}\n`;
    if (next === text) { stats.unchanged++; continue; }
    fs.writeFileSync(file, next);
    stats.written++;
  }
  console.log(`${stats.written} udgaver fik source_lines · ${stats.unchanged} havde det allerede · `
    + `${stats.noSource} uden kildefil`);
}

if (require.main === module) main();

module.exports = { withSourceLines };
