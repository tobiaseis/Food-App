'use strict';

/**
 * Henter opskrifter fra kilderne i sources.js og gemmer dem normaliseret.
 *
 * Crawleren er bevidst langsom (≈1 kald/sek pr. kilde) og identificerer sig
 * selv. Vi henter kun sider, kildens robots.txt tillader, og gemmer kun
 * fakta – titel, ingrediensliste, næringsindhold, billede og link.
 *
 *   node src/recipes/crawl.js                     # lidt fra alle kilder
 *   node src/recipes/crawl.js --limit 400
 *   node src/recipes/crawl.js bbcgoodfood --limit 250
 */

const { getDb } = require('../db');
const { SOURCES, BY_KEY } = require('./sources');
const { extractRecipe } = require('./extract');
const { estimateNutrition, scoreTiers, primaryTier } = require('./classify');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { retries = 2, timeoutMs = 20000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: UA, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      return await res.text();
    } catch {
      clearTimeout(t);
      if (attempt < retries) await sleep(1200 * (attempt + 1));
    }
  }
  return null;
}

const locsIn = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);

/** Finder opskrifts-URL'er – via kildens sitemap, eller dens egen metode. */
async function discoverUrls(source, limit) {
  if (typeof source.discover === 'function') {
    return [...new Set(await source.discover({ fetchText, sleep }, limit))];
  }

  const indexXml = await fetchText(source.sitemapIndex);
  if (!indexXml) return [];

  let maps = source.pickSitemaps(locsIn(indexXml));
  if (!maps.length) maps = [source.sitemapIndex];

  const urls = [];
  for (const map of maps) {
    const xml = await fetchText(map);
    if (!xml) continue;
    for (const u of locsIn(xml)) {
      if (source.isRecipeUrl(u)) urls.push(u);
    }
    if (urls.length >= limit * 3) break;
    await sleep(400);
  }
  return [...new Set(urls)];
}

// ── Lagring ──────────────────────────────────────────────────────────────────

function storeRecipe(db, source, parsed) {
  const nutritionFromSite = parsed.kcal != null || parsed.protein_g != null;
  let kcal = parsed.kcal, protein = parsed.protein_g, carbs = parsed.carbs_g;
  let nutritionSrc = nutritionFromSite ? 'site' : null;

  if (!nutritionFromSite) {
    const est = estimateNutrition(parsed.ingredients, parsed.servings);
    if (est) { kcal = est.kcal; protein = est.protein_g; carbs = est.carbs_g; nutritionSrc = 'estimated'; }
  } else if (carbs == null) {
    const est = estimateNutrition(parsed.ingredients, parsed.servings);
    if (est) carbs = est.carbs_g;
  }

  const scores = scoreTiers({ ...parsed, kcal, protein_g: protein, carbs_g: carbs, source: source.key }, parsed.ingredients);
  const { tier, tier_score } = primaryTier(scores);

  const info = db.prepare(`
    INSERT INTO recipes (
      url, source, source_name, title, description, image, lang, servings,
      total_minutes, kcal, protein_g, carbs_g, fat_g, nutrition_src,
      tier, tier_score, score_healthy, score_classic, score_premium,
      keywords, fetched_at
    ) VALUES (
      @url, @source, @source_name, @title, @description, @image, @lang, @servings,
      @total_minutes, @kcal, @protein_g, @carbs_g, @fat_g, @nutrition_src,
      @tier, @tier_score, @score_healthy, @score_classic, @score_premium,
      @keywords, @fetched_at
    )
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title, image = excluded.image, servings = excluded.servings,
      total_minutes = excluded.total_minutes, kcal = excluded.kcal,
      protein_g = excluded.protein_g, nutrition_src = excluded.nutrition_src,
      tier = excluded.tier, tier_score = excluded.tier_score,
      score_healthy = excluded.score_healthy, score_classic = excluded.score_classic,
      score_premium = excluded.score_premium,
      fetched_at = excluded.fetched_at
  `).run({
    url: parsed.url,
    source: source.key,
    source_name: source.name,
    title: parsed.title,
    description: parsed.description,
    image: parsed.image,
    lang: source.lang,
    servings: parsed.servings,
    total_minutes: parsed.total_minutes,
    kcal, protein_g: protein,
    carbs_g: carbs, fat_g: parsed.fat_g,
    nutrition_src: nutritionSrc,
    tier, tier_score,
    score_healthy: scores.healthy,
    score_classic: scores.classic,
    score_premium: scores.premium,
    keywords: parsed.keywords,
    fetched_at: new Date().toISOString(),
  });

  const row = db.prepare('SELECT id FROM recipes WHERE url = ?').get(parsed.url);
  const recipeId = row.id;

  db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
  const ins = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient, taxonomy_key, is_staple, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const ing of parsed.ingredients) {
    ins.run(recipeId, ing.raw, ing.qty, ing.unit, ing.ingredient, ing.taxonomy_key, ing.is_staple, ing.position);
  }

  return { recipeId, created: info.changes > 0, tier };
}

