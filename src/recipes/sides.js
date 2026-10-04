'use strict';

/**
 * Hele måltider: spørger Claude Code (headless, på brugerens abonnement — som
 * rewrite.js), om hver aftensret er et helt måltid, og hvis ikke, hvilket
 * klassisk tilbehør der mangler. Svaret gemmes i udgavens fil som `meal`;
 * import-da.js lægger tilbehøret ind i opskriften.
 *
 *   npm run recipes:sides -- run [--limit N] [--ids 1,2] [--force] [--parallel N] [--model M]
 *   npm run recipes:sides -- one <recipe_id> [--model M]
 *
 * En udgave, der allerede har `meal`, springes over (medmindre --force), så en
 * afbrudt kørsel fortsætter, hvor den slap.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { UNITS, MEAL_SCHEMA, editionPath, lineOf } = require('./edition');
const { askClaude, drain, reportStops, argValue } = require('./rewrite');

// En enkel ja/nej-vurdering plus en lille tilbehørsopskrift: Haiku er nok og
// sparer abonnementets grænse. --model sonnet, hvis den tager fejl for ofte.
const DEFAULT_MODEL = 'haiku';

// Fast tekst, uden noget der skifter fra kald til kald, så den kan genbruges
// fra cachen. Enhederne kommer fra UNITS, så prompt og skema aldrig skilles.
const INSTRUCTIONS = `Du er redaktør på en dansk madplan-app. Du får en aftensret fra appen og vurderer, om den er et helt måltid.

VURDERING
Er retten et helt aftensmåltid for en dansk husstand? Et helt måltid har en hovedråvare og noget mættende (kartofler, ris, pasta, brød, korn, dej, bønner) eller rigeligt grønt. Supper, gryderetter, pastaretter, tærter, pizza, wraps og salater med protein og stivelse eller rigeligt grønt er hele måltider.
- complete er true, hvis retten er et helt måltid; side er så null.
- reason er én kort sætning om hvorfor.

TILBEHØR (kun hvis retten ikke er et helt måltid)
- Foreslå ÉT enkelt, klassisk tilbehør, der passer til retten og køkkenet: fx kogte kartofler, ris, brød eller grøn salat – eller to af dem, når det er det naturlige, fx kartofler og salat.
- Mængderne er til rettens eget antal portioner.
- Højst 4 ingredienser og højst 3 korte trin i bydeform.
- Brug kun disse enheder: ${UNITS.join(', ')} – eller null, når linjen ikke har en mængde.
- Skriv varenavnene med småt, som de hedder i et dansk supermarked (kartofler, ris, grøn salat – ikke Kartofler).
- Skriv ikke salt, peber, olie eller smør som ingredienslinjer – de står i køkkenet i forvejen. Kun hvis tilbehøret ikke kan laves uden, fx smør til kartoffelmos.
- Ingen mængder i trinene.
- section og note er null, og optional er false.

EKSEMPEL på et godt tilbehør (4 portioner)
title: Kogte kartofler og grøn salat
ingredienser: 1 kg kartofler; 1 stk hovedsalat
trin: 1. Skræl kartoflerne, og kog dem møre i letsaltet vand. 2. Vask salaten, riv den i stykker, og server den til kartoflerne.
`;

function systemText() { return INSTRUCTIONS; }

/** Ret og portioner, ingredienslinjerne og trinene — fra udgaven, ikke fra kilden. */
function userMessage(ed) {
  return [
    `Titel: ${ed.title}`,
    `Portioner: ${ed.servings ?? 'ikke oplyst'}`,
    '',
    'Ingredienser:',
    ...(ed.ingredients || []).map((i) => `- ${lineOf(i)}`),
    '',
    'Fremgangsmåde:',
    ...(ed.steps || []).map((s, i) => `${i + 1}. ${s.text}`),
  ].join('\n');
}

