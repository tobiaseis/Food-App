'use strict';

/**
 * Regressionstest for push() i src/sync/build.js.
 *
 * Baggrunden: products.id, offers.id og recipes.id er AUTOINCREMENT i SQLite.
 * De er lokale løbenumre, ikke stabile nøgler. Bygges databasen forfra – fx
 * hvis release-assetet mangler i GitHub Actions – får de samme varer nye
 * id'er. Den gamle push upsertede på id og væltede så med
 *
 *   409 · 23505 · Key (slug)=(yogamtte) already exists
 *
 * fordi slug'en allerede sad på en anden række. Testen kører mod en
 * PostgREST-efterligning med de samme constraints som Supabase: UNIQUE(slug),
 * fremmednøgler og ON DELETE CASCADE.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL_TEST || 'http://localhost:5598';
process.env.SUPABASE_SERVICE_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { server, DB, SCHEMA } = require('./helpers/mock-postgrest.js');
const build = require('../src/sync/build.js');
const { push, collectPlanIndex, collectPriceTables } = build;
const { getDb } = require('../src/db');
const engine = require('../public/engine.js');

const quiet = () => {};
const reset = () => { for (const t of Object.keys(DB)) DB[t].length = 0; };

/** Lille kunstig read-model – nok til at ramme alle fremmednøgler. */
function makeModel(shift = 0) {
  const s = (n) => n + shift;
  return {
    chains: [{ id: 'netto', name: 'Netto', slug: 'netto' }],
    products: [
      { id: s(1), slug: 'yogamtte', name: 'Yogamåtte' },
      { id: s(2), slug: 'hakket-oksekoed', name: 'Hakket oksekød', fat_grade: '8-12' },
    ],
    stores: [{ id: 'st1', chain_id: 'netto', name: 'Netto Torvet' }],
    offers: [
      { id: s(10), external_id: 'tjek-a', product_id: s(1), chain_id: 'netto', heading: 'Yogamåtte' },
      { id: s(11), external_id: 'tjek-b', product_id: s(2), chain_id: 'netto', heading: 'Hakket oksekød 8-12%' },
    ],
    recipes: [{ id: s(20), url: 'https://valdemarsro.dk/frikadeller/', title: 'Frikadeller' }],
    priceStats: [{ product_id: s(2), base_unit: 'kg', median: 89.5, samples: 6 }],
    priceSeries: [{ product_id: s(2), base_unit: 'kg', period: '2026-35', median: 89.5, n: 3 }],
    deals: [{ offer_id: s(11), product_id: s(2), verdict: 'godt', discount_pct: 0.22, rank: 1 }],
    plans: [{ tier: 'healthy', week: 35, year: 2026, variant: 0, payload: { days: [] } }],
    // Madplans-indekset. offer_index hænger på chains, recipe_index på ingenting –
    // begge udskiftes helt ved hver kørsel, ligesom resten af det afledte lag.
    offerIndex: [{ taxonomy_key: 'hakket_oksekoed', chain_id: 'netto', offer_id: s(11),
                   product_id: s(2), product_name: 'Hakket oksekød', unit_price: 69.9,
                   base_unit: 'kg', normal_unit_price: 89.5 }],
    taxonomyPrices: [{ taxonomy_key: 'hakket_oksekoed', name: 'Hakket oksekød',
                       unit_price: 89.5, base_unit: 'kg', samples: 6 }],
    // Varekataloget. Salt står der for lagerlistens skyld: det er en essential,
    // og dem har recipe_index allerede filtreret væk.
    items: [
      { key: 'hakket_oksekoed', name: 'Hakket oksekød', category: 'meat', class: 'fresh',
        keeps: 'perishable', base_unit: 'kg', piece_g: null },
      { key: 'salt', name: 'Salt', category: 'pantry', class: 'essential',
        keeps: 'pantry', base_unit: 'kg', piece_g: null },
    ],
    recipeIndex: [{ recipe_id: s(20), title: 'Frikadeller', url: 'https://valdemarsro.dk/frikadeller/',
                    score_classic: 0.8, unknown_main: false,
                    items: [{ key: 'hakket_svinekoed', cat: 'meat', amount: 0.5 }] }],
    // recipe_details hænger på recipes, ligesom recipe_index — udskiftes helt
    // ved hver kørsel, samme grund som recipeIndex ovenfor.
    recipeDetails: [{ recipe_id: s(20), title: 'Frikadeller', intro: null, image: null,
                      source_name: 'Test', servings: 4, total_minutes: null, active_minutes: null,
                      ingredients: [], steps: [] }],
    // Priserne. item_prices hænger på chains; recipe_costs gør også, men
    // BEVIDST ikke på recipes — recipes.id er et lokalt løbenummer, og hele
    // det afledte lag udskiftes i samme kørsel.
    itemPrices: [{ item_key: 'hakket_oksekoed', chain_id: 'netto', pack_qty: 0.4,
                   pack_unit: 'kg', pack_price: 32, unit_price: 80, n_obs: 3,
                   source: 'manual', observed_at: '2026-09-15T00:00:00.000Z',
                   valid_until: '2027-03-14T00:00:00.000Z' }],
    recipeCosts: [{ recipe_id: s(20), chain_id: 'netto', cost: 48.5, cost_packs: 64,
                    coverage: 1, priceable: true, computed_at: '2026-09-15T00:00:00.000Z' }],
    notifications: [],
    summary: { at: '2026-08-27T00:00:00.000Z', week: 35, year: 2026 },
  };
}

test.before(() => new Promise((r) => server.listen(5598, r)));
test.after(() => server.close());

test('push lægger hele read-modellen ind', async () => {
  reset();
  await push(makeModel(), quiet);
  assert.equal(DB.products.length, 2);
  assert.equal(DB.item_prices.length, 1);
  assert.equal(DB.recipe_costs.length, 1);
  assert.equal(DB.offers.length, 2);
  assert.equal(DB.deals.length, 1);
  assert.equal(DB.price_stats.length, 1);
  assert.equal(DB.meal_plans.length, 1);
  assert.equal(DB.offer_index.length, 1);
  assert.equal(DB.taxonomy_prices.length, 1);
  assert.equal(DB.recipe_index.length, 1);
  assert.equal(DB.items.length, 2, 'varekataloget skal med — ellers kan browseren ikke bygge listerne');
});

