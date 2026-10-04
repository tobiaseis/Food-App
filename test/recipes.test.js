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

// De danske udgavers navne for varer, taksonomien allerede havde (import-runde
// 2026-10-04). Uden dem talte importen "N ukendte linjer" og holdt udgaven
// tilbage, selvom den engelske linje var koblet til samme vare.
const DANISH_SYNONYMS = [
  ['oksekæber', 'oksekoed'],
  ['svinebov', 'flaeskesteg'], ['svineskulder', 'flaeskesteg'], ['svinebryst', 'flaeskesteg'],
  ['svinenakke', 'flaeskesteg'],
  ['gedeost', 'ost'],
  ['perleløg', 'loeg'],
  ['babysalatblade', 'salat'],
  ['østershatte', 'champignon'],
  ['kinakål', 'kaal'], ['savoykål', 'kaal'], ['savojkål', 'kaal'],
  ['brombær', 'baer'], ['stikkelsbær', 'baer'],
  ['sushiris', 'ris'], ['fuldkornsris', 'ris'],
  ['speltmel', 'mel'], ['fuldkornsspeltmel', 'mel'], ['grahamsmel', 'mel'], ['kartoffelmel', 'mel'],
  ['focaccia', 'brod'], ['ciabatta', 'brod'],
  ['bagespray', 'olie'],
  ['sherryeddike', 'eddike'],
  ['glucosesirup', 'glukosesirup'],
  ['laurbærblad', 'krydderi'], ['kommenfrø', 'krydderi'], ['kommen', 'krydderi'],
  ['muskatblomme', 'muskatblomme'],
  ['mandelmel', 'noedder'], ['mandelflager', 'noedder'],
  ['tonic', 'sodavand'],
  ['portvin', 'vin'], ['sherry', 'vin'],
  ['rom', 'spiritus'], ['gin', 'spiritus'], ['tequila', 'spiritus'], ['pernod', 'spiritus'],
  ['vaniljepulver', 'vanilje'],
  ['valmuefrø', 'kerner_froe'], ['bukkehornsfrø', 'kerner_froe'], ['blandede kerner', 'kerner_froe'],
  ['ansjosfilet', 'ansjoser'],
  ['svesker', 'toerret_frugt'], ['tørret frugt', 'toerret_frugt'],
  ['stenfrugt', 'stenfrugt'],
  ['xanthangummi', 'fortykningsmiddel'],
  ['kaffirlimeblade', 'kaffirblade'],
  ['tørrede bukkehornsblade', 'fenugreekblade'], ['bukkehornsblade', 'fenugreekblade'],
];
for (const [word, key] of DANISH_SYNONYMS) {
  test(`det danske ord "${word}" kobles til ${key}`, () => {
    assert.equal(parseIngredient(`200 g ${word}`).item_key, key);
  });
}

test('de nye danske ord tager ikke en anden vares match', () => {
  // Hvert nyt ord er prøvet mod alle linjer i basen, udgaverne, kilderne og
  // tilbuddene. Her står de tilfælde, der ville være gået galt uden et værn.
  assert.equal(parseIngredient('2 tbsp sherry vinegar').item_key, 'eddike', "'sherry' tog eddiken");
  assert.equal(parseIngredient('1 spsk sherryeddike').item_key, 'eddike');
  assert.equal(parseIngredient('2 tsk spidskommen').item_key, 'krydderi');
  assert.notEqual(parseIngredient('0,5 dl solbærmarmelade').item_key, 'baer', 'marmelade er ikke bær');
  assert.notEqual(parseIngredient('6 enebær').item_key, 'baer', 'enebær er et krydderi');
  assert.notEqual(parseIngredient('1 tsk næringsgær').item_key, 'gaer', 'næringsgær hæver ikke');
  assert.notEqual(parseIngredient('2 tsk mandelaroma').item_key, 'noedder');
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
  // Tipboksens tekst er med: kildesiderne hentes én gang, og hvad der tabes
  // her, ser omskrivningen aldrig. Et "Se video her" for meget skriver
  // modellen selv ud; et manglende trin kan den ikke gætte.
  assert.deepEqual(steps.map((s) => s.text),
    ['Varm panden op.', 'Se video her.', 'Vend kødet efter to minutter.']);
});

