'use strict';

/**
 * Skriver appens danske udgave af opskrifterne med Claude Code i
 * headless-tilstand (`claude -p`) — på brugerens Claude-abonnement, ikke på
 * API'et, så der er ingen ekstra udgift. Abonnementets forbrugsgrænse gælder:
 * rammes den, stopper kørslen pænt, og næste kørsel fortsætter, hvor den slap
 * (en opskrift med en fil i data/opskrifter/ springes over).
 *
 *   npm run recipes:rewrite -- run [--limit N] [--source S] [--ids 1,2] [--force]
 *                                  [--parallel 2] [--model opus]
 *   npm run recipes:rewrite -- one <recipe_id> [--model opus]
 *
 * CLI'en: CLAUDE_BIN, ellers den nyeste i VS Code-udvidelserne, ellers
 * `claude` på PATH. Den kører fra en tom mappe uden værktøjer, indstillinger
 * og MCP: modellen skal kun læse opskriften og svare i skemaets form.
 *
 * Råmaterialet er tmp/kilder/ (fetch-sources.js); resultatet er
 * data/opskrifter/<kilde>/<slug>.json, som import-da.js læser ind i basen.
 * Hver udgaves fremgangsmåde måles mod kildens (overlap nedenfor) og
 * logges i tmp/omskrivning/overlap.jsonl; de, der er for tæt på, listes til
 * sidst med en færdig `run --force --ids …`-linje.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getDb } = require('../db');
const { SEED } = require('../lib/taxonomy');
const { UNITS, RECIPE_SCHEMA, sourcePath, editionPath } = require('./edition');

// Sonnet bruger mindst af abonnementets grænse og er rigeligt til at
// oversætte og runde mængder af. --model opus, hvis piloten siger andet.
const DEFAULT_MODEL = 'sonnet';
const EDITION = 1;
// Så mange fejl i træk (ikke grænsen), før run() giver op — se drain().
const MAX_ERRORS_IN_A_ROW = 5;
const STATE_DIR = path.join(__dirname, '..', '..', 'tmp', 'omskrivning');

const argValue = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

/** Den nyeste Claude Code-udvidelse blandt mappenavnene — efter versionsnummer, ikke alfabet. */
function newestClaude(dirs) {
  const ver = (d) => (d.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  const found = dirs.filter((d) => ver(d).length === 3);
  found.sort((a, b) => { const x = ver(a), y = ver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return found.length ? found[found.length - 1] : null;
}

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  const dir = fs.existsSync(ext) ? newestClaude(fs.readdirSync(ext)) : null;
  if (dir) {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const bin = path.join(ext, dir, 'resources', 'native-binary', exe);
    if (fs.existsSync(bin)) return bin;
  }
  return 'claude';
}

/** Har abonnementet sagt stop for nu? 429, eller "usage limit" i beskeden. */
function limitHit(res) {
  return Boolean(res && res.is_error && (res.api_error_status === 429
    || /usage limit|rate limit|limit reached/i.test(String(res.result || ''))));
}

/**
 * Den model, der faktisk skrev svaret. modelUsage kan have flere nøgler — en
 * hjælpemodel (fx til selve skema-udtrækket) står ofte først og har et par
 * håndfulde tokens; den model, der skrev opskriften, har langt flere
 * outputTokens. Uden dette blev filens `model`-felt sat til hjælpemodellen
 * (Haiku), selvom kaldet bad om Sonnet.
 */
function generatingModel(modelUsage, fallback) {
  const entries = Object.entries(modelUsage || {});
  if (!entries.length) return fallback;
  entries.sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
  return entries[0][0];
}

// Brugerens valg 2026-09-30: så lidt om som muligt. Samme ret; mængderne
// rundet til danske pakninger og runde tal, så de ikke er kildens egne; og
// fremgangsmåden med egne ord — det er teksten, ophavsretten beskytter.
const INSTRUCTIONS = `Du er redaktør på en dansk madplan-app. Du får en opskrift fra en kilde – dansk eller engelsk – og skriver appens egen danske udgave af den.

Lav så lidt om som muligt: samme ret, samme råvarer, samme teknik, samme tider og temperaturer, samme portionsantal. Udgaven skal kunne laves i et dansk køkken med varer fra et dansk supermarked.

INGREDIENSER
- Skriv på dansk, én vare pr. linje. "Salt og peber" er to linjer.
- Brug kun disse enheder: ${UNITS.join(', ')} – eller null, når linjen ikke har en mængde. Omregn: cup → dl, oz → g, lb → g, tbsp → spsk, tsp → tsk, stick butter → g.
- Rund mængderne til det, man køber i Danmark, og til runde tal: hele pakker, hvor det giver mening (450 g hakket oksekød → 500 g; en dåse hakkede tomater er 400 g; et bæger fløde er 2,5 dl), ellers et rundt tal tæt på (180 g → 200 g). Ingen vare må ændres mere end 20 % op eller ned, og retten skal smage som før.
- name er varen alene, som den hedder i et dansk supermarked ("kyllingebryst", ikke "kyllingebryst uden skind i strimler"). Brug navnene fra varekataloget nedenfor, når de passer. Behold udskæringen, når det er den, man køber (lammeculotte, kyllingeoverlår, svinemørbrad). Tilberedning ("finthakket", "i strimler") står i note.
- Er en vare svær at få i Netto, REMA 1000, Føtex, Bilka, Lidl eller Coop, så skift den til den nærmeste almindelige danske vare (double cream → piskefløde, courgette → squash, streaky bacon → bacon i skiver, self-raising flour → hvedemel og bagepulver). Skift aldrig rettens hovedråvare ud: lam forbliver lam, laks forbliver laks.
- optional er kun sand, hvis kilden selv kalder varen valgfri eller "evt.".
- section er en overskrift som "Til dressingen", eller null.
- Skriv hver erstatning af en vare som én kort sætning i changes. Afrundinger skal ikke med. Ingen erstatninger: en tom liste.

FREMGANGSMÅDE
- Skriv trinene fra bunden ud fra, hvad der skal ske i køkkenet – redigér ikke kildens sætninger. Ingen sætning må følge kildens ordstilling: brug dine egne verber og din egen sætningsbygning, og saml eller del trin, hvor det gør det tydeligere. Retten, teknikken, tiderne og temperaturerne er de samme. Skriv i korte trin i bydeform.
- Temperaturer i °C for almindelig ovn; skriv varmluft, hvis kilden gør. Gasmærker og °F omregnes.
- Gentag ikke mængder fra ingredienslisten i trinene – de kan blive justeret i appen. Skriv "halvdelen af hvidløget", ikke "2 fed hvidløg".
- section som ved ingredienserne.

TITEL OG INTRO
- title: kort og dansk, som en dansk kogebog ville kalde retten.
- intro: én eller to sætninger med dine egne ord om retten.
- servings: kildens portionsantal, uændret.

VAREKATALOG (foretrukne varenavne)
`;

// Sorteret og uden noget, der skifter fra kald til kald: samme prompt hver
// gang, så den kan genbruges fra cachen og bruger mindre af grænsen.
function systemText() {
  const catalog = SEED
    .filter((e) => e.cat !== 'nonfood')
    // Alle synonymer med, ikke kun de første 6: "lammeculotte" står som
    // nr. 9 på listen for 'lam', og en afkortning fik modellen til aldrig at
    // se den — så den skrev "lammekød" (note: "culotte") i stedet.
    .map((e) => `- ${e.name}${e.da && e.da.length ? ` (${e.da.join(', ')})` : ''}`)
    .sort((a, b) => a.localeCompare(b, 'da'))
    .join('\n');
  return INSTRUCTIONS + catalog;
}

function userMessage(src) {
  return [
    `Kilde: ${src.lang === 'en' ? 'engelsk' : 'dansk'}`,
    `Titel: ${src.title}`,
    `Portioner: ${src.yield_count ?? 'ikke oplyst'}`,
    '',
    'Ingredienser:',
    ...src.ingredients.map((l) => `- ${l}`),
    '',
    'Fremgangsmåde:',
    ...src.steps.map((s, i) => `${i + 1}. ${s.section ? `[${s.section}] ` : ''}${s.text}`),
  ].join('\n');
}

/** Ét kald til CLI'en. Svarer { output, model } eller { error, limit }. */
function ask(src, { model = DEFAULT_MODEL } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json',
      '--json-schema', JSON.stringify(RECIPE_SCHEMA),
      // ~12.900 tegn (systemText + skema) — et godt stykke under Windows'
      // grænse på 32.767 for en kommandolinje. Vokser kataloget meget, skal
      // den i en fil eller flyttes til stdin-beskeden (se testen for grænsen).
      '--system-prompt', systemText(),
      '--tools', '', '--setting-sources', '', '--strict-mcp-config',
      '--no-session-persistence', '--model', model];
    // En tom mappe: ingen CLAUDE.md eller projektfiler må farve svaret.
    const child = spawn(claudeBin(), args, { cwd: os.tmpdir() });
    let out = '';
    let err = '';
    // setEncoding og ikke Buffer + '': et æ, der deles mellem to bidder,
    // ville ellers blive til to ødelagte tegn.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ error: `claude kunne ikke startes: ${e.message}` }));
    child.on('close', (code) => {
      let res;
      try { res = JSON.parse(out); } catch {
        return resolve({ error: `uventet svar (kode ${code}): ${(err || out).trim().slice(0, 300)}` });
      }
      if (limitHit(res)) return resolve({ error: String(res.result || 'grænsen er nået'), limit: true });
      if (res.is_error || res.subtype !== 'success' || !res.structured_output) {
        return resolve({ error: String(res.result || res.subtype || 'intet svar').slice(0, 300) });
      }
      resolve({ output: res.structured_output, model: generatingModel(res.modelUsage, model) });
    });
    child.stdin.end(userMessage(src));
  });
}