test('en Supabase uden items-tabellen tømmer ikke madplanen', async () => {
  // items er den nyeste tabel, og en eksisterende installation har den ikke,
  // før schema.sql er kørt igen. Al sletning sker før al indsættelse, så
  // stod items sidst i DERIVED, var meal_plans, recipe_index, item_prices og
  // recipe_costs allerede tømt, når 404'en kom — målt i reviewet af plan 3
  // opgave 1, hvor de fire stod med 0 rækker. Nu skal fejlen komme FØR.
  reset();
  await push(makeModel(), quiet);
  const saved = SCHEMA.items;
  delete SCHEMA.items;
  try {
    await assert.rejects(push(makeModel(), quiet), /items/);
  } finally {
    SCHEMA.items = saved;
  }
  assert.equal(DB.meal_plans.length, 1, 'madplanen må ikke være væk');
  assert.equal(DB.recipe_index.length, 1, 'opskrifterne må ikke være væk');
  assert.equal(DB.item_prices.length, 1, 'priserne må ikke være væk');
  assert.equal(DB.recipe_costs.length, 1, 'opskriftspriserne må ikke være væk');
});

test('varekataloget udskiftes, det hober sig ikke op', async () => {
  // En vare, der er fjernet fra SEED, skal også forsvinde i skyen. Upsertes
  // kataloget ovenpå, bliver den et spøgelse, som browserens lagerliste
  // stadig kan slå op — samme grund som seed-items' dropGone.
  reset();
  await push(makeModel(), quiet);
  const next = makeModel();
  next.items = next.items.filter((i) => i.key !== 'salt');
  await push(next, quiet);
  assert.deepEqual(DB.items.map((i) => i.key), ['hakket_oksekoed']);
});

test('madplans-indekset udskiftes, det hober sig ikke op', async () => {
  reset();
  await push(makeModel(), quiet);
  // Næste uge: nye opskrifts-id'er (basen er bygget forfra) og et andet tilbud.
  await push(makeModel(500000), quiet);
  assert.equal(DB.recipe_index.length, 1, 'gamle opskriftsrækker er væk');
  assert.equal(DB.recipe_index[0].recipe_id, 500020);
  assert.equal(DB.offer_index.length, 1);

  // Samme krav til recipe_costs, og her er det ikke kosmetisk: nøglen er
  // recipe_id, og det er et lokalt løbenummer. Ryddes tabellen ikke, bliver
  // sidste uges pris liggende under et id, der nu tilhører en anden opskrift —
  // og budget-sporet sorterer efter den.
  assert.equal(DB.recipe_costs.length, 1, 'gamle opskriftspriser er væk');
  assert.equal(DB.recipe_costs[0].recipe_id, 500020);
  assert.equal(DB.item_prices.length, 1);
});

test('en base bygget forfra giver ikke 409 på UNIQUE(slug)', async () => {
  reset();
  await push(makeModel(), quiet);
  assert.equal(DB.products.find((p) => p.slug === 'yogamtte').id, 1);

  // Samme varer, nye AUTOINCREMENT-numre. Må ikke kaste.
  await push(makeModel(500000), quiet);

  assert.equal(DB.products.length, 2, 'ingen dubletter');
  assert.equal(DB.products.find((p) => p.slug === 'yogamtte').id, 500001, 'nyt id slog igennem');
});

test('udskiftningen efterlader ingen forældreløse rækker', async () => {
  reset();
  await push(makeModel(), quiet);
  await push(makeModel(500000), quiet);

  const productIds = new Set(DB.products.map((p) => p.id));
  const offerIds = new Set(DB.offers.map((o) => o.id));
  assert.ok(DB.offers.every((o) => productIds.has(o.product_id)), 'tilbud peger på varer der findes');
  assert.ok(DB.deals.every((d) => offerIds.has(d.offer_id)), 'deals peger på tilbud der findes');
  assert.ok(DB.price_series.every((r) => productIds.has(r.product_id)), 'prisserie peger på varer der findes');
});

test('udløbne tilbud hober sig ikke op', async () => {
  reset();
  await push(makeModel(), quiet);

  // Næste uge: kun ét af tilbuddene er stadig i avisen.
  const next = makeModel();
  next.offers = next.offers.slice(0, 1);
  next.deals = [];
  await push(next, quiet);

  assert.equal(DB.offers.length, 1, 'det gamle tilbud er væk, ikke bare skjult');
});

test('læst/ulæst på notifikationer overlever udskiftningen', async () => {
  reset();
  DB.watches.push({ id: 7, device_id: 'dev-1', label: 'Hakket oksekød', query: 'hakket oksekød' });

  const first = makeModel();
  first.notifications = [{ watch_id: 7, offer_id: 11, device_id: 'dev-1', reason: 'tilbud' }];
  await push(first, quiet);

  // Brugeren læser notifikationen.
  const readAt = '2026-08-27T09:00:00.000Z';
  DB.notifications[0].read_at = readAt;

  // Næste kørsel: samme tilbud, nyt id.
  const second = makeModel(500000);
  second.notifications = [{ watch_id: 7, offer_id: 500011, device_id: 'dev-1', reason: 'tilbud' }];
  await push(second, quiet);

  assert.equal(DB.notifications.length, 1);
  assert.equal(DB.notifications[0].read_at, readAt, 'læst-markering blev genskabt');
  assert.equal(DB.notifications[0].offer_id, 500011, 'peger på det nye tilbuds-id');
});

test('overvågninger røres ikke', async () => {
  reset();
  DB.watches.push({ id: 7, device_id: 'dev-1', label: 'Skyr', query: 'skyr' });
  await push(makeModel(), quiet);
  await push(makeModel(500000), quiet);
  assert.equal(DB.watches.length, 1, 'brugerens overvågning er intakt');
});

// ── recipeIndex: kontrakten med browserens engine.js ─────────────────────────

/**
 * collectPlanIndex() (src/sync/build.js) er den anden halvdel af en kontrakt,
 * public/engine.js kun kan holde, hvis begge sider leverer samme feltform.
 * Ingen test kaldte tidligere collectPlanIndex() selv – test/mealplan.test.js
 * satte `weight` i hånden på engine-siden, så den testede kun at motoren
 * FORBRUGER feltet, aldrig at bygge-trinnet rent faktisk PRODUCERER det.
 * Fjernes `weight` fra build.js, bestod hele testsuiten (111/111) alligevel –
 * det er præcis den fejl, denne test findes for at fange.
 */
