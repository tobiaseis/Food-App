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

test('en dansk titel får samme hverdagsstraf som den engelske', () => {
  // reclassify regner sporet ud fra titlen, og efter recipes:import er det
  // den danske udgaves. "Kylling i bradepande" skal straffes som "Chicken
  // traybake" — ellers flytter retten spor, fordi den skiftede sprog.
  const recipe = { protein_g: 35, kcal: 520, total_minutes: 30 };
  const lines = [
    { taxonomy_key: 'oksemoerbrad', qty: 600, unit: 'g' },
    { taxonomy_key: 'lam',          qty: 200, unit: 'g' },
  ];
  const premiumOf = (title) => scoreTiers({ ...recipe, title }, lines).premium;
  const neutral = premiumOf('Kylling med ris');
  const pairs = [
    ['Cottage pie', 'Kødtærte med kartoffelmos'],
    ["Shepherd's pie", 'Hyrdetærte'],
    ['Chicken traybake', 'Kylling i bradepande'],
    ['Jacket potatoes with tuna', 'Bagekartofler med tun'],
    ['Jacket potato with beans', 'Bagt kartoffel med bønner'],
    ['Fish fingers with peas', 'Fiskefingre med ærter'],
    ['Cheese toasties', 'Parisertoast'],
    ['Chicken nuggets', 'Kyllingenuggets'],
  ];
  for (const [en, da] of pairs) {
    assert.ok(premiumOf(en) < neutral, `${en} straffes ikke`);
    assert.equal(premiumOf(da), premiumOf(en), `${da} skal straffes som ${en}`);
  }
  // Og ikke ord, der blot ligner: tilbehør og tilberedning er ikke retten.
  for (const t of ['Laks med ovnbagte kartofler', 'Bagt kartoffelmos', 'Salat med toastede pinjekerner']) {
    assert.equal(premiumOf(t), neutral, `${t} er ikke en hverdagsret`);
  }
});

// ── Frikadeller tælles i stykker, ikke portioner ─────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { servingsFromYield, scaleNutrition } = require('../src/recipes/servings');

test('servingsFromYield: 18 frikadeller er 5 portioner, 4 personer er 4', () => {
  // Brugerens regel: én portion er 3-4 frikadeller.
  assert.equal(servingsFromYield('Linsefrikadeller', 18), 5);
  assert.equal(servingsFromYield('Pink tundeller', 8), 2);
  assert.equal(servingsFromYield('Easy healthy falafels', 16), 5);
  assert.equal(servingsFromYield('Chicken & basil meatballs', 24), 7);
  // Under 8 er tallet personer.
  assert.equal(servingsFromYield('Frikadeller', 4), 4);
  assert.equal(servingsFromYield('Classic homemade meatballs', 6), 6);
  // Frikadellen er ikke hovedordet: 8 pitaer er ikke 8 frikadeller.
  assert.equal(servingsFromYield('Bagt frikadellepita med cremefraiche dressing', 8), 8);
  assert.equal(servingsFromYield('Lasagne', 12), 12);
  assert.equal(servingsFromYield('Linsefrikadeller', null), null);
});

test('servingsFromYield: spyd, forårsruller, dumplings og pandekager tælles i stykker', () => {
  assert.equal(servingsFromYield('Grillspyd med kylling, halloumi og chorizo', 12), 4);
  assert.equal(servingsFromYield('Sprøde forårsruller', 30), 8);
  assert.equal(servingsFromYield('Rice paper dumplings', 20), 3);
  assert.equal(servingsFromYield('Sliders – Miniburger', 20), 7);
  assert.equal(servingsFromYield('Majspandekager', 10), 3);
  assert.equal(servingsFromYield('Smash burger tacos', 8), 3);
  // Over 250 g pr. "stykke" er tallet personer: 2,5 kg til 8.
  assert.equal(servingsFromYield('Herbed chicken skewers', 8, 2521), 8);
  assert.equal(servingsFromYield('Chicken skewers with tzatziki', 8, 1229), 3);
});

