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

// Tilbehøret skal være lækkert og passe til retten (brugeren: "ordentlige og
// lækre måltider"), så kvaliteten vejer tungere end abonnementets grænse.
// --model haiku kan stadig vælges.
const DEFAULT_MODEL = 'sonnet';

// Fast tekst, uden noget der skifter fra kald til kald, så den kan genbruges
// fra cachen. Enhederne kommer fra UNITS, så prompt og skema aldrig skilles.
const INSTRUCTIONS = `Du er redaktør på en dansk madplan-app. Du får en aftensret fra appen og vurderer, om den er et helt måltid.

VURDERING
Er retten et helt aftensmåltid for en dansk husstand? Et helt måltid har en hovedråvare og noget mættende (kartofler, ris, pasta, brød, korn, dej, bønner) eller rigeligt grønt. Supper, gryderetter, pastaretter, tærter, pizza, wraps og salater med protein og stivelse eller rigeligt grønt er hele måltider.
- complete er true, hvis retten er et helt måltid; side er så null.
- reason er én kort sætning om hvorfor.

TILBEHØR (kun hvis retten ikke er et helt måltid)
- Foreslå ét rigtigt tilbehør, der passer til rettens køkken og smag – det, en god kogebog eller et måltidskassefirma ville servere til retten. Fx sprøde ovnkartofler med rosmarin, agurkesalat med dild, sesamnudler, ristet brød med hvidløgssmør, couscoussalat med citron, coleslaw, ovnbagte rodfrugter eller kartoffelmos med brunet smør.
- FORBUDT: ren kogte kartofler, ren kogt ris uden noget andet og en bar salat af ét blad (hovedsalat eller grøn salat alene). Giv altid tilbehøret smag: krydderurter, dressing, citron, hvidløg, ristede frø eller en stegt eller bagt tilberedning.
- Tilbehøret må ikke være bælgfrugter (bønner, ærter, linser, kikærter) eller æg – de kan blive forvekslet med rettens hovedråvare. Brug kartofler, ris, pasta, nudler, couscous, brød eller grønt som salat, gulerødder, broccoli.
- En sauce eller dressing er ikke tilbehør i sig selv, men må gerne være en del af tilbehøret.
- Mængderne er til rettens eget antal portioner.
- Højst 6 ingredienser og højst 4 korte trin i bydeform.
- Brug kun disse enheder: ${UNITS.join(', ')} – eller null, når linjen ikke har en mængde.
- Skriv varenavnene med småt, som de hedder i et dansk supermarked (kartofler, ris, grøn salat – ikke Kartofler).
- Salt og peber skal ikke stå som ingredienslinjer – de står i køkkenet i forvejen. Olie og smør skriver du, når tilbehøret kræver det (fx til ovnkartofler).
- Ingen mængder i trinene.
- section og note er null, og optional er false.

EKSEMPEL på et godt tilbehør (4 portioner)
title: Sprøde rosmarinkartofler og agurkesalat
ingredienser: 1 kg kartofler; 2 spsk olivenolie; 2 tsk rosmarin; 1 stk agurk; 2 spsk eddike; 1 dl dild
trin: 1. Skær kartoflerne i både, vend dem med olie, rosmarin og salt, og bag dem sprøde ved 220 grader i cirka 35 minutter. 2. Skær agurken i tynde skiver, og vend den med eddike, dild og en knivspids salt. 3. Server agurkesalaten til de varme kartofler.
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

// Salt og peber, modellen alligevel skriver ind: de står i køkkenet og må ikke
// komme på indkøbslisten. Olie og smør beholdes: et tilbehør som sprøde
// ovnkartofler kræver dem, og de er essentials, der alligevel kun havner på
// "tjek at du har". Kun navnet som hele linjen.
const PANTRY = new Set(['salt', 'peber']);

/**
 * Retter modellens tilbehør til, før det gemmes: varenavne med småt (modellen
 * skriver "Kartofler" trods prompten), og salt/peber-linjer droppes — medmindre
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