test('collectPlanIndex leverer amount, weight, optional OG measured', () => {
  const db = getDb();
  const now = new Date().toISOString();

  const { lastInsertRowid: recipeId } = db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at)
    VALUES (?, 'test', 'Test', 'Æggekage', 'da', 4, ?)
  `).run('https://test.invalid/aeggekage-contract-test', now);

  // 'aeg' er base_unit 'stk' (piece_g 58) – amount er et STYKANTAL (6 æg),
  // weight skal være det kg-sammenlignelige tal (6 × 58 g), altså IKKE amount.
  // 'kyllingebryst' og 'kartofler' er kg-varer, hvor weight = amount, men de
  // skal med for at nå loadRecipes()' krav om mindst 3 varer i opskriften.
  //
  // Fløden er 'evt.' og står der for optional-feltet: uden en linje, hvor
  // flaget er SANDT, ville testen bestå på et felt, der altid var false.
  //
  // Enheden står der for measured-feltet: kyllingebrystet VEJES (kg) og må få
  // en rest af bakken; æggene tælles og må ikke.
  const insertIng = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertIng.run(recipeId, '6 æg', 'æg', 1, 'aeg', 6, 0, null);
  insertIng.run(recipeId, '0.5 kg kyllingebryst', 'kyllingebryst', 2, 'kyllingebryst', 0.5, 0, 'kg');
  insertIng.run(recipeId, '0.6 kg kartofler', 'kartofler', 3, 'kartofler', 0.6, 0, 'kg');
  insertIng.run(recipeId, 'evt. et skvæt fløde', 'fløde', 4, 'floede', 0.1, 1, null);

  try {
    const { recipeIndex } = collectPlanIndex(quiet);
    const recipe = recipeIndex.find((r) => r.recipe_id === recipeId);
    assert.ok(recipe, 'testopskriften er med i indekset');

    const egg = recipe.items.find((i) => i.key === 'aeg');
    assert.ok(egg, 'æg er med i items');
    assert.equal(egg.amount, 6, 'amount er det ægte stykantal');
    assert.notEqual(egg.weight, egg.amount, 'weight er IKKE amount for en stk-vare');
    assert.equal(egg.weight, Math.round((6 * 58 / 1000) * 1000) / 1000, 'weight er stykantal × stykvægt');

    // 'evt.'-linjer skal kunne springes over i indkøbslisten, og browseren
    // kan kun det, hvis flaget følger med i nyttelasten. Det er samme
    // kontrakt som weight: ingen anden test dækker, at build.js rent
    // faktisk PRODUCERER feltet.
    const floede = recipe.items.find((i) => i.key === 'floede');
    assert.ok(floede, 'fløde er med i items');
    assert.equal(floede.optional, true, 'evt.-linjen er markeret optional');
    assert.equal(recipe.items.find((i) => i.key === 'aeg').optional, false,
      'en almindelig linje er ikke optional');

    // measured: kun en linje, der vejer eller måler varen, må få resten af
    // pakken. Browserens motor holder kun reglen, hvis flaget kommer med —
    // uden det ville ugen i browseren fylde op, hvor serverens ikke gør.
    assert.equal(recipe.items.find((i) => i.key === 'kyllingebryst').measured, true,
      '"0.5 kg kyllingebryst" vejes');
    assert.equal(egg.measured, false, '"6 æg" tælles');

    for (const item of recipe.items) {
      assert.ok('amount' in item, `${item.key} mangler amount`);
      assert.ok('weight' in item, `${item.key} mangler weight`);
      assert.ok('optional' in item, `${item.key} mangler optional`);
      assert.equal(typeof item.optional, 'boolean', `${item.key}.optional er ikke boolsk`);
      assert.ok('measured' in item, `${item.key} mangler measured`);
      assert.equal(typeof item.measured, 'boolean', `${item.key}.measured er ikke boolsk`);
    }
  } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
  }
});

/**
 * De tre felter, der blev lagt på nyttelasten i denne plan — og som ingen test
 * ville have savnet.
 *
 * `sync.test.js` prøver ellers push() mod en HÅNDSKREVET model (makeModel), og
 * dén går glat igennem, selv om en kolonne falder ud af build.js' SELECT:
 * modellen er jo ikke bygget af basen. Det samme hul, som `weight` havde, før
 * testen ovenfor kom til.
 *
 *   base_qty      uden den kan effectivePrice ikke bruge tilbuddet som pris;
 *                 serveren virker, og browseren taber hvert eneste tilbud.
 *   unknown_count uden den ser de 678 opskrifter med ukendte ingredienser
 *                 fuldt prissatte ud i browseren (canPrice).
 *   collectPriceTables  eksporteres, synkes — og havde ingen test overhovedet.
 */
test('collectPlanIndex leverer base_qty på tilbuddene OG unknown_count på retten', () => {
  const db = getDb();
  const now = new Date().toISOString();
  const till = new Date(Date.now() + 7 * 86400000).toISOString();

  db.prepare("INSERT OR IGNORE INTO chains (id, name, slug) VALUES ('tst', 'Testkæde', 'tst-sync')").run();
  const { lastInsertRowid: productId } = db.prepare(`
    INSERT INTO products (slug, name, category, item_key, created_at)
    VALUES ('t-sync-kartofler', 'Kartofler 2 kg', 'produce', 'kartofler', ?)`).run(now);
  const { lastInsertRowid: offerId } = db.prepare(`
    INSERT INTO offers (external_id, product_id, chain_id, heading, price,
                        base_qty, base_unit, unit_price, run_from, run_till, observed_at)
    VALUES ('t-sync-1', ?, 'tst', 'Kartofler 2 kg', 12, 2, 'kg', 6, ?, ?, ?)`)
    .run(productId, now, till, now);

  // En opskrift med én ingrediens, taksonomien IKKE kender. Den når aldrig
  // ind i items — kun tællingen kan fortælle browseren, at den findes.
  const { lastInsertRowid: recipeId } = db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at)
    VALUES (?, 'test', 'Test', 'Ret med en ukendt', 'da', 4, ?)`)
    .run('https://test.invalid/ukendt-count-test', now);
  const insertIng = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insertIng.run(recipeId, '0.5 kg kyllingebryst', 'kyllingebryst', 1, 'kyllingebryst', 0.5, 0);
  insertIng.run(recipeId, '0.6 kg kartofler', 'kartofler', 2, 'kartofler', 0.6, 0);
  insertIng.run(recipeId, '6 æg', 'æg', 3, 'aeg', 6, 0);
  insertIng.run(recipeId, 'et stykke galangal', 'galangal', 4, null, null, 0);
  // En ukendt EVT.-linje tæller ikke: den købes ikke og må ikke kunne gøre
  // retten uprissætbar. Samme regel som i loadRecipes og recipe_costs.
  insertIng.run(recipeId, 'evt. lidt koriander', 'koriander', 5, null, null, 1);

  try {
    const { offerIndex, recipeIndex } = collectPlanIndex(quiet);

    const offer = offerIndex.find((o) => o.offer_id === offerId);
    assert.ok(offer, 'tilbuddet er med i indekset');
    assert.ok(offer.base_qty > 0, 'base_qty skal med — ellers er tilbuddet ikke en pris');
    assert.equal(offer.base_unit, 'kg');
    for (const row of offerIndex) {
      assert.ok('base_qty' in row, `${row.taxonomy_key} mangler base_qty`);
    }

    const recipe = recipeIndex.find((r) => r.recipe_id === recipeId);
    assert.ok(recipe, 'opskriften er med i indekset');
    assert.equal(recipe.unknown_count, 1, 'den ukendte, ikke-valgfri linje er talt');
    assert.equal(typeof recipe.unknown_count, 'number');

    // keywords er FJERDE felt i denne payload, der skal huskes fire steder
    // (loadRecipes, build.js, supabase/schema.sql, public/data.js). De tre
    // foerste — base_qty, optional, unknown_count — blev alle glemt et af
    // stederne og virkede paa serveren mens browseren fik ingenting.
    // engine.isDinner laeser dette felt; uden det er hver ret aftensmad.
    assert.ok('keywords' in recipe,
      'keywords mangler i payloaden — isDinner kan ikke skelne dessert fra middag');

    // Femte felt: arbejdstiden. Uden den viser browseren kun tiden i alt.
    assert.ok('active_minutes' in recipe, 'active_minutes mangler i payloaden');
  } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
    db.prepare('DELETE FROM offers WHERE id = ?').run(offerId);
    db.prepare('DELETE FROM products WHERE id = ?').run(productId);
  }
});

