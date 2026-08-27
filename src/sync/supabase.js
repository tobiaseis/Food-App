'use strict';

/**
 * Supabase-klient bygget på PostgREST og almindelig fetch.
 *
 * Ingen SDK: PostgREST er et HTTP-API, og projektet har i forvejen ingen
 * runtime-afhængigheder ud over better-sqlite3. Det holder GitHub Actions-
 * kørslen hurtig og forsyningskæden kort.
 *
 * Miljøvariabler:
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role-nøglen (kun i Actions – aldrig i frontend)
 */

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';

function assertConfigured() {
  if (!URL_BASE || !KEY) {
    throw new Error(
      'SUPABASE_URL og SUPABASE_SERVICE_KEY mangler. ' +
      'Sæt dem som miljøvariabler (lokalt) eller repository secrets (GitHub Actions).'
    );
  }
}

const isConfigured = () => Boolean(URL_BASE && KEY);

const headers = (extra = {}) => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, options = {}, { retries = 3 } = {}) {
  assertConfigured();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${URL_BASE}/rest/v1/${path}`, options);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
        await sleep(700 * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} på ${path}: ${(await res.text()).substring(0, 300)}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(700 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/**
 * Upsert i portioner.
 *
 * PostgREST tager imod et array pr. kald, men rammer man for stort et payload
 * timer forespørgslen ud. 500 rækker ad gangen er en fornuftig størrelse for
 * de bredeste tabeller her.
 */
async function upsert(table, rows, { chunk = 500, onConflict = null, log = null } = {}) {
  if (!rows.length) return 0;
  let done = 0;

  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    await request(`${table}${qs}`, {
      method: 'POST',
      headers: headers({
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(batch),
    });
    done += batch.length;
    if (log && rows.length > chunk) log(`    ${table}: ${done}/${rows.length}`);
  }
  return done;
}

/** Henter alle rækker med paginering (PostgREST maks. 1000 pr. kald). */
async function selectAll(table, { select = '*', order = 'id.asc', pageSize = 1000, query = '' } = {}) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const path = `${table}?select=${encodeURIComponent(select)}&order=${order}` +
                 `&limit=${pageSize}&offset=${offset}${query ? `&${query}` : ''}`;
    const batch = await request(path, { headers: headers() });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

async function del(table, query) {
  return request(`${table}?${query}`, {
    method: 'DELETE',
    headers: headers({ Prefer: 'return=minimal' }),
  });
}

module.exports = { request, upsert, selectAll, del, headers, isConfigured, assertConfigured, URL_BASE };
