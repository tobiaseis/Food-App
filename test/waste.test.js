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
