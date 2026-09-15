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
const { PIECE_G } = require('../src/lib/units');
const taxonomy = require('../src/lib/taxonomy');

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

// ── Kurateringen fra spec afsnit 1.1 ─────────────────────────────────────────

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

test('specialblandinger flyttet ud af krydderi er baseline, ikke essential', () => {
  // Afsluttende whole-branch review: 'essential' betyder "antages allerede i
  // skabet", og disse seks er specialblandinger/importvarer, ikke almindelige
  // danske skabsvarer — samme begrundelse som garam masala og kardemomme
  // ovenfor. Var de blevet på krydderi (essential), ville de aldrig komme på
  // indkøbslisten eller få en pris, og opskrifter, der reelt mangler dem,
  // ville tælles som fuldt prissatte.
  for (const key of ['zaatar', 'cajun_krydderi', 'five_spice', 'mixed_spice',
                      'blandede_krydderurter', 'muskatblomme']) {
    const it = taxonomy.get(key);
    assert.ok(it, `${key} skal findes i taksonomien`);
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

test('nye synonymer stjæler ikke match fra eksisterende varer', () => {
  // Danske synonymer matcher som orddele, og lige match afgøres af position.
  // Et kort, generisk stammeord kan derfor kapre linjer, det ikke ejer.
  const CASES = [
    ['sesamolie', 'olie'], ['sesame oil', 'olie'], ['toasted sesame oil', 'olie'],
    ['sesamfrø', 'sesamfroe'], ['sesame seeds', 'sesamfroe'],
    ['jomfruolivenolie', 'olie'], ['kokosmælk', 'kokosmaelk'],
  ];
  for (const [text, key] of CASES) {
    assert.equal(taxonomy.lookup(text)?.entry.key ?? null, key, text);
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

// ── Seed-vejen og database-vejen skal give det samme ────────────────────────
//
// Taksonomien har to kilder: basens rækker og SEED-arrayet. De skal give det
// samme. Ellers består testene mod en forældet base, mens produktionen kører
// på noget andet — præcis den fejltype, hele denne opgave findes for at
// fjerne, og den der ikke fejler når den rammer.
//
// Mappingen herunder skal holdes identisk med fallbacket i taxonomy.js.
function seedIndex() {
  const { SEED } = taxonomy;
  return buildIndex(
    SEED.map((e) => ({
      key: e.key, name: e.name, category: e.cat, class: e.class, keeps: e.keeps,
      base_unit: e.base_unit || 'kg', piece_g: PIECE_G[e.key] ?? null,
      density_g_ml: e.density_g_ml ?? null,
      protein_per_100g: e.p ?? null, kcal_per_100g: e.kcal ?? null,
      carbs_per_100g: e.c ?? null,
      premium: e.premium ? 1 : 0, fat_grades: e.fatGrades ? 1 : 0,
    })),
    SEED.flatMap((e) => [
      ...(e.da || []).map((t) => ({ item_key: e.key, lang: 'da', text: t })),
      ...(e.en || []).map((t) => ({ item_key: e.key, lang: 'en', text: t })),
    ]),
  );
}

test('seed-vejen og database-vejen giver samme varer', () => {
  const FIELDS = ['name', 'category', 'class', 'keeps', 'base_unit',
                  'piece_g', 'density_g_ml', 'protein_per_100g',
                  'kcal_per_100g', 'carbs_per_100g', 'fat_grades', 'premium'];
  const dump = (it) => FIELDS.map((f) => `${f}=${it[f] ?? ''}`).join('|');

  const seed = seedIndex();
  assert.equal(taxonomy.all().length, seed.all().length,
    'basen har ikke samme antal varer som SEED — kør `npm run seed:items`');

  for (const e of seed.all()) {
    const fromDb = taxonomy.get(e.key);
    assert.ok(fromDb, `${e.key} findes i SEED men ikke i basen`);
    assert.equal(dump(fromDb), dump(e), e.key);
  }
});

test('seed-vejen og database-vejen slår ens op', () => {
  const seed = seedIndex();
  for (const text of ['500 g kyllingebrystfilet', 'jomfruolivenolie', 'sesamolie',
                      '2 dl piskefløde', 'tomatoes, roughly chopped', 'majskylling']) {
    assert.equal(taxonomy.lookup(text)?.entry.key ?? null,
                 seed.lookup(text)?.entry.key ?? null, text);
  }
});