test('fremgangsmåden fra microdata: tekst i en <span> mellem to blokke tabes ikke', () => {
  const html = `<div itemscope itemtype="http://schema.org/Recipe">
    <div itemprop="recipeInstructions">
      <p>Brun løget.</p>
      <span class="step">Tilsæt <b>tomaterne</b> og lad det simre i 20 minutter.</span>
      <p>Smag til.</p>
      <span>Server med ris.</span>
      <img src="x.jpg" alt="">
    </div>
  </div>`;
  assert.deepEqual(stepsFromMicrodata(html).map((s) => s.text), [
    'Brun løget.',
    'Tilsæt tomaterne og lad det simre i 20 minutter.',
    'Smag til.',
    'Server med ris.',
  ]);
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

test('"(valgfri)" overlever den natlige backfill:amounts', () => {
  // backfill:amounts kører EFTER recipes:import og klassificerer hver linje
  // igen. Havde den sin egen regel uden "(valgfri)", blev baconnet
  // obligatorisk hver nat. Scriptets egen funktion, ikke kun regexen.
  const { lineOptional } = require('../scripts/backfill-amounts');
  const { OPTIONAL_RE } = require('../src/recipes/extract');
  const line = lineOf({ amount: 100, unit: 'g', name: 'bacon', note: null, optional: true });
  assert.equal(line, '100 g bacon (valgfri)');
  assert.equal(lineOptional(line), 1);
  assert.ok(OPTIONAL_RE.test(line));
  assert.equal(lineOptional('100 g bacon'), 0);
  assert.equal(lineOptional('1 tbsp sesame seeds (optional)'), 1);
  assert.equal(lineOptional(null), 0);
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

const { overlap, OVERLAP_MAX_SHARE, OVERLAP_MAX_RUN, drain, MAX_ERRORS_IN_A_ROW } = require('../src/recipes/rewrite');

test('omskrivningen stopper efter fem fejl i træk — ikke efter 2.000', async () => {
  // En CLI, der er holdt op med at virke (udløbet login, ny version), fejler
  // hver opskrift på et sekund. Køen skal give op og sige den sidste fejl.
  const todo = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1 }));
  const asked = [];
  const res = await drain(todo, {
    parallel: 2,
    ask: async (src) => { asked.push(src.id); return { error: `login udløbet (${src.id})` }; },
    onOk: () => assert.fail('intet lykkes her'),
  });
  assert.equal(MAX_ERRORS_IN_A_ROW, 5);
  assert.ok(asked.length <= MAX_ERRORS_IN_A_ROW + 1, `${asked.length} kald`);
  assert.match(res.broken, /login udløbet/);
  assert.equal(res.failed.length, asked.length);
  assert.equal(res.stopped, null);

  // En udgave, der lykkes, nulstiller tællingen: fire fejl, én god, fire fejl
  // stopper ikke.
  const mixed = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({ id }));
  const done = [];
  const ok = await drain(mixed, {
    ask: async (src) => (src.id === 5 ? { output: {} } : { error: 'dårlig opskrift' }),
    onOk: (src) => done.push(src.id),
  });
  assert.equal(ok.broken, null);
  assert.deepEqual(done, [5]);
  assert.equal(ok.failed.length, 8);

  // Grænsen er sin egen udgang og tæller ikke som en fejl.
  const limit = await drain(mixed, {
    ask: async (src) => (src.id === 3 ? { error: 'usage limit', limit: true } : { output: {} }),
    onOk: () => {},
  });
  assert.equal(limit.stopped, 'usage limit');
  assert.equal(limit.failed.length, 0);
});

