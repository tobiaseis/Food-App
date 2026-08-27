'use strict';

/**
 * Regressionstests for normaliseringen.
 *
 * Hver case her er et rigtigt eksempel fra en dansk tilbudsavis, som på et
 * tidspunkt blev udregnet forkert. De er ikke opdigtede – de er de fælder,
 * data faktisk indeholder.
 *
 *   node --test test/
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const norm = require('../src/lib/normalize');
const taxonomy = require('../src/lib/taxonomy');
const { parseIngredient } = require('../src/recipes/extract');

// ── Dansk talformat ──────────────────────────────────────────────────────────

test('dansk talformat: punktum er tusindseparator, komma er decimaltegn', () => {
  const cases = [
    // "Pr. kg max 1.268,57" betyder 1268,57 kr/kg – ikke 1,268
    ['Flere varianter Pr. kg max 1.268,57 7-200 gram', 1268.57],
    ['24x33 cl. Pr. liter 9.97', 9.97],
    ['72.00/9.09 pr. liter', 9.09],
    ['Partivare. Max. 393.33 pr. kg', 393.33],
    ['500 g. Pr. kg 30,00', 30],
  ];
  for (const [desc, expected] of cases) {
    assert.equal(norm.parseStatedUnitPrice(desc)?.value, expected, desc);
  }
});

test('kvalitetsklasse forveksles ikke med kilopris', () => {
  // "Klasse 1." stod før som "1 pr. kg" og gjorde druer til 1 kr/kg
  const r = norm.parseStatedUnitPrice('Klasse 1. Pr. kg 24,00 Pr. 1/2 kg');
  assert.equal(r.value, 24);
  assert.equal(r.unit, 'kg');
});

// ── Enhedspris ───────────────────────────────────────────────────────────────

const offer = (price, size, unitSymbol, siSymbol, siFactor, pieces, description) => ({
  pricing: { price },
  description,
  quantity: {
    unit: { symbol: unitSymbol, si: { symbol: siSymbol, factor: siFactor } },
    size: { from: size[0], to: size[1] },
    pieces: { from: pieces[0], to: pieces[1] },
  },
});

test('enhedspris rammer avisens eget tal for en enkelt dåse', () => {
  // Pepsi 33 cl til 3 kr – avisen trykker selv 9,09 pr. liter
  const r = norm.computeUnitPrice(
    offer(3, [33, 33], 'cl', 'l', 0.01, [1, 1], '33 cl. 72.00/9.09 pr. liter')
  );
  assert.equal(r.base_unit, 'l');
  assert.equal(r.unit_price, 9.09);
});

test('forkert enhed i API-data fanges af avisens pr.-liter-linje', () => {
  // Tjek angiver 24×33 cl som "33 l pr. stk" => 792 liter => 0,10 kr/l
  const r = norm.computeUnitPrice(
    offer(79, [33, 33], 'l', 'l', 1, [24, 24], '24x33 cl. ds. Pr. liter 9.97')
  );
  assert.equal(r.unit_price, 9.97, 'skal rette sig efter avisen, ikke efter 792 liter');
  assert.ok(r.base_qty < 25, 'mængden skal være realistisk');
});

test('halvkilo-vare regnes korrekt trods forvirrende beskrivelse', () => {
  const r = norm.computeUnitPrice(
    offer(12, [0.5, 0.5], 'kg', 'kg', 1, [1, 1], 'Klasse 1. Pr. kg 24,00 Pr. 1/2 kg')
  );
  assert.equal(r.unit_price, 24);
  assert.equal(r.base_qty, 0.5);
});

test('urealistisk mængde giver aldrig en kilopris', () => {
  // Hellere en stykpris end et forkert kr/kg, der topper "ugens fund".
  // 900 kg er ikke en dagligvare, så mængden forkastes og prisen falder
  // tilbage til pris pr. stk.
  const r = norm.computeUnitPrice(offer(50, [900, 900], 'kg', 'kg', 1, [1, 1], 'Ingen kilopris her'));
  assert.equal(r.base_unit, 'stk', 'må ikke udgive sig for at være en kilopris');
  assert.equal(r.unit_price, 50, 'falder tilbage til pris pr. stk');
});

test('flerstyksemballage ganges op', () => {
  // 2-pak à 500 g = 1 kg
  const r = norm.computeUnitPrice(offer(40, [500, 500], 'g', 'kg', 0.001, [2, 2], '2 x 500 g'));
  assert.equal(r.base_qty, 1);
  assert.equal(r.unit_price, 40);
});

// ── Vare-identitet ───────────────────────────────────────────────────────────

test('samme varetype genkendes på tværs af forskellige overskrifter', () => {
  // Uden dette findes der ingen prishistorik: hver uges ordlyd ville
  // blive til sin egen "vare".
  const variants = [
    'REMA 1000 Hakket dansk oksekød 15-20%',
    'Hakket oksekød 8-12%',
    'Dansk hakket oksekød, 500 g',
  ];
  const keys = variants.map((v) => norm.productIdentity(v).taxonomy_key);
  assert.deepEqual(keys, ['hakket_oksekoed', 'hakket_oksekoed', 'hakket_oksekoed']);
});

// ── Varianter der flytter prisen ─────────────────────────────────────────────

test('fedtprocent adskiller hakket kød i forskellige varer', () => {
  // 8-12 % og 15-20 % har systematisk forskellig kilopris. Slås de sammen,
  // ligner prisforskellen på magert og fedt kød et tilbud.
  const mager = norm.productIdentity('Coop hakket oksekød 8-12%');
  const fed   = norm.productIdentity('REMA 1000 Hakket dansk oksekød 15-20%');
  assert.equal(mager.fat_grade, '8-12');
  assert.equal(fed.fat_grade, '15-20');
  assert.notEqual(mager.slug, fed.slug);
  assert.equal(mager.taxonomy_key, fed.taxonomy_key, 'stadig samme varetype');
});

test('nærliggende fedtintervaller samles i samme grad', () => {
  // "14-18 %" og "15-20 %" er den samme hylde hos slagteren
  assert.equal(norm.productIdentity('Velsmag hakket oksekød 14-18%').fat_grade, '15-20');
  assert.equal(norm.productIdentity('Coop hakket oksekød 4-7%').fat_grade, '3-7');
});

test('procenter der ikke er fedt ignoreres', () => {
  // "med 35 % grøntsager" er ikke en fedtprocent
  assert.equal(norm.parseFatGrade('Hakket oksekød med 35 % grøntsager'), null);
  assert.equal(norm.parseFatGrade('Spar 20 % på alt kød'), null);
});

test('økologi genkendes trods dansk ordgrænse', () => {
  // /\bøkolog/ matcher ALDRIG " økologisk", fordi ø ikke er et ASCII-ordtegn
  assert.ok(norm.isOrganic('Änglamark økologisk hakket oksekød 8-12%'));
  assert.ok(norm.isOrganic('ØGO økologisk hakket oksekød'));
  assert.ok(!norm.isOrganic('Hakket oksekød 8-12%'));
});

test('økologisk kød er sin egen vare', () => {
  // Samme fedtprocent koster ~40 % mere økologisk – de må ikke sammenlignes
  const konv = norm.productIdentity('Coop hakket oksekød 8-12%');
  const oeko = norm.productIdentity('ØGO økologisk hakket oksekød 8-12%');
  assert.equal(konv.organic, 0);
  assert.equal(oeko.organic, 1);
  assert.notEqual(konv.slug, oeko.slug);
});

test('primær variant vælges ved "eller"-tilbud', () => {
  const id = norm.productIdentity('Pepsi Max eller Faxe Kondi', '33 cl');
  assert.equal(id.taxonomy_key, 'sodavand');
});

test('sammensatte ord matcher på hovedordet', () => {
  assert.equal(taxonomy.lookup('clemente ekstra jomfruolivenolie').entry.key, 'olie');
  assert.equal(taxonomy.lookup('skinkeculotte').entry.key, 'skinke', 'dansk sætter hovedordet forrest');
});

test('korte ord matcher ikke inde i andre ord', () => {
  // "is" må ikke ramme "ris", "and" må ikke ramme vilkårlige ord
  assert.equal(taxonomy.lookup('jasminris').entry.key, 'ris');
  assert.notEqual(taxonomy.lookup('Kartoffelmix')?.entry.key, 'is');
});

test('marcipanbrød er konfekt, ikke brød', () => {
  assert.equal(norm.productIdentity('Anthon Berg minimarcipanbrød').taxonomy_key, 'chokolade');
});

test('kaffe slår bønner i "hele bønner"-tilbud', () => {
  const id = norm.productIdentity('Gevalia, Café Noir, Peter Larsen formalet kaffe eller hele bønner');
  assert.equal(id.taxonomy_key, 'kaffe');
});

// ── Ingrediensparsing ────────────────────────────────────────────────────────

test('dansk enhedsforkortelse forveksles ikke med begyndelsen af et ord', () => {
  // "2 løg" blev til "2 l" + "øg", fordi \b i JS ikke regner ø som bogstav
  const r = parseIngredient('2 løg, finthakket');
  assert.equal(r.qty, 2);
  assert.equal(r.unit, null);
  assert.equal(r.taxonomy_key, 'loeg');
});

test('mængde og enhed læses ud af danske ingredienslinjer', () => {
  const r = parseIngredient('400 g hakket oksekød');
  assert.equal(r.qty, 400);
  assert.equal(r.unit, 'g');
  assert.equal(r.taxonomy_key, 'hakket_oksekoed');
});

test('engelske ingredienser kobles til danske varetyper', () => {
  // Sprogbroen: engelske opskrifter skal kunne matche danske tilbud
  assert.equal(parseIngredient('500g beef mince').taxonomy_key, 'hakket_oksekoed');
  assert.equal(parseIngredient('2 garlic cloves, crushed').taxonomy_key, 'hvidloeg');
  assert.equal(parseIngredient('1 onion, finely chopped').taxonomy_key, 'loeg');
});

test('brøker og intervaller læses som tal', () => {
  assert.equal(parseIngredient('½ citron').qty, 0.5);
  assert.equal(parseIngredient('2-3 gulerødder').qty, 2.5);
});

test('basisvarer markeres, så de ikke tæller som tilbudsmatch', () => {
  assert.equal(parseIngredient('1 tsk salt').is_staple, 1);
  assert.equal(parseIngredient('2 spsk olivenolie').is_staple, 1);
  assert.equal(parseIngredient('400 g kyllingebryst').is_staple, 0);
});

// ── ISO-uge ──────────────────────────────────────────────────────────────────

test('ISO-uge beregnes efter torsdagsreglen', () => {
  assert.deepEqual(norm.isoWeek(new Date('2026-01-01')), { week: 1, year: 2026 });
  assert.deepEqual(norm.isoWeek(new Date('2026-08-27')), { week: 35, year: 2026 });
});