// ── Kørsel ───────────────────────────────────────────────────────────────────

async function crawlSource(source, { limit = 150, log = console.log } = {}) {
  const db = getDb();
  const known = new Set(
    db.prepare('SELECT url FROM recipes WHERE source = ?').all(source.key).map((r) => r.url)
  );

  log(`\n[${source.name}] finder opskrifts-URL'er...`);
  const all = await discoverUrls(source, limit);
  const fresh = all.filter((u) => !known.has(u));
  log(`  ${all.length} opskrifter i sitemap · ${known.size} allerede hentet · henter op til ${Math.min(limit, fresh.length)}`);

  const stats = { ok: 0, failed: 0, skipped: 0, tiers: {} };
  const queue = fresh.slice(0, limit);

  for (let i = 0; i < queue.length; i++) {
    const url = queue[i];
    const html = await fetchText(url);
    if (!html) { stats.failed++; await sleep(source.delayMs); continue; }

    let parsed = null;
    try { parsed = extractRecipe(html, url); } catch { /* uparselig side */ }

    if (!parsed || parsed.ingredients.length < 2) {
      stats.skipped++;
    } else {
      try {
        const { tier } = storeRecipe(db, source, parsed);
        stats.ok++;
        stats.tiers[tier] = (stats.tiers[tier] || 0) + 1;
      } catch (err) {
        stats.failed++;
        if (stats.failed <= 3) log(`    fejl ved ${url}: ${err.message}`);
      }
    }

    if ((i + 1) % 25 === 0) log(`  ${i + 1}/${queue.length} · ${stats.ok} gemt`);
    await sleep(source.delayMs);
  }

  log(`  ${source.name}: ${stats.ok} gemt, ${stats.skipped} uden opskriftsdata, ${stats.failed} fejlede`);
  return stats;
}

async function crawlAll({ sources = SOURCES, limit = 150, log = console.log } = {}) {
  const totals = { ok: 0, failed: 0, skipped: 0 };
  for (const s of sources) {
    const st = await crawlSource(s, { limit, log });
    totals.ok += st.ok; totals.failed += st.failed; totals.skipped += st.skipped;
  }
  return totals;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const li = args.indexOf('--limit');
  const limit = li !== -1 ? parseInt(args[li + 1], 10) : 150;
  const keys = args.filter((a) => !a.startsWith('--') && a !== String(limit));
  const sources = keys.length ? keys.map((k) => BY_KEY.get(k)).filter(Boolean) : SOURCES;

  if (keys.length && sources.length !== keys.length) {
    console.error('Ukendt kilde. Gyldige:', SOURCES.map((s) => s.key).join(', '));
    process.exit(1);
  }

  crawlAll({ sources, limit })
    .then((t) => {
      const db = getDb();
      const n = db.prepare('SELECT COUNT(*) n FROM recipes').get().n;
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`${t.ok} opskrifter hentet i denne kørsel · ${n} i databasen i alt`);
      for (const r of db.prepare('SELECT tier, COUNT(*) n FROM recipes GROUP BY tier ORDER BY n DESC').all()) {
        console.log(`  ${String(r.tier).padEnd(10)} ${r.n}`);
      }
    })
    .catch((e) => { console.error('[FEJL]', e.message); process.exit(1); });
}

module.exports = { crawlAll, crawlSource, discoverUrls, storeRecipe };
