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