/**
 * Lagerlisten i browseren — femte felt i rækken efter base_qty, optional,
 * unknown_count og keywords.
 *
 * shoppingList bygger "tjek at du har" af rettens essential-linjer. build.js
 * skar dem fra, så browserens lagerliste var tom, mens serverens loadRecipes
 * havde dem: to lister på skærmen, den ene altid tom, og ingen fejl. Samme
 * filter holdt en ret med kun ÉN købt linje ude af browseren, som serveren
 * kunne vælge ("Hel kylling i airfryer" er kylling, salt og peber).
 *
 * Testen kører shoppingList på begge ender af den SAMME ret og kræver samme
 * lagerliste — ikke bare, at feltet findes.
 */
test('collectPlanIndex sender basisvarerne med, så lagerlisten er den samme i browseren', () => {
  const db = getDb();
  const now = new Date().toISOString();
  const { lastInsertRowid: recipeId } = db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at)
    VALUES (?, 'test', 'Test', 'Hel kylling i ovn', 'da', 4, ?)`)
    .run('https://test.invalid/lagerliste-test', now);
  const insertIng = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Én købt linje og tre basisvarer — salt to gange, som opskrifter gør.
  insertIng.run(recipeId, '1,5 kg hel kylling', 'hel kylling', 1, 'hel_kylling', 1.5, 0);
  insertIng.run(recipeId, '1 tsk salt', 'salt', 2, 'salt', 0.006, 0);
  insertIng.run(recipeId, 'friskkværnet peber', 'peber', 3, 'peber', null, 0);
  insertIng.run(recipeId, 'salt til servering', 'salt', 4, 'salt', null, 0);
  insertIng.run(recipeId, '2 spsk olie', 'olie', 5, 'olie', 0.03, 0);

  try {
    const { recipeIndex } = collectPlanIndex(quiet);
    const synced = recipeIndex.find((r) => r.recipe_id === recipeId);
    assert.ok(synced, 'en ret med én købt linje er med i indekset, som på serveren');

    const salt = synced.items.filter((i) => i.key === 'salt');
    assert.equal(salt.length, 1, 'én linje pr. basisvare pr. ret');
    assert.deepEqual(salt[0], { key: 'salt', essential: true },
      'basisvaren sendes som nøgle og flag — ingen del af motoren læser dens mængde');

    const items = new Map(build.collectItems().map((r) => [r.key, r]));
    const served = require('../src/mealplan/generate').loadRecipes({})
      .find((r) => r.id === recipeId);
    const pantryOf = (recipe) => engine.shoppingList(
      { days: [{ recipe: { title: 'Hel kylling i ovn', servings: 4, items: recipe.items } }] },
      { items, chainIds: [] }).pantry.map((p) => p.key);

    assert.deepEqual(pantryOf(synced), ['olie', 'peber', 'salt'].sort((a, b) =>
      items.get(a).name.localeCompare(items.get(b).name, 'da')),
    'browserens lagerliste er ikke tom');
    assert.deepEqual(pantryOf(synced), pantryOf(served),
      'browserens lagerliste er serverens lagerliste');
    // Og basisvarerne må ikke begynde at blive købt: isBoughtLine skal stadig
    // sige nej til dem i browseren.
    assert.ok(synced.items.filter((i) => i.essential)
      .every((i) => !engine.isBoughtLine(i, items.get(i.key))));
  } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
  }
});

/**
 * Mængderne i browseren er serverens mængder — ikke afrundede.
 *
 * build.js rundede amount og weight til tre decimaler. Da de fem trin blev
 * kørt i browseren og på serveren side om side, var retter, priser og linjer
 * ens, men spildet var 2 øre forskelligt, fordi resten af pakken blev regnet
 * af hver sin mængde. Og et behov ved en pakkegrænse giver en pose mere det
 * ene sted end det andet.
 */
test('collectPlanIndex sender mængderne uafrundede, som loadRecipes har dem', () => {
  const db = getDb();
  const now = new Date().toISOString();
  const { lastInsertRowid: recipeId } = db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at)
    VALUES (?, 'test', 'Test', 'Kylling i tredjedele', 'da', 4, ?)`)
    .run('https://test.invalid/afrunding-test', now);
  const insertIng = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Tre mængder, tre decimaler ikke kan bære: en tredjedel, 1½ tsk og et
  // stykantal, hvis vægt (piece_g) er et flydende produkt.
  insertIng.run(recipeId, '1/3 kg kyllingebryst', 'kyllingebryst', 1, 'kyllingebryst', 1 / 3, 0);
  insertIng.run(recipeId, '1½ tsk hvidløg', 'hvidløg', 2, 'hvidloeg', 0.0075, 0);
  insertIng.run(recipeId, '3 æg', 'æg', 3, 'aeg', 3, 0);

  try {
    const synced = collectPlanIndex(quiet).recipeIndex.find((r) => r.recipe_id === recipeId);
    const served = require('../src/mealplan/generate').loadRecipes({}).find((r) => r.id === recipeId);
    assert.ok(synced && served);
    for (const line of served.items.filter((i) => !i.essential)) {
      const s = synced.items.find((i) => i.key === line.key);
      assert.strictEqual(s.amount, line.amount, `${line.key}.amount er serverens`);
      assert.strictEqual(s.weight, line.weight, `${line.key}.weight er serverens`);
    }
  } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
  }
});