const readEdition = (r) => {
  const file = editionPath(r.source, r.url);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

/**
 * De retter, der skal vurderes: aftensretter med dansk udgave, uden `meal`
 * (medmindre force). `read` kan skiftes ud i tests, så de ikke rør filer.
 * Svarer [{ recipe, edition }] — ret i basen og udgavens indhold.
 */
function pendingMeals(recipes, items, { ids = null, force = false, limit = Infinity, isDinner, read = readEdition } = {}) {
  const want = ids ? new Set(ids) : null;
  const out = [];
  for (const r of recipes) {
    if (want && !want.has(r.id)) continue;
    if (!isDinner(r, items)) continue;
    const edition = read(r);
    if (!edition) continue;
    if (!force && edition.meal) continue;
    out.push({ recipe: r, edition });
    if (out.length >= limit) break;
  }
  return out;
}

// Basisvarer, modellen alligevel skriver ind: de står i køkkenet og må ikke
// komme på indkøbslisten. Kun navnet som hele linjen — "smør" i "peanutsmør" rører vi ikke.
const PANTRY = new Set(['salt', 'peber', 'olie', 'olivenolie', 'smør']);

/**
 * Retter modellens tilbehør til, før det gemmes: varenavne med småt (modellen
 * skriver "Kartofler" trods prompten), og basisvarelinjer droppes — medmindre
 * de er tilbehørets eneste linje. Resten af teksten er uændret.
 */
function cleanSide(side) {
  if (!side) return side;
  const lines = side.ingredients.map((i) => ({ ...i, name: i.name.toLowerCase() }));
  const kept = lines.filter((i) => !PANTRY.has(i.name.trim()));
  return { ...side, ingredients: kept.length ? kept : lines };
}

/** Udgaven med `meal` sat; alt andet uændret. Nøglens plads bevares ved --force. */
function withMeal(edition, answer, now = new Date()) {
  const { complete, reason, side } = answer.output;
  return { ...edition, meal: { complete, reason, side: cleanSide(side), model: answer.model, checked_at: now.toISOString() } };
}

function writeMeal(recipe, edition, answer) {
  const file = editionPath(recipe.source, recipe.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(withMeal(edition, answer), null, 2)}\n`);
  return file;
}

const ask = (edition, model) => askClaude({
  system: systemText(), schema: MEAL_SCHEMA, input: userMessage(edition), model,
});

function context() {
  // Først her: sides.js' rene funktioner skal kunne indlæses i tests uden motoren.
  const { loadRecipes } = require('../mealplan/generate');
  const { isDinner } = require('../../public/engine');
  const items = new Map(getDb().prepare('select * from items').all().map((i) => [i.key, i]));
  return { recipes: loadRecipes({}), items, isDinner };
}

const describe = (m) => (m.complete ? 'helt måltid' : `tilbehør: ${m.side ? m.side.title : '(intet)'}`);

async function run(args) {
  const { recipes, items, isDinner } = context();
  const ids = argValue(args, '--ids');
  const todo = pendingMeals(recipes, items, {
    ids: ids ? ids.split(',').map(Number) : null,
    force: args.includes('--force'),
    limit: Number(argValue(args, '--limit')) || Infinity,
    isDinner,
  }).map((p) => ({ ...p, id: p.recipe.id }));
  if (!todo.length) { console.log('Intet at vurdere.'); return; }
  const model = argValue(args, '--model') || DEFAULT_MODEL;
  const parallel = Math.max(1, Number(argValue(args, '--parallel')) || 1);
  let ok = 0;
  let withSide = 0;

  const { failed, stopped, broken } = await drain(todo, {
    parallel,
    ask: (t) => ask(t.edition, model),
    onOk: (t, answer) => {
      writeMeal(t.recipe, t.edition, answer);
      if (!answer.output.complete) withSide++;
      if (++ok % 25 === 0) console.log(`  ${ok}/${todo.length}`);
    },
  });

  console.log(`${ok} vurderet · ${withSide} får tilbehør · ${failed.length} fejlede`);
  for (const f of failed.slice(0, 30)) console.log(`  ${f.id}: ${f.why}`);
  if (failed.length) console.log(`Kør dem igen: npm run recipes:sides -- run --ids ${failed.map((f) => f.id).join(',')}`);
  reportStops({ stopped, broken });
}

async function one(id, args) {
  const { recipes, items, isDinner } = context();
  const r = recipes.find((x) => x.id === Number(id));
  if (!r) throw new Error(`Opskrift ${id} er ikke i madplanens opskrifter`);
  const edition = readEdition(r);
  if (!edition) throw new Error(`${id} har ingen dansk udgave`);
  if (!isDinner(r, items)) console.log(`(${id} er ikke en aftensret efter motoren — vurderes alligevel)`);
  const answer = await ask(edition, argValue(args, '--model') || DEFAULT_MODEL);
  if (answer.error) throw new Error(`${id}: ${answer.error}`);
  const file = writeMeal(r, edition, answer);
  console.log(`Skrevet: ${path.relative(process.cwd(), file)} (${answer.model}) · ${describe(answer.output)}`);
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'run') return run(args);
  if (cmd === 'one') return one(args[0], args.slice(1));
  console.log('Brug: run [--limit N] [--ids 1,2] [--force] [--parallel N] [--model M] | one <id>');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('[FEJL]', e.message); process.exit(1); });
}

module.exports = { systemText, userMessage, pendingMeals, withMeal, cleanSide, DEFAULT_MODEL };
