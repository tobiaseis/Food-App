'use strict';

/**
 * Læser de danske udgaver (data/opskrifter/**.json) ind i data.db.
 *
 * Idempotent: filens hash står på retten, og en uændret fil røres ikke. Den
 * køres også i den natlige kørsel, så release-assettet aldrig står uden de
 * danske opskrifter.
 *
 * En udgave, der ikke består kontrollen, springes over og nævnes; den gamle
 * udgave i basen bliver stående. Er den set efter og i orden, sættes
 * "accepted": true i filen, og så læses den ind.
 *
 * Én ødelagt fil (ugyldig JSON, en fejl i parseIngredient e.l.) stopper ikke
 * resten af kørslen: den tælles og nævnes for sig ("errored"), og de øvrige
 * filer læses videre. Kørslen er natlig og ubemandet, så én fejlfil i
 * data/opskrifter/ må ikke vælte hele den natlige opdatering.
 *
 *   npm run recipes:import
 *   npm run recipes:import -- --report tmp/omskrivning/kontrol.md
 *
 * Bagefter: npm run backfill:amounts && npm run reclassify && npm run costs:recompute
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const taxonomy = require('../lib/taxonomy');
const { parseIngredient } = require('./extract');
const { UNITS, EDITION_DIR, lineOf, labelOf } = require('./edition');

const MAIN_CATS = new Set(['meat', 'poultry', 'fish']);
const catOf = (key) => { const m = key && taxonomy.get(key); return m ? (m.category || m.cat) : null; };

// Et dyr forrest i et sammensat kødord skal genfindes i varen. Ellers er
// "lammeculotte" blevet til bøf igen (opgave 1).
const ANIMAL_PREFIX = [
  ['lamme', (k) => k === 'lam'],
  ['kalve', (k) => k === 'kalvekoed'],
  ['okse', (k) => /okse|boef/.test(k)],
  ['svine', (k) => /svin|flaesk/.test(k)],
  ['kylling', (k) => /kylling/.test(k)],
];

// Søstervarer af samme dyr eller samme vare. Den engelske linje og den danske
// rammer ofte hver sin nøgle for det samme kød: "1 kylling (ca. 1200 g)" er
// `kylling`, udgavens "hel kylling" er `hel_kylling`; "4 slices of ham" og
// "prosciutto" er `paalaeg`, udgavens "skinke" og "parmaskinke" er `skinke`.
// Kontrollen holdt 137 udgaver tilbage for "hovedråvaren er væk", mest af den
// grund. Inden for familien er hovedråvaren der stadig, og mængden måles over
// hele familien; et skift til et andet dyr (lam → svin) fanges som før. En
// hovedvare, der ikke står her, er sin egen familie.
const FAMILIES = {
  kylling: ['kylling', 'hel_kylling', 'kyllingebryst', 'kyllingelaar'],
  svin: ['flaeskesteg', 'svinemoerbrad', 'svinekoteletter', 'hakket_svinekoed', 'bacon', 'skinke',
    'paalaeg', 'poelser'],
  okse: ['oksekoed', 'boef', 'oksemoerbrad', 'hakket_oksekoed'],
  lam: ['lam'],
  kalv: ['kalvekoed'],
};
const FAMILY_OF = new Map(Object.entries(FAMILIES).flatMap(([f, keys]) => keys.map((k) => [k, f])));
const familyOf = (key) => FAMILY_OF.get(key) || key;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name))
      : d.name.endsWith('.json') ? [path.join(dir, d.name)] : []))
    .sort();
}

/** Hvad der er galt med udgaven. Tom liste: den kan læses ind. */
function problems(ed, lines, before) {
  const out = [];
  if (!ed.title || ed.title.length < 3) out.push('ingen titel');
  if (!Array.isArray(ed.steps) || ed.steps.length < 2) out.push('færre end to trin');
  if (!Array.isArray(ed.ingredients) || ed.ingredients.length < 2) out.push('færre end to ingredienser');
  for (const ing of ed.ingredients || []) {
    if (ing.unit != null && !UNITS.includes(ing.unit)) out.push(`ukendt enhed "${ing.unit}"`);
    if (ing.amount != null && !(ing.amount > 0)) out.push(`mængden ${ing.amount} for ${ing.name}`);
  }
  if (ed.yield_count && ed.servings !== ed.yield_count) {
    out.push(`${ed.servings} portioner, kilden siger ${ed.yield_count}`);
  }

  // Hovedråvaren må ikke være skiftet ud — en søstervare af samme dyr er den
  // samme råvare (FAMILIES).
  const after = new Set(lines.map((l) => l.item_key).filter(Boolean).map(familyOf));
  const seen = new Set();
  for (const k of new Set(before.filter((l) => MAIN_CATS.has(catOf(l.item_key))).map((l) => l.item_key))) {
    const fam = familyOf(k);
    if (seen.has(fam)) continue;
    seen.add(fam);
    if (!after.has(fam)) { out.push(`hovedråvaren ${k} er væk`); continue; }
    // Afrundingen må højst flytte en vare 20 % (prompten); 25 % giver plads
    // til hele pakker. Mere end det er en anden ret. Summen er familiens:
    // "1 kylling 1200 g" mod "hel kylling 1200 g" er den samme mængde.
    const sum = (ls) => ls.filter((l) => l.item_key && familyOf(l.item_key) === fam)
      .reduce((a, l) => a + (l.amount || 0), 0);
    const was = sum(before), now = sum(lines);
    if (was > 0 && now > 0 && Math.abs(now / was - 1) > 0.25) {
      out.push(`${k}: ${Math.round(was * 1000)} → ${Math.round(now * 1000)} (mere end 25 %)`);
    }
  }
  for (const l of lines) {
    if (!MAIN_CATS.has(catOf(l.item_key))) continue;
    for (const [prefix, ok] of ANIMAL_PREFIX) {
      if (l.ingredient.startsWith(prefix) && !ok(l.item_key)) out.push(`"${l.raw}" er koblet til ${l.item_key}`);
    }
  }

  // Flere ukendte linjer end før: udgaven er sværere at prissætte end kilden.
  const unknown = (ls) => ls.filter((l) => !l.item_key && !l.optional).length;
  if (unknown(lines) > unknown(before)) out.push(`${unknown(lines)} ukendte linjer (før ${unknown(before)})`);
  // Flere ingredienslinjer end kilden: en erstattet færdigvare er blevet til en
  // hjemmelavet delopskrift med opfundne mængder (pilotens cheesecake med gelé).
  // Marginen på +2 og 30 % lader "salt og peber" blive til to linjer.
  //
  // Målestokken er KILDESIDENS linjer (source_lines, skrevet af rewrite.js):
  // basens linjer er ofte færre end sidens — #643 softice har 9 på siden, 4 i
  // basen — og 128 udgaver blev holdt tilbage for linjer, kilden faktisk har.
  // En ældre fil uden feltet måles mod basen som før.
  const fromSource = typeof ed.source_lines === 'number';
  const base = fromSource ? ed.source_lines : before.length;
  if (base > 0 && lines.length > base + 2 && lines.length > base * 1.3) {
    out.push(`${lines.length} ingredienslinjer, ${fromSource ? 'kilden' : 'før'} ${base} (nye ingredienser?)`);
  }
  return out;
}

