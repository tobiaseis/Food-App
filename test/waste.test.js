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
  ['kyllingebryst',   { key: 'kyllingebryst',   name: 'Kyllingebryst',   category: 'poultry', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['kyllingelaar',    { key: 'kyllingelaar',    name: 'Kyllingelår',     category: 'poultry', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['pasta',           { key: 'pasta',           name: 'Pasta',           category: 'grain', class: 'baseline', keeps: 'pantry', base_unit: 'kg' }],
  ['ris',             { key: 'ris',             name: 'Ris',             category: 'grain', class: 'baseline', keeps: 'keeps',  base_unit: 'kg' }],
  ['persille',        { key: 'persille',        name: 'Persille',        category: 'veg',  class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['aeg',             { key: 'aeg',             name: 'Æg',              category: 'eggs', class: 'fresh', keeps: 'keeps',      base_unit: 'stk' }],
  ['hvidloeg',        { key: 'hvidloeg',        name: 'Hvidløg',         category: 'veg',  class: 'fresh', keeps: 'keeps',      base_unit: 'kg' }],
  // Uden pris i nogen kæde, med vilje: den er C1-testens hele pointe.
  ['havbars',         { key: 'havbars',         name: 'Havbars',         category: 'fish', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['salt',            { key: 'salt',            name: 'Salt',            category: 'pantry', class: 'essential', keeps: 'pantry', base_unit: 'kg' }],
]);

const W_NORMALS = new Map([
  ['hakket_oksekoed|c1', [{ pack_qty: 1, pack_unit: 'kg', pack_price: 80,  unit_price: 80,  source: 'manual' }]],
  ['laks|c1',            [{ pack_qty: 1, pack_unit: 'kg', pack_price: 120, unit_price: 120, source: 'manual' }]],
  ['kylling|c1',         [{ pack_qty: 1, pack_unit: 'kg', pack_price: 90,  unit_price: 90,  source: 'manual' }]],
  ['kartofler|c1',       [{ pack_qty: 2, pack_unit: 'kg', pack_price: 16,  unit_price: 8,   source: 'manual' }]],
  ['ris|c1',             [{ pack_qty: 1, pack_unit: 'kg', pack_price: 20,  unit_price: 20,  source: 'manual' }]],
  ['pasta|c1',           [{ pack_qty: 1, pack_unit: 'kg', pack_price: 12,  unit_price: 12,  source: 'manual' }]],
  ['kyllingebryst|c1',   [{ pack_qty: 1, pack_unit: 'kg', pack_price: 95,  unit_price: 95,  source: 'manual' }]],
  ['kyllingelaar|c1',    [{ pack_qty: 1, pack_unit: 'kg', pack_price: 60,  unit_price: 60,  source: 'manual' }]],
  ['persille|c1',        [{ pack_qty: 0.05, pack_unit: 'kg', pack_price: 10, unit_price: 200, source: 'manual' }]],
  ['aeg|c1',             [{ pack_qty: 6, pack_unit: 'stk', pack_price: 18, unit_price: 3, source: 'manual' }]],
  ['hvidloeg|c1',        [{ pack_qty: 0.09, pack_unit: 'kg', pack_price: 6, unit_price: 66.67, source: 'manual' }]],
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
  // Til én:  0,5 kg hakket oksekød, ganget op til fire personer = 2 kg = to
  //          poser = 160 kr. Ulæst er den 100 kr og ser billigst ud.
  // Til fire: 1 kg laks + 0,6 kg kartofler = 136 kr + 2,80 spildvægt. Den er
  //          dyrest som opskrift og skal alligevel vinde.
  const tilEn = { ...recipe(13, 0.8, [line('hakket_oksekoed', 0.5)]), servings: 1 };
  const tilFire = { ...recipe(14, 0.8, [line('laks', 1), line('kartofler', 0.6)]), servings: 4 };
  const week = engine.sharedWeek([tilEn, tilFire], { days: 1, ...FIXTURE.ctx });
  assert.deepEqual(week.picks.map((p) => p.id), [14]);
  near(week.cost, 136);
});

test('opskrifterne skaleres til husstanden', () => {
  // Man køber ikke ti portioner majsdeller til én aftensmad. Retten her er
  // skrevet til ti personer og bruger 2,5 kg hakket oksekød — 0,25 kg pr.
  // portion — og kurven skal følge husstanden, ikke opskriften.
  const tilTi = { ...recipe(15, 0.8, [line('hakket_oksekoed', 2.5)]), servings: 10 };
  const uge = (servings) => engine.sharedWeek([tilTi], { days: 1, servings, ...FIXTURE.ctx });

  near(uge(4).cost, 80);    // 1,0 kg → én pose
  near(uge(8).cost, 160);   // 2,0 kg → to poser
  near(uge(2).cost, 80);    // 0,5 kg → stadig én pose, halvdelen til overs
  near(uge(2).waste, 20);   // … og den halve pose tæller som spild

  // Standard er 4, og en husstand på nul er ikke en husstand.
  near(engine.sharedWeek([tilTi], { days: 1, ...FIXTURE.ctx }).cost, 80);
  near(uge(0).cost, 80);
});

test('et stykke kan ikke deles, og en lille mængde forsvinder ikke i afrundingen', () => {
  // Skaleringen laver 2 æg til ti personer om til 0,8 æg til fire. Man bruger
  // et helt æg, og både kurven og forklaringen skal sige 1.
  const aegRet = (id) => ({ ...recipe(id, 0.8, [line('aeg', 2), line('kylling', 0.5)]), servings: 10 });
  const week = engine.sharedWeek([aegRet(16), aegRet(17)], { days: 2, servings: 4, ...FIXTURE.ctx });
  const aeg = week.shared.find((s) => s.key === 'aeg');
  assert.equal(aeg.need, 2, '0,8 + 0,8 æg skal købes som 1 + 1, ikke som 1,6');

  // Og oprundingen sker på SUMMEN, ikke pr. ret. Fire retter à 0,4 æg er
  // to æg, ikke fire — rundes hver ret op for sig, køber ugen dobbelt.
  const lidtAeg = (id) => ({ ...recipe(id, 0.8, [line('aeg', 1), line('kylling', 0.5)]), servings: 10 });
  const fire = engine.sharedWeek([lidtAeg(20), lidtAeg(21), lidtAeg(22), lidtAeg(23)],
    { days: 4, servings: 4, ...FIXTURE.ctx });
  assert.equal(fire.shared.find((s) => s.key === 'aeg').need, 2,
    '4 x 0,4 æg er 2 æg, ikke 4');

  // Og 3 g hvidløg må ikke stå som "0 kg". round2 er rigtig for en pris og
  // forkert for en mængde.
  const fedRet = (id) => recipe(id, 0.8, [line('hvidloeg', 0.003), line('kylling', 0.5)]);
  const uge2 = engine.sharedWeek([fedRet(18), fedRet(19)], { days: 2, ...FIXTURE.ctx });
  const fed = uge2.shared.find((s) => s.key === 'hvidloeg');
  assert.ok(fed.need > 0, `hvidløget stod som ${fed.need}`);
  assert.match(engine.explainWeek(uge2), /0\.006 kg Hvidløg/);
});

test('forklaringen fyldes ikke op med småpenge', () => {
  // "sparer 7,96 kr på smør" er en tynd overskrift for en uge til 234 kr.
  // Er der en besparelse, der bærer sin plads, nævnes kun den.
  const stor = { key: 'a', name: 'Oksekød', unit: 'kg', used: 2, need: 1, saved: 1, saved_kr: 80 };
  const lille = { key: 'b', name: 'Smør', unit: 'kg', used: 2, need: 0.05, saved: 1, saved_kr: 8 };
  // Og kronerne står der: det er dem, der gav linjen dens plads, og en ren
  // mængde ("0.021 kg Hvidløg") læses som ingenting.
  assert.equal(engine.explainWeek({ cost: 234, shared: [stor, lille] }),
    'deler 1 kg Oksekød over 2 retter (80 kr)');

  // Men er alt, der deles, småt, er det stadig sandt og skal siges.
  assert.equal(engine.explainWeek({ cost: 234, shared: [lille] }),
    'deler 0.05 kg Smør over 2 retter (8 kr)');
});

test('en ret, vi ikke kan prissætte, ser gratis ud og skal ikke vinde', () => {
  // C1. basketCost springer en vare uden pris over — den koster nul og
  // spilder nul. Målt på hele korpusset havde alle otte valgte retter
  // priceable = 0, og en havbars-middag stod til 6 kr, fordi tre fjerdedele
  // af dens ingredienser var usynlige.
  //
  // 'havbars' har ingen pris i c1. Retten har en hovedråvare og ser billig
  // ud — og skal alligevel tabe til ret 2, der koster 96 kr for alt.
  const ukendt = recipe(24, 1.0, [line('havbars', 0.6), line('kartofler', 0.6)]);
  const week = engine.sharedWeek([ukendt, CANDIDATES[1]], { days: 1, ...FIXTURE.ctx });
  assert.deepEqual(week.picks.map((p) => p.id), [2]);

  // Blødt, som hovedråvare-filteret: kan INGEN prissættes, er en dårlig uge
  // bedre end ingen uge.
  assert.equal(engine.sharedWeek([ukendt], { days: 1, ...FIXTURE.ctx }).picks.length, 1);

  // To veje mere til den samme gratis frokost, begge målt i basen.
  //
  // En ingrediens, taksonomien ikke kender, når aldrig ind i recipe.items —
  // motoren kan ikke selv se den, så loadRecipes tæller den.
  const medUkendtLinje = { ...recipe(27, 1.0, [line('kylling', 0.5)]), unknown_count: 2 };
  assert.deepEqual(
    engine.sharedWeek([medUkendtLinje, CANDIDATES[1]], { days: 1, ...FIXTURE.ctx })
      .picks.map((p) => p.id), [2]);

  // Og en KENDT vare uden mængde ("et stykke ingefær"): needsOf springer den
  // over, og retten køber den aldrig.
  const udenMaengde = recipe(28, 1.0, [line('kylling', 0.5), line('kartofler', null)]);
  assert.deepEqual(
    engine.sharedWeek([udenMaengde, CANDIDATES[1]], { days: 1, ...FIXTURE.ctx })
      .picks.map((p) => p.id), [2]);
});

test('uden butikker er der ingen uge — ikke en gratis uge', () => {
  // C1, anden halvdel: uden kæder kan intet prissættes, og hver ret koster
  // nul. En uge med fire retter og 0 kr på er det værste af begge dele.
  const week = engine.sharedWeek(CANDIDATES, { days: 4, ...FIXTURE.ctx, chainIds: [] });
  assert.deepEqual(week.picks, []);
  assert.equal(week.cost, 0);
  assert.deepEqual(week.shared, []);
});

test('besparelsen regnes i den butik, kurven køber i', () => {
  // C2. Kurven vælger kæde på pris PLUS værdien af spildet; forklaringen
  // valgte på enhedspris alene. De to er uenige, når den laveste kilopris
  // kommer i en større pakke — målt for 49 af de 76 varer med priser i mere
  // end én kæde.
  //
  // Her: c2 har den laveste kilopris (70 kr/kg) i en 2 kg-pose, c1 en dyrere
  // kilopris (80) i en 1 kg-pose. Behovet er 1 kg, så c1 er billigst i
  // kroner OG uden spild — kurven køber der. Enhedsprisen ville have peget
  // på c2 og talt en 2 kg-pose.
  const normals = new Map([
    ['hakket_oksekoed|c1', [{ pack_qty: 1, pack_unit: 'kg', pack_price: 80, unit_price: 80, source: 'manual' }]],
    ['hakket_oksekoed|c2', [{ pack_qty: 2, pack_unit: 'kg', pack_price: 140, unit_price: 70, source: 'manual' }]],
  ]);
  const ctx = { items: W_ITEMS, offers: new Map(), normals, chainIds: ['c1', 'c2'] };
  const halv = (id) => recipe(id, 0.8, [line('hakket_oksekoed', 0.5)]);
  const week = engine.sharedWeek([halv(25), halv(26)], { days: 2, ...ctx });

  near(week.cost, 80);                       // én 1 kg-pose fra c1
  const okse = week.shared.find((s) => s.key === 'hakket_oksekoed');
  assert.equal(okse.saved, 1);
  near(okse.saved_kr, 80);                   // c1's pose, ikke c2's 140 kr
});

test('begge forslag bærer overlappet', () => {
  // Opgave 8 læser feltet. Stod det kun på B, ville A give undefined.
  const [a, b] = engine.twoProposals(FIXTURE.candidates, { days: 3, ...FIXTURE.ctx });
  assert.equal(typeof a.overlap, 'number');
  assert.equal(a.overlap, b.overlap);
});

test('ugen bliver ikke tre retter om samme hovedråvare', () => {
  // Den sidste fælde, og den er indbygget i mekanismen: delingen BELØNNER
  // ensformighed. Tre ærteretter deles om én pose ærter, og det er den
  // billigste uge, der findes. Målt på rigtige data gav det Ærtesuppe,
  // Pea purée og Pasta med ærter og citron i samme forslag — og før det fire
  // kyllingeretter i træk.
  //
  // Fire retter med hakket oksekød som hovedråvare; kun to må komme med, og
  // den femte ret med en anden hovedråvare skal ind i stedet, selv om den er
  // dyrere.
  const okse = (id) => recipe(id, 1.0, [line('hakket_oksekoed', 0.5), line('kartofler', 0.3)]);
  const laksRet = recipe(33, 1.0, [line('laks', 0.5), line('ris', 0.3)]);
  const week = engine.sharedWeek([okse(29), okse(30), okse(31), okse(32), laksRet],
    { days: 3, ...FIXTURE.ctx });

  assert.equal(week.picks.length, 3);
  const okseRetter = week.picks.filter((p) => p.items.some((i) => i.key === 'hakket_oksekoed'));
  assert.equal(okseRetter.length, 2, `${okseRetter.length} retter om samme oksekød`);
  assert.ok(week.picks.some((p) => p.id === 33), 'laksen skal ind i stedet');
});

test('spærren tæller hovedråvaren på kategori, ikke på nøgle', () => {
  // Fælden, der slap igennem den første udgave: 'poultry' rummer syv varer
  // (and, hakket_kylling, hel_kylling, kalkun, kylling, kyllingebryst,
  // kyllingelaar), så "højst 2 pr. NØGLE" tillader fjorten kyllingemiddage.
  // Målt gav det fire kyllingeretter i samme forslag — uden at bryde spærren.
  //
  // Her: tre retter med hver sin kyllingeudskæring. Kun to må med, og laksen
  // skal ind i stedet, selv om den er dyrere.
  const kyl = (id, key) => recipe(id, 1.0, [line(key, 0.5), line('kartofler', 0.3)]);
  const laksRet = recipe(41, 1.0, [line('laks', 0.5), line('ris', 0.3)]);
  const week = engine.sharedWeek(
    [kyl(38, 'kylling'), kyl(39, 'kyllingebryst'), kyl(40, 'kyllingelaar'), laksRet],
    { days: 3, ...FIXTURE.ctx });

  const fjer = week.picks.filter((p) => W_ITEMS.get(p.items[0].key).category === 'poultry');
  assert.equal(fjer.length, 2, `${fjer.length} fjerkræretter af 3`);
  assert.ok(week.picks.some((p) => p.id === 41), 'laksen skal ind i stedet');
});

test('tilbehørsspærren overlever, at hovedråvarerne er brugt op', () => {
  // Runderne løsner én spærre ad gangen. Med [2,3] og så [99,99] forsvandt
  // tilbehørsspærren i samme øjeblik hovedråvarerne var opbrugt, og så blev
  // ugen pasta hver dag alligevel — netop den fejl, spærren findes for.
  //
  // Fem pastaretter og to risretter, alle med oksekød: hovedråvaren er
  // opbrugt efter to retter, men der må stadig højst være tre med pasta.
  const medPasta = (id) => recipe(id, 1.0, [line('hakket_oksekoed', 0.4), line('pasta', 0.3)]);
  const medRis = (id) => recipe(id, 0.9, [line('hakket_oksekoed', 0.4), line('ris', 0.3)]);
  const week = engine.sharedWeek(
    [medPasta(42), medPasta(43), medPasta(44), medPasta(45), medPasta(46), medRis(47), medRis(48)],
    { days: 5, ...FIXTURE.ctx });
  assert.equal(week.picks.length, 5);
  const pastaRetter = week.picks.filter((p) => p.items.some((i) => i.key === 'pasta'));
  assert.ok(pastaRetter.length <= 3, `${pastaRetter.length} pastaretter af 5`);
});

test('spærren giver efter, når der ikke er andet', () => {
  // Anden runde er [99, 99]: en uge med for få retter er ikke et bedre svar
  // end en ensformig uge. Fire oksekødsretter og tre dage — så bliver det tre
  // oksekødsretter.
  const okse = (id) => recipe(id, 1.0, [line('hakket_oksekoed', 0.5), line('kartofler', 0.3)]);
  const week = engine.sharedWeek([okse(34), okse(35), okse(36), okse(37)],
    { days: 3, ...FIXTURE.ctx });
  assert.equal(week.picks.length, 3);
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

// ── Kædevalg og de to lister ─────────────────────────────────────────────────
//
// Boden er 25 kr pr. ekstra butik, så grænsen ligger dér. Fiksturen lægger den
// ene vare billigere i kæde 2 med præcis kendt forskel.
//
// Kæde 2 har KUN laks. Gav man den også kartofler, kunne den dække hele kurven
// alene og uden bod — så ville svaret være ['c2'], og testen målte ikke det,
// den tror. Nu skal man i c1 efter kartoflerne uanset hvad, og spørgsmålet
// bliver det rigtige: er laksen billig nok til turen?
const NORMALS_2 = new Map([
  ...W_NORMALS,
  ['laks|c2', [{ pack_qty: 1, pack_unit: 'kg', pack_price: 102, unit_price: 102, source: 'manual' }]],
]);
const NORMALS_BILLIG = new Map([
  ...W_NORMALS,
  ['laks|c2', [{ pack_qty: 1, pack_unit: 'kg', pack_price: 0.5, unit_price: 0.5, source: 'manual' }]],
]);
const BASKET = new Map([['laks', 1], ['kartofler', 1]]);

test('en besparelse på 18 kr udløser ikke en ekstra butik', () => {
  // Laks: 120 kr i c1, 102 i c2. Kartoflerne findes kun i c1.
  //   c1 alene : 120 + 16                                  = 136
  //   c2 alene : 102 + manglende kartofler (16 + 40)        = 158
  //   c1 + c2  : 102 + 16 + 25 bod                          = 143
  // De 18 kr sparede bærer ikke turen.
  const r = engine.chooseChains(BASKET, {
    chainIds: ['c1', 'c2'], items: W_ITEMS, offers: new Map(), normals: NORMALS_2,
  });
  assert.deepEqual(r.chains, ['c1']);
  near(r.total, 136);
});

test('en stor besparelse gør den ekstra butik det værd', () => {
  //   c1 alene : 120 + 16                                  = 136
  //   c2 alene : 0,5 + manglende kartofler (16 + 40)        = 56,5
  //   c1 + c2  : 0,5 + 16 + 25 bod                          = 41,5
  //
  // Og her ligger hele grunden til, at boden for en manglende vare SKAL være
  // større end boden for en ekstra butik: var den mindre, ville "så lad
  // kartoflerne være" altid slå "så tag turen til butik 2", og optimeringen
  // ville svare ved at fjerne varer fra listen i stedet for at vælge butik.
  const r = engine.chooseChains(BASKET, {
    chainIds: ['c1', 'c2'], items: W_ITEMS, offers: new Map(), normals: NORMALS_BILLIG,
  });
  assert.deepEqual([...r.chains].sort(), ['c1', 'c2']);
  near(r.total, 41.5);
  assert.ok(engine.MISSING_ITEM_NUISANCE > engine.EXTRA_STORE_PENALTY,
    'en manglende vare skal koste mere end turen, der ville skaffe den');
});

test('boden for en manglende vare følger varens egen pris', () => {
  // En delmængde, der ikke FØRER varen, må ikke se billig ud, fordi det den
  // ikke har koster nul. Med en fast bod på 50 kr ville c2 alene stå til
  // 16 + 50 = 66 og vinde — og laksen til 120 kr ville forsvinde lydløst fra
  // indkøbslisten. Boden er varens egen billigste pris plus besværet.
  //
  //   c1 alene : 120 + 16                                  = 136
  //   c2 alene : 16 + manglende laks (120 + 40)            = 176
  //   c1 + c2  : 120 + 16 + 25 bod                          = 161
  const normals = new Map([
    ...W_NORMALS,
    ['kartofler|c2', [{ pack_qty: 2, pack_unit: 'kg', pack_price: 16, unit_price: 8, source: 'manual' }]],
  ]);
  const r = engine.chooseChains(BASKET, {
    chainIds: ['c1', 'c2'], items: W_ITEMS, offers: new Map(), normals,
  });
  assert.deepEqual(r.chains, ['c1']);
  assert.ok(r.assignment.has('laks'), 'laksen skal købes, ikke droppes');
  assert.ok(r.assignment.has('kartofler'));
});

test('uden butikker er der intet kædevalg — og ingen undtagelse', () => {
  // Løkken over delmængder kører nul gange uden kæder. Uden en egen udgang
  // returnerede funktionen null, og indkøbslisten ville kaste på
  // `chosen.assignment` i stedet for at sige, at vi ikke kender nogen pris.
  const r = engine.chooseChains(BASKET, { chainIds: [], items: W_ITEMS, normals: W_NORMALS });
  assert.deepEqual(r.chains, []);
  assert.equal(r.assignment.size, 0);
});

test('indkøbslisten deler i køb og lagertjek', () => {
  // Ret 1 har salt (essential) og kartofler (købes).
  const plan = { days: [{ recipe: CANDIDATES[0] }] };
  const list = engine.shoppingList(plan, CTX);

  assert.ok(list.buy.some((b) => b.key === 'kartofler'));
  assert.ok(list.buy.every((b) => b.key !== 'salt'), 'essentials må ikke købes');
  assert.ok(list.pantry.some((p) => p.key === 'salt'), 'salt skal på lagerlisten');
  assert.ok(list.pantry.every((p) => p.est_cost === undefined),
    'essentials må aldrig have en pris');

  // 1 kg hakket oksekød (80) + én 2 kg-pose kartofler (16).
  near(list.total, 96);
  assert.deepEqual(list.chains, ['c1']);
});

test('valgfrie linjer driver ikke et indkøb — men en valgfri hovedprotein gør', () => {
  // Præcis samme regel som ugens kurv (isBoughtLine). Var de to uenige, ville
  // ugen blive valgt på én kurv og listen skrevet på en anden — og de to tal
  // står side om side på skærmen.
  const medPersille = { days: [{ recipe: recipe(60, 0.5, [
    line('kartofler', 0.6),
    { ...line('persille', 0.02), optional: true },
  ]) }] };
  assert.ok(engine.shoppingList(medPersille, CTX).buy.every((b) => b.key !== 'persille'),
    'evt. persille skal springes over');

  // OPTIONAL_RE fejlflager "4 chicken breasts (skinless, if you like)". En ret
  // med valgfri laks er ikke en ret, så laksen købes.
  const medLaks = { days: [{ recipe: recipe(61, 0.5, [
    line('kartofler', 0.6),
    { ...line('laks', 0.4), optional: true },
  ]) }] };
  assert.ok(engine.shoppingList(medLaks, CTX).buy.some((b) => b.key === 'laks'),
    'en valgfri hovedprotein købes — se isBoughtLine');
});

test('indkøbslisten skalerer til husstanden', () => {
  // Ellers vælges ugen på skalerede mængder, mens listen skrives på
  // opskriftens egne — og listen er det, der bliver til virkelighed.
  const tilTi = { ...recipe(62, 0.8, [line('hakket_oksekoed', 2.5)]), servings: 10 };
  const plan = { days: [{ recipe: tilTi }] };

  near(engine.shoppingList(plan, { ...CTX, servings: 4 }).total, 80);   // 1,0 kg -> én pose
  near(engine.shoppingList(plan, { ...CTX, servings: 8 }).total, 160);  // 2,0 kg -> to poser
  near(engine.shoppingList(plan, CTX).total, 80);                      // standard er 4
});

test('listen og ugen regner på den samme kurv', () => {
  // Invarianten, der betyder mest: ugens pris og indkøbslistens sum er det
  // samme regnestykke på det samme grundlag. Skrider de fra hinanden, står
  // der to forskellige tal på skærmen for den samme uge.
  const week = engine.sharedWeek(CANDIDATES, { days: 2, ...CTX });
  const list = engine.shoppingList({ days: week.picks.map((r) => ({ recipe: r })) }, CTX);
  near(list.total, week.cost);
});

test('spildet står i kroner og er vægtet efter holdbarhed', () => {
  // Tre tal, og kun det ene er rigtigt. 0,6 kg laks til overs (perishable,
  // 120 kr/kg) og 0,75 kg pasta (pantry, 12 kr/kg):
  //
  //   1,35        de rå rester lagt sammen — kilo laks plus kilo pasta er
  //               tilfældigvis samme enhed her, men med æg i kurven adderer
  //               samme regnestykke stykker og kilo. Dimensionsfejlen fra
  //               opgave 5 og 7, denne gang direkte på skærmen.
  //   81 kr       uvægtet: 72 for laksen PLUS 9 for pasta, der ikke bliver
  //               smidt ud. Så er items.keeps uden virkning, og "kartofler
  //               til overs er ikke spild" gælder ikke længere.
  //   72 kr       vægtet: laksen tæller fuldt, pastaen slet ikke.
  const plan = { days: [{ recipe: recipe(63, 0.8, [line('laks', 0.4), line('pasta', 0.25)]) }] };
  near(engine.shoppingList(plan, CTX).waste_kr, 72);
});

test('ugens spildscore er halvdelen af listens spild', () => {
  // De to tal står side om side i brugerfladen — ugens "spild" i forslaget og
  // listens waste_kr — og skal kunne regnes om til hinanden. Ugens er
  // betalingsvilligheden (× WASTE_AVERSION), listens er værdien.
  const week = engine.sharedWeek(CANDIDATES, { days: 2, ...CTX });
  const list = engine.shoppingList({ days: week.picks.map((r) => ({ recipe: r })) }, CTX);
  near(week.waste, list.waste_kr * engine.WASTE_AVERSION);
});

test('used_in tæller kun de retter, varen faktisk købes til', () => {
  // Målt på første rigtige kørsel: "potato wedges and green veg, to serve
  // (optional)" er en kartoffellinje, der aldrig bliver købt. Talte den med,
  // stod der "Kartofler · 0,7 kg · 2 retter" om en mængde, kun én ret havde
  // bedt om — og tallet står lige ved siden af mængden.
  const koeber = recipe(66, 0.8, [line('kartofler', 0.7), line('kylling', 0.5)]);
  const pynt = recipe(67, 0.8, [line('laks', 0.5), { ...line('kartofler', null), optional: true }]);
  const list = engine.shoppingList({ days: [{ recipe: koeber }, { recipe: pynt }] }, CTX);
  const kart = list.buy.find((b) => b.key === 'kartofler');
  near(kart.need, 0.7);
  assert.deepEqual(kart.used_in, ['Ret 66']);
});

test('3 g hvidløg står ikke som 0 kg på listen', () => {
  // round2 er rigtig for en pris og forkert for en mængde. "0 kg Hvidløg" på
  // en indkøbsliste er ikke en oplysning — samme fejl som i explainWeek.
  const plan = { days: [{ recipe: recipe(64, 0.8, [line('hvidloeg', 0.003)]) }] };
  const hvid = engine.shoppingList(plan, CTX).buy.find((b) => b.key === 'hvidloeg');
  assert.ok(hvid.need > 0, `hvidløget stod som ${hvid.need}`);
});

test('en vare uden pris står stadig på listen — og tælles', () => {
  // Havbars har ingen pris i c1. Den skal stadig købes: behovet er ægte, og
  // en liste, der tier om det, sender folk hjem uden aftensmad. Men den må
  // ikke tælle som 0 kr i totalen, og brugeren skal kunne se, hvor mange
  // linjer der mangler en pris.
  const plan = { days: [{ recipe: recipe(65, 0.8, [line('havbars', 0.6), line('kartofler', 0.6)]) }] };
  const list = engine.shoppingList(plan, CTX);
  const hav = list.buy.find((b) => b.key === 'havbars');
  assert.ok(hav, 'havbarsen skal stå på listen');
  assert.equal(hav.est_cost, null);
  assert.equal(hav.chain, null);
  assert.equal(list.unpriced, 1);
  near(list.total, 16);
});