test('collectPriceTables har den form, Supabase tager imod', () => {
  const db = getDb();
  const now = '2026-09-15T00:00:00.000Z';

  db.prepare("INSERT OR IGNORE INTO chains (id, name, slug) VALUES ('tst', 'Testkæde', 'tst-sync')").run();
  const { lastInsertRowid: recipeId } = db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at)
    VALUES (?, 'test', 'Test', 'Prissat ret', 'da', 2, ?)`)
    .run('https://test.invalid/pris-tabel-test', now);

  db.prepare(`
    INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit, pack_price,
                             unit_price, n_obs, source, observed_at, valid_until)
    VALUES ('kartofler', 'tst', 2, 'kg', 15.95, 7.975, 0, 'manual', ?, '2027-03-14T00:00:00.000Z')`)
    .run(now);
  db.prepare(`
    INSERT INTO recipe_costs (recipe_id, chain_id, cost, cost_packs, cost_per_serving,
                              coverage, priceable, has_main, computed_at)
    VALUES (?, 'tst', 48.5, 64, 24.25, 1, 1, 1, ?)`).run(recipeId, now);

  try {
    const { itemPrices, recipeCosts } = collectPriceTables(db, quiet);

    const price = itemPrices.find((r) => r.item_key === 'kartofler' && r.chain_id === 'tst');
    assert.ok(price, 'normalprisen er med');
    for (const f of ['pack_qty', 'pack_unit', 'pack_price', 'unit_price', 'n_obs',
                     'source', 'observed_at', 'valid_until']) {
      assert.ok(f in price, `item_prices mangler ${f}`);
    }
    assert.ok(price.pack_qty > 0, 'pack_qty skal med — choosePack runder op på den');

    const cost = recipeCosts.find((r) => r.recipe_id === recipeId);
    assert.ok(cost, 'den prissatte ret er med');
    // Budget-sporet sorterer på cost_per_serving blandt rækker med has_main.
    // Falder en af de to ud af SELECT'en, er sorteringen i skyen enten
    // unormaliseret eller fyldt med dressinger — se spec 1.5.
    assert.equal(cost.cost_per_serving, 24.25);
    assert.equal(cost.has_main, true, 'has_main skal være BOOLSK, ikke 1');
    assert.equal(cost.priceable, true, 'priceable skal være boolsk — Postgres afviser 1');
    assert.equal(typeof cost.cost, 'number');
  } finally {
    db.prepare('DELETE FROM recipe_costs WHERE recipe_id = ?').run(recipeId);
    db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
    db.prepare("DELETE FROM item_prices WHERE chain_id = 'tst'").run();
  }
});

// ── Det browseren skal have til de to lister (plan 3, opgave 1) ─────────────

test('collectItems leverer det, de to lister skal bruge', () => {
  const rows = build.collectItems();
  const salt = rows.find((r) => r.key === 'salt');
  const kartofler = rows.find((r) => r.key === 'kartofler');

  assert.equal(salt.class, 'essential', 'lagerlisten hviler på class');
  assert.equal(kartofler.base_unit, 'kg', 'pakkeafrundingen hviler på base_unit');
  assert.ok(kartofler.keeps, 'spildvægtningen hviler på keeps');
  // Essentials SKAL med: de er hele pointen med lagerlisten.
  assert.ok(rows.some((r) => r.class === 'essential'));
});

// ── Browserens halvdel af kontrakten ─────────────────────────────────────────
//
// De to tests herunder kører public/data.js, som den kører i browseren: i ét
// vm-rige sammen med engine.js, med `window` som det globale objekt og en
// falsk PostgREST, der serverer det, build.js ville have synket. Et
// håndskrevet kort ville kun teste, at motoren FORBRUGER rækkerne — ikke at
// browseren rent faktisk bygger dem, og det er dér, base_qty, optional og
// unknown_count faldt ud.

/**
 * Supabase set udefra: filtrene data.js bruger (eq, in), select-projektion og
 * tidsstempler i Postgres' form ('+00:00', ikke 'Z'). Et filter, den ikke
 * kender, kaster — ellers kunne testen bestå på rækker, et rigtigt PostgREST
 * aldrig ville have sendt.
 */
function fakePostgrest(tables) {
  const calls = [];
  // Som en Supabase i dansk tid svarer: samme øjeblik, men skrevet '+02:00'.
  // effectivePrice sammenligner valid_until med nu SOM TEKST, og
  // '2026-09-25T13:00:00+02:00' ser senere ud end '2026-09-25T12:00:00.000Z',
  // selv om det er en time TIDLIGERE. Uden browserens omregning til '…Z'
  // bliver en udløbet pris læst som gyldig.
  const pgTime = (v) => {
    if (typeof v !== 'string' || !/Z$/.test(v)) return v;
    return new Date(Date.parse(v) + 2 * 3600e3).toISOString().replace(/\.\d+Z$/, '') + '+02:00';
  };
  const fetch = async (url) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    calls.push(table);
    if (!tables[table]) {
      return { ok: false, status: 404, text: async () => `relation "${table}" does not exist` };
    }
    let rows = tables[table].map((r) => ({
      ...r,
      ...('valid_until' in r ? { valid_until: pgTime(r.valid_until) } : {}),
      ...('observed_at' in r ? { observed_at: pgTime(r.observed_at) } : {}),
    }));
    for (const [col, v] of u.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(col)) continue;
      const i = v.indexOf('.');
      const [op, val] = [v.slice(0, i), v.slice(i + 1)];
      if (op === 'eq') rows = rows.filter((r) => String(r[col]) === val);
      else if (op === 'in') {
        const set = new Set(val.replace(/^\(|\)$/g, '').split(','));
        rows = rows.filter((r) => set.has(String(r[col])));
      } else throw new Error(`falsk PostgREST kender ikke ${col}=${v}`);
    }
    // order= skal virke, ellers kan testen ikke se, om data.js beder om den
    // raekkefoelge, serverens normalPricesFor bruger. effectivePrice tager den
    // foerste ved uafgjort, og pakkerne kommer i hentet orden.
    const ord = u.searchParams.get('order');
    if (ord) {
      const keys = ord.split(',').map((x) => { const [c, d] = x.split('.'); return [c, d === 'desc' ? -1 : 1]; });
      rows.sort((a, b) => {
        for (const [c, d] of keys) { if (a[c] < b[c]) return -d; if (a[c] > b[c]) return d; }
        return 0;
      });
    }
    const sel = u.searchParams.get('select');
    if (sel && sel !== '*') {
      rows = rows.map((r) => Object.fromEntries(sel.split(',').map((c) => [c, r[c]])));
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  return { fetch, calls };
}

/** engine.js + data.js i ét rige, som i browseren. */
function loadBrowser(tables) {
  const pg = fakePostgrest(tables);
  const sandbox = {
    console,
    fetch: pg.fetch,
    APP_CONFIG: { SUPABASE_URL: 'https://fake.supabase.test', SUPABASE_ANON_KEY: 'anon' },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  // I browseren ER window det globale objekt. engine.js lægger PlanEngine på
  // `this`, data.js læser window.PlanEngine — de to skal ramme det samme.
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['engine.js', 'data.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'),
      sandbox, { filename: f });
  }
  return { Data: sandbox.Data, engine: sandbox.PlanEngine, calls: pg.calls };
}

/**
 * En frisk base i tmpdir med sin egen `generate.js`, så serverens
 * normalPricesFor kan køre på præcis de rækker, testen lægger ind. test.db
 * røres ikke: en REMA-kæde dér ville give skøn i hver anden testfil.
 */
function tempServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madplan-binding-'));
  const dbPath = path.join(dir, 'binding.db');
  assert.ok(path.resolve(dbPath).startsWith(path.resolve(os.tmpdir())),
    'testbasen skal ligge i os.tmpdir()');
  const ids = ['src/db', 'src/price/history', 'src/mealplan/generate']
    .map((m) => require.resolve(path.join(__dirname, '..', m)));
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  for (const id of ids) delete require.cache[id];
  try {
    const db = require('../src/db').getDb();
    const plans = require('../src/mealplan/generate');
    return {
      db, plans,
      // Håndtaget skal lukkes, før filen kan slettes på Windows.
      cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
  } finally {
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
    for (const id of ids) delete require.cache[id];
  }
}

test('browseren får varekataloget som det kort, shoppingList slår op i', async () => {
  const items = build.collectItems();
  const b = loadBrowser({ items });
  const map = await b.Data.items();

  assert.equal(map.size, items.length, 'hele kataloget, også essentials');
  assert.equal(map.get('salt').class, 'essential', 'lagerlisten hviler på class');
  assert.equal(map.get('kartofler').base_unit, 'kg');
  assert.ok(map.get('kartofler').keeps);

  // Kataloget skifter sjældnere end priserne; det hentes én gang pr. visning.
  await b.Data.items();
  assert.equal(b.calls.filter((t) => t === 'items').length, 1, 'kataloget caches');
});

/**
 * Serverens og browserens normalpriskort skal være det SAMME kort.
 *
 * Version 1 bruger REMA's normalpriser som skøn i alle andre kæder
 * (engine.withEstimates). Serveren lægger skønnet ind i normalPricesFor;
 * browseren skal gøre det samme, ellers viser appen en ret som prissat, som
 * recipe_costs kalder uprissat — eller omvendt. Testen fejler, hvis data.js
 * glemmer withEstimates, glemmer at hente REMA's rækker, når REMA ikke er en
 * favorit, eller taber en kolonne, effectivePrice læser.
 */
test('browserens normalpriskort giver samme pris som serverens normalPricesFor', async () => {
  const srv = tempServer();
  const { db } = srv;
  try {
    const chain = db.prepare('INSERT INTO chains (id, name, slug) VALUES (?, ?, ?)');
    chain.run('R', 'REMA 1000', 'rema1000');
    chain.run('N', 'Testkæde N', 'tst-n');
    chain.run('F', 'Testkæde F', 'tst-f');

    const item = db.prepare(`INSERT INTO items (key, name, category, class, keeps, base_unit)
                             VALUES (?, ?, ?, ?, ?, ?)`);
    item.run('loeg', 'Løg', 'veg', 'baseline', 'keeps', 'kg');
    item.run('kartofler', 'Kartofler', 'veg', 'baseline', 'keeps', 'kg');
    item.run('aeg', 'Æg', 'eggs', 'fresh', 'keeps', 'stk');
    item.run('persille', 'Persille', 'veg', 'fresh', 'perishable', 'kg');
    item.run('vin', 'Vin', 'drink', 'baseline', 'pantry', 'l');
    const UNITS = { loeg: 'kg', kartofler: 'kg', aeg: 'stk', persille: 'kg', vin: 'l' };

    const FRESH = '2099-01-01T00:00:00Z';
    const STALE = '2020-01-01T00:00:00Z';
    // Udløbet en time før `now` nedenfor. Det er den eneste række, hvor
    // tidszonen kan vende svaret: 2020 og 2099 ligger for langt væk til, at
    // to timers forskel betyder noget.
    const NEAR = '2026-09-25T11:00:00.000Z';
    const price = db.prepare(`
      INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit, pack_price,
                               unit_price, source, observed_at, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-15T00:00:00Z', ?)`);
    // REMA's hyldepris — kilden til skønnet.
    price.run('loeg', 'R', 1, 'kg', 12, 12, 'api:rema', FRESH);
    // Kædens egen indtastede pris slår skønnet, også når den er dyrere.
    price.run('loeg', 'N', 1, 'kg', 14, 14, 'manual', FRESH);
    // Et REMA-gæt bygget af tilbud må ALDRIG blive et skøn andre steder.
    price.run('kartofler', 'R', 2, 'kg', 10, 5, 'derived', FRESH);
    price.run('kartofler', 'F', 2, 'kg', 16, 8, 'derived', FRESH);
    // Skønnet slår kædens eget, billigere gæt.
    price.run('aeg', 'R', 10, 'stk', 32.95, 3.295, 'api:rema', FRESH);
    price.run('aeg', 'N', 10, 'stk', 25, 2.5, 'derived', FRESH);
    // To indtastede priser: den billige er udløbet. Taber browseren
    // valid_until, vinder den forkerte.
    price.run('persille', 'N', 0.075, 'kg', 6, 80, 'manual', STALE);
    price.run('persille', 'N', 0.1, 'kg', 17.4, 174, 'manual', FRESH);
    // Samme mønster i F, men den billige udløb for en time siden. Læser
    // browseren '+02:00' som tekst, tror den, prisen stadig gælder, og vælger
    // den forkerte pakke.
    price.run('persille', 'F', 0.075, 'kg', 6, 80, 'manual', NEAR);
    price.run('persille', 'F', 0.1, 'kg', 17.4, 174, 'manual', FRESH);
    // To pakker paa samme niveau, sat ind MOD primaernoeglens orden (1 l foer
    // 0,375 l). Det er virkeligheden: vin har netop de to hos REMA, og skoennet
    // kopierer begge til alle kaeder. Uden en fast orden paa begge sider kommer
    // `packs` i hver sin raekkefoelge, og effectivePrice er ikke laengere ens.
    price.run('vin', 'R', 1, 'l', 29, 29, 'manual', FRESH);
    price.run('vin', 'R', 0.375, 'l', 25, 66.67, 'manual', FRESH);

    // Browserens rækker kommer ad synk-vejen: collectCatalog og
    // collectPriceTables er præcis det, build.js sender til Supabase.
    const tables = {
      chains: build.collectCatalog(db).chains,
      sync_state: [],
      // Vendt om med vilje: sorterer browseren ikke selv (order= i
      // forespoergslen), faar den raekkerne i forkert orden, og testen fejler.
      item_prices: collectPriceTables(db, quiet).itemPrices.slice().reverse(),
    };

    const now = new Date('2026-09-25T12:00:00Z');
    const plain = (x) => JSON.parse(JSON.stringify(x));
    let estimateOnly = 0;

    // REMA uden for favoritterne (skønnet skal hentes alligevel), REMA som
    // favorit, og ingen favoritter (= alle kæder, som i mealPlan).
    for (const favs of [['N', 'F'], ['R', 'N'], []]) {
      const server = srv.plans.normalPricesFor(favs.length ? favs : null);
      const b = loadBrowser(tables);
      const browser = await b.Data.normalPrices(favs);

      assert.deepEqual([...browser.keys()].sort(), [...server.keys()].sort(),
        `samme vare|kæde-par for favoritterne [${favs}]`);

      for (const key of Object.keys(UNITS)) {
        for (const chainId of favs.length ? favs : ['R', 'N', 'F']) {
          const opts = { now, baseUnit: UNITS[key] };
          const s = engine.effectivePrice(key, chainId, { ...opts, normals: server });
          const w = b.engine.effectivePrice(key, chainId, { ...opts, normals: browser });
          assert.deepEqual(plain(w), plain(s), `${key}|${chainId} for favoritterne [${favs}]`);
          // Tæl de par, hvor prisen KUN findes som skøn (løg og æg i F).
          // Uden dem kunne testen bestå på et fixture, der aldrig prøvede
          // skønnet — og det er netop dem, en browser uden withEstimates
          // kalder uprissat.
          const own = (server.get(`${key}|${chainId}`) || [])
            .filter((r) => r.source !== 'estimate:rema');
          if (s && s.source === 'estimate:rema' && !own.length) estimateOnly++;
        }
      }
    }
    assert.ok(estimateOnly >= 2, `par med kun et skøn skal være prøvet af (${estimateOnly})`);
  } finally {
    srv.cleanup();
  }
});

