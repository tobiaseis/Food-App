'use strict';

/**
 * Regressionstests for madplans-motoren.
 *
 * Motoren er ren – ingen database – så testene beskriver præcis det løfte,
 * planen giver brugeren: rettens HOVEDRÅVARE er på tilbud i de butikker, man
 * selv har valgt, basisvarer tæller ikke med, og kravet lempes kun, når der
 * ikke er tilbud nok til at holde det.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));
const taxonomy = require('../src/lib/taxonomy');

// ── Hjælpere ─────────────────────────────────────────────────────────────────

const item = (key, cat, amount, extra = {}) => ({ key, cat, amount, ingredient: key, ...extra });

const offer = (key, chain, unitPrice, normal = null) => ([key, {
  offer_id: 1, product_id: 1, chain_id: chain.toLowerCase(), chain,
  product_name: key, heading: `${key} tilbud`,
  price: 20, unit_price: unitPrice, base_unit: 'kg',
  normal_unit_price: normal, image: null,
}]);

const FAJITA = [
  item('kyllingebryst', 'poultry', 0.6),
  item('peberfrugt', 'veg', 0.3),
  item('tortilla', 'bakery', 0.24),
  item('hakkede_tomater', 'pantry', 0.4),
  item('olie', 'pantry', 0.015, { essential: true }),
  item('krydderi', 'pantry', 0.005, { essential: true }),
  item('salt', 'pantry', 0.003, { essential: true }),
];

// ── Rollefordeling ───────────────────────────────────────────────────────────

test('basisvarer tæller hverken som krav eller som match', () => {
  const roles = engine.assignRoles(FAJITA);
  const keys = [...roles.mains, ...roles.support].map((i) => i.key);
  for (const staple of ['olie', 'krydderi', 'salt']) {
    assert.ok(!keys.includes(staple), `${staple} skal være basisvare`);
  }
  assert.deepEqual(roles.staples.map((i) => i.key).sort(), ['krydderi', 'olie', 'salt']);
});

test('kyllingen er hovedråvaren i en fajita – resten er støtte', () => {
  const roles = engine.assignRoles(FAJITA);
  assert.deepEqual(roles.mains.map((i) => i.key), ['kyllingebryst']);
  assert.deepEqual(roles.support.map((i) => i.key).sort(),
    ['hakkede_tomater', 'peberfrugt', 'tortilla']);
});

test('lidt bacon til pynt bliver ikke et krav ved siden af kødet', () => {
  const roles = engine.assignRoles([
    item('oksekoed', 'meat', 0.8),
    item('bacon', 'meat', 0.025),
    item('kartofler', 'veg', 0.6),
  ]);
  assert.deepEqual(roles.mains.map((i) => i.key), ['oksekoed']);
  assert.ok(roles.support.some((i) => i.key === 'bacon'));
});

test('æg vinder ikke hovedrollen over kylling alene på stykantal', () => {
  // Regression fundet ved review af opgave 9: 'aeg' er den eneste stk-baserede
  // MAIN_CATS-vare (piece_g 58). Uden en fælles vægt sammenlignede roleWeight()
  // amount-tal på tværs af enheder direkte: "2" (stk æg) slog "0,4" (kg
  // kylling) som rent tal, selvom to æg (~116 g) vejer langt mindre end
  // 400 g kylling. Målt mod hele korpus: 287 af 2.224 opskrifter fik en
  // anden hovedråvare, 200 af dem endte med æg som ENESTE hovedråvare (fx
  // "Kålsalat med crispy kylling", "Friske forårsruller med kokosrejer").
  // weight retter det ved at regne stk om til et kg-sammenligneligt tal FØR
  // rollerne afgøres. amount er urørt — det er stadig det, der vises/regnes
  // på i indkøbslisten og prisen.
  const roles = engine.assignRoles([
    item('kyllingebryst', 'poultry', 0.4, { weight: 0.4 }),
    item('aeg', 'eggs', 2, { weight: (2 * 58) / 1000 }),
  ]);
  assert.deepEqual(roles.mains.map((i) => i.key), ['kyllingebryst']);
});

test('uden weight falder rollevægten tilbage til amount, som før opgaven', () => {
  // Ældre payloads (eller en forbruger der ikke er opdateret) har ikke
  // weight-feltet. roleWeight skal ikke krakelere af det — den falder
  // tilbage til den gamle (ufuldkomne, men kendte) adfærd.
  const roles = engine.assignRoles([
    item('kyllingebryst', 'poultry', 0.4),
    item('aeg', 'eggs', 2),
  ]);
  assert.deepEqual(roles.mains.map((i) => i.key), ['aeg']);
});

test('to kød i samme mængde er begge hovedråvarer', () => {
  const roles = engine.assignRoles([
    item('laks', 'fish', 0.4),
    item('torsk', 'fish', 0.4),
    item('pasta', 'grain', 0.3),
  ]);
  assert.deepEqual(roles.mains.map((i) => i.key).sort(), ['laks', 'torsk']);
});

test('vegetarret får den tungeste bærende råvare som hovedråvare', () => {
  // Osten er IKKE hovedråvaren: en kartoffelgratin planlægges op om
  // kartoflen. 'cheese' var kortvarigt i MAIN_CATS i opgave 7 og blev rullet
  // tilbage — se kommentaren dér for de to tal, der afgjorde det.
  const roles = engine.assignRoles([
    item('kartofler', 'veg', 0.9),
    item('loeg', 'veg', 0.1),
    item('ost', 'cheese', 0.15),
  ]);
  assert.deepEqual(roles.mains.map((i) => i.key), ['kartofler']);
});

test('ukendt kød blokerer vegetar-reserven, så planen ikke lover forkert', () => {
  const items = [item('kartofler', 'veg', 0.9), item('loeg', 'veg', 0.1)];
  assert.equal(engine.assignRoles(items).mains.length, 1);
  // "750 g lammebov" kunne ikke slås op → retten er ikke en vegetarret,
  // og vi ved ikke, om hovedråvaren er på tilbud. Så udelades den.
  assert.equal(engine.assignRoles(items, { unknownMain: true }).mains.length, 0);
});

test('samme varetype to gange i listen er ét krav, ikke to', () => {
  const roles = engine.assignRoles([
    item('loeg', 'veg', 0.1),
    item('loeg', 'veg', 0.22),
    item('kyllingebryst', 'poultry', 0.5),
  ]);
  assert.equal(roles.support.length, 1);
  assert.equal(roles.support[0].amount, 0.22);    // største mængde vinder
});

// ── Scoring ──────────────────────────────────────────────────────────────────

test('scoren skelner mellem hovedråvare og støtte', () => {
  const roles = engine.assignRoles(FAJITA);
  const offers = new Map([offer('kyllingebryst', 'Netto', 60, 90)]);
  const s = engine.scoreRecipe({ servings: 4 }, roles, offers, new Map());

  assert.equal(s.main_count, 1);
  assert.equal(s.main_total, 1);
  assert.ok(s.mains_all_on_offer);
  assert.equal(s.support_count, 0);
  assert.equal(s.support_total, 3);
  assert.equal(s.matched[0].role, 'main');
  assert.equal(s.unmatched.length, 3);
});

test('besparelsen regnes mod normalprisen, ikke mod skiltet', () => {
  const roles = engine.assignRoles([item('kyllingebryst', 'poultry', 1)]);
  const offers = new Map([offer('kyllingebryst', 'Netto', 60, 100)]);
  const s = engine.scoreRecipe({ servings: 4 }, roles, offers, new Map());
  assert.equal(s.est_cost, 60);                   // 1 kg × 60 kr/kg
  assert.equal(s.est_savings, 40);                // 1 kg × (100 − 60)
});

test('ingredienser uden tilbud prissættes til normalpris', () => {
  const roles = engine.assignRoles([
    item('kyllingebryst', 'poultry', 1),
    item('broccoli', 'veg', 0.5),
  ]);
  const offers = new Map([offer('kyllingebryst', 'Netto', 60, 100)]);
  const normal = new Map([['broccoli', { unit_price: 20, base_unit: 'kg', name: 'Broccoli' }]]);
  const s = engine.scoreRecipe({ servings: 4 }, roles, offers, normal);
  assert.equal(s.est_cost, 70);                   // 60 + 0,5 kg × 20
  assert.equal(s.unmatched[0].name, 'Broccoli');
});

test('urealistiske mængder tælles ikke med i prisen', () => {
  const roles = engine.assignRoles([item('mel', 'pantry', 90)]);
  const offers = new Map([offer('mel', 'Netto', 12, 20)]);
  const s = engine.scoreRecipe({ servings: 4 }, roles, offers, new Map());
  assert.equal(s.est_cost, 0);
});

test('stykpriser regnes uafhængigt af antal, og et normalt antal styk afvises ikke', () => {
  // 'aeg' er en reel stk-baseret vare i taksonomien og kan være hovedråvare
  // (fx en omelet) — "eggs" er en af MAIN_CATS. amount er her et rigtigt
  // stykantal (12, en bakke æg), ikke gram. MAX_SANE_AMOUNT gælder kun kg/l
  // (se kommentaren i qtyInBase): den må IKKE afvise et helt normalt
  // stykantal, bare fordi 12 > 5. Uden den regel ville hver eneste opskrift
  // med mere end fem æg, skiver brød eller tortillas miste sin pris.
  const roles = engine.assignRoles([item('aeg', 'eggs', 12)]);
  const offers = new Map([['aeg', {
    offer_id: 1, product_id: 1, chain_id: 'netto', chain: 'Netto',
    product_name: 'Æg', heading: 'Æg tilbud', price: 30,
    unit_price: 30, base_unit: 'stk', normal_unit_price: null, image: null,
  }]]);
  const s = engine.scoreRecipe({ servings: 4 }, roles, offers, new Map());
  assert.equal(s.match_count, 1);
  // 1 stk (den konservative regel — se qtyInBase), ikke 12, og ikke afvist.
  assert.equal(s.matched[0].est_cost, 30);
});

test('en stk-vare mod et kilopris-tilbud prissættes på vægt, ikke på stykantal', () => {
  // Regression: 'tortilla' er base_unit 'stk' i taksonomien, men mange
  // tortilla-tilbud (og brød) er kg-prissat. amount er her et STYKANTAL (4
  // tortillas), ikke en vægt — qtyInBase skal bruge item.weight (240 g,
  // udregnet af weightFor() i generate.js) mod et kg-tilbud, ikke amount
  // direkte. Uden det regnede motoren 4 stk som 4 kg: 4 × 90,91 kr/kg =
  // 363,64 kr for en ret, der reelt koster ~21,82 kr for 240 g.
  const roles = engine.assignRoles([item('tortilla', 'bakery', 4, { weight: 0.24 })]);
  const offers = new Map([offer('tortilla', 'Netto', 90.91)]);
  const s = engine.scoreRecipe({ servings: 4 }, roles, offers, new Map());
  assert.equal(s.matched[0].est_cost, 21.82);
  assert.notEqual(s.matched[0].est_cost, 363.64);
});

// ── Krav-trin ────────────────────────────────────────────────────────────────

const recipe = (id, mainKey, extra = []) => ({
  id, title: `Ret ${id}`, url: `https://x/${id}`, servings: 4, tier_score: 0.8,
  items: [item(mainKey, 'poultry', 0.5), item('pasta', 'grain', 0.3), ...extra],
});

test('retter uden hovedråvaren på tilbud kommer ikke med', () => {
  const recipes = [];
  for (let i = 1; i <= 20; i++) recipes.push(recipe(i, 'kyllingebryst'));
  for (let i = 21; i <= 40; i++) recipes.push(recipe(i, 'laks'));

  const plan = engine.buildPlan({
    recipes,
    offers: new Map([offer('kyllingebryst', 'Netto', 60, 90), offer('pasta', 'Netto', 15, 20)]),
    seed: 1,
  });

  assert.equal(plan.days.length, 7);
  assert.equal(plan.rule.level, 'strict');
  assert.equal(plan.rule.relaxed, false);
  for (const d of plan.days) {
    assert.ok(d.mains.every((m) => m.on_offer), `${d.recipe.title} lover en råvare uden tilbud`);
  }
});

test('kravet lempes – og siges højt – når der ikke er tilbud nok', () => {
  // Kun laksen er på tilbud, og kun fire retter bruger den. Så kan det
  // strengeste krav ikke bære en uge, og motoren falder et trin ned.
  const recipes = [];
  for (let i = 1; i <= 4; i++) recipes.push(recipe(i, 'laks'));
  for (let i = 5; i <= 30; i++) recipes.push(recipe(i, 'kyllingebryst'));

  const plan = engine.buildPlan({
    recipes,
    offers: new Map([offer('pasta', 'Netto', 15, 20)]),   // ingen kød på tilbud
    seed: 1,
  });

  assert.equal(plan.days.length, 7);
  assert.equal(plan.rule.relaxed, true);
  assert.ok(plan.rule.label.length > 0);
});

test('uden tilbud overhovedet er svaret en forklaring, ikke en tom plan', () => {
  const plan = engine.buildPlan({ recipes: [recipe(1, 'laks')], offers: new Map(), seed: 1 });
  assert.equal(plan.days.length, 0);
  assert.match(plan.error, /butikker/);
});

test('samme seed giver samme plan, nyt seed giver en anden', () => {
  const recipes = [];
  for (let i = 1; i <= 40; i++) recipes.push(recipe(i, 'kyllingebryst'));
  const offers = new Map([offer('kyllingebryst', 'Netto', 60, 90), offer('pasta', 'Netto', 15, 20)]);

  const a = engine.buildPlan({ recipes, offers, seed: 1 });
  const b = engine.buildPlan({ recipes, offers, seed: 1 });
  const c = engine.buildPlan({ recipes, offers, seed: 99 });

  const ids = (p) => p.days.map((d) => d.recipe.id).join(',');
  assert.equal(ids(a), ids(b));
  assert.notEqual(ids(a), ids(c));
});

test('ugen bliver ikke syv gange pasta, selvom pastaen er på tilbud', () => {
  // Pastaretterne scorer højest (billig pasta OG billigt kød), så uden en
  // spærre på tilbehøret ville de tage hele ugen. Rissene findes som
  // alternativ, så spærren HAR noget at falde tilbage på.
  const proteins = ['kyllingebryst', 'laks', 'torsk', 'oksekoed', 'bacon', 'rejer', 'tun'];
  const recipes = [];
  let id = 1;
  for (const p of proteins) {
    for (const starch of ['pasta', 'ris', null]) {
      for (let i = 0; i < 3; i++) {
        recipes.push({
          id: id++, title: `${starch || 'salat'} med ${p}`, url: 'https://x', servings: 4,
          tier_score: starch === 'pasta' ? 0.9 : 0.7,
          items: [item(p, 'meat', 0.5),
                  starch ? item(starch, 'grain', 0.3) : item('salat', 'veg', 0.2)],
        });
      }
    }
  }
  const offers = new Map([
    ...proteins.map((p) => offer(p, 'Netto', 60, 90)),
    offer('pasta', 'Netto', 15, 20),
    offer('ris', 'Netto', 18, 22),
    offer('salat', 'Netto', 30, 40),
  ]);

  const plan = engine.buildPlan({ recipes, offers, seed: 3 });
  assert.equal(plan.days.length, 7);
  const withPasta = plan.days.filter((d) =>
    d.matched.some((m) => m.taxonomy_key === 'pasta')).length;
  assert.ok(withPasta <= 3, `${withPasta} af 7 retter var pasta`);
});

test('spærren giver efter, hvis der ikke findes andet end pasta', () => {
  // En halv uge er ikke et svar. Kan variationen ikke opfyldes, skal planen
  // stadig blive til syv retter.
  const recipes = [];
  for (let i = 1; i <= 20; i++) {
    recipes.push({
      id: i, title: `Pastaret ${i}`, url: 'https://x', servings: 4, tier_score: 0.8,
      items: [item('kyllingebryst', 'poultry', 0.5), item('pasta', 'grain', 0.3)],
    });
  }
  const plan = engine.buildPlan({
    recipes,
    offers: new Map([offer('kyllingebryst', 'Netto', 60, 90), offer('pasta', 'Netto', 15, 20)]),
    seed: 3,
  });
  assert.equal(plan.days.length, 7);
});

// ── Indkøbsliste ─────────────────────────────────────────────────────────────

test('indkøbslisten grupperes efter butik og har resten for sig', () => {
  const recipes = [];
  for (let i = 1; i <= 20; i++) {
    recipes.push(recipe(i, 'kyllingebryst', [item('broccoli', 'veg', 0.4)]));
  }
  const plan = engine.buildPlan({
    recipes,
    offers: new Map([offer('kyllingebryst', 'Netto', 60, 90), offer('pasta', 'REMA 1000', 15, 20)]),
    normalPrices: new Map([['broccoli', { unit_price: 25, base_unit: 'kg', name: 'Broccoli' }]]),
    seed: 1,
  });

  const list = engine.shoppingList(plan);
  assert.deepEqual(list.on_offer.map((c) => c.chain).sort(), ['Netto', 'REMA 1000']);
  assert.deepEqual(list.rest.map((r) => r.name), ['Broccoli']);
  assert.equal(list.rest[0].used_in.length, 7);   // brugt i alle syv retter
});

// ── Taksonomi ────────────────────────────────────────────────────────────────

test('krydderier og olie er basisvarer; aromater skal købes, ikke stå i skabet i forvejen', () => {
  for (const k of ['salt', 'peber', 'krydderi', 'olie', 'eddike', 'mel', 'soja', 'bouillon']) {
    assert.ok(taxonomy.isEssential(k), `${k} bør være basisvare`);
  }
  for (const k of ['kyllingebryst', 'peberfrugt', 'tortilla', 'hakkede_tomater',
                   'hvidloeg', 'ingefaer', 'persille']) {
    assert.ok(!taxonomy.isEssential(k), `${k} bør IKKE være basisvare`);
  }
});

test('ukendte kødlinjer genkendes som mulig hovedråvare', () => {
  for (const raw of ['750 g lammebov, lammehals eller lign.', '1 kg bone-in pork shoulder',
                     '500 g kalvelever', '750g-1kg brisket']) {
    assert.ok(taxonomy.hintsAtMainIngredient(raw), raw);
  }
  for (const raw of ['1 spsk frisk rosmarin, finthakket', '2 dl mælk', '1 knivspids salt']) {
    assert.ok(!taxonomy.hintsAtMainIngredient(raw), raw);
  }
});
