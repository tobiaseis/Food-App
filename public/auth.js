'use strict';

/**
 * Anonymt login mod Supabase.
 *
 * Formålet er ikke at få brugere til at oprette en konto – det skal de aldrig.
 * Formålet er, at hver installation får et rigtigt auth.uid(), så
 * overvågninger og notifikationer kan lukkes af Row Level Security.
 *
 * Uden det adskilles brugerne kun af et device_id fra localStorage, og
 * anon-nøglen ligger i enhver APK: enhver med den kunne læse og slette alles
 * overvågninger. Det er fint for én husstand og uacceptabelt i Play Store.
 * Se supabase/auth.sql.
 *
 * Ingen SDK. GoTrue er et HTTP-API, og projektet har ingen frontend-
 * afhængigheder – det skal det blive ved med at have.
 *
 * FALDER TILBAGE PÆNT: er anonymt login ikke slået til i Supabase-projektet
 * endnu, sætter init() bare `enabled = false`, og datalaget bruger anon-
 * nøglen som hidtil. Appen virker altså både før og efter migreringen, og
 * de to kan derfor rulles ud hver for sig.
 */

const AUTH_CFG = window.APP_CONFIG || {};
const AUTH_KEY = 'madplan_session';

// Fornys, når der er mindre end dette tilbage. Supabase-tokens lever en time.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const authState = {
  enabled: false,
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,          // ms siden epoch
  userId: null,
  claimed: false,
};

/* ── Sessionen på disken ──────────────────────────────────────────────────── */

function readSession() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeSession(s) {
  const raw = JSON.stringify(s);
  try { localStorage.setItem(AUTH_KEY, raw); } catch { /* privat vindue */ }
  // Samme grund som device-id'et: en ryddet WebView må ikke koste brugeren
  // adgangen til sine egne rækker.
  window.Native?.persist(AUTH_KEY, raw);
}

function adopt(session) {
  if (!session || !session.access_token) return false;
  authState.accessToken = session.access_token;
  authState.refreshToken = session.refresh_token || null;
  authState.userId = session.user?.id || session.user_id || null;
  authState.expiresAt = session.expires_at
    ? session.expires_at * 1000
    : Date.now() + (session.expires_in || 3600) * 1000;
  authState.enabled = true;
  writeSession({
    access_token: authState.accessToken,
    refresh_token: authState.refreshToken,
    expires_at: Math.floor(authState.expiresAt / 1000),
    user_id: authState.userId,
  });
  return true;
}

/* ── GoTrue ───────────────────────────────────────────────────────────────── */

async function gotrue(path, body) {
  const res = await fetch(`${AUTH_CFG.SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: AUTH_CFG.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.msg || data.error_description || data.error || `HTTP ${res.status}`);
    err.code = data.error_code || data.code || String(res.status);
    throw err;
  }
  return data;
}

const signInAnonymously = () => gotrue('signup', { data: {}, gotrue_meta_security: {} });

const refreshWith = (refreshToken) =>
  gotrue('token?grant_type=refresh_token', { refresh_token: refreshToken });

/* ── Overtagelse af de gamle rækker ───────────────────────────────────────────
   Overvågninger oprettet før login fandtes har user_id = NULL og bliver
   usynlige i det øjeblik policyerne strammes. claim_device() i auth.sql
   binder dem til den nye bruger ud fra det device_id, appen stadig har
   liggende. Kaldes én gang pr. installation.                                */

async function claimDevice() {
  if (authState.claimed || !authState.accessToken) return;
  const deviceId = (() => {
    try { return localStorage.getItem('madplan_device'); } catch { return null; }
  })();
  if (!deviceId) { authState.claimed = true; return; }

  try {
    await fetch(`${AUTH_CFG.SUPABASE_URL}/rest/v1/rpc/claim_device`, {
      method: 'POST',
      headers: {
        apikey: AUTH_CFG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${authState.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_device_id: deviceId }),
    });
  } catch { /* funktionen findes ikke endnu – rækkerne overtages næste gang */ }
  authState.claimed = true;
}

/* ── API ──────────────────────────────────────────────────────────────────── */

/** Fornyer sessionen. Returnerer true, hvis der bagefter er en gyldig token. */
async function refresh() {
  if (!authState.refreshToken) return false;
  try {
    return adopt(await refreshWith(authState.refreshToken));
  } catch {
    // Forældet refresh-token. En ny anonym bruger ville miste adgangen til
    // de gamle rækker, så der logges ikke bare ind igen her – det gør
    // init() ved næste opstart, hvor claim_device også kører.
    authState.enabled = false;
    return false;
  }
}

async function init() {
  if (!AUTH_CFG.SUPABASE_URL || !AUTH_CFG.SUPABASE_ANON_KEY) return false;

  const stored = readSession();
  if (stored?.access_token) {
    authState.accessToken = stored.access_token;
    authState.refreshToken = stored.refresh_token;
    authState.userId = stored.user_id;
    authState.expiresAt = (stored.expires_at || 0) * 1000;
    authState.enabled = true;
    authState.claimed = true;             // gjort ved første login
    if (authState.expiresAt - Date.now() < REFRESH_MARGIN_MS) await refresh();
    return authState.enabled;
  }

  try {
    adopt(await signInAnonymously());
    await claimDevice();
  } catch (err) {
    // Typisk "anonymous_provider_disabled": migreringen er ikke kørt endnu.
    // Det er ikke en fejl – datalaget bruger anon-nøglen som hidtil.
    authState.enabled = false;
  }
  return authState.enabled;
}

window.Auth = {
  get enabled() { return authState.enabled; },
  /** Synkron – datalaget skal kunne sætte headeren uden at vente. */
  token: () => authState.accessToken,
  userId: () => authState.userId,
  expired: () => authState.expiresAt - Date.now() < REFRESH_MARGIN_MS,
  init,
  refresh,
};
