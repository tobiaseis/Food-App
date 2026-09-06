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

// ── Brotest mod facit ────────────────────────────────────────────────────────
//
// Så længe taxonomy.js har sin egen lookup, ER den facit. Denne test er den
// eneste, der kan fange, at det nye indeks er *næsten* magen til — og næsten
// er ikke godt nok, når 26.242 ingredienslinjer skal slås op gennem det.
// Opgave 3 sletter testen igen, fordi facit forsvinder dér.

test('indekset svarer som taxonomy.js på ægte ingredienslinjer', () => {
  const taxonomy = require('../src/lib/taxonomy');
  const mirror = buildIndex(
    taxonomy.TAXONOMY.map((e) => ({
      key: e.key, name: e.name, category: e.cat,
      class: 'fresh', keeps: 'keeps', base_unit: 'kg', premium: !!e.premium,
    })),
    taxonomy.TAXONOMY.flatMap((e) => [
      ...(e.da || []).map((t) => ({ item_key: e.key, lang: 'da', text: t })),
      ...(e.en || []).map((t) => ({ item_key: e.key, lang: 'en', text: t })),
    ]),
  );

  // Hver linje er en fælde, kommentarerne i taxonomy.js navngiver.
  const CASES = [
    '500 g hakket oksekød', 'jomfruolivenolie', 'Skinkeculotte',
    'Indbagt laks med spinat', 'majskylling', 'tomat ketchup', 'butter beans',
    '3 boneless and skinless chicken thighs', 'Lambi crisps with topping',
    '2 courgettes', 'tomatoes, roughly chopped', '400 g plum tomatoes',
    '1 dåse hakkede tomater', 'friskkværnet peber', 'grillkylling',
    'reveal the pepperoni', 'pork tenderloin, sliced', '2 dl piskefløde',
  ];
  for (const text of CASES) {
    assert.equal(
      mirror.lookup(text)?.entry.key ?? null,
      taxonomy.lookup(text)?.entry.key ?? null,
      text,
    );
  }
});

// ── Kurateringen fra spec afsnit 1.1 ─────────────────────────────────────────

const taxonomy = require('../src/lib/taxonomy');

test('essentials er hvad der reelt står i et dansk køkkenskab', () => {
  for (const key of ['salt', 'peber', 'olie', 'eddike', 'sukker', 'mel',
                     'bouillon', 'soja', 'ketchup', 'honning', 'rasp']) {
    assert.equal(taxonomy.get(key).class, 'essential', `${key} skal være essential`);
  }
});

test('hvidløg, ingefær og frisk persille skal købes — de er ikke essentials', () => {
  for (const key of ['hvidloeg', 'ingefaer', 'persille']) {
    assert.notEqual(taxonomy.get(key).class, 'essential', `${key} skal købes`);
  }
});

test('specialkrydderier er baseline: de købes, men holder i månedsvis', () => {
  for (const key of ['sesamfroe', 'garam_masala', 'gurkemeje', 'kardemomme']) {
    const it = taxonomy.get(key);
    assert.equal(it.class, 'baseline', `${key} skal være baseline`);
    assert.equal(it.keeps, 'pantry', `${key} skal holde i månedsvis`);
  }
});

test('rodfrugter og kål er baseline — prisen står stille året rundt', () => {
  for (const key of ['kartofler', 'gulerod', 'loeg', 'kaal']) {
    const it = taxonomy.get(key);
    assert.equal(it.class, 'baseline', `${key} skal være baseline`);
    assert.equal(it.keeps, 'keeps', `${key} skal holde i uger`);
  }
});

test('varer der rådner på en uge er fresh og perishable', () => {
  for (const key of ['tomat', 'agurk', 'broccoli', 'porre']) {
    const it = taxonomy.get(key);
    assert.equal(it.class, 'fresh', `${key} skal være fresh`);
    assert.equal(it.keeps, 'perishable', `${key} skal være perishable`);
  }
});

test('alle varer har gyldig class og keeps', () => {
  const CLASSES = new Set(['fresh', 'baseline', 'essential']);
  const KEEPS   = new Set(['perishable', 'keeps', 'pantry']);
  for (const it of taxonomy.all()) {
    assert.ok(CLASSES.has(it.class), `${it.key} har ugyldig class: ${it.class}`);
    assert.ok(KEEPS.has(it.keeps),   `${it.key} har ugyldig keeps: ${it.keeps}`);
  }
});

test('essentials må aldrig være perishable — så ville de ikke kunne stå i skabet', () => {
  for (const it of taxonomy.all()) {
    if (it.class === 'essential') {
      assert.notEqual(it.keeps, 'perishable', `${it.key} kan ikke være essential og perishable`);
    }
  }
});

test('isStaple findes ikke længere — informationen bor i class', () => {
  assert.equal(typeof taxonomy.isStaple, 'undefined');
});
