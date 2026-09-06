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
  // Måler at en kategori FLYTTER scoren — ikke hvordan sporene rangerer
  // indbyrdes (det er en vægtnings-beslutning, ikke denne opgaves ansvar).
  // Ser scoreTiers ikke kategorierne, gør ekstra grøntsager ingen forskel.
  const recipe = { protein_g: 35, kcal: 520, total_minutes: 30 };
  const uden = scoreTiers(recipe, [{ taxonomy_key: 'kyllingebryst', qty: 600, unit: 'g' }]);
  const med  = scoreTiers(recipe, [
    { taxonomy_key: 'kyllingebryst', qty: 600, unit: 'g' },
    { taxonomy_key: 'broccoli',      qty: 300, unit: 'g' },
    { taxonomy_key: 'spinat',        qty: 100, unit: 'g' },
  ]);
  assert.ok(med.healthy > uden.healthy,
    `grøntsager skal hæve healthy: ${med.healthy} vs ${uden.healthy}`);
});

test('scoreTiers ser luksusråvarer', () => {
  const s = scoreTiers({ protein_g: 35, kcal: 520, total_minutes: 30 }, [
    { taxonomy_key: 'oksemoerbrad', qty: 600, unit: 'g' },
    { taxonomy_key: 'lam',          qty: 200, unit: 'g' },
  ]);
  assert.ok(s.premium > 0, `premium var ${s.premium} — isPremium ses ikke`);
});