// ── Egne ord, målt ──────────────────────────────────────────────────────────
//
// Det er de egne ord i fremgangsmåden, der gør det forsvarligt at udelade
// kreditering (brugerens beslutning 2026-09-30) — og prompten kan kun BEDE om
// dem. Derfor måles hver udgave mod kildens trin: hvor stor en del af
// udgavens 5-ords-sekvenser står også hos kilden, og hvor lang er den længste
// fælles ordrække. Tallene bliver i tmp/omskrivning/ (gitignoret) og kommer
// aldrig i udgavens JSON: filen er appens opskrift, ikke et regnskab over kilden.

// Over dette er udgaven for tæt på kilden og skal skrives igen. 15 % fælles
// 5-ords-sekvenser er langt over, hvad to selvstændige beskrivelser af samme
// ret deler ("i en gryde ved middel varme"); 12 ord i træk er en sætning.
const OVERLAP_MAX_SHARE = 0.15;
const OVERLAP_MAX_RUN = 12;
const NGRAM = 5;

/** Trinenes ord: små bogstaver, uden tegnsætning. Trin er strenge eller { text }. */
function wordsOf(steps) {
  return (steps || [])
    .map((s) => (typeof s === 'string' ? s : (s && s.text) || ''))
    .join(' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

/**
 * Hvor meget af udgavens fremgangsmåde står også hos kilden?
 *
 *   share    andelen af udgavens 5-ords-sekvenser, der også findes i kildens
 *            trin (0–1). Trinene læses som én tekst, så en sætning, der er
 *            flyttet til et andet trin, tæller med.
 *   longest  den længste ordrække, de to har til fælles.
 */
function overlap(sourceSteps, editionSteps) {
  const a = wordsOf(sourceSteps);
  const b = wordsOf(editionSteps);

  const grams = new Set();
  for (let i = 0; i + NGRAM <= a.length; i++) grams.add(a.slice(i, i + NGRAM).join(' '));
  let total = 0;
  let shared = 0;
  for (let i = 0; i + NGRAM <= b.length; i++) {
    total++;
    if (grams.has(b.slice(i, i + NGRAM).join(' '))) shared++;
  }

  // Længste fælles delsekvens af ord, én række ad gangen: et par hundrede ord
  // på hver side er få tusinde celler.
  let longest = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > longest) longest = cur[j];
      }
    }
    prev = cur;
  }
  return { share: total ? shared / total : 0, longest };
}

