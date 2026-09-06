'use strict';

/**
 * Tests for opslagsindekset.
 *
 * Reglerne her er ikke akademiske. Hver case er et sted, hvor et naivt
 * indexOf gav et forkert svar på ægte data: dansk sætter ord sammen, engelsk
 * gør ikke, og hovedordet står forrest i danske varenavne.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIndex } = require('../src/lib/items');

const ITEMS = [
  { key: 'hakket_oksekoed', name: 'Hakket oksekød', category: 'meat',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg' },
  { key: 'oksekoed', name: 'Oksekød', category: 'meat',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg' },
  { key: 'olie', name: 'Olie', category: 'pantry',
    class: 'essential', keeps: 'pantry', base_unit: 'l' },
  { key: 'ris', name: 'Ris', category: 'grain',
    class: 'baseline', keeps: 'pantry', base_unit: 'kg' },
  { key: 'lam', name: 'Lammekød', category: 'meat',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg', premium: true },
  { key: 'kyllingelaar', name: 'Kyllingelår', category: 'poultry',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg' },
];

const SYNONYMS = [
  { item_key: 'hakket_oksekoed', lang: 'da', text: 'hakket oksekød' },
  { item_key: 'hakket_oksekoed', lang: 'en', text: 'minced beef' },
  { item_key: 'oksekoed',        lang: 'da', text: 'oksekød' },
  { item_key: 'oksekoed',        lang: 'en', text: 'beef' },
  { item_key: 'olie',            lang: 'da', text: 'olivenolie' },
  { item_key: 'ris',             lang: 'da', text: 'ris' },
  { item_key: 'lam',             lang: 'en', text: 'lamb' },
  { item_key: 'kyllingelaar',    lang: 'en', text: 'chicken thighs' },
];

const idx = buildIndex(ITEMS, SYNONYMS);

test('det mest specifikke synonym vinder over sin egen orddel', () => {
  assert.equal(idx.lookup('500 g hakket oksekød').entry.key, 'hakket_oksekoed');
});

test('dansk accepterer delmatch i sammensatte ord', () => {
  // 'olivenolie' er ét ord; betydningen sidder inde i ordet.
  assert.equal(idx.lookup('jomfruolivenolie').entry.key, 'olie');
});

test('engelsk kræver helt ord — "Lambi" er ikke lamb', () => {
  assert.equal(idx.lookup('Lambi crisps with the topping'), null);
});

test('korte danske synonymer lukkes ude af engelsk tekst', () => {
  // 'ris' må ikke ramme 'crisps'; 'chicken thighs' skal vinde.
  assert.equal(
    idx.lookup('3 boneless and skinless chicken thighs').entry.key,
    'kyllingelaar',
  );
});

test('get returnerer varen, ukendt nøgle giver null', () => {
  assert.equal(idx.get('ris').name, 'Ris');
  assert.equal(idx.get('findes_ikke'), null);
});

test('isEssential læser class, ikke en separat liste', () => {
  assert.equal(idx.isEssential('olie'), true);
  assert.equal(idx.isEssential('ris'), false);
  assert.equal(idx.isEssential('hakket_oksekoed'), false);
});

test('isPremium læser premium-flaget', () => {
  assert.equal(idx.isPremium('lam'), true);
  assert.equal(idx.isPremium('ris'), false);
});

test('all() giver alle varer', () => {
  assert.equal(idx.all().length, ITEMS.length);
});