test('egne ord måles: fælles 5-ords-sekvenser og den længste fælles ordrække', () => {
  const kilde = [
    { section: null, text: 'Heat the oven to 200C. Season the chicken thighs with salt, pepper and paprika.' },
    { section: null, text: 'Roast for 35 minutes until golden and cooked through, then rest for five minutes.' },
  ];

  // Samme tekst: alt er fælles. Tegnsætning og store bogstaver tæller ikke,
  // og trin må gerne være strenge.
  const samme = overlap(kilde, kilde.map((s) => s.text.toUpperCase().replace(/[.,]/g, ' ; ')));
  assert.equal(samme.share, 1);
  assert.equal(samme.longest, 28);            // alle ord i begge trin

  // Skrevet om fra bunden: intet fælles.
  const egne = overlap(kilde, [
    'Tænd ovnen på 200 grader. Krydr kyllingeoverlårene godt med salt, peber og paprika.',
    'Steg dem cirka 35 minutter, til de er gyldne og gennemstegte. Lad dem hvile lidt.',
  ]);
  assert.equal(egne.share, 0);
  assert.ok(egne.longest < 3, `længste fælles række var ${egne.longest}`);

  // En sætning på syv ord taget med: den længste række er syv.
  const lånt = overlap(kilde, ['Krydr kødet godt.', 'Roast for 35 minutes until golden and — nej, steg det.']);
  assert.equal(lånt.longest, 7);
  assert.ok(lånt.share > 0 && lånt.share < 1);

  // Tomme trin giver ingen division med nul.
  assert.deepEqual(overlap([], []), { share: 0, longest: 0 });
  assert.ok(OVERLAP_MAX_SHARE === 0.15 && OVERLAP_MAX_RUN === 12);
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

const os = require('os');
const fs = require('fs');
const path = require('path');
const { importAll } = require('../src/recipes/import-da');

const EDITION_FIXTURE = {
  url: 'https://test.invalid/da-import-1', source: 'test', source_name: 'Test',
  edition: 1, model: 'test', written_at: '2026-09-30T12:00:00.000Z',
  total_minutes: 90, active_minutes: 15, yield_count: 4,
  title: 'Lammeculotte med krydderurter', intro: 'Mør lam med salvie.', servings: 4,
  ingredients: [
    { section: null, amount: 600, unit: 'g', name: 'lammeculotte', note: null, optional: false },
    { section: null, amount: 3, unit: 'fed', name: 'hvidløg', note: 'hakket', optional: false },
    { section: null, amount: null, unit: null, name: 'salt', note: null, optional: false },
  ],
  steps: [
    { section: null, text: 'Gnid kødet med hvidløg og salt.' },
    { section: null, text: 'Steg det i ovnen ved 180 °C.' },
  ],
  changes: [],
};

// yieldCount og description: det, kilden efterlod på retten før udgaven.
function withEdition(edition, fn, { yieldCount = 4, description = null } = {}) {
  const db = getDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opskrifter-'));
  fs.writeFileSync(path.join(dir, 'ret.json'), JSON.stringify(edition));
  const id = Number(db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, description, lang, servings, yield_count, fetched_at)
    VALUES (?, 'test', 'Test', 'Lamb rump', ?, 'en', 4, ?, ?)`)
    .run(edition.url, description, yieldCount, new Date().toISOString()).lastInsertRowid);
  const p = parseIngredient('600 g lamb rump', 0);
  db.prepare(`INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient, item_key, amount, optional, position)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(id, p.raw, p.qty, p.unit, p.ingredient, p.item_key, p.amount, p.optional);
  try { return fn({ db, dir, id }); } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('en dansk udgave læses ind: titel, tider, linjer og trin', () => {
  withEdition(EDITION_FIXTURE, ({ db, dir, id }) => {
    const first = importAll({ dir, log: () => {} });
    assert.equal(first.applied, 1);
    const r = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
    assert.equal(r.title, 'Lammeculotte med krydderurter');
    assert.equal(r.lang, 'da');
    assert.equal(r.edition, 1);
    assert.equal(r.total_minutes, 90);
    assert.equal(r.active_minutes, 15);
    const lines = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY position').all(id);
    assert.deepEqual(lines.map((l) => l.item_key), ['lam', 'hvidloeg', 'salt']);
    assert.equal(lines[1].label, 'hvidløg, hakket');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_steps WHERE recipe_id = ?').get(id).n, 2);
    // Anden gang er filen uændret og røres ikke.
    assert.equal(importAll({ dir, log: () => {} }).unchanged, 1);
  });
});

test('udgaven fjerner kildens description og udfylder et manglende yield_count', () => {
  // description er op til 500 tegn af kildens egen tekst, og release-assettets
  // data.db er offentlig, hvis repoet er. Og uden yield_count regner
  // reclassify portionerne fra en allerede regnet servings.
  withEdition({ ...EDITION_FIXTURE, servings: 6, yield_count: null }, ({ db, dir, id }) => {
    assert.equal(importAll({ dir, log: () => {} }).applied, 1);
    const r = db.prepare('SELECT description, yield_count, intro FROM recipes WHERE id = ?').get(id);
    assert.equal(r.description, null);
    assert.equal(r.yield_count, 6);
    assert.equal(r.intro, 'Mør lam med salvie.');
  }, { yieldCount: null, description: 'Tender lamb rump with a herb crust, from the source.' });

  // Et yield_count, kilden selv satte, bliver stående.
  withEdition({ ...EDITION_FIXTURE, servings: 6, yield_count: null }, ({ db, dir, id }) => {
    importAll({ dir, log: () => {} });
    assert.equal(db.prepare('SELECT yield_count FROM recipes WHERE id = ?').get(id).yield_count, 4);
  });
});

test('en udgave, der har flyttet hovedråvaren mere end 25 %, læses ikke ind', () => {
  const more = {
    ...EDITION_FIXTURE,
    url: 'https://test.invalid/da-import-3',
    ingredients: [{ section: null, amount: 900, unit: 'g', name: 'lammeculotte', note: null, optional: false },
                  ...EDITION_FIXTURE.ingredients.slice(1)],
  };
  withEdition(more, ({ dir }) => {
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.flagged, 1);
    assert.match(res.flaggedList[0].issues.join(), /lam: 600 → 900/);
  });
});

test('en udgave, der har skiftet hovedråvaren ud, læses ikke ind', () => {
  const swapped = {
    ...EDITION_FIXTURE,
    url: 'https://test.invalid/da-import-2',
    ingredients: [{ section: null, amount: 600, unit: 'g', name: 'svinemørbrad', note: null, optional: false },
                  ...EDITION_FIXTURE.ingredients.slice(1)],
  };
  withEdition(swapped, ({ db, dir, id }) => {
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.applied, 0);
    assert.equal(res.flagged, 1);
    assert.equal(db.prepare('SELECT title FROM recipes WHERE id = ?').get(id).title, 'Lamb rump');
  });
  // Godkendt i hånden: så læses den ind alligevel.
  withEdition({ ...swapped, accepted: true }, ({ dir }) => {
    assert.equal(importAll({ dir, log: () => {} }).applied, 1);
  });
});