test('servingsFromYield: den danske titel giver samme portioner som den engelske', () => {
  // reclassify regner portionerne igen ud fra titlen, og efter recipes:import
  // er den dansk. "Easy healthy falafels" (16 stk) må ikke blive 16 portioner,
  // fordi den nu hedder "Nemme falafler".
  const pairs = [
    ['Easy healthy falafels', 'Nemme, sunde falafler', 16],
    ['Chicken & basil meatballs', 'Kyllingekødboller med basilikum', 24],
    ['Thai fish cakes', 'Thailandske fiskefrikadeller', 12],
    ['Chicken skewers with tzatziki', 'Kyllingespyd med tzatziki', 8],
    ['Crispy spring rolls', 'Sprøde forårsruller', 30],
    ['Prawn summer rolls', 'Sommerruller med rejer', 12],
    ['Pork dumplings', 'Dumplings med svinekød', 20],
    ['Fluffy pancakes', 'Luftige pandekager', 10],
    ['Belgian waffles', 'Belgiske vafler', 9],
    ['Beef sliders', 'Miniburgere med oksekød', 12],
    ['Leek & cheese pie', 'Porretærte med ost', 1],
  ];
  for (const [en, da, n] of pairs) {
    const want = servingsFromYield(en, n);
    assert.notEqual(want, n, `${en}: reglen skal flytte tallet`);
    assert.equal(servingsFromYield(da, n), want, `${da} skal give ${want} som ${en}`);
  }
});

test('portionsantallet læses også fra greatbritishchefs\' egen side-JSON', () => {
  // Ingen recipeYield i deres JSON-LD; alle 400 stod uden og blev regnet som 4.
  const { yieldFromPage } = require('../src/recipes/extract');
  assert.equal(yieldFromPage('..."description":"x","yieldTextOverride":"6","tagCourse":{...'), 6);
  assert.equal(yieldFromPage('<html>ingen</html>'), null);
});

test('servingsFromYield: "1" på en tærte er én hel tærte, ikke én portion', () => {
  assert.equal(servingsFromYield('Kartoffel og bacon tærte', 1), 4);
  assert.equal(servingsFromYield('Quiche lorraine', 1), 4);
  assert.equal(servingsFromYield('Crab & asparagus omelette', 1), 1);
});

test('scaleNutrition: kildens tal pr. stykke bliver tal pr. portion', () => {
  assert.deepEqual(scaleNutrition({ kcal: 100, protein_g: 5, carbs_g: null, fat_g: 4 }, 18, 5),
    { kcal: 360, protein_g: 18, carbs_g: null, fat_g: 14.4 });
  const same = { kcal: 500 };
  assert.equal(scaleNutrition(same, 4, 4), same);
});

test('reclassify regner portioner fra kildens rå antal — og kun én gang', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madplan-servings-'));
  const dbPath = path.join(dir, 'servings.db');
  assert.ok(path.resolve(dbPath).startsWith(path.resolve(os.tmpdir())));
  const mods = ['src/db', 'src/lib/taxonomy', 'src/recipes/extract', 'src/recipes/classify',
                'src/recipes/reclassify'].map((m) => require.resolve(path.join(__dirname, '..', m)));
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  for (const id of mods) delete require.cache[id];
  const warn = console.warn;
  console.warn = () => {};
  let db;
  try {
    db = require('../src/db').getDb();
    const { reclassify } = require('../src/recipes/reclassify');
    const ins = db.prepare(`INSERT INTO recipes (url, source, source_name, title, servings,
                              kcal, protein_g, fat_g, nutrition_src, fetched_at)
                            VALUES (?, 'x', 'X', ?, ?, ?, ?, ?, ?, '2026-09-28')`);
    // En base fra før kolonnen: servings ER kildens rå antal, yield_count er tom.
    const a = ins.run('a', 'Linsefrikadeller', 18, 100, 5, 4, 'site').lastInsertRowid;
    const b = ins.run('b', 'Frikadeller', 4, 600, 30, 30, 'site').lastInsertRowid;
    // 28 stk er 8 portioner — og 8 ligner igen et stykantal. Uden det rå tal
    // ville næste kørsel gøre det til 2.
    const c = ins.run('c', 'Chicken & basil meatballs', 28, 50, 4, 2, 'site').lastInsertRowid;
    const get = db.prepare('SELECT servings, yield_count, kcal, fat_g FROM recipes WHERE id = ?');

    reclassify({ log: () => {} });
    assert.deepEqual({ ...get.get(a) }, { servings: 5, yield_count: 18, kcal: 360, fat_g: 14.4 });
    assert.deepEqual({ ...get.get(b) }, { servings: 4, yield_count: 4, kcal: 600, fat_g: 30 });
    assert.deepEqual({ ...get.get(c) }, { servings: 8, yield_count: 28, kcal: 175, fat_g: 7 });

    // Kører hver nat. En anden kørsel må hverken dele 5 igen eller gange
    // næringen op en gang til.
    const again = reclassify({ log: () => {} });
    assert.equal(again.reserved, 0);
    assert.deepEqual({ ...get.get(a) }, { servings: 5, yield_count: 18, kcal: 360, fat_g: 14.4 });
    assert.deepEqual({ ...get.get(c) }, { servings: 8, yield_count: 28, kcal: 175, fat_g: 7 });
  } finally {
    console.warn = warn;
    if (db) db.close();
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
    for (const id of mods) delete require.cache[id];
  }
});