// ── De fem trin: browseren og serveren giver de samme tal (plan 3, opgave 3) ──

/**
 * Hele flowet, begge veje, på de samme rækker.
 *
 * Browseren: public/data.js mod den LOKALE server (npm start) over rigtig
 * HTTP — flowInputs, choices og lists, som app.js kalder dem. Serveren: den
 * samme motor på serverens egne indlæsere (loadRecipes, activeOfferMap,
 * normalPricesFor). Puljen, begge forslag, deres pris og begge lister skal
 * være ens til øret.
 *
 * Det er grunden til, at motoren er én fil. Uden testen er der kun ordet for,
 * at tabellerne, browseren får, er dem, serveren regner med — og det ord har
 * holdt for lidt fem gange: base_qty, optional, unknown_count, keywords og
 * basisvarerne.
 */
test('de fem trin: browseren og serveren giver samme pulje, forslag og lister', async () => {
  const db = getDb();
  const now = new Date().toISOString();
  const till = new Date(Date.now() + 7 * 86400000).toISOString();
  const plans = require('../src/mealplan/generate');
  const { server } = require('../src/server');

  db.prepare("INSERT OR IGNORE INTO chains (id, name, slug) VALUES ('tst', 'Testkæde', 'tst-sync')").run();
  const recipeIds = [];
  const addRecipe = (title, score, lines) => {
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at, keywords, score_classic)
      VALUES (?, 'test', 'Test', ?, 'da', 4, ?, 'Aftensmad', ?)`)
      .run(`https://test.invalid/flow-${recipeIds.length}`, title, now, score);
    // Enheden afgør, om en rest må lægges i retten (engine.MEASURED_UNITS).
    // Uden den ville ingen linje vejes, og påfyldningen slet ikke prøves her.
    const ins = db.prepare(`INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional, unit)
                            VALUES (?, ?, ?, ?, ?, ?, 0, ?)`);
    lines.forEach(([key, amount, unit = 'kg'], i) => ins.run(id, `${amount} ${unit} ${key}`, key, i + 1, key, amount, unit));
    recipeIds.push(Number(id));
  };
  // Fire middage i fire kategorier, der deler kartofler, løg og pasta, og
  // som alle bruger salt — lagerlisten skal have noget at vise.
  addRecipe('Kylling med kartofler', 0.9, [['kyllingebryst', 0.5], ['kartofler', 0.6], ['loeg', 0.1], ['salt', 0.005]]);
  addRecipe('Oksekød med pasta', 0.9, [['hakket_oksekoed', 0.5], ['pasta', 0.4], ['loeg', 0.2], ['salt', 0.005]]);
  addRecipe('Laks med kartofler', 0.8, [['laks', 0.4], ['kartofler', 0.8], ['floede', 0.2, 'l'], ['salt', 0.005]]);
  // Kyllingen TÆLLES her ("2 stk"): den ret må ikke få resten af bakken,
  // og browseren skal vide det lige så vel som serveren.
  addRecipe('Kylling med ris', 0.7, [['kyllingebryst', 1 / 3, 'stk'], ['ris', 0.3], ['loeg', 0.1], ['salt', 0.005]]);

  const price = db.prepare(`INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit, pack_price,
                              unit_price, source, observed_at, valid_until)
                            VALUES (?, 'tst', ?, ?, ?, ?, 'manual', ?, '2099-01-01T00:00:00.000Z')`);
  for (const [key, qty, unit, kr] of [['kyllingebryst', 0.5, 'kg', 45], ['hakket_oksekoed', 0.4, 'kg', 32],
    ['laks', 0.25, 'kg', 40], ['kartofler', 2, 'kg', 16], ['loeg', 1, 'kg', 12], ['pasta', 0.5, 'kg', 10],
    ['floede', 0.25, 'l', 9], ['ris', 1, 'kg', 14]]) price.run(key, qty, unit, kr, kr / qty, now);

  // Et aktivt tilbud på kartofler, så kilden 'offer' også prøves.
  const { lastInsertRowid: productId } = db.prepare(`INSERT INTO products (slug, name, category, item_key, created_at)
    VALUES ('t-flow-kartofler', 'Kartofler 2 kg', 'produce', 'kartofler', ?)`).run(now);
  db.prepare(`INSERT INTO offers (external_id, product_id, chain_id, heading, price, base_qty, base_unit,
                                  unit_price, run_from, run_till, observed_at)
              VALUES ('t-flow-1', ?, 'tst', 'Kartofler 2 kg', 10, 2, 'kg', 5, ?, ?, ?)`).run(productId, now, till, now);

  // Budget-sporets rangering, som scripts/recompute-recipe-costs.js skriver den.
  const cost = db.prepare(`INSERT INTO recipe_costs (recipe_id, chain_id, cost, cost_packs, cost_per_serving,
                             coverage, priceable, has_main, computed_at) VALUES (?, 'tst', ?, ?, ?, 1, 1, 1, ?)`);
  recipeIds.forEach((id, i) => cost.run(id, 40 + i, 60 + i, [18, 11, 25, 14][i], now));

  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const sandbox = {
      console, URL,
      fetch: (u, o) => fetch(new URL(u, base), o),
      APP_CONFIG: {},                           // ingen Supabase: den lokale bagende
      localStorage: { getItem: () => null, setItem: () => {} },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const f of ['engine.js', 'data.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'), sandbox, { filename: f });
    }
    const Data = sandbox.Data;
    const plain = (x) => JSON.parse(JSON.stringify(x));

    const items = new Map(build.collectItems().map((r) => [r.key, r]));
    const chainIds = ['tst'];
    const offers = plans.activeOfferMap({ chainIds });
    const normals = plans.normalPricesFor(chainIds);
    const { week, year } = engine.isoWeek(new Date());
    const days = 2;
    const servings = 3;
    let sawTopup = false;

    for (const track of ['classic', 'budget']) {
      const ctx = await Data.flowInputs(track, chainIds);
      assert.equal(ctx.seed, year * 100 + week, 'frøet er ugen');
      const browser = Data.choices(ctx, { days, servings });

      let recipes = plans.loadRecipes(track === 'budget' ? {} : { tier: track })
        .filter((r) => recipeIds.includes(r.id));
      let rank;
      if (track === 'budget') {
        const per = new Map(db.prepare("SELECT recipe_id, cost_per_serving FROM recipe_costs WHERE chain_id = 'tst'")
          .all().map((r) => [r.recipe_id, r.cost_per_serving]));
        recipes = recipes.map((r) => ({ ...r, score: 0, cost_per_serving: per.get(r.id) }));
        rank = (r) => -r.cost_per_serving;
      } else {
        recipes = recipes.map((r) => ({ ...r, score: r.tier_score }));
      }
      const pool = engine.candidatePool(recipes,
        { days, items, rank, seed: year * 100 + week, offers, normals, chainIds });
      const props = engine.twoProposals(pool.pool, { days, servings, items, offers, normals, chainIds });

      assert.equal(browser.pool.length, 4, `${track}: hele fiksturen er i puljen`);
      assert.deepEqual(browser.pool.map((r) => r.id), pool.pool.map((r) => r.id), `${track}: samme pulje`);
      assert.equal(browser.thin, pool.thin);
      if (track === 'budget') {
        assert.deepEqual(browser.pool.slice(0, 2).map((r) => r.title), ['Oksekød med pasta', 'Kylling med ris'],
          'budget rangerer efter pris pr. portion');
      }

      props.forEach((w, i) => {
        const tag = `${track} forslag ${'AB'[i]}`;
        const bw = browser.proposals[i];
        assert.deepEqual(bw.picks.map((r) => r.id), w.picks.map((r) => r.id), `${tag}: samme retter`);
        assert.equal(bw.cost, w.cost, `${tag}: samme ugepris`);
        assert.equal(bw.waste, w.waste, `${tag}: samme spild`);

        const s = engine.shoppingList({ days: w.picks.map((recipe) => ({ recipe })) },
          { items, offers, normals, chainIds, servings });
        const b = Data.lists(ctx, bw.picks, { servings });
        assert.equal(b.total, s.total, `${tag}: samme indkøbssum`);
        assert.equal(b.total, w.cost, `${tag}: listen koster det, forslaget sagde`);
        assert.equal(b.waste_kr, s.waste_kr, `${tag}: samme spild på listen`);
        assert.deepEqual(plain(b.pantry), plain(s.pantry), `${tag}: samme lagerliste`);
        assert.ok(b.pantry.some((p) => p.key === 'salt'), `${tag}: lagerlisten er ikke tom i browseren`);
        const lines = plain(b.buy).map(({ source, stale, ...line }) => line);
        assert.deepEqual(lines, plain(s.buy), `${tag}: samme købsliste`);
        // Kilden, skærmen viser, er kædevalgets egen: et tilbud er et tilbud.
        for (const line of b.buy) assert.equal(line.source === 'offer', line.on_offer, `${line.key}: kilde og on_offer`);
        // Påfyldningen: samme fordeling begge steder, og aldrig i en ret,
        // der tæller varen.
        assert.deepEqual(plain(b.topups), plain(s.topups), `${tag}: samme påfyldning`);
        if (Object.keys(s.topups).length) sawTopup = true;
        const talt = recipeIds[3];            // 'Kylling med ris', kyllingen i stk
        assert.ok(!(s.topups[talt] && s.topups[talt].kyllingebryst),
          `${tag}: en ret, der tæller kyllingen, får ikke resten`);
      });
    }
    assert.ok(sawTopup, 'påfyldningen skal prøves i mindst ét forslag, ellers måler paritetstesten den ikke');
  } finally {
    await new Promise((r) => server.close(r));
    db.prepare(`DELETE FROM recipe_costs WHERE recipe_id IN (${recipeIds.join(',')})`).run();
    for (const id of recipeIds) db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
    db.prepare("DELETE FROM offers WHERE external_id = 't-flow-1'").run();
    db.prepare('DELETE FROM products WHERE id = ?').run(productId);
    db.prepare("DELETE FROM item_prices WHERE chain_id = 'tst'").run();
  }
});

