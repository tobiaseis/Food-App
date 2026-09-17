'use strict';

/**
 * Tests for pakkeafrunding og spild.
 *
 * Reglen, hele planen hviler på: man køber hele pakker. Skal man bruge
 * 1,3 kg kartofler, koster det to 1 kg-poser eller én 1,5 kg-pose — ikke
 * 1,3 × kiloprisen. Og resten er kun spild, hvis varen ikke holder.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const PACKS = [
  { pack_qty: 1,   pack_price: 8,  unit_price: 8 },
  { pack_qty: 1.5, pack_price: 12, unit_price: 8 },
  { pack_qty: 2,   pack_price: 12, unit_price: 6 },
];

test('behovet rundes op til hele pakker', () => {
  const c = engine.choosePack(1.3, PACKS, { keeps: 'keeps' });
  near(c.bought, 1.5);
  near(c.pack_price * c.packs, 12);
  near(c.leftover, 0.2);
});

test('billigst vinder, når resten alligevel ikke er spild', () => {
  // 2 kg og 1,5 kg koster begge 12 kr, og for en pantry-vare vejer resten
  // ingenting. De to får altså samme score, og den første i listen vinder.
  // Testen siger derfor kun at PRISEN er 12 — ikke hvilken pose der blev valgt.
  const c = engine.choosePack(1.3, PACKS, { keeps: 'pantry' });
  near(c.pack_price * c.packs, 12);
  near(c.waste, 0);
});

test('for en letfordærvelig vare tæller resten fuldt', () => {
  const c = engine.choosePack(1.3, PACKS, { keeps: 'perishable' });
  near(c.bought, 1.5);
  near(c.waste, 0.2);
});

test('to pakker, når ingen enkelt er stor nok', () => {
  const c = engine.choosePack(3.4, [{ pack_qty: 2, pack_price: 12, unit_price: 6 }], { keeps: 'keeps' });
  assert.equal(c.packs, 2);
  near(c.bought, 4);
  near(c.leftover, 0.6);
});

test('intet behov giver ingen pakke', () => {
  assert.equal(engine.choosePack(0, PACKS, { keeps: 'keeps' }), null);
  assert.equal(engine.choosePack(1, [], { keeps: 'keeps' }), null);
  // En pakke uden brugbar størrelse eller pris er ikke en pakke. Er der
  // ingen andre, er svaret null — ikke en pose til nul kroner.
  assert.equal(engine.choosePack(1, [{ pack_qty: 0, pack_price: 8 }], { keeps: 'keeps' }), null);
});

test('score er et internt tal og slipper ikke ud', () => {
  // Præcis den lækage, effectivePrice fik rettet i opgave 4: et
  // sorteringstal, der ender i en indkøbsliste, bliver læst som en pris.
  const c = engine.choosePack(1.3, PACKS, { keeps: 'keeps' });
  assert.deepEqual(
    Object.keys(c).sort(),
    ['bought', 'cost', 'leftover', 'pack_price', 'pack_qty', 'packs', 'waste'],
  );
});

test('et behov, der går præcist op, køber ikke en pakke for meget', () => {
  // Tre retter med 400 g hakket oksekød hver lægges sammen til
  // 1.2000000000000002, og 1.2000000000000002 / 0.4 er 3.0000000000000004.
  // Et rent Math.ceil køber en fjerde bakke og kalder de 400 g for spild.
  const need = 0.4 + 0.4 + 0.4;
  const c = engine.choosePack(need, [{ pack_qty: 0.4, pack_price: 26, unit_price: 65 }], { keeps: 'perishable' });
  assert.equal(c.packs, 3);
  near(c.cost, 78);
  near(c.leftover, 0);
  near(c.waste, 0);
});

test('spildstraffen følger varens værdi og er ikke et fast kronebeløb', () => {
  // Den dimensionelle regel, og hele grunden til at straffen er en ANDEL:
  // én 'stk'-enhed er ét æg til 3 kr, mens én 'kg'-enhed kan være
  // oksemørbrad til 200. Et fast beløb pr. enhed straffer de tre æg
  // hårdest — det er fem gange så mange enheder — selvom der ryger mad for
  // 9 kr ud mod 60.
  //
  // Målt udefra: hvor meget EKSTRA vil funktionen give for en pakke uden
  // rest? Det er lige præcis straffen, og den skal stå i forhold til, hvad
  // resten er værd.
  const vælgerPakkenUdenRest = (need, spildpakke, exactQty, pris) => {
    const c = engine.choosePack(need,
      [spildpakke, { pack_qty: exactQty, pack_price: pris }], { keeps: 'keeps' });
    return c.pack_qty === exactQty;
  };

  // 3 æg af en 6-pakke til 18 kr (3 kr/stk): 3 æg til overs = 9 kr mad,
  // halvt vægtet og halv aversion -> tærsklen er 2,25 kr.
  const AEG = { pack_qty: 6, pack_price: 18 };
  assert.ok(vælgerPakkenUdenRest(3, AEG, 3, 18 + 2),
    'æg: 2 kr ekstra er under straffen og skal vinde');
  assert.ok(!vælgerPakkenUdenRest(3, AEG, 3, 18 + 2.5),
    'æg: 2,50 kr ekstra er over straffen og skal tabe');

  // 0,3 kg oksemørbrad af en 0,6 kg-pakke til 120 kr (200 kr/kg): resten er
  // 60 kr mad, knap syv gange så meget, og tærsklen er 15 kr. Med et fast
  // beløb pr. enhed ville den have været 6,7 gange MINDRE end æggenes.
  const OKSE = { pack_qty: 0.6, pack_price: 120 };
  assert.ok(vælgerPakkenUdenRest(0.3, OKSE, 0.3, 120 + 14),
    'okse: 14 kr ekstra er under straffen og skal vinde');
  assert.ok(!vælgerPakkenUdenRest(0.3, OKSE, 0.3, 120 + 16),
    'okse: 16 kr ekstra er over straffen og skal tabe');
});

test('en ukendt holdbarhed vægtes som "keeps" og giver ikke NaN', () => {
  // Kortopslaget må ikke gå gennem Object.prototype: med 'constructor' som
  // nøgle ville vægten blive en Function, og spildet NaN — samme fælde som
  // SOURCE_RANK i effectivePrice.
  for (const keeps of ['constructor', 'findes_ikke', undefined]) {
    const c = engine.choosePack(1.3, PACKS, { keeps });
    assert.ok(Number.isFinite(c.waste), `waste blev ${c.waste} for keeps=${keeps}`);
    near(c.waste, 0.1);
  }
});

// ── Fikstur til ugen ─────────────────────────────────────────────────────────
//
// Seks retter i to familier, så svaret kan regnes i hovedet.
//
// Familie A: ret 1 og 2 deler hakket oksekød; ret 3 er lige så god, men
// trækker en helt ny vare. Hakket oksekød sælges i 1 kg til 80 kr, og 1 og 2
// bruger 0,5 kg hver — sammen bruger de posen op. Vælges 1 og 3, skal der
// købes en pose oksekød (80 kr, halvdelen til overs) OG en pose laks (120 kr).
//
// Familie B (4, 5, 6) er den samme historie med kylling og ris, og den er
// dyrere end A med vilje: så ved vi, at A vinder på pris og ikke på et
// tilfælde, OG at der er retter tilbage at bygge et ANDET forslag af. Med
// færre kandidater end dage kan to forslag pr. definition ikke være
// forskellige — se kommentaren ved twoProposals.
//
// Regnet igennem, dag 2, med ret 1 i kurven (0,5 kg oksekød, 0,6 kg kartofler):
//   ret 2 koster  −21,20 kr — posen bliver brugt op, og det sparede spild er
//                             mere værd end retten koster at tilføje
//   ret 3 koster  +148,80 kr — en ny pose laks, og halvdelen af oksekødet
//                             stadig til overs
// Hele mekanismen står i de to tal.

const W_ITEMS = new Map([
  ['hakket_oksekoed', { key: 'hakket_oksekoed', name: 'Hakket oksekød', category: 'meat', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['laks',            { key: 'laks',            name: 'Laks',            category: 'fish', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['kylling',         { key: 'kylling',         name: 'Kylling',         category: 'poultry', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['kartofler',       { key: 'kartofler',       name: 'Kartofler',       category: 'veg',  class: 'baseline', keeps: 'keeps',   base_unit: 'kg' }],
  ['ris',             { key: 'ris',             name: 'Ris',             category: 'grain', class: 'baseline', keeps: 'keeps',  base_unit: 'kg' }],
  ['persille',        { key: 'persille',        name: 'Persille',        category: 'veg',  class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['salt',            { key: 'salt',            name: 'Salt',            category: 'pantry', class: 'essential', keeps: 'pantry', base_unit: 'kg' }],
]);

const W_NORMALS = new Map([
  ['hakket_oksekoed|c1', [{ pack_qty: 1, pack_unit: 'kg', pack_price: 80,  unit_price: 80,  source: 'manual' }]],
  ['laks|c1',            [{ pack_qty: 1, pack_unit: 'kg', pack_price: 120, unit_price: 120, source: 'manual' }]],
  ['kylling|c1',         [{ pack_qty: 1, pack_unit: 'kg', pack_price: 90,  unit_price: 90,  source: 'manual' }]],
  ['kartofler|c1',       [{ pack_qty: 2, pack_unit: 'kg', pack_price: 16,  unit_price: 8,   source: 'manual' }]],
  ['ris|c1',             [{ pack_qty: 1, pack_unit: 'kg', pack_price: 20,  unit_price: 20,  source: 'manual' }]],
  ['persille|c1',        [{ pack_qty: 0.05, pack_unit: 'kg', pack_price: 10, unit_price: 200, source: 'manual' }]],
]);

const recipe = (id, score, items) => ({ id, title: `Ret ${id}`, score, items });
const line = (key, amount, optional = false) => ({ key, amount, weight: amount, optional });

const CANDIDATES = [
  recipe(1, 0.8, [line('hakket_oksekoed', 0.5), line('kartofler', 0.6), line('salt', 0.01)]),
  recipe(2, 0.8, [line('hakket_oksekoed', 0.5), line('kartofler', 0.6)]),
  recipe(3, 0.8, [line('laks', 0.5),            line('kartofler', 0.6)]),
  recipe(4, 0.8, [line('kylling', 0.5),         line('ris', 0.3)]),
  recipe(5, 0.8, [line('kylling', 0.5),         line('ris', 0.3)]),
  recipe(6, 0.8, [line('laks', 0.5),            line('ris', 0.3)]),
];

const CTX = { items: W_ITEMS, offers: new Map(), normals: W_NORMALS, chainIds: ['c1'] };
const FIXTURE = { candidates: CANDIDATES, ctx: CTX };

test('delt indkøb foretrækker retter, der bruger samme pose op', () => {
  // To retter deles om 1 kg hakket oksekød; de øvrige trækker en helt ny vare
  // til samme score. Ugen skal vælge de to, der deler.
  const week = engine.sharedWeek(FIXTURE.candidates, { days: 2, ...FIXTURE.ctx });
  assert.deepEqual(week.picks.map((p) => p.id).sort(), [1, 2]);
  assert.ok(week.shared.length >= 1, 'skal kunne forklare hvad der deles');
});

test('ugens pris er hele pakker, og spildet er kroner — ikke NaN', () => {
  // Tallene kan regnes i hånden: 1 kg oksekød (80) + én pose kartofler à 2 kg
  // (16) = 96 kr. Oksekødet går præcist op; kartoflerne har 0,8 kg til overs,
  // som for en 'keeps'-vare vægter halvt: 0,8 × 0,5 × 8 kr/kg × 0,5 = 1,60 kr.
  //
  // `waste` skal læse kurvens wasteKr. Feltet skiftede navn, da spildet gik
  // fra enheder til kroner, og et opslag på det gamle navn giver NaN — et tal,
  // ingen opdager, fordi det står, hvor et tal skal stå.
  const week = engine.sharedWeek(FIXTURE.candidates, { days: 2, ...FIXTURE.ctx });
  near(week.cost, 96);
  near(week.waste, 1.6);
});

test('"deler" måles i sparede pakker, ikke i antal retter', () => {
  // Kernen i rettelsen. To retter, der HVER bruger en hel 1 kg-pose, deler
  // ingenting: der købes to poser. Meldes det alligevel som deling, lyver
  // forklaringen om netop den besparelse, brugeren bad om.
  const helePakker = [
    recipe(7, 0.8, [line('hakket_oksekoed', 1), line('salt', 0.01)]),
    recipe(8, 0.8, [line('hakket_oksekoed', 1), line('salt', 0.01)]),
  ];
  const week = engine.sharedWeek(helePakker, { days: 2, ...FIXTURE.ctx });
  assert.equal(week.picks.length, 2);
  near(week.cost, 160);                       // to poser, ikke én
  assert.deepEqual(week.shared, [], 'to hele poser er ikke en deling');

  // Og modstykket: kan behovet samles i én pose, er besparelsen ægte og står
  // i nyttelasten, så opgave 8 kan vise den uden at regne den ud igen.
  const delt = engine.sharedWeek(FIXTURE.candidates, { days: 2, ...FIXTURE.ctx });
  const okse = delt.shared.find((s) => s.key === 'hakket_oksekoed');
  assert.ok(okse, 'oksekødet deles og skal stå i forklaringen');
  assert.equal(okse.used, 2);
  assert.equal(okse.saved, 1);                // to poser hver for sig, én sammen
  near(okse.saved_kr, 80);
});

test('valgfri ingredienser købes ikke — men en valgfri hovedprotein gør', () => {
  // Samme regel som recipe_costs i opgave 6, og det skal være den SAMME regel:
  // ellers koster ugen noget andet end de retter, den er bygget af.
  //
  // Persillen koster 10 kr for den mindste bakke. Købes den, står der 116.
  const medPersille = [recipe(9, 0.8,
    [line('kylling', 0.5), line('kartofler', 0.6), line('persille', 0.02, true)])];
  near(engine.sharedWeek(medPersille, { days: 1, ...FIXTURE.ctx }).cost, 106);

  // Og modsat: kyllingen er flaget valgfri, men en ret med valgfri kylling er
  // ikke en ret. Den købes, og så koster ugen 90 + 16.
  const medKylling = [recipe(10, 0.8, [line('kartofler', 0.6), line('kylling', 0.5, true)])];
  near(engine.sharedWeek(medKylling, { days: 1, ...FIXTURE.ctx }).cost, 106);
});

test('en ret uden hovedråvare er ikke aftensmad', () => {
  // Rettelsen efter første prøvekørsel mod rigtige data: ugen foreslog
  // hasselnøddesirup, hot honey, mørdej og en roux. De er billige og scorer
  // højt, og den grådige regel kan ikke se, at de ikke er aftensmad.
  //
  // Ret 12 er billigere END og scorer højere end ret 2 — og skal alligevel
  // tabe, fordi der ikke er noget at bygge en middag op om.
  const kunTilbehoer = recipe(12, 0.99, [line('kartofler', 0.2)]);
  const week = engine.sharedWeek([kunTilbehoer, CANDIDATES[1]], { days: 1, ...FIXTURE.ctx });
  assert.deepEqual(week.picks.map((p) => p.id), [2]);

  assert.equal(engine.hasMainCourse(kunTilbehoer, W_ITEMS), false);
  assert.equal(engine.hasMainCourse(CANDIDATES[1], W_ITEMS), true);

  // Er der INGEN retter med hovedråvare, er to tomme forslag ikke et bedre
  // svar end én tvivlsom ret. Så falder filteret tilbage.
  assert.equal(engine.sharedWeek([kunTilbehoer], { days: 1, ...FIXTURE.ctx }).picks.length, 1);
});

test('marginalen måles pr. portion', () => {
  // Portionsantallet går fra 1 til 12 blandt de prissatte opskrifter. Uden
  // normalisering sammenlignes en ret til én person med en ret til fire, og
  // retten til én vinder hver gang — ikke fordi den er billigere at spise,
  // men fordi den køber mindst.
  //
  // Til én:  0,5 kg hakket oksekød = 80 kr + 20 kr spildvægt = 100 kr, og
  //          det er 100 kr for ét måltid.
  // Til fire: 1 kg laks + 0,6 kg kartofler = 136 kr + 2,80 = 138,80 kr, men
  //          kun 34,70 kr pr. portion. Den er dyrest og skal alligevel vinde.
  const tilEn = { ...recipe(13, 0.8, [line('hakket_oksekoed', 0.5)]), servings: 1 };
  const tilFire = { ...recipe(14, 0.8, [line('laks', 1), line('kartofler', 0.6)]), servings: 4 };
  const week = engine.sharedWeek([tilEn, tilFire], { days: 1, ...FIXTURE.ctx });
  assert.deepEqual(week.picks.map((p) => p.id), [14]);
  near(week.cost, 136);
});

test('de to forslag deler højst én ret', () => {
  const [a, b] = engine.twoProposals(FIXTURE.candidates, { days: 3, ...FIXTURE.ctx });
  const overlap = a.picks.filter((p) => b.picks.some((q) => q.id === p.id));
  assert.ok(overlap.length <= 1, `delte ${overlap.length} retter`);
});

test('et forslag kan forklare sig selv i én linje', () => {
  const [a] = engine.twoProposals(FIXTURE.candidates, { days: 3, ...FIXTURE.ctx });
  assert.match(a.explanation, /deler/);
});

test('en uge uden deling påstår ikke at dele', () => {
  const week = engine.sharedWeek(
    [recipe(11, 0.8, [line('hakket_oksekoed', 1)])], { days: 1, ...FIXTURE.ctx });
  assert.equal(engine.explainWeek(week), 'ingen råvarer deles på tværs af retterne');
});
