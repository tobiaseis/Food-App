'use strict';

/**
 * Henter kildens portionsantal for opskrifter, der står uden.
 *
 * Crawleren springer opskrifter over, den allerede har hentet, så en rettelse
 * i udtrækket når aldrig de gamle. Det ramte greatbritishchefs: alle 400 stod
 * uden portionsantal og blev regnet som 4, selv om siden siger "Serves 2" eller
 * "Serves 8" — tallet stod bare et sted, udtrækket ikke kiggede (se
 * yieldFromPage i extract.js).
 *
 * Skriver kun yield_count, kildens rå tal. Portionerne regnes af reclassify,
 * så de samme regler (frikadeller i stykker, en tærte er fire) gælder her.
 * Kan køres igen: den spørger kun til opskrifter, der stadig mangler tallet.
 *
 *   node src/recipes/backfill-yield.js [--limit N]
 */

const { getDb } = require('../db');
const { extractRecipe } = require('./extract');
const { BY_KEY } = require('./sources');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backfill({ limit = Infinity, log = console.log } = {}) {
  const db = getDb();
  const missing = db.prepare(`
    SELECT id, url, source FROM recipes
     WHERE yield_count IS NULL AND servings IS NULL
     ORDER BY id
  `).all().slice(0, limit);

  log(`${missing.length} opskrifter uden portionsantal`);
  const update = db.prepare('UPDATE recipes SET yield_count = ? WHERE id = ?');

  let found = 0, none = 0, failed = 0;
  for (let i = 0; i < missing.length; i++) {
    const r = missing[i];
    try {
      const res = await fetch(r.url, { headers: UA, redirect: 'follow' });
      if (res.ok) {
        const parsed = extractRecipe(await res.text(), r.url);
        if (parsed && parsed.servings > 0) { update.run(parsed.servings, r.id); found++; }
        else none++;
      } else failed++;
    } catch { failed++; }

    if ((i + 1) % 50 === 0) log(`  ${i + 1}/${missing.length} · ${found} fundet`);
    // Kildens egen pause, samme som crawleren bruger.
    await sleep((BY_KEY.get(r.source) || {}).delayMs || 1000);
  }

  log(`${found} portionsantal hentet · ${none} sider uden · ${failed} fejlede`
    + (found ? '\nKør `npm run reclassify` for at regne portionerne om.' : ''));
  return { found, none, failed };
}

if (require.main === module) {
  const i = process.argv.indexOf('--limit');
  const limit = i !== -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
  backfill({ limit }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { backfill };
