'use strict';

/**
 * Tests for enhedskonvertering.
 *
 * Den vigtige regel: rumfang må ikke gå gennem gram, når varen måles i liter.
 * "2 dl fløde" er 0,2 l uanset fløderens massefylde — regner man om til gram
 * og tilbage, får man 0,22 l, og indkøbslisten køber en karton for meget.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { gramsOf, amountOf, parenWeight, amountOfLine } = require('../src/lib/units');

const KG   = { base_unit: 'kg' };
const L    = { base_unit: 'l', density_g_ml: 1.0 };
const OLIE = { base_unit: 'l', density_g_ml: 0.92 };
const LOEG = { base_unit: 'kg', piece_g: 110 };
const AEG  = { base_unit: 'stk', piece_g: 58 };

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('masse til kg', () => {
  near(amountOf({ qty: 500, unit: 'g' }, KG), 0.5);
  near(amountOf({ qty: 1.5, unit: 'kg' }, KG), 1.5);
});

test('rumfang til liter går IKKE gennem gram', () => {
  near(amountOf({ qty: 2, unit: 'dl' }, L), 0.2);
  // Massefylden må ikke smitte af, når begge sider er rumfang.
  near(amountOf({ qty: 2, unit: 'dl' }, OLIE), 0.2);
});

test('rumfang til kg bruger massefylden', () => {
  near(amountOf({ qty: 1, unit: 'l' }, { base_unit: 'kg', density_g_ml: 0.92 }), 0.92);
});

test('masse til liter bruger massefylden den anden vej', () => {
  near(amountOf({ qty: 920, unit: 'g' }, OLIE), 1.0);
});

test('stykvarer tælles, de vejes ikke', () => {
  near(amountOf({ qty: 4, unit: null }, AEG), 4);
  near(amountOf({ qty: 4, unit: 'stk' }, AEG), 4);
  // 200 g æg er ~3,4 æg
  near(amountOf({ qty: 200, unit: 'g' }, AEG), 200 / 58);
});

test('"2 løg" bruger stykvægten', () => {
  near(amountOf({ qty: 2, unit: null }, LOEG), 0.22);
});

test('enhedsløst tal over 100 er gram, ikke stykker', () => {
  // "400 hakket svinekød" uden enhed: 400 g, ikke 400 stykker á 100 g.
  near(amountOf({ qty: 400, unit: null, item_key: 'hakket_svinekoed' }, KG), 0.4);
  near(amountOf({ qty: 175, unit: null, item_key: 'mel' }, KG), 0.175);
  // Under grænsen tælles der stadig stykker.
  near(amountOf({ qty: 2, unit: null }, LOEG), 0.22);
  // 30 asparges à 20 g. Var 3 kg, da asparges faldt tilbage til 100 g stykket.
  near(amountOf({ qty: 30, unit: null, item_key: 'asparges' }, KG), 0.6);
  // Stykvarer tælles uanset hvor mange der er.
  near(amountOf({ qty: 12, unit: null }, AEG), 12);
});

test('stykvarer tælles uanset hvor mange, også over gram-grænsen', () => {
  // 150 æg er 150 stykker, ikke 150 gram. Uden undtagelsen i gramsOf ville
  // grænsen slå til, og et stort antal stykvarer blive til en vægt.
  near(amountOf({ qty: 150, unit: null }, AEG), 150);
  near(gramsOf({ qty: 150, unit: null, item_key: 'aeg' }, AEG), 150 * 58);
});

test('ukendt mængde giver null, ikke nul', () => {
  assert.equal(amountOf({ qty: null, unit: 'g' }, KG), null);
  assert.equal(amountOf({ qty: 0, unit: 'g' }, KG), null);
  assert.equal(amountOf({ qty: 2, unit: 'g' }, null), null);
});

test('gramsOf er stadig til rådighed for næringsberegningen', () => {
  near(gramsOf({ qty: 2, unit: 'dl' }, L), 200);
  near(gramsOf({ qty: 2, unit: null }, LOEG), 220);
});

test('gramsOf uden vare falder tilbage til stykvægten på ingrediensens nøgle', () => {
  // Det gamle gramsOf slog selv op i PIECE_G. Mister vi det, bliver hvert
  // løg til 100 g, og både rollevægt og pris i madplanen skrider.
  near(gramsOf({ qty: 1, unit: null, taxonomy_key: 'loeg' }), 110);
  near(gramsOf({ qty: 2, unit: null, item_key: 'aeg' }), 116);
  near(gramsOf({ qty: 1, unit: null, taxonomy_key: 'ukendt_vare' }), 100);
  near(gramsOf({ qty: 1, unit: null }), 100);
});

test('varen vinder over tabellen, når begge findes', () => {
  near(gramsOf({ qty: 1, unit: null, taxonomy_key: 'loeg' }, { piece_g: 200 }), 200);
});

// ── Vægten i parentesen ─────────────────────────────────────────────────────
//
// "1 kylling (ca. 1200 g)" blev til 0,1 kg, fordi parentesen blev skåret væk,
// før mængden blev læst. 331 linjer har et bart antal og en vægt i parentes.


test('forfatterens vægt i parentes vinder over vores stykvægt', () => {
  // Uden parentesen er "1 kylling" ét stykke à 100 g.
  near(amountOfLine({ raw: '1 kylling (ca. 1200 g)', qty: 1, unit: null }, KG), 1.2);
  near(amountOfLine({ raw: '4 kyllingeoverlår (ca. 1 kg)', qty: 4, unit: null }, KG), 1);
});

test('en vægt pr. stykke ganges med antallet', () => {
  near(amountOfLine({ raw: '2 kyllingebryst (á 125 g)', qty: 2, unit: null }, KG), 0.25);
  near(amountOfLine({ raw: '4 chicken breasts (about 200g each)', qty: 4, unit: null }, KG), 0.8);
  near(amountOfLine({ raw: '12 prawns (ideally around 60-80g per prawn)', qty: 12, unit: null }, KG), 0.84);
});

test('et alternativ i parentes er ikke denne vares vægt', () => {
  // "(or 800-900g trimmed lean leg)" beskriver en anden vare end linjens.
  assert.equal(parenWeight('1 leg of lamb (or 800-900g trimmed lean leg)'), null);
});

test('et interval bliver til midtpunktet', () => {
  near(amountOfLine({ raw: '1 squash (about 300-400g)', qty: 1, unit: null }, KG), 0.35);
});

test('parentesen tilsidesætter ikke en rigtig enhed eller en stk-vare', () => {
  // "2 dåser (ca. 800 g)": dåsen er selv en enhed, og amountOf regner den.
  const daase = amountOfLine({ raw: '2 dåser tomater (ca. 800 g)', qty: 2, unit: 'dåser' }, KG);
  near(daase, amountOf({ qty: 2, unit: 'dåser' }, KG));
  // "4 æg (ca. 250 g)" er fire æg — æg tælles i stk, og antallet ER mængden.
  const STK = { base_unit: 'stk' };
  near(amountOfLine({ raw: '4 æg (ca. 250 g)', qty: 4, unit: null, item_key: 'aeg' }, STK), 4);
});

test('vægten må også stå efter et komma — og decimalkommaet deler ikke', () => {
  // "1 ribbensteg, cirka 1,5 kg." blev gemt som 0,1 kg og lå øverst i
  // budget-sporet til 1,39 kr pr. portion. Et almindeligt split(',') skar
  // "1,5" over til "cirka 1" uden enhed.
  near(amountOfLine({ raw: '1 ribbensteg, cirka 1,5 kg.', qty: 1, unit: null }, KG), 1.5);
  near(amountOfLine({ raw: '4 gammon steaks, about 300g each', qty: 4, unit: null }, KG), 1.2);
  // Et kommasegment tæller kun, når det SELV starter med en omtrentlig vægt.
  assert.equal(parenWeight('2 løg, hakket'), null);
});