test('en ødelagt fil stopper ikke resten af indlæsningen', () => {
  // Kørslen er natlig og ubemandet: én fil med ugyldig JSON må ikke vælte de
  // andre, gyldige udgaver i samme mappe.
  const good = { ...EDITION_FIXTURE, url: 'https://test.invalid/da-import-5' };
  withEdition(good, ({ db, dir, id }) => {
    // 'a-bad.json' sorteres alfabetisk før withEdition's egen 'ret.json', så
    // den ugyldige fil læses først.
    fs.writeFileSync(path.join(dir, 'a-bad.json'), '{ dette er ikke json');
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.errored, 1);
    assert.ok(res.erroredList[0].file.includes('a-bad.json'), res.erroredList[0].file);
    assert.ok(res.erroredList[0].error, 'fejlteksten mangler');
    assert.equal(res.applied, 1);
    assert.equal(db.prepare('SELECT title FROM recipes WHERE id = ?').get(id).title, good.title);
  });
});

test('i GitHub Actions bliver fejl og eftersyn en ::warning::-linje', () => {
  // En natlig kørsel, der lykkes, læser ingen. Advarslen står på forsiden.
  const good = { ...EDITION_FIXTURE, url: 'https://test.invalid/da-import-6' };
  const was = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  try {
    withEdition(good, ({ dir }) => {
      fs.writeFileSync(path.join(dir, 'a-bad.json'), '{ dette er ikke json');
      const lines = [];
      importAll({ dir, log: (l) => lines.push(l) });
      const warnings = lines.filter((l) => l.startsWith('::warning'));
      assert.equal(warnings.length, 1, lines.join('\n'));
      assert.match(warnings[0], /0 til eftersyn, 1 kunne ikke læses/);
      assert.match(warnings[0], /a-bad\.json/);
      assert.ok(!warnings[0].includes('\n'), 'en annotation er én linje');
    });
  } finally {
    if (was === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = was;
  }
  // Uden noget at sige: ingen linje.
  const { actionsWarning } = require('../src/recipes/import-da');
  assert.equal(actionsWarning([], []), null);
});

test('en udgave med flere ingredienslinjer end kilden læses ikke ind', () => {
  // Kilden har 1 linje; 4 er mere end +2 og mere end 30 %.
  const many = {
    ...EDITION_FIXTURE,
    url: 'https://test.invalid/da-import-7',
    ingredients: [...EDITION_FIXTURE.ingredients,
                  { section: null, amount: 2, unit: 'dl', name: 'vand', note: null, optional: false }],
  };
  withEdition(many, ({ dir }) => {
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.flagged, 1);
    assert.match(res.flaggedList[0].issues.join(), /ingredienslinjer/);
  });
});