/** Er udgaven for tæt på kilden til at blive stående? */
const tooClose = (o) => o.share > OVERLAP_MAX_SHARE || o.longest >= OVERLAP_MAX_RUN;

/**
 * Målingen for én skrevet udgave: lægges i overlap.jsonl og siges højt, hvis
 * den er for tæt på. Svarer målingen, så kalderen kan samle listen.
 */
function recordOverlap(src, answer) {
  const o = overlap(src.steps, answer.output && answer.output.steps);
  const row = { id: src.id, url: src.url, share: Math.round(o.share * 1000) / 1000, longest: o.longest };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, 'overlap.jsonl'), `${JSON.stringify(row)}\n`);
  if (tooClose(o)) {
    console.log(`  for tæt på kilden: ${src.id} · ${(o.share * 100).toFixed(0)} % fælles 5-ords-sekvenser · ${o.longest} ord i træk`);
  }
  return { ...row, close: tooClose(o) };
}

/** Listen til sidst: de udgaver, der skal skrives igen, og kommandoen, der gør det. */
function reportClose(close) {
  if (!close.length) return;
  console.log(`\nFor tæt på kilden (${close.length}) — skriv dem igen:`);
  console.log(`npm run recipes:rewrite -- run --force --ids ${close.join(',')}`);
}

