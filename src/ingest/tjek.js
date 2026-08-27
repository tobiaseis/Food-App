'use strict';

/**
 * Klient til Tjek/eTilbudsavis' offentlige katalog-API.
 *
 * Dette erstatter PDF-nedhentning + AI-vision. API'et leverer strukturerede
 * felter som vision-udtrækket aldrig fik fat i: førpris, eksakt mængde med
 * SI-faktor (så kr/kg bliver regnestykke frem for gætværk), gyldighedsperiode,
 * sidetal og produktbillede – gratis og deterministisk.
 */

const BASE = 'https://squid-api.tjek.com/v2';

const HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/** Dagligvarekæder i Danmark, med Tjek dealer-id. */
const CHAINS = [
  { id: '9ba51',  slug: 'netto',        name: 'Netto' },
  { id: 'bdf5A',  slug: 'foetex',       name: 'føtex' },
  { id: '11deC',  slug: 'rema1000',     name: 'REMA 1000' },
  { id: '93f13',  slug: 'bilka',        name: 'Bilka' },
  { id: '71c90',  slug: 'lidl',         name: 'Lidl' },
  { id: '0b1e8',  slug: 'superbrugsen', name: 'SuperBrugsen' },
  { id: 'c1edq',  slug: 'kvickly',      name: 'Kvickly' },
  { id: '267e1m', slug: 'meny',         name: 'MENY' },
  { id: '88ddE',  slug: 'spar',         name: 'SPAR' },
  { id: 'DWZE1w', slug: '365discount',  name: '365discount' },
  { id: 'd311fg', slug: 'brugsen',      name: 'Brugsen' },
  { id: '603dfL', slug: 'minkoebmand',  name: 'Min Købmand' },
  { id: '70d42L', slug: 'abclavpris',   name: 'ABC Lavpris' },
  { id: 'f6f54',  slug: 'letkoeb',      name: 'LET-KØB' },
  { id: 'faacr',  slug: 'salling',      name: 'Salling' },
];

const CHAIN_BY_ID   = new Map(CHAINS.map((c) => [c.id, c]));
const CHAIN_BY_SLUG = new Map(CHAINS.map((c) => [c.slug, c]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET med simpel backoff. Tjek rate-limiter ved høj hastighed. */
async function api(pathAndQuery, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(BASE + pathAndQuery, { headers: HEADERS });
      if (res.status === 429 || res.status >= 500) {
        await sleep(800 * Math.pow(2, attempt));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathAndQuery}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(600 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/** Aktive kataloger (tilbudsaviser) for en eller flere kæder. */
async function getCatalogs(dealerIds, { limit = 24 } = {}) {
  const ids = Array.isArray(dealerIds) ? dealerIds.join(',') : dealerIds;
  const list = await api(`/catalogs?dealer_ids=${encodeURIComponent(ids)}&limit=${limit}`);
  return Array.isArray(list) ? list : [];
}

/** Alle tilbud i ét katalog. Pagineres til bunden. */
async function getOffers(catalogId, { pageSize = 100, maxPages = 20 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await api(
      `/offers?catalog_id=${encodeURIComponent(catalogId)}&limit=${pageSize}&offset=${page * pageSize}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
    await sleep(150);
  }
  return out;
}

/**
 * Butikker for en kæde. Med `lat`/`lng`/`radius` returneres kun butikker
 * inden for radius – det er dét, der driver "tilbud i butikker nær dig".
 */
async function getStores(dealerId, { lat, lng, radius, limit = 100 } = {}) {
  let q = `/stores?dealer_ids=${encodeURIComponent(dealerId)}&limit=${limit}`;
  if (typeof lat === 'number' && typeof lng === 'number') {
    q += `&r_lat=${lat}&r_lng=${lng}&r_radius=${Math.round(radius || 15000)}`;
  }
  const list = await api(q);
  return Array.isArray(list) ? list : [];
}

/** Afstand i km mellem to koordinater (haversine). */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = {
  BASE, CHAINS, CHAIN_BY_ID, CHAIN_BY_SLUG,
  api, getCatalogs, getOffers, getStores, distanceKm, sleep,
};
