'use strict';

/**
 * Henter kildesiderne igen og gemmer råmaterialet til den danske udgave i
 * tmp/kilder/<kilde>/<slug>.json: titel, portioner, tider, ingredienslinjer og
 * fremgangsmåde.
 *
 * tmp/ er gitignoret med vilje. Kildens fremgangsmåde er dens egen tekst; den
 * er input til omskrivningen og må hverken ende i git, i data.db (som ligger
 * som release-asset) eller i Supabase.
 *
 *   npm run recipes:fetch-sources                          # alle, der mangler
 *   npm run recipes:fetch-sources -- --source valdemarsro --limit 20
 *   npm run recipes:fetch-sources -- --ids 2178,2179 --force
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { BY_KEY } = require('./sources');
const { fetchText } = require('./crawl');
const { extractRecipe } = require('./extract');
const { instructionsFrom } = require('./instructions');
const { sourcePath } = require('./edition');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argValue = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

async function fetchOne(row) {
  const html = await fetchText(row.url);
  if (!html) return { ok: false, reason: 'kunne ikke hentes' };
  const parsed = extractRecipe(html, row.url);
  if (!parsed) return { ok: false, reason: 'ingen opskrift på siden' };
  const steps = instructionsFrom(html);
  if (!steps.length) return { ok: false, reason: 'ingen fremgangsmåde' };

  const record = {
    url: row.url, source: row.source, source_name: row.source_name, lang: row.lang,
    fetched_at: new Date().toISOString(),
    title: parsed.title,
    image: parsed.image,
    keywords: parsed.keywords,
    yield_count: parsed.servings,
    // Sidens næring pr. SIN portion (tal, ikke tekst). rewrite.js lægger den i
    // udgaven, så en ret, release-basen ikke kender, får sidens tal og ikke et skøn.
    nutrition: parsed.kcal != null || parsed.protein_g != null
      ? { kcal: parsed.kcal, protein_g: parsed.protein_g, carbs_g: parsed.carbs_g, fat_g: parsed.fat_g }
      : null,
    total_minutes: parsed.total_minutes,
    active_minutes: parsed.active_minutes,
    ingredients: parsed.ingredients.map((i) => i.raw),
    steps,
  };
  const file = sourcePath(row.source, row.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return { ok: true };
}

async function main(args) {
  const db = getDb();
  const ids = argValue(args, '--ids');
  const source = argValue(args, '--source');
  const limit = Number(argValue(args, '--limit')) || Infinity;
  const force = args.includes('--force');

  let rows = db.prepare('SELECT id, url, source, source_name, lang FROM recipes ORDER BY id').all();
  if (ids) { const want = new Set(ids.split(',').map(Number)); rows = rows.filter((r) => want.has(r.id)); }
  if (source) rows = rows.filter((r) => r.source === source);
  if (!force) rows = rows.filter((r) => !fs.existsSync(sourcePath(r.source, r.url)));
  rows = rows.slice(0, limit);

  // Én kø pr. kilde, kørt side om side: samme høflighed pr. site som
  // crawleren (sources.js' delayMs), men ikke fire gange så lang tid i alt.
  const queues = new Map();
  for (const r of rows) {
    if (!queues.has(r.source)) queues.set(r.source, []);
    queues.get(r.source).push(r);
  }
  const failed = [];
  let done = 0;
  await Promise.all([...queues].map(async ([key, list]) => {
    const delay = BY_KEY.get(key)?.delayMs ?? 1000;
    for (const r of list) {
      // Én fejlende URL må ikke fælde hele køen: uden try/catch afviser et
      // uventet kast hele Promise.all og standser de andre kilders køer med.
      let res;
      try {
        res = await fetchOne(r);
      } catch (e) {
        res = { ok: false, reason: e.message };
      }
      if (!res.ok) failed.push({ id: r.id, url: r.url, reason: res.reason });
      if (++done % 50 === 0) console.log(`  ${done}/${rows.length}`);
      await sleep(delay);
    }
  }));

  console.log(`${rows.length - failed.length} kilder gemt i tmp/kilder/ · ${failed.length} fejlede`);
  for (const f of failed.slice(0, 30)) console.log(`  ${f.id} ${f.url}: ${f.reason}`);
  return { saved: rows.length - failed.length, failed };
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('[FEJL]', e.message); process.exit(1); });
}

module.exports = { fetchOne, main };