test('tre linjer mod én før (+2) udløser ikke ingrediensreglen', () => {
  withEdition({ ...EDITION_FIXTURE, url: 'https://test.invalid/da-import-8' }, ({ dir }) => {
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.flagged, 0);
    assert.equal(res.applied, 1);
  });
});

// ── Kontrollen sammenligner det sammenlignelige ──────────────────────────────

const { problems } = require('../src/recipes/import-da');

/** En udgave, der kun kan fejle på det, testen prøver: titel, trin og portioner er i orden. */
function edOf(ingredients, extra = {}) {
  return {
    title: 'Ret til prøve', servings: 4, yield_count: 4,
    steps: [{ section: null, text: 'Først.' }, { section: null, text: 'Så.' }],
    ingredients: ingredients.map(([amount, unit, name]) =>
      ({ section: null, amount, unit, name, note: null, optional: false })),
    ...extra,
  };
}
const parsedLines = (raws) => raws.map((raw, i) => ({ ...parseIngredient(raw, i), raw }));
const editionLines = (ed) => parsedLines(ed.ingredients.map(lineOf));

test('hovedråvaren genfindes i en søstervare af samme dyr', () => {
  // Den engelske linje og den danske kan ramme hver sin nøgle for samme kød:
  // "1 kylling (ca. 1200 g)" er `kylling`, "hel kylling" er `hel_kylling`;
  // "4 slices of ham" er `paalaeg`, "skinke" er `skinke`. 137 udgaver blev
  // holdt tilbage for "hovedråvaren er væk", og det var mest den slags.
  const cases = [
    [['1 kylling (ca. 1200 g)', '1 tsp salt'], [[1200, 'g', 'hel kylling'], [1, 'tsk', 'salt']]],
    [['4 slices of ham', '1 tsp salt'], [[4, 'skive', 'skinke'], [1, 'tsk', 'salt']]],
    [['4 slices prosciutto', '1 tsp salt'], [[4, 'skive', 'parmaskinke'], [1, 'tsk', 'salt']]],
  ];
  for (const [before, after] of cases) {
    const ed = edOf(after);
    assert.deepEqual(problems(ed, editionLines(ed), parsedLines(before)), [], before[0]);
  }
});

test('mængden måles over hele familien: 1,2 kg kylling mod 1,8 kg hel kylling er for meget', () => {
  const ed = edOf([[1800, 'g', 'hel kylling'], [1, 'tsk', 'salt']]);
  const issues = problems(ed, editionLines(ed), parsedLines(['1 kylling (ca. 1200 g)', '1 tsp salt']));
  assert.equal(issues.length, 1, issues.join());
  assert.match(issues[0], /kylling: 1200 → 1800 \(mere end 25 %\)/);
});

test('et andet dyr er stadig en anden ret: lam → svinemørbrad', () => {
  const ed = edOf([[600, 'g', 'svinemørbrad'], [1, 'tsk', 'salt']]);
  const issues = problems(ed, editionLines(ed), parsedLines(['600 g lamb rump', '1 tsp salt']));
  assert.ok(issues.includes('hovedråvaren lam er væk'), issues.join());
});

