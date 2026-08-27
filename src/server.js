'use strict';

/**
 * HTTP-server: JSON-API + statisk frontend.
 *
 *   node src/server.js          →  http://localhost:3000
 *
 * Bevidst uden webframework – ruterne er få nok til, at node:http rækker,
 * og så slipper projektet for en afhængighed mere.
 */

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { getDb, getSetting, setSetting } = require('./db');
const tjek     = require('./ingest/tjek');
const priceLib = require('./price/history');
const plans    = require('./mealplan/generate');
const watches  = require('./watch/notify');
const { ingest } = require('./ingest/run');

const PORT       = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ── Hjælpere ─────────────────────────────────────────────────────────────────

const json = (res, data, status = 200) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1e6) { reject(new Error('For stor forespørgsel')); req.destroy(); }
  });
  req.on('end', () => {
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); } catch { reject(new Error('Ugyldig JSON')); }
  });
  req.on('error', reject);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  // Ingen sti-udbrud
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbudt'); return; }

  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA-fallback gælder KUN stier uden filendelse. Ellers ville en
      // manglende /config.js svare med index.html og status 200, og browseren
      // ville forsøge at køre HTML som JavaScript – en fejl der er meget
      // svær at gennemskue fra konsollen.
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Ikke fundet: ${rel}`);
        return;
      }
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Ikke fundet'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Forespørgsler ────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

function activeWhere(alias = 'o') {
  return `(${alias}.run_from IS NULL OR ${alias}.run_from <= @now)
      AND (${alias}.run_till IS NULL OR ${alias}.run_till >= @now)`;
}

function queryOffers({ q, chain, category, sort = 'discount', limit = 60, offset = 0, activeOnly = true }) {
  const db = getDb();
  const where = [];
  const params = { now: nowIso(), limit: Math.min(+limit || 60, 200), offset: +offset || 0 };

  if (activeOnly) where.push(activeWhere());
  if (q) {
    where.push('(LOWER(o.heading) LIKE @q OR LOWER(p.name) LIKE @q OR LOWER(o.description) LIKE @q)');
    params.q = `%${String(q).toLowerCase()}%`;
  }
  if (chain) {
    const ids = String(chain).split(',').filter(Boolean);
    where.push(`o.chain_id IN (${ids.map((_, i) => `@c${i}`).join(',')})`);
    ids.forEach((id, i) => { params[`c${i}`] = id; });
  }
  if (category) { where.push('p.category = @cat'); params.cat = category; }

  const order = {
    price: 'o.price ASC',
    unit_price: 'o.unit_price ASC NULLS LAST',
    newest: 'o.run_from DESC',
    discount: 'o.unit_price ASC NULLS LAST',
  }[sort] || 'o.unit_price ASC NULLS LAST';

  return db.prepare(`
    SELECT o.id, o.heading, o.description, o.price, o.pre_price, o.unit_price,
           o.base_unit, o.base_qty, o.image, o.run_from, o.run_till, o.page,
           o.product_id, p.name AS product_name, p.category, p.taxonomy_key,
           o.chain_id, c.name AS chain_name, c.color
      FROM offers o
      JOIN products p ON p.id = o.product_id
      JOIN chains   c ON c.id = o.chain_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${order}
     LIMIT @limit OFFSET @offset
  `).all(params);
}

/**
 * Ugens bedste reelle tilbud: dem hvor kr/kg ligger markant under varens
 * egen normalpris – ikke bare dem med det største tal på skiltet.
 */
function topDeals({ limit = 24, chain = null, minSamples = 3 } = {}) {
  const db = getDb();
  const params = { now: nowIso(), minSamples, limit: Math.min(+limit || 24, 100) };
  let chainFilter = '';
  if (chain) {
    const ids = String(chain).split(',').filter(Boolean);
    chainFilter = `AND o.chain_id IN (${ids.map((_, i) => `@c${i}`).join(',')})`;
    ids.forEach((id, i) => { params[`c${i}`] = id; });
  }

  // Normalprisen beregnes som medianen pr. varetype. SQLite har ikke median,
  // så vi bruger AVG som hurtig forfiltrering og lader assessRow give det
  // præcise svar for de kandidater, der slipper igennem.
  //
  // Både statistik og resultat regnes på ÉN pris pr. kæde pr. uge. Kæder som
  // ABC Lavpris udgiver samme vare i 16 aviser ad gangen, og uden det ville
  // både gennemsnittet og listen drukne i den samme vare.
  return db.prepare(`
    WITH dedup AS (
      SELECT product_id, base_unit, chain_id, year, week, MIN(unit_price) AS unit_price
        FROM offers
       WHERE unit_price IS NOT NULL AND base_unit IN ('kg','l')
       GROUP BY product_id, base_unit, chain_id, year, week
    ),
    stats AS (
      SELECT product_id, base_unit, AVG(unit_price) AS avg_price, COUNT(*) AS n
        FROM dedup
       GROUP BY product_id, base_unit
      HAVING COUNT(*) >= @minSamples
    ),
    ranked AS (
      SELECT o.id,
             ROW_NUMBER() OVER (PARTITION BY o.product_id ORDER BY o.unit_price ASC, o.id ASC) AS rn
        FROM offers o
       WHERE ${activeWhere()} AND o.unit_price IS NOT NULL
    )
    SELECT o.id, o.heading, o.price, o.pre_price, o.unit_price, o.base_unit,
           o.image, o.run_till, o.product_id,
           p.name AS product_name, p.category, p.taxonomy_key,
           o.chain_id, c.name AS chain_name, c.color,
           s.avg_price, s.n AS samples,
           (s.avg_price - o.unit_price) / s.avg_price AS rough_discount
      FROM offers o
      JOIN ranked r ON r.id = o.id AND r.rn = 1
      JOIN stats s  ON s.product_id = o.product_id AND s.base_unit = o.base_unit
      JOIN products p ON p.id = o.product_id
      JOIN chains   c ON c.id = o.chain_id
     WHERE p.category IS NOT NULL AND p.category != 'nonfood'
       AND o.unit_price < s.avg_price * 0.85
       ${chainFilter}
     ORDER BY rough_discount DESC
     LIMIT @limit
  `).all(params);
}

// ── Ruter ────────────────────────────────────────────────────────────────────

const planCache = new Map();
const planKey = (tier, chains) => `${tier}|${(chains || []).join(',')}`;

async function handleApi(req, res, url) {
  const p = url.pathname;
  const qs = url.searchParams;
  const db = getDb();

  // ── Status & stamdata ────────────────────────────────────────────────────
  if (p === '/api/status') {
    const one = (sql) => db.prepare(sql).get();
    return json(res, {
      offers: one('SELECT COUNT(*) n FROM offers').n,
      active_offers: db.prepare(`SELECT COUNT(*) n FROM offers o WHERE ${activeWhere()}`).get({ now: nowIso() }).n,
      products: one('SELECT COUNT(*) n FROM products').n,
      chains: one('SELECT COUNT(*) n FROM chains').n,
      stores: one('SELECT COUNT(*) n FROM stores').n,
      recipes: one('SELECT COUNT(*) n FROM recipes').n,
      watches: one('SELECT COUNT(*) n FROM watches WHERE active = 1').n,
      unread: one('SELECT COUNT(*) n FROM notifications WHERE read_at IS NULL').n,
      last_ingest: one('SELECT MAX(observed_at) t FROM offers').t,
      weeks_of_history: one('SELECT COUNT(DISTINCT year || \'-\' || week) n FROM offers').n,
      home: { lat: getSetting('home_lat', null), lng: getSetting('home_lng', null),
              label: getSetting('home_label', null) },
    });
  }

  if (p === '/api/chains') {
    return json(res, db.prepare(`
      SELECT c.*, COUNT(o.id) AS offer_count
        FROM chains c LEFT JOIN offers o ON o.chain_id = c.id
       GROUP BY c.id ORDER BY c.name
    `).all());
  }

  if (p === '/api/categories') {
    return json(res, db.prepare(`
      SELECT p.category, COUNT(*) n FROM offers o JOIN products p ON p.id = o.product_id
       WHERE p.category IS NOT NULL AND ${activeWhere()}
       GROUP BY p.category ORDER BY n DESC
    `).all({ now: nowIso() }));
  }

  // ── Tilbud ───────────────────────────────────────────────────────────────
  if (p === '/api/offers') {
    return json(res, queryOffers({
      q: qs.get('q'), chain: qs.get('chain'), category: qs.get('category'),
      sort: qs.get('sort'), limit: qs.get('limit'), offset: qs.get('offset'),
    }));
  }

  if (p === '/api/deals') {
    const rows = topDeals({ limit: qs.get('limit') || 24, chain: qs.get('chain') });
    // Præcis bedømmelse (median-baseret) for de kandidater, der nåede hertil
    const assessed = rows.map((r) => {
      const a = priceLib.assessRow({ ...r, id: r.id });
      return { ...r, verdict: a.verdict, discount_pct: a.discount_pct,
               confidence: a.confidence, baseline: a.baseline, is_cheapest: a.is_cheapest };
    }).filter((r) => r.discount_pct != null && r.discount_pct > 0)
      .sort((a, b) => b.discount_pct - a.discount_pct);
    return json(res, assessed);
  }

  // ── Produkt: historik + sammenligning ────────────────────────────────────
  const productMatch = p.match(/^\/api\/products\/(\d+)$/);
  if (productMatch) {
    const id = +productMatch[1];
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!product) return json(res, { error: 'Ukendt vare' }, 404);

    const unit = db.prepare(
      `SELECT base_unit, COUNT(*) n FROM offers WHERE product_id = ? AND unit_price IS NOT NULL
        GROUP BY base_unit ORDER BY n DESC LIMIT 1`
    ).get(id)?.base_unit || 'stk';

    return json(res, {
      product,
      base_unit: unit,
      baseline: priceLib.getBaseline(id, unit),
      chains: priceLib.compareChains(id, { baseUnit: unit }),
      history: priceLib.getHistory(id, { baseUnit: unit }),
      series: priceLib.weeklySeries(id, unit),
    });
  }

  const offerMatch = p.match(/^\/api\/offers\/(\d+)$/);
  if (offerMatch) {
    const assessment = priceLib.assessOffer(+offerMatch[1]);
    if (!assessment) return json(res, { error: 'Ukendt tilbud' }, 404);
    const offer = db.prepare(`
      SELECT o.*, p.name AS product_name, p.category, c.name AS chain_name
        FROM offers o JOIN products p ON p.id=o.product_id JOIN chains c ON c.id=o.chain_id
       WHERE o.id = ?`).get(+offerMatch[1]);
    return json(res, { offer, assessment });
  }

  // ── Madplaner ────────────────────────────────────────────────────────────
  if (p === '/api/mealplan') {
    const tier = qs.get('tier') || 'classic';
    if (!plans.TIERS[tier]) return json(res, { error: 'Ukendt spor' }, 400);
    const chainIds = (qs.get('chains') || '').split(',').filter(Boolean);
    const key = planKey(tier, chainIds);

    if (!qs.get('refresh') && planCache.has(key)) return json(res, planCache.get(key));

    // Ved "Ny plan" gives et nyt seed, så brugeren får en anden uge og ikke
    // den samme liste igen. Uden refresh er seedet fast pr. uge, så en
    // genindlæsning ikke flytter rundt på planen under fødderne på folk.
    const { week, year } = require('./lib/normalize').isoWeek(new Date());
    const seed = qs.get('refresh') ? (Date.now() & 0x7fffffff) : (year * 100 + week);

    const plan = plans.generatePlan({ tier, chainIds: chainIds.length ? chainIds : null, seed });
    if (!plan.error) {
      plan.shopping_list = plans.shoppingList(plan);
      try { plans.savePlan(plan); } catch { /* historik er ikke kritisk */ }
      planCache.set(key, plan);
    }
    return json(res, plan);
  }

  // ── Følg varer ───────────────────────────────────────────────────────────
  if (p === '/api/watches' && req.method === 'GET') return json(res, watches.listWatches());

  if (p === '/api/watches' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const w = watches.createWatch({
        label: body.label, query: body.query || body.label,
        chainIds: body.chain_ids || [], maxKm: body.max_km ?? null,
        minDiscount: body.min_discount ?? null, maxUnitPrice: body.max_unit_price ?? null,
      });
      const created = watches.runWatches();
      return json(res, { watch: w, new_notifications: created.length }, 201);
    } catch (err) { return json(res, { error: err.message }, 400); }
  }

  const watchMatch = p.match(/^\/api\/watches\/(\d+)$/);
  if (watchMatch && req.method === 'DELETE') {
    return json(res, { deleted: watches.deleteWatch(+watchMatch[1]) });
  }

  if (p === '/api/watches/run' && req.method === 'POST') {
    return json(res, { created: watches.runWatches() });
  }

  if (p === '/api/notifications' && req.method === 'GET') {
    return json(res, watches.listNotifications({
      unreadOnly: qs.get('unread') === '1', limit: +(qs.get('limit') || 100),
    }));
  }

  if (p === '/api/notifications/read' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, { marked: watches.markRead(body.ids) });
  }

  // ── Butikker & indstillinger ─────────────────────────────────────────────
  if (p === '/api/stores/near') {
    const lat = parseFloat(qs.get('lat')), lng = parseFloat(qs.get('lng'));
    const radius = parseFloat(qs.get('radius') || '10');
    if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'lat/lng mangler' }, 400);
    const rows = db.prepare(`
      SELECT s.*, c.name AS chain_name, c.color FROM stores s JOIN chains c ON c.id = s.chain_id
       WHERE s.lat IS NOT NULL`).all();
    const near = rows
      .map((s) => ({ ...s, km: Math.round(tjek.distanceKm(lat, lng, s.lat, s.lng) * 10) / 10 }))
      .filter((s) => s.km <= radius)
      .sort((a, b) => a.km - b.km)
      .slice(0, 120);
    return json(res, near);
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    for (const [k, v] of Object.entries(body)) setSetting(k, v);
    return json(res, { ok: true });
  }

  // ── Vedligehold ──────────────────────────────────────────────────────────
  if (p === '/api/ingest' && req.method === 'POST') {
    const body = await readBody(req);
    const stats = await ingest({ withStores: !!body.stores, log: () => {} });
    planCache.clear();
    watches.runWatches();
    return json(res, stats);
  }

  return json(res, { error: 'Ukendt endepunkt' }, 404);
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

if (require.main === module) {
  getDb();
  server.listen(PORT, () => {
    console.log(`Madplan kører på http://localhost:${PORT}`);
  });
}

module.exports = { server, queryOffers, topDeals };
