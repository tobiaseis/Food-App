'use strict';

/**
 * Datalag med to bagender.
 *
 *   · lokal    – Node-serveren på /api/*  (npm start)
 *   · supabase – PostgREST direkte fra browseren (Vercel-deployet)
 *
 * Frontenden kalder de samme funktioner uanset hvad, så udvikling lokalt og
 * drift i skyen ikke er to forskellige apps.
 *
 * Supabase-varianten laver kun simple SELECTs: prisstatistik og
 * tilbudsvurderinger er regnet færdige af GitHub Actions og ligger klar som
 * rækker.
 *
 * Madplanen er den ene undtagelse, og med vilje. Den afhænger af brugerens
 * FAVORITBUTIKKER, og dem findes der 32.767 kombinationer af – de kan ikke
 * forudberegnes. I stedet hentes de to små opslagstabeller, planen bygges af
 * (`offer_index`, `recipe_index`), og `public/engine.js` – nøjagtig samme
 * motor som kører i GitHub Actions – sætter planen sammen her i browseren.
 */

const CFG = window.APP_CONFIG || {};
const USE_SUPABASE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

/** Stabilt id pr. browser – knytter overvågninger til denne enhed. */
function deviceId() {
  let id = null;
  try { id = localStorage.getItem('madplan_device'); } catch { /* privat vindue */ }
  if (!id) {
    id = 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('madplan_device', id); } catch { /* ignoreres */ }
  }
  return id;
}

// ── Favoritbutikker ──────────────────────────────────────────────────────────

/**
 * De kæder, brugeren rent faktisk handler i.
 *
 * Tom liste = ikke valgt endnu; så bygges madplanen af alle kæder, som den
 * altid har gjort. Valget bor i localStorage, fordi det er personligt og skal
 * virke i begge bagender – kører man mod den lokale server, spejles det også
 * til dens `settings`, så `npm run update` bygger planen af de samme butikker.
 */
const FAV_KEY = 'madplan_favorite_chains';

function readFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const ids = raw ? JSON.parse(raw) : null;
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  } catch { return []; }
}

function writeFavorites(ids) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(ids || [])); } catch { /* privat vindue */ }
}

// ── PostgREST ────────────────────────────────────────────────────────────────

