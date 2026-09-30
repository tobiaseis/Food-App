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