test('collectRecipeDetails leverer ingredienser med mængde og fremgangsmåde', () => {
  const db = getDb();
  const { collectRecipeDetails } = require('../src/sync/build');
  const id = Number(db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at,
                         edition, intro, total_minutes, active_minutes)
    VALUES ('https://test.invalid/details', 'test', 'Test', 'Lam i ovn', 'da', 4, ?, 1, 'Mørt.', 90, 15)`)
    .run(new Date().toISOString()).lastInsertRowid);
  db.prepare(`INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient, item_key, amount,
                                              optional, position, section, label)
              VALUES (?, '600 g lammeculotte', 600, 'g', 'lammeculotte', 'lam', 0.6, 0, 0, NULL, 'lammeculotte')`).run(id);
  db.prepare("INSERT INTO recipe_steps (recipe_id, position, section, text) VALUES (?, 0, NULL, 'Steg kødet.')").run(id);
  try {
    const [row] = collectRecipeDetails(db, id);
    assert.deepEqual(row, {
      recipe_id: id, title: 'Lam i ovn', intro: 'Mørt.', image: null, source_name: 'Test',
      servings: 4, total_minutes: 90, active_minutes: 15,
      ingredients: [{ qty: 600, unit: 'g', label: 'lammeculotte', key: 'lam', optional: false, section: null }],
      steps: [{ section: null, text: 'Steg kødet.' }],
    });
  } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  }
});