function writeEdition(src, answer) {
  const ed = {
    url: src.url, source: src.source, source_name: src.source_name,
    edition: EDITION, model: answer.model, written_at: new Date().toISOString(),
    // Tiderne er kildens, læst af times.js — ikke modellens.
    total_minutes: src.total_minutes ?? null,
    active_minutes: src.active_minutes ?? null,
    yield_count: src.yield_count ?? null,
    ...answer.output,
  };
  const file = editionPath(src.source, src.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ed, null, 2)}\n`);
  return file;
}

/** De opskrifter, der har råmateriale, men endnu ingen dansk udgave. */
function pending(args) {
  let rows = getDb().prepare('SELECT id, url, source FROM recipes ORDER BY id').all();
  const ids = argValue(args, '--ids');
  const source = argValue(args, '--source');
  const limit = Number(argValue(args, '--limit')) || Infinity;
  const force = args.includes('--force');
  if (ids) { const want = new Set(ids.split(',').map(Number)); rows = rows.filter((r) => want.has(r.id)); }
  if (source) rows = rows.filter((r) => r.source === source);

  const out = [];
  for (const r of rows) {
    const file = sourcePath(r.source, r.url);
    if (!fs.existsSync(file)) continue;
    if (!force && fs.existsSync(editionPath(r.source, r.url))) continue;
    out.push({ ...JSON.parse(fs.readFileSync(file, 'utf8')), id: r.id });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Køen: `parallel` kald ad gangen, til alt er skrevet, grænsen er nået, eller
 * CLI'en er holdt op med at virke. `ask(src)` svarer som ask(); `onOk(src,
 * answer)` gemmer en udgave. Svarer `{ failed, stopped, broken }`.
 *
 * Fem fejl i træk er ikke fem dårlige opskrifter, men en CLI, der ikke
 * virker: en ændret grænsebesked, et udløbet login, en ny version. Uden
 * stoppet fejlede hver eneste resterende opskrift på et sekund, og linjen til
 * at køre dem igen blev 2.000 id'er lang. En udgave, der lykkes, nulstiller
 * tællingen; grænsen tæller ikke med — den har sin egen udgang.
 */
async function drain(todo, { parallel = 1, ask: askOne, onOk }) {
  const failed = [];
  let next = 0;
  let stopped = null;
  let broken = null;
  let errorsInARow = 0;

  async function worker() {
    while (!stopped && !broken && next < todo.length) {
      const src = todo[next++];
      const answer = await askOne(src);
      if (answer.limit) { stopped = answer.error; break; }
      if (answer.error) {
        failed.push({ id: src.id, why: answer.error });
        if (++errorsInARow >= MAX_ERRORS_IN_A_ROW) broken = answer.error;
        continue;
      }
      errorsInARow = 0;
      onOk(src, answer);
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  return { failed, stopped, broken };
}

async function run(args) {
  const todo = pending(args);
  if (!todo.length) { console.log('Intet at omskrive.'); return; }
  const model = argValue(args, '--model') || DEFAULT_MODEL;
  // Et par kald ad gangen går hurtigere, men når grænsen tilsvarende hurtigere.
  const parallel = Math.max(1, Number(argValue(args, '--parallel')) || 1);
  const started = Date.now();
  const close = [];
  let ok = 0;

  const { failed, stopped, broken } = await drain(todo, {
    parallel,
    ask: (src) => ask(src, { model }),
    onOk: (src, answer) => {
      writeEdition(src, answer);
      if (recordOverlap(src, answer).close) close.push(src.id);
      if (++ok % 10 === 0) {
        const sec = (Date.now() - started) / 1000 / ok;
        console.log(`  ${ok}/${todo.length} · ${sec.toFixed(0)} s pr. opskrift`);
      }
    },
  });

  const perRecipe = ok ? ((Date.now() - started) / 1000 / ok).toFixed(0) : '–';
  console.log(`${ok} danske udgaver skrevet · ${failed.length} fejlede · ${perRecipe} s pr. opskrift`);
  for (const f of failed.slice(0, 30)) console.log(`  ${f.id}: ${f.why}`);
  if (failed.length) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'fejl.json'), JSON.stringify(failed, null, 2));
    console.log(`Kør dem igen: npm run recipes:rewrite -- run --force --ids ${failed.map((f) => f.id).join(',')}`);
  }
  reportClose(close);
  if (broken) {
    console.log(`\n${MAX_ERRORS_IN_A_ROW} fejl i træk — kørslen er stoppet. Den sidste: ${broken}`);
    console.log('Se, om claude virker (login, version), og start samme kommando igen — den fortsætter, hvor den slap.');
  }
  if (stopped) {
    console.log(`\nAbonnementets grænse er nået: ${stopped}`);
    console.log('Start samme kommando igen, når grænsen er nulstillet — den fortsætter, hvor den slap.');
  }
}

async function one(id, args) {
  const r = getDb().prepare('SELECT id, url, source FROM recipes WHERE id = ?').get(Number(id));
  if (!r) throw new Error(`Ukendt opskrift ${id}`);
  const src = { ...JSON.parse(fs.readFileSync(sourcePath(r.source, r.url), 'utf8')), id: r.id };
  const answer = await ask(src, { model: argValue(args, '--model') || DEFAULT_MODEL });
  if (answer.error) throw new Error(`${id}: ${answer.error}`);
  console.log(`Skrevet: ${path.relative(process.cwd(), writeEdition(src, answer))} (${answer.model})`);
  if (recordOverlap(src, answer).close) reportClose([src.id]);
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'run') return run(args);
  if (cmd === 'one') return one(args[0], args.slice(1));
  console.log('Brug: run [--limit N] [--source S] [--ids 1,2] [--force] [--parallel N] [--model M] | one <id>');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('[FEJL]', e.message); process.exit(1); });
}

module.exports = {
  newestClaude, limitHit, generatingModel, systemText, userMessage,
  overlap, OVERLAP_MAX_SHARE, OVERLAP_MAX_RUN, drain, MAX_ERRORS_IN_A_ROW,
};
