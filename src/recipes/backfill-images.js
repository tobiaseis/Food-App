'use strict';

/**
 * Henter billeder for opskrifter, hvor billedfeltet mangler eller ikke er en
 * URL. Bruges efter en rettelse i billedudtrækket, så man slipper for at
 * crawle alt forfra.
 *
 *   node src/recipes/backfill-images.js
 */

const { getDb } = require('../db');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backfill({ delayMs = 800, log = console.log } = {}) {
  const db = getDb();
  const broken = db.prepare(`
    SELECT id, url, source FROM recipes
     WHERE image IS NULL OR image = '' OR image NOT LIKE 'http%'
  `).all();

  log(`${broken.length} opskrifter mangler et brugbart billede`);
  const update = db.prepare('UPDATE recipes SET image = ? WHERE id = ?');

  let fixed = 0, failed = 0;
  for (let i = 0; i < broken.length; i++) {
    const r = broken[i];
    try {
      const res = await fetch(r.url, { headers: UA, redirect: 'follow' });
      if (res.ok) {
        const html = await res.text();
        const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        if (og && /^https?:\/\//i.test(og[1])) { update.run(og[1], r.id); fixed++; }
        else failed++;
      } else failed++;
    } catch { failed++; }

    if ((i + 1) % 50 === 0) log(`  ${i + 1}/${broken.length} · ${fixed} rettet`);
    await sleep(delayMs);
  }

  log(`${fixed} billeder hentet, ${failed} uden brugbart billede`);
  return { fixed, failed };
}

if (require.main === module) backfill();

module.exports = { backfill };
