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
 * Supabase-varianten laver kun simple SELECTs: madplaner, prisstatistik og
 * tilbudsvurderinger er regnet færdige af GitHub Actions og ligger klar som
 * rækker. Der er ingen tung logik i browseren.
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
    return sb('chains?select=id,name,slug,logo,color&order=name.asc');
  },

  async offers({ q = '', chain = '', sort = 'unit_price', limit = 72 } = {}) {
    if (!USE_SUPABASE) {
      const p = new URLSearchParams({ q, chain, sort, limit: String(limit) });
      return local(`/api/offers?${p}`);
    }
    const order = { price: 'price.asc', newest: 'run_from.desc' }[sort] || 'unit_price.asc.nullslast';
    let path = `offers?select=${OFFER_COLS},products(name,category,taxonomy_key),chains(name,color)` +
               `&${activeFilter()}&order=${order}&limit=${limit}`;
    if (q) path += `&heading=ilike.*${encodeURIComponent(q)}*`;
    if (chain) path += `&chain_id=eq.${encodeURIComponent(chain)}`;
    return (await sb(path)).map(flattenOffer);
  },

  async deals(limit = 48) {
    if (!USE_SUPABASE) return local(`/api/deals?limit=${limit}`);
    const rows = await sb(
      `deals?select=verdict,discount_pct,confidence,is_cheapest,rank,` +
      `offers(${OFFER_COLS},products(name,category,taxonomy_key),chains(name,color))` +
      `&order=rank.asc&limit=${limit}`
    );
    return rows
      .filter((r) => r.offers)
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
   * Madplaner er regnet færdige. `variant` skifter mellem de forudberegnede
   * udgaver, så "Ny plan" virker uden at generatoren skal køre i skyen.
   */
  async mealPlan(tier, variant = 0) {
    if (!USE_SUPABASE) {
      return local(`/api/mealplan?tier=${tier}${variant ? '&refresh=1' : ''}`);
    }
    const rows = await sb(
      `meal_plans?tier=eq.${tier}&select=variant,payload,est_cost,est_savings` +
      `&order=year.desc,week.desc,variant.asc`
    );
    if (!rows.length) {
      return { error: 'Ingen madplan er bygget endnu. Kør GitHub Actions-jobbet.' };
    }
    const week = rows.filter((r) => r.variant != null);
    return week[variant % week.length].payload;
  },

  async planVariantCount(tier) {
    if (!USE_SUPABASE) return Infinity;
    const rows = await sb(`meal_plans?tier=eq.${tier}&select=variant&order=variant.asc`);
    return rows.length || 1;
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
