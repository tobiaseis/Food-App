'use strict';

/**
 * Tests for src/recipes/: kobling, tider, fremgangsmåde, den danske udgave og
 * indlæsningen af den.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIngredient } = require('../src/recipes/extract');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('dyret i et sammensat kødord bestemmer varen', () => {
  // "lammeculotte" blev til Bøf/steak, og appen foreslog at købe bøf på
  // tilbud til en lammeret. Det generiske stykke (culotte, mørbrad) må kun
  // vinde, når der ikke står et dyr foran.
  const cases = [
    ['600 g lammeculotte', 'lam'],
    ['500 g lammemørbrad', 'lam'],
    ['400 g lammeinderlår', 'lam'],
    ['1 kg lammeskulder', 'lam'],
    ['500 g hakket lammekød', 'lam'],
    ['600 g kalveculotte', 'kalvekoed'],
    ['500 g kalvemørbrad', 'kalvekoed'],
    ['500 g oksemørbrad', 'oksemoerbrad'],
    ['500 g svinemørbrad', 'svinemoerbrad'],
    ['600 g culotte', 'boef'],
  ];
  for (const [raw, key] of cases) assert.equal(parseIngredient(raw).item_key, key, raw);
});

const { danishMinutes, labelledTimes, pickTimes } = require('../src/recipes/times');
const { extractRecipe } = require('../src/recipes/extract');

test('timer og minutter på dansk', () => {
  assert.equal(danishMinutes('1 t. 30 min.'), 90);
  assert.equal(danishMinutes('1 time og 30 min'), 90);
  assert.equal(danishMinutes('2 timer'), 120);
  assert.equal(danishMinutes('45 min.'), 45);
  assert.equal(danishMinutes('ingen tid'), null);
  assert.deepEqual(labelledTimes('Tid i alt 1 t. 30 min. Arbejdstid 15 min. Antal 4 pers.'),
    { total: 90, active: 15 });
});

test('Valdemarsros etiketter vinder over deres byttede schema.org-felter', () => {
  // Siden: "Tid i alt 45 min. Arbejdstid 30 min." — men markup'en siger
  // cookTime = PT45M og totalTime = PT30M. Læste vi totalTime, blev
  // arbejdstiden til tiden i alt.
  const labelled = labelledTimes('Tid i alt 45 min. Arbejdstid 30 min. Antal 4 pers.');
  assert.deepEqual(labelled, { total: 45, active: 30 });
  assert.deepEqual(pickTimes({ labelled, prep: null, cook: 45, total: 30 }),
    { total_minutes: 45, active_minutes: 30 });
});

test('uden etiketter: tid i alt fra schema.org, arbejdstid fra forberedelsen', () => {
  const none = { total: null, active: null };
  // Arla: prepTime PT30M, cookTime PT00M, totalTime PT1H15M.
  assert.deepEqual(pickTimes({ labelled: none, prep: 30, cook: 0, total: 75 }),
    { total_minutes: 75, active_minutes: 30 });
  // Uden totalTime: forberedelse + tilberedning.
  assert.deepEqual(pickTimes({ labelled: none, prep: 15, cook: 50, total: null }),
    { total_minutes: 65, active_minutes: 15 });
  // En arbejdstid over tiden i alt er to felter i byttet rækkefølge.
  assert.deepEqual(pickTimes({ labelled: { total: 20, active: 60 } }),
    { total_minutes: 60, active_minutes: 20 });
  assert.deepEqual(pickTimes({ labelled: none }), { total_minutes: null, active_minutes: null });
});

test('teaserkasse før opskriften påvirker ikke tiderne', () => {
  // En side med "Relaterede opskrifter" før selve opskriften. Hvis vi læser hele
  // siden ufiltreret, får vi teaserens tider (20/10), ikke opskriftens (45/30).
  // extractRecipe skal scope til Recipe-elementet så teaserens tider ignoreres.
  const html = `
    <html>
    <head><title>Lammeculotte</title></head>
    <body>
    <h1>Lammeculotte</h1>
    <div class="related-recipes">
      <h2>Relaterede opskrifter</h2>
      <div class="recipe-teaser">
        <h3>Kyllingelasagne</h3>
        <p>Tid i alt 20 min. Arbejdstid 10 min.</p>
      </div>
    </div>
    <div itemtype="http://schema.org/Recipe">
      <span itemprop="name">Lammeculotte</span>
      <span itemprop="recipeIngredient">600 g lammeculotte</span>
      <div class="recipe-info">
        Tid i alt 45 min. Arbejdstid 30 min.
        <span itemprop="cookTime">PT45M</span>
        <span itemprop="totalTime">PT30M</span>
      </div>
      <span itemprop="recipeInstructions">Tilbered lammekødet.</span>
    </div>
    </body>
    </html>
  `;
  const recipe = extractRecipe(html, 'https://example.com/lammeculotte');
  assert.equal(recipe.total_minutes, 45, 'tid i alt skal være 45, ikke 20 fra teaseren');
  assert.equal(recipe.active_minutes, 30, 'arbejdstid skal være 30, ikke 10 fra teaseren');
});

const { getDb, setSetting } = require('../src/db');

test('basen har kolonnerne og tabellen til den danske udgave', () => {
  const db = getDb();
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['active_minutes', 'intro', 'edition', 'edition_hash', 'edited_at', 'changes']) {
    assert.ok(cols('recipes').includes(c), `recipes.${c}`);
  }
  for (const c of ['section', 'label']) assert.ok(cols('recipe_ingredients').includes(c), `recipe_ingredients.${c}`);
  assert.deepEqual(cols('recipe_steps'), ['recipe_id', 'position', 'section', 'text']);
});

test('uden dansk udgave er retten ude af madplanen, når indstillingen er sat', () => {
  const db = getDb();
  const plans = require('../src/mealplan/generate');
  const now = new Date().toISOString();
  // loadRecipes tager kun retter med mindst tre kendte varer — derfor tre linjer.
  const line = db.prepare(`INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional)
                           VALUES (?, ?, ?, ?, ?, ?, 0)`);
  const add = (url, edition) => {
    const id = Number(db.prepare(`
      INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at, edition)
      VALUES (?, 'test', 'Test', ?, 'da', 4, ?, ?)`).run(url, url, now, edition).lastInsertRowid);
    [['kyllingebryst', 0.5], ['kartofler', 0.6], ['loeg', 0.1]]
      .forEach(([key, amount], i) => line.run(id, `${amount} ${key}`, key, i, key, amount));
    return id;
  };
  const a = add('https://test.invalid/edition-ja', 1);
  const b = add('https://test.invalid/edition-nej', null);
  try {
    const ids = () => new Set(plans.loadRecipes({}).map((r) => r.id));
    assert.ok(ids().has(b), 'uden indstillingen er alle med');
    setSetting('recipes_edition_only', true);
    assert.ok(ids().has(a) && !ids().has(b), 'med indstillingen kun de danske');
  } finally {
    setSetting('recipes_edition_only', false);
    db.prepare('DELETE FROM recipes WHERE id IN (?, ?)').run(a, b);
  }
});

const { stepsFromJsonLd, stepsFromMicrodata } = require('../src/recipes/instructions');
const { slugOf } = require('../src/recipes/edition');

test('fremgangsmåden fra JSON-LD: trin, afsnit og Arlas "type" uden @', () => {
  const steps = stepsFromJsonLd([
    { type: 'HowToSection', name: 'First instruction', itemListElement: [
      { type: 'HowToStep', text: 'Varm olien.' },
      { '@type': 'HowToStep', text: 'Brun kyllingen.' }] },
    { '@type': 'HowToSection', name: 'Til saucen', itemListElement: [
      { '@type': 'HowToStep', text: 'Rør fløden i.' }] },
  ]);
  assert.deepEqual(steps, [
    { section: null, text: 'Varm olien.' },
    { section: null, text: 'Brun kyllingen.' },
    { section: 'Til saucen', text: 'Rør fløden i.' },
  ]);
  assert.deepEqual(stepsFromJsonLd('Heat the oil.\nAdd the onions.'),
    [{ section: null, text: 'Heat the oil.' }, { section: null, text: 'Add the onions.' }]);
});

test('fremgangsmåden fra microdata (Valdemarsro)', () => {
  const html = `<div itemscope itemtype="http://schema.org/Recipe">
    <p itemprop="recipeInstructions">Kom salt og <b>hvidløg</b> i en morter.</p>
    <p itemprop="recipeInstructions">Steg kødet.</p></div>`;
  assert.deepEqual(stepsFromMicrodata(html), [
    { section: null, text: 'Kom salt og hvidløg i en morter.' },
    { section: null, text: 'Steg kødet.' },
  ]);
});

test('fremgangsmåden fra microdata: indlejret element med samme tagnavn afkorter ikke', () => {
  // Dagens Valdemarsro-markup: alt i én <div itemprop="recipeInstructions">.
  // En ikke-grådig backreference-regex ville stoppe ved boksens </div> og
  // tabe trinnet efter den.
  const html = `<div itemscope itemtype="http://schema.org/Recipe">
    <div itemprop="recipeInstructions">
      <p>Varm panden op.</p>
      <div class="tip">Se video her.</div>
      <p>Vend kødet efter to minutter.</p>
    </div>
  </div>`;
  const steps = stepsFromMicrodata(html);
  assert.deepEqual(steps.map((s) => s.text),
    ['Varm panden op.', 'Vend kødet efter to minutter.']);
});

test('fremgangsmåden fra microdata: <p> og <ul><li> i samme boks bliver hvert sit trin', () => {
  const html = `<div itemscope itemtype="http://schema.org/Recipe">
    <div itemprop="recipeInstructions">
      <p>Krydr kødet.</p>
      <p>Intervalsteges efter følgende metode:</p>
      <ul>
        <li>Steg i 10 minutter.</li>
        <li>Hvil i 10 minutter.</li>
      </ul>
      <p>Skæres i skiver inden servering.</p>
    </div>
  </div>`;
  assert.deepEqual(stepsFromMicrodata(html), [
    { section: null, text: 'Krydr kødet.' },
    { section: null, text: 'Intervalsteges efter følgende metode:' },
    { section: null, text: 'Steg i 10 minutter.' },
    { section: null, text: 'Hvil i 10 minutter.' },
    { section: null, text: 'Skæres i skiver inden servering.' },
  ]);
});

test('fremgangsmåden fra microdata: en <li> med sin egen under-liste mister ikke tekst', () => {
  // Samme fejlklasse som boksen i "indlejret element..."-testen ovenfor, men
  // ét niveau nede: et enkelt trin har sin egen <ul><li> midt i sig (fx en
  // intervalmetode), og alt efter under-listen skal stadig være med i det
  // ÉNE trin — ikke splittet op i flere trin, og ikke tabt.
  const html = `<div itemscope itemtype="http://schema.org/Recipe">
    <ul itemprop="recipeInstructions">
      <li>Intervalmetode:<ul><li>Steg i 10 min.</li><li>Hvil i 10 min.</li></ul>Herefter serveres.</li>
    </ul>
  </div>`;
  const steps = stepsFromMicrodata(html);
  assert.equal(steps.length, 1, 'under-listen må ikke splittes op i egne trin');
  for (const part of ['Intervalmetode:', 'Steg i 10 min.', 'Hvil i 10 min.', 'Herefter serveres.']) {
    assert.ok(steps[0].text.includes(part), `mangler "${part}" i: ${steps[0].text}`);
  }
});

test('fremgangsmåden fra microdata: løs tekst mellem to blokke bliver også et trin', () => {
  const html = `<div itemscope itemtype="http://schema.org/Recipe">
    <div itemprop="recipeInstructions"><p>Et.</p>Mellemtekst.<p>To.</p></div>
  </div>`;
  assert.deepEqual(stepsFromMicrodata(html), [
    { section: null, text: 'Et.' },
    { section: null, text: 'Mellemtekst.' },
    { section: null, text: 'To.' },
  ]);
});

test('filnavnet er stabilt og unikt pr. URL', () => {
  const a = 'https://www.valdemarsro.dk/lammeculotte/';
  assert.equal(slugOf(a), slugOf(a));
  assert.match(slugOf(a), /^lammeculotte-[0-9a-f]{6}$/);
  assert.notEqual(slugOf('https://x.test/a/lasagne'), slugOf('https://x.test/b/lasagne'));
});

const { lineOf, labelOf, UNITS, RECIPE_SCHEMA } = require('../src/recipes/edition');

test('den danske linje læses tilbage til samme vare og mængde', () => {
  const kb = parseIngredient(lineOf({ amount: 400, unit: 'g', name: 'kyllingebryst', note: 'i strimler', optional: false }));
  assert.equal(kb.item_key, 'kyllingebryst');
  near(kb.amount, 0.4);
  assert.equal(parseIngredient(lineOf({ amount: 1.5, unit: 'dl', name: 'piskefløde', note: null, optional: false })).qty, 1.5);
  // Valgfri står bagerst: "evt." forrest ville skygge for mængden.
  const opt = parseIngredient(lineOf({ amount: 100, unit: 'g', name: 'bacon', note: null, optional: true }));
  assert.equal(opt.optional, 1);
  near(opt.amount, 0.1);
  assert.equal(labelOf({ name: 'kyllingebryst', note: 'i strimler' }), 'kyllingebryst, i strimler');
});

test('skemaet kender kun enheder, parseIngredient kan læse', () => {
  for (const u of UNITS) {
    const p = parseIngredient(`2 ${u} løg`);
    assert.equal(p.unit, u, `enheden ${u} læses ikke`);
  }
  assert.equal(RECIPE_SCHEMA.additionalProperties, false);
});

const { newestClaude, limitHit, generatingModel, systemText } = require('../src/recipes/rewrite');

test('den nyeste Claude Code i VS Code-udvidelserne vælges — efter versionsnummer', () => {
  assert.equal(newestClaude([
    'anthropic.claude-code-2.1.99-win32-x64',
    'anthropic.claude-code-2.1.285-win32-x64',
    'ms-python.python-2026.1.0',
  ]), 'anthropic.claude-code-2.1.285-win32-x64');
  assert.equal(newestClaude(['ms-python.python-2026.1.0']), null);
});

test('abonnementets grænse genkendes, andre fejl gør ikke', () => {
  assert.equal(limitHit({ is_error: true, api_error_status: 429, result: 'x' }), true);
  assert.equal(limitHit({ is_error: true, result: 'Claude usage limit reached|1759300000' }), true);
  assert.equal(limitHit({ is_error: true, result: 'Invalid JSON schema' }), false);
  assert.equal(limitHit({ is_error: false, result: 'usage limit' }), false);
});

test('den model, der skrev svaret, er den med flest outputTokens — ikke den første nøgle i modelUsage', () => {
  // En hjælpemodel (fx til selve skema-udtrækket) stod først i modelUsage
  // med få tokens; filens model-felt endte med at pege på den i stedet for
  // den model, der rent faktisk skrev opskriften.
  assert.equal(generatingModel({
    'claude-haiku-4-5-20251001': { inputTokens: 906, outputTokens: 14 },
    'claude-sonnet-5-5': { inputTokens: 2, outputTokens: 93, cacheCreationInputTokens: 1077 },
  }, 'sonnet'), 'claude-sonnet-5-5');
  assert.equal(generatingModel({}, 'sonnet'), 'sonnet');
});

test('varekataloget i systemprompten har udskæringsnavne, og kommandolinjen er et godt stykke under Windows-grænsen', () => {
  const st = systemText();
  // "lammeculotte" stod som nr. 9 i 'lam'-varens da-liste; en afkortning til
  // de første 6 synonymer fik modellen til aldrig at se den.
  assert.ok(st.includes('lammeculotte'), 'lammeculotte mangler i kataloget');
  const size = st.length + JSON.stringify(RECIPE_SCHEMA).length;
  assert.ok(size < 28000, `--system-prompt + --json-schema er ${size} tegn, for tæt på Windows' grænse på 32.767`);
});