/**
 * Én `::warning::`-linje til GitHub Actions: hvor mange udgaver der venter på
 * eftersyn eller ikke kunne læses, og de første filer. Én linje, fordi en
 * annotation er én linje; null, når der intet er at sige.
 */
function actionsWarning(flagged, errored) {
  if (!flagged.length && !errored.length) return null;
  const files = [...errored, ...flagged].map((f) => f.file).slice(0, 10);
  const more = flagged.length + errored.length - files.length;
  return `::warning title=Danske opskrifter::${flagged.length} til eftersyn, `
    + `${errored.length} kunne ikke læses — ${files.join(', ')}${more > 0 ? ` (+${more} flere)` : ''}. `
    + 'Kør npm run recipes:import -- --report tmp/omskrivning/kontrol.md lokalt.';
}

function importAll({ dir = EDITION_DIR, log = console.log, reportPath = null } = {}) {
  const db = getDb();
  const byUrl = new Map(db.prepare('SELECT id, url, edition_hash FROM recipes').all().map((r) => [r.url, r]));
  const before = db.prepare('SELECT raw, ingredient, item_key, amount, optional FROM recipe_ingredients WHERE recipe_id = ?');

  const apply = db.transaction((id, ed, lines, hash) => {
    // description = NULL: den rummer op til 500 tegn af kildens EGEN tekst
    // (extract.js), og release-assettets data.db er offentlig, hvis repoet er.
    // Kildens tekst forlader ikke maskinen — heller ikke via basen. Udgavens
    // intro, med egne ord, tager dens plads (også i classify.js).
    //
    // yield_count udfyldes kun, hvor kilden intet sagde: reclassify regner
    // portionerne fra det rå tal og faldt ellers tilbage på den allerede
    // regnede `servings`. Udgavens servings er kildens portionsantal, uændret.
    db.prepare(`
      UPDATE recipes SET title = @title, intro = @intro, lang = 'da', description = NULL,
             yield_count = COALESCE(yield_count, @servings),
             total_minutes = COALESCE(@total, total_minutes),
             active_minutes = COALESCE(@active, active_minutes),
             edition = @edition, edition_hash = @hash, edited_at = @at, changes = @changes
       WHERE id = @id`).run({
      id, title: ed.title, intro: ed.intro || null,
      servings: ed.servings > 0 ? ed.servings : null,
      total: ed.total_minutes ?? null, active: ed.active_minutes ?? null,
      edition: ed.edition, hash, at: ed.written_at || new Date().toISOString(),
      changes: JSON.stringify(ed.changes || []),
    });
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
    const ins = db.prepare(`
      INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient, item_key, amount,
                                      optional, position, section, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((l, i) => ins.run(id, l.raw, l.qty, l.unit, l.ingredient, l.item_key, l.amount,
      l.optional, i, l.section, l.label));
    db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(id);
    const step = db.prepare('INSERT INTO recipe_steps (recipe_id, position, section, text) VALUES (?, ?, ?, ?)');
    ed.steps.forEach((s, i) => step.run(id, i, s.section || null, s.text));
  });

  const stats = { applied: 0, unchanged: 0, flagged: 0, orphan: 0, errored: 0 };
  const flagged = [];
  const orphaned = [];
  const errored = [];
  for (const file of listFiles(dir)) {
    const rel = path.relative(process.cwd(), file);
    try {
      const text = fs.readFileSync(file, 'utf8');
      const ed = JSON.parse(text);
      const row = byUrl.get(ed.url);
      if (!row) { stats.orphan++; orphaned.push({ file: rel, url: ed.url }); continue; }
      const hash = crypto.createHash('sha1').update(text).digest('hex');
      if (row.edition_hash === hash) { stats.unchanged++; continue; }

      const lines = (ed.ingredients || []).map((ing, i) => {
        const raw = lineOf(ing);
        return { ...parseIngredient(raw, i), raw, section: ing.section || null, label: labelOf(ing) };
      });
      const issues = problems(ed, lines, before.all(row.id));
      if (issues.length && !ed.accepted) {
        stats.flagged++;
        flagged.push({ file: rel, id: row.id, title: ed.title, issues });
        continue;
      }
      apply(row.id, ed, lines, hash);
      stats.applied++;
    } catch (err) {
      // apply() er en transaktion, så en fejl undervejs i den ruller kun DEN
      // ene opskrift tilbage — ikke tidligere filer i samme kørsel.
      stats.errored++;
      errored.push({ file: rel, error: err.message });
    }
  }

  log(`${stats.applied} læst ind · ${stats.unchanged} uændrede · ${stats.flagged} til eftersyn · `
    + `${stats.orphan} uden ret i basen · ${stats.errored} kunne ikke læses`);
  for (const f of flagged.slice(0, 20)) log(`  ${f.id} ${f.title}: ${f.issues.join('; ')}`);
  // Navngiv også forældreløse og fejlede filer i loggen: i en natlig,
  // ubemandet kørsel er logudskriften det eneste sted, man kan se HVORFOR en
  // fil ikke blev læst ind.
  for (const f of orphaned.slice(0, 20)) log(`  uden ret i basen: ${f.file} (${f.url})`);
  for (const f of errored.slice(0, 20)) log(`  kunne ikke læses: ${f.file}: ${f.error}`);
  // I GitHub Actions bliver linjen en advarsel på kørslens forside. Ellers
  // står det kun dybt i loggen af en kørsel, der lykkedes — og ingen læser den.
  if (process.env.GITHUB_ACTIONS) {
    const warning = actionsWarning(flagged, errored);
    if (warning) log(warning);
  }
  if (reportPath) {
    const md = ['# Danske udgaver til eftersyn', '',
      ...flagged.map((f) => `- **${f.title}** (${f.id}) \`${f.file}\`\n  - ${f.issues.join('\n  - ')}`)];
    if (errored.length) {
      md.push('', '## Kunne ikke læses', '',
        ...errored.map((f) => `- \`${f.file}\`: ${f.error}`));
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${md.join('\n')}\n`);
    log(`Eftersynslisten: ${reportPath}`);
  }
  return { ...stats, flaggedList: flagged, erroredList: errored };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--report');
  importAll({ reportPath: i === -1 ? null : args[i + 1] });
}

module.exports = { importAll, problems, actionsWarning };
