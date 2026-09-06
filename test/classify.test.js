'use strict';

/**
 * Regressionstest for feltnavne-skiftet i opgave 3.
 *
 * taxonomy.get()/.lookup() returnerer nu baserækker (`category`,
 * `protein_per_100g`, `kcal_per_100g`, `carbs_per_100g`) i stedet for
 * seedets korte navne (`cat`, `p`, `kcal`, `c`). classify.js læste de gamle
 * navne uden at fejle – det blev bare stille og roligt forkert.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { estimateNutrition, scoreTiers } = require('../src/recipes/classify');

test('estimateNutrition regner på varens makroer', () => {
  const est = estimateNutrition([
    { taxonomy_key: 'kyllingebryst', qty: 600, unit: 'g' },
    { taxonomy_key: 'ris',           qty: 250, unit: 'g' },
  ], 4);
  assert.ok(est, 'må ikke være null — det er den, når feltnavnene ikke passer');
  assert.ok(est.protein_g > 20, `protein pr. portion var ${est.protein_g}`);
});

test('scoreTiers ser kategorierne', () => {
  // Kylling + broccoli + ris er en lærebogs-"sund og proteinrig" ret. Ser
  // scoreTiers ikke kategorierne, tæller den 0 grøntsager og scorer den som
  // hverdagsmad — uden at fejle.
  const s = scoreTiers({ protein_g: 35, kcal: 520, total_minutes: 30 }, [
    { taxonomy_key: 'kyllingebryst', qty: 600, unit: 'g' },
    { taxonomy_key: 'broccoli',      qty: 300, unit: 'g' },
    { taxonomy_key: 'ris',           qty: 250, unit: 'g' },
  ]);
  assert.ok(s.healthy > s.classic, `healthy ${s.healthy} skulle slå classic ${s.classic}`);
});
