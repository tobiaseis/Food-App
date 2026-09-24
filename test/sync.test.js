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
const { server, DB } = require('./helpers/mock-postgrest.js');
const { push, collectPlanIndex } = require('../src/sync/build.js');
const { getDb } = require('../src/db');

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
    recipeIndex: [{ recipe_id: s(20), title: 'Frikadeller', url: 'https://valdemarsro.dk/frikadeller/',
                    score_classic: 0.8, unknown_main: false,
                    items: [{ key: 'hakket_svinekoed', cat: 'meat', amount: 0.5 }] }],
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
test('collectPlanIndex leverer amount, weight OG optional', () => {
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
  const insertIng = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertIng.run(recipeId, '6 æg', 'æg', 1, 'aeg', 6, 0);
  insertIng.run(recipeId, '0.5 kg kyllingebryst', 'kyllingebryst', 2, 'kyllingebryst', 0.5, 0);
  insertIng.run(recipeId, '0.6 kg kartofler', 'kartofler', 3, 'kartofler', 0.6, 0);
  insertIng.run(recipeId, 'evt. et skvæt fløde', 'fløde', 4, 'floede', 0.1, 1);

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

    for (const item of recipe.items) {
      assert.ok('amount' in item, `${item.key} mangler amount`);
      assert.ok('weight' in item, `${item.key} mangler weight`);
      assert.ok('optional' in item, `${item.key} mangler optional`);
      assert.equal(typeof item.optional, 'boolean', `${item.key}.optional er ikke boolsk`);
    }
  } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
  }
});