const sbHeaders = (extra = {}) => ({
  apikey: CFG.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

async function sb(path, options = {}) {
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: sbHeaders(options.headers),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Henter ALLE rækker, ikke kun den første side.
 *
 * PostgREST svarer med et loft pr. forespørgsel (typisk 1.000 rækker), og
 * madplans-indekset er større end det. Uden sidevisning ville planen stille og
 * roligt blive bygget på en tilfældig tredjedel af opskrifterne.
 */
async function sbAll(path, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const page = await sb(path, {
      headers: { 'Range-Unit': 'items', Range: `${from}-${from + pageSize - 1}` },
    });
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

async function local(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

// Kun aktive tilbud: run_till mangler eller ligger i fremtiden
const activeFilter = () => `or=(run_till.is.null,run_till.gte.${new Date().toISOString()})`;

const OFFER_COLS = 'id,heading,description,price,pre_price,unit_price,base_unit,base_qty,' +
                   'image,run_from,run_till,product_id,chain_id';

/** Flader PostgRESTs indlejrede relationer ud til den form, UI'et forventer. */
function flattenOffer(o) {
  return {
    ...o,
    product_name: o.products?.name ?? null,
    category: o.products?.category ?? null,
    taxonomy_key: o.products?.taxonomy_key ?? null,
    chain_name: o.chains?.name ?? null,
    color: o.chains?.color ?? null,
  };
}

// ── Madplans-indeks (kun Supabase-bagenden) ──────────────────────────────────

// Indekset skifter kun, når den natlige kørsel har været forbi. Vi henter det
// derfor én gang pr. sidevisning og genbruger det på tværs af spor og
// "Ny plan" – ellers ville hvert klik koste et par hundrede kilobyte.
const planIndex = { offers: null, prices: null, recipes: {} };

const MIN_TIER_SCORE = 0.35;

const TIER_LABELS = {
  healthy: 'Sund & proteinrig (lavt kulhydrat)',
  classic: 'Klassisk hverdagsmad',
  premium: 'Gourmet',
};

async function loadPlanIndex(tier) {
  if (!planIndex.prices) {
    const [prices, offers] = await Promise.all([
      sbAll('taxonomy_prices?select=*&order=taxonomy_key.asc'),
      sbAll('offer_index?select=*&order=taxonomy_key.asc,chain_id.asc'),
    ]);
    planIndex.prices = prices;
    planIndex.offers = offers;
  }
  if (!planIndex.recipes[tier]) {
    planIndex.recipes[tier] = await sbAll(
      `recipe_index?score_${tier}=gte.${MIN_TIER_SCORE}&select=*&order=recipe_id.asc`
    );
  }
  return planIndex;
}

/**
 * Reducerer indekset til ét tilbud pr. varetype – billigste pr. kg/l blandt
 * brugerens egne butikker. Tom `chainIds` betyder alle kæder.
 */
function offerMapFor(rows, chainIds, chainNames) {
  const allowed = chainIds && chainIds.length ? new Set(chainIds) : null;
  const map = new Map();
  for (const r of rows) {
    if (allowed && !allowed.has(r.chain_id)) continue;
    const prev = map.get(r.taxonomy_key);
    if (prev && prev.unit_price <= r.unit_price) continue;
    map.set(r.taxonomy_key, { ...r, chain: chainNames[r.chain_id] || r.chain_id });
  }
  return map;
}

// ── API ──────────────────────────────────────────────────────────────────────

const Data = {
  backend: USE_SUPABASE ? 'supabase' : 'local',

  async status() {
    if (!USE_SUPABASE) return local('/api/status');
    const rows = await sb('sync_state?key=eq.last_build&select=value,updated_at');
    const v = rows?.[0]?.value || {};
    return {
      offers: v.offers ?? 0,
      active_offers: v.offers ?? 0,
      products: v.products ?? 0,
      chains: 14,
      stores: 0,
      recipes: v.recipes ?? 0,
      weeks_of_history: null,
      last_ingest: rows?.[0]?.updated_at ?? v.at ?? null,
      unread: await this.unreadCount(),
      home: { lat: null, lng: null },
    };
  },

  async unreadCount() {
    if (!USE_SUPABASE) {
      const s = await local('/api/status');
      return s.unread || 0;
    }
    const rows = await sb(
      `notifications?device_id=eq.${deviceId()}&read_at=is.null&select=id`,
      { headers: { Prefer: 'count=exact' } }
    );
    return Array.isArray(rows) ? rows.length : 0;
  },

  async chains() {
    if (!USE_SUPABASE) return local('/api/chains');
    const [rows, state] = await Promise.all([
      sb('chains?select=id,name,slug,logo,color&order=name.asc'),
      sb('sync_state?key=eq.last_build&select=value'),
    ]);
    const counts = state?.[0]?.value?.chain_offers || {};
    return rows.map((c) => ({ ...c, active_count: counts[c.id] ?? null }));
  },

  // ── Favoritbutikker ───────────────────────────────────────────────────────

  favorites: readFavorites,

  async setFavorites(ids) {
    const clean = [...new Set((ids || []).filter(Boolean))];
    writeFavorites(clean);
    // Den lokale server bygger også planer uden for browseren (npm run update),
    // så den skal kende valget. Supabase-bagenden har ingen server at fortælle.
    if (!USE_SUPABASE) await local('/api/settings', { method: 'POST', body: { favorite_chains: clean } });
    return clean;
  },

  /** Første besøg i en ny browser: overtag serverens gemte valg. */
  async adoptServerFavorites(status) {
    if (USE_SUPABASE || readFavorites().length) return readFavorites();
    const saved = (status && status.favorite_chains) || [];
    if (saved.length) writeFavorites(saved);
    return readFavorites();
  },

  // `chain` er en kommasepareret liste (eller tom = alle kæder), så de samme
  // favoritbutikker kan bruges her som i madplanen.
  async offers({ q = '', chain = '', sort = 'unit_price', limit = 72 } = {}) {
    if (!USE_SUPABASE) {
      const p = new URLSearchParams({ q, chain, sort, limit: String(limit) });
      return local(`/api/offers?${p}`);
    }
    const order = { price: 'price.asc', newest: 'run_from.desc' }[sort] || 'unit_price.asc.nullslast';
    let path = `offers?select=${OFFER_COLS},products(name,category,taxonomy_key),chains(name,color)` +
               `&${activeFilter()}&order=${order}&limit=${limit}`;
    if (q) path += `&heading=ilike.*${encodeURIComponent(q)}*`;
    const ids = String(chain).split(',').filter(Boolean);
    if (ids.length) path += `&chain_id=in.(${ids.map(encodeURIComponent).join(',')})`;
    return (await sb(path)).map(flattenOffer);
  },

  async deals(limit = 48, chain = '') {
    const ids = String(chain).split(',').filter(Boolean);

    if (!USE_SUPABASE) {
      const p = new URLSearchParams({ limit: String(limit) });
      if (ids.length) p.set('chain', ids.join(','));
      return local(`/api/deals?${p}`);
    }

    // Listen er kort nok til at filtrere her. Alternativet – et filter på den
    // indlejrede offers-relation – kræver !inner-join og gør forespørgslen
    // væsentligt mere skrøbelig for at spare et par kilobyte.
    const rows = await sb(
      `deals?select=verdict,discount_pct,confidence,is_cheapest,rank,` +
      `offers(${OFFER_COLS},products(name,category,taxonomy_key),chains(name,color))` +
      `&order=rank.asc&limit=${ids.length ? 100 : limit}`
    );
    const allowed = ids.length ? new Set(ids) : null;
    return rows
      .filter((r) => r.offers && (!allowed || allowed.has(r.offers.chain_id)))
      .slice(0, limit)
      .map((r) => ({ ...flattenOffer(r.offers), verdict: r.verdict,
                     discount_pct: r.discount_pct, confidence: r.confidence,
                     is_cheapest: r.is_cheapest }));
  },

  async product(id) {
    if (!USE_SUPABASE) return local(`/api/products/${id}`);

    const [product] = await sb(`products?id=eq.${id}&select=*`);
    if (!product) return { error: 'Ukendt vare' };

    const stats = await sb(`price_stats?product_id=eq.${id}&select=*&order=samples.desc`);
    const unit = stats[0]?.base_unit || 'stk';

    const [series, offers] = await Promise.all([
      sb(`price_series?product_id=eq.${id}&base_unit=eq.${unit}&select=*&order=period.asc`),
      sb(`offers?product_id=eq.${id}&base_unit=eq.${unit}&unit_price=not.is.null&${activeFilter()}` +
         `&select=${OFFER_COLS},chains(name,color)&order=unit_price.asc`),
    ]);

    // Billigste tilbud pr. kæde – PostgREST kan ikke lave DISTINCT ON,
    // og listen er kort nok til at reducere her.
    const best = new Map();
    for (const o of offers.map(flattenOffer)) if (!best.has(o.chain_id)) best.set(o.chain_id, o);

    const s = stats[0];
    return {
      product,
      base_unit: unit,
      baseline: s ? { median: s.median, min: s.min_price, max: s.max_price,
                      samples: s.samples, chains: s.chains, periods: s.periods } : null,
      chains: [...best.values()],
      series: series.map((p) => ({ period: p.period, median: p.median,
                                   min: p.min_price, max: p.max_price, n: p.n })),
      history: [],
    };
  },

  /**
   * Ugens madplan for ét spor, bygget af tilbuddene i brugerens egne butikker.
   *
   * `variant` er "Ny plan": et nyt seed, ikke en ny forespørgsel til serveren.
   */
  async mealPlan(tier, variant = 0, chainIds = null) {
    const chains = chainIds || readFavorites();

    if (!USE_SUPABASE) {
      const q = new URLSearchParams({ tier });
      q.set('chains', chains.length ? chains.join(',') : 'all');
      if (variant) q.set('refresh', String(variant));
      return local(`/api/mealplan?${q}`);
    }

    let index;
    try {
      index = await loadPlanIndex(tier);
    } catch (err) {
      // Er skemaet ikke migreret endnu, findes tabellerne ikke. Fald tilbage
      // på den forudberegnede plan – den bruger alle kæder, men er bedre end
      // en tom side, og beskeden siger hvorfor.
      const rows = await sb(
        `meal_plans?tier=eq.${tier}&select=variant,payload&order=year.desc,week.desc,variant.asc`
      );
      if (!rows.length) return { error: `Madplans-indekset kunne ikke hentes (${err.message}).` };
      const plan = rows[variant % rows.length].payload;
      return { ...plan, index_missing: true };
    }

    const chainRows = await this.chains();
    const chainNames = Object.fromEntries(chainRows.map((c) => [c.id, c.name]));

    const names = {};
    const normalPrices = new Map();
    for (const p of index.prices) {
      names[p.taxonomy_key] = p.name;
      if (p.unit_price != null) {
        normalPrices.set(p.taxonomy_key,
          { unit_price: p.unit_price, base_unit: p.base_unit, name: p.name });
      }
    }

    const recipes = index.recipes[tier].map((r) => ({
      id: r.recipe_id,
      title: r.title, url: r.url, image: r.image,
      source: r.source, source_name: r.source_name,
      servings: r.servings, total_minutes: r.total_minutes,
      kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g,
      nutrition_src: r.nutrition_src,
      tier_score: r[`score_${tier}`],
      unknown_main: r.unknown_main,
      // Indekset sender kun nøgle, kategori og mængde. Navnet ligger i
      // taxonomy_prices, så det ikke gentages på 2.000 opskrifter.
      items: (r.items || []).map((i) => ({ ...i, ingredient: names[i.key] || i.key })),
    }));

    const { week, year } = window.PlanEngine.isoWeek(new Date());
    const plan = window.PlanEngine.buildPlan({
      tier,
      tierLabel: TIER_LABELS[tier] || '',
      recipes,
      offers: offerMapFor(index.offers, chains, chainNames),
      normalPrices,
      seed: variant ? (year * 1000 + week * 10 + variant) : (year * 100 + week),
      chainIds: chains.length ? chains : null,
      chainNames: chains.length ? chains.map((id) => chainNames[id]).filter(Boolean) : null,
    });

    if (!plan.error) plan.shopping_list = window.PlanEngine.shoppingList(plan);
    return plan;
  },

  // ── Overvågninger ─────────────────────────────────────────────────────────

  async watches() {
    if (!USE_SUPABASE) return local('/api/watches');
    const rows = await sb(
      `watches?device_id=eq.${deviceId()}&select=*&order=created_at.desc`
    );
    // Tællinger som den lokale server ellers laver med underforespørgsler
    const notifs = await sb(
      `notifications?device_id=eq.${deviceId()}&select=watch_id,read_at`
    );
    return rows.map((w) => ({
      ...w,
      notif_count: notifs.filter((n) => n.watch_id === w.id).length,
      unread: notifs.filter((n) => n.watch_id === w.id && !n.read_at).length,
    }));
  },

  async createWatch(body) {
    if (!USE_SUPABASE) return local('/api/watches', { method: 'POST', body });
    const row = await sb('watches', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{
        device_id: deviceId(),
        label: body.label,
        query: body.query || body.label,
        chain_ids: body.chain_ids || [],
        max_km: body.max_km ?? null,
        min_discount: body.min_discount ?? null,
        max_unit_price: body.max_unit_price ?? null,
        home_lat: body.home_lat ?? null,
        home_lng: body.home_lng ?? null,
      }]),
    });
    // Træf dannes af den natlige kørsel – der er ingen generator i browseren.
    return { watch: row[0], new_notifications: 0, deferred: true };
  },

  async deleteWatch(id) {
    if (!USE_SUPABASE) return local(`/api/watches/${id}`, { method: 'DELETE' });
    await sb(`watches?id=eq.${id}&device_id=eq.${deviceId()}`, { method: 'DELETE' });
    return { deleted: true };
  },

  async runWatches() {
    if (!USE_SUPABASE) return local('/api/watches/run', { method: 'POST' });
    return { created: [], deferred: true };
  },

  async notifications(limit = 60) {
    if (!USE_SUPABASE) return local(`/api/notifications?limit=${limit}`);
    const rows = await sb(
      `notifications?device_id=eq.${deviceId()}&select=*,` +
      `watches(label),offers(heading,price,base_unit,image,run_till,chains(name))` +
      `&order=created_at.desc&limit=${limit}`
    );
    return rows.map((n) => ({
      ...n,
      watch_label: n.watches?.label ?? '',
      heading: n.offers?.heading ?? '',
      price: n.offers?.price ?? null,
      base_unit: n.offers?.base_unit ?? null,
      image: n.offers?.image ?? null,
      chain_name: n.offers?.chains?.name ?? '',
    }));
  },

  async markRead() {
    if (!USE_SUPABASE) return local('/api/notifications/read', { method: 'POST', body: {} });
    await sb(`notifications?device_id=eq.${deviceId()}&read_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    });
    return { marked: true };
  },

  async storesNear(lat, lng, radius = 5) {
    if (!USE_SUPABASE) return local(`/api/stores/near?lat=${lat}&lng=${lng}&radius=${radius}`);
    // Groft koordinat-vindue, finafstand regnes her
    const d = radius / 111;
    const rows = await sb(
      `stores?lat=gte.${lat - d}&lat=lte.${lat + d}&lng=gte.${lng - d * 1.8}&lng=lte.${lng + d * 1.8}` +
      `&select=*,chains(name,color)&limit=400`
    );
    const km = (a, b, c, e) => {
      const R = 6371, r = (x) => (x * Math.PI) / 180;
      const dLat = r(c - a), dLng = r(e - b);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    return rows
      .map((s) => ({ ...s, chain_name: s.chains?.name ?? '', km: Math.round(km(lat, lng, s.lat, s.lng) * 10) / 10 }))
      .filter((s) => s.km <= radius)
      .sort((a, b) => a.km - b.km);
  },

  async saveSettings(body) {
    if (!USE_SUPABASE) return local('/api/settings', { method: 'POST', body });
    try { localStorage.setItem('madplan_home', JSON.stringify(body)); } catch { /* ignoreres */ }
    return { ok: true };
  },

  async ingest() {
    if (!USE_SUPABASE) return local('/api/ingest', { method: 'POST', body: {} });
    return { deferred: true };
  },

  deviceId,
};

window.Data = Data;