test('linjetallet måles mod kildens linjer, ikke mod basens', () => {
  // #643 softice: kildesiden har 9 linjer, basen kun 4 (crawleren fik ikke
  // dem alle med), udgaven 9. Det er ikke nye ingredienser.
  const nine = [[5, 'dl', 'mælk'], [100, 'g', 'sukker'], [3, 'stk', 'æg'], [2, 'dl', 'piskefløde'],
    [1, 'tsk', 'vaniljesukker'], [50, 'g', 'smør'], [1, 'knivspids', 'salt'],
    [100, 'g', 'mørk chokolade'], [1, 'stk', 'citron']];
  const db4 = parsedLines(['500 ml milk', '100 g sugar', '3 eggs', '2 dl cream']);

  const fromSource = edOf(nine, { source_lines: 9 });
  assert.deepEqual(problems(fromSource, editionLines(fromSource), db4), []);

  // Siger kilden selv 4, er 9 stadig nye ingredienser.
  const invented = edOf(nine, { source_lines: 4 });
  assert.match(problems(invented, editionLines(invented), db4).join(), /9 ingredienslinjer, kilden 4/);

  // Uden source_lines (en ældre fil) er basens linjer målestokken, som før.
  const old = edOf(nine);
  assert.match(problems(old, editionLines(old), db4).join(), /9 ingredienslinjer, før 4/);
});

test('udgaven husker kildens antal ingredienslinjer ved siden af yield_count', () => {
  const { editionRecord } = require('../src/recipes/rewrite');
  const src = {
    url: 'https://test.invalid/x', source: 'test', source_name: 'Test',
    total_minutes: 30, active_minutes: 10, yield_count: 4,
    ingredients: ['1 a', '2 b', '3 c'],
  };
  const ed = editionRecord(src, { model: 'm', output: { title: 'X', ingredients: [] } });
  assert.equal(ed.source_lines, 3);
  const keys = Object.keys(ed);
  assert.equal(keys[keys.indexOf('yield_count') + 1], 'source_lines');
});

test('backfill-source-lines lægger source_lines lige efter yield_count og rører intet andet', () => {
  const { withSourceLines } = require('../scripts/backfill-source-lines');
  const ed = { url: 'u', total_minutes: 30, active_minutes: null, yield_count: 4, title: 'T', ingredients: [] };
  const out = withSourceLines(ed, 7);
  assert.deepEqual(Object.keys(out),
    ['url', 'total_minutes', 'active_minutes', 'yield_count', 'source_lines', 'title', 'ingredients']);
  assert.equal(out.source_lines, 7);
  assert.equal(ed.source_lines, undefined, 'originalen er urørt');
  // Allerede der: samme plads, nyt tal.
  assert.deepEqual(Object.keys(withSourceLines(out, 8)), Object.keys(out));
  assert.equal(withSourceLines(out, 8).source_lines, 8);
});

test('systemprompten forbyder hjemmelavede erstatninger', () => {
  assert.ok(systemText().includes('aldrig med en hjemmelavet version'));
});

test('systemprompten begrænser genbrugt ordsekvens fra kilder til fire ord i træk', () => {
  assert.ok(systemText().includes('Genbrug aldrig mere end fire ord i træk'));
});

test('en flæskesteg erstattet af lidt bacon er ikke den samme hovedråvare', () => {
  const before = parsedLines(['1 kg svinekam', '1 tsp salt']);
  assert.equal(before[0].item_key, 'flaeskesteg');
  const ed = edOf([[100, 'g', 'bacon'], [1, 'tsk', 'salt']]);
  const issues = problems(ed, editionLines(ed), before);
  assert.ok(issues.some((i) => /hovedråvaren .* er væk/.test(i)), issues.join());
});

test('kyllingebryst → hakket kylling er stadig samme hovedråvare', () => {
  const ed = edOf([[500, 'g', 'hakket kylling'], [1, 'tsk', 'salt']]);
  assert.equal(editionLines(ed)[0].item_key, 'hakket_kylling');
  assert.deepEqual(problems(ed, editionLines(ed), parsedLines(['500 g chicken breast', '1 tsp salt'])), []);
});

// ── Tilbehør: vurderingen af måltidet (sides.js) ───────────────────────────
const { MEAL_SCHEMA } = require('../src/recipes/edition');
const sides = require('../src/recipes/sides');

test('MEAL_SCHEMA tillader kun UNITS (samme ingrediensskema som udgaven) og er lukket', () => {
  const side = MEAL_SCHEMA.properties.side.anyOf[0];
  assert.equal(MEAL_SCHEMA.additionalProperties, false);
  assert.equal(side.additionalProperties, false);
  assert.equal(side.properties.ingredients, RECIPE_SCHEMA.properties.ingredients);
  const unit = side.properties.ingredients.items.properties.unit.anyOf[0];
  assert.deepEqual(unit.enum, UNITS);
  assert.deepEqual(MEAL_SCHEMA.required, ['complete', 'reason', 'side']);
});

test('udvælgelsen: kun aftensretter med udgave, og meal springes over uden --force', () => {
  const recipes = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const editions = { 1: { title: 'a' }, 2: { title: 'b', meal: { complete: true } }, 3: null, 4: { title: 'd' } };
  const isDinner = (r) => r.id !== 4; // 4 er ikke aftensmad
  const read = (r) => editions[r.id];
  const ids = (o) => sides.pendingMeals(recipes, [], { isDinner, read, ...o }).map((p) => p.recipe.id);
  assert.deepEqual(ids({}), [1]);
  assert.deepEqual(ids({ force: true }), [1, 2]);
  assert.deepEqual(ids({ force: true, limit: 1 }), [1]);
  assert.deepEqual(ids({ force: true, ids: [2] }), [2]);
});

test('meal skrives ind i udgaven, og de øvrige felter er uændrede', () => {
  const ed = { url: 'u', title: 'Stegt tunsteak', servings: 4, ingredients: [{ name: 'tun' }], steps: [{ section: null, text: 'Steg.' }] };
  const side = { title: 'Kogte kartofler', ingredients: [], steps: ['Kog.'] };
  const out = sides.withMeal(ed, { output: { complete: false, reason: 'Mangler stivelse.', side }, model: 'claude-haiku-4-5' }, new Date('2026-10-04T10:00:00Z'));
  const { meal, ...rest } = out;
  assert.deepEqual(rest, ed);
  assert.deepEqual(meal, { complete: false, reason: 'Mangler stivelse.', side, model: 'claude-haiku-4-5', checked_at: '2026-10-04T10:00:00.000Z' });
  assert.equal(ed.meal, undefined, 'den oprindelige udgave røres ikke');
});

test('sides-prompten er fast og nævner de tilladte enheder; beskeden bruger udgavens linjer', () => {
  assert.equal(sides.systemText(), sides.systemText());
  assert.ok(sides.systemText().includes(UNITS.join(', ')));
  const msg = sides.userMessage({ title: 'T', servings: 2, ingredients: [{ amount: 400, unit: 'g', name: 'tun', note: null, optional: false }], steps: [{ text: 'Steg.' }] });
  assert.match(msg, /Portioner: 2/);
  assert.match(msg, /- 400 g tun/);
  assert.match(msg, /1\. Steg\./);
});

test('cleanSide: varenavne med småt, basisvarer droppes, men en eneste linje bevares', () => {
  const l = (name, extra = {}) => ({ section: null, amount: 1, unit: 'g', name, note: 'Til Vandet', optional: false, ...extra });
  const side = { title: 'Kartofler', ingredients: [l('Kartofler'), l('Grøn salat'), l('Olivenolie'), l('Salt'), l('Peanutsmør')], steps: ['Kog.'] };
  const out = sides.cleanSide(side);
  assert.deepEqual(out.ingredients.map((i) => i.name), ['kartofler', 'grøn salat', 'peanutsmør']);
  assert.equal(out.ingredients[0].note, 'Til Vandet', 'resten af teksten er uændret');
  assert.equal(out.title, 'Kartofler');
  const only = sides.cleanSide({ title: 'x', ingredients: [l('Smør')], steps: [] });
  assert.deepEqual(only.ingredients.map((i) => i.name), ['smør']);
  assert.equal(sides.cleanSide(null), null);
});

// ── Tilbehør (meal.side) ─────────────────────────────────────────────────────

const SIDE = {
  title: 'Kogte kartofler',
  ingredients: [
    { section: null, amount: 800, unit: 'g', name: 'kartofler', note: null, optional: false },
    { section: null, amount: null, unit: null, name: 'salt', note: null, optional: false },
  ],
  steps: ['Kog kartoflerne møre i letsaltet vand.', 'Hæld vandet fra og damp dem af.'],
};
const withMeal = (n, meal) => ({ ...EDITION_FIXTURE, url: `https://test.invalid/da-side-${n}`, meal });

test('en udgave med tilbehør får afsnittet Tilbehør i linjer og trin', () => {
  withEdition(withMeal(1, { complete: false, reason: 'x', side: SIDE }), ({ db, dir, id }) => {
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.applied, 1, JSON.stringify(res.flaggedList));
    const lines = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY position').all(id);
    assert.equal(lines.length, 5);
    assert.deepEqual(lines.slice(3).map((l) => l.section), ['Tilbehør: Kogte kartofler', 'Tilbehør: Kogte kartofler']);
    assert.equal(lines[3].item_key, 'kartofler');
    const steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY position').all(id);
    assert.deepEqual(steps.slice(2).map((s) => s.section), ['Tilbehør', 'Tilbehør']);
    assert.equal(steps[2].text, SIDE.steps[0]);
    // Tilbehørets 2 linjer tæller ikke med i ingredienslinje-kontrollen (3 + 2 > 1 + 2 og > 30 %).
    assert.equal(res.flagged, 0);
  });
});

test('en udgave med et helt måltid eller uden tilbehør får ingen ekstra linjer', () => {
  withEdition(withMeal(2, { complete: true, reason: 'x', side: null }), ({ db, dir, id }) => {
    assert.equal(importAll({ dir, log: () => {} }).applied, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_ingredients WHERE recipe_id = ?').get(id).n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_steps WHERE recipe_id = ?').get(id).n, 2);
  });
  withEdition(withMeal(3, { complete: true, reason: 'x', side: SIDE }), ({ db, dir, id }) => {
    importAll({ dir, log: () => {} });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_ingredients WHERE recipe_id = ?').get(id).n, 3);
  });
});

test('et tilbehør med ukendt enhed, uden trin eller med for mange linjer holdes tilbage', () => {
  const bad = [
    { ...SIDE, ingredients: [{ ...SIDE.ingredients[0], unit: 'bolle' }, SIDE.ingredients[1]] },
    { ...SIDE, steps: [] },
    { ...SIDE, ingredients: Array(5).fill(SIDE.ingredients[0]) },
    { ...SIDE, ingredients: [] },
    { ...SIDE, ingredients: [{ ...SIDE.ingredients[0], amount: 0 }] },
  ];
  bad.forEach((side, i) => {
    // accepted frigiver ikke et ødelagt tilbehør.
    withEdition({ ...withMeal(10 + i, { complete: false, reason: 'x', side }), accepted: true }, ({ db, dir, id }) => {
      const res = importAll({ dir, log: () => {} });
      assert.equal(res.applied, 0, `tilfælde ${i}`);
      assert.equal(res.flagged, 1);
      assert.match(res.flaggedList[0].issues[0], /^tilbehør:/);
      assert.equal(db.prepare('SELECT title FROM recipes WHERE id = ?').get(id).title, 'Lamb rump');
    });
  });
});

test('en udgave, der får meal tilføjet, læses ind igen', () => {
  withEdition(EDITION_FIXTURE, ({ db, dir, id }) => {
    importAll({ dir, log: () => {} });
    fs.writeFileSync(path.join(dir, 'ret.json'),
      JSON.stringify({ ...EDITION_FIXTURE, meal: { complete: false, reason: 'x', side: SIDE } }));
    assert.equal(importAll({ dir, log: () => {} }).applied, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_ingredients WHERE recipe_id = ?').get(id).n, 5);
  });
});
