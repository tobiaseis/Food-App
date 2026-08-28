'use strict';

/**
 * Sender de notifikationer, der endnu ikke er sendt, som push.
 *
 * Hele detektionen findes i forvejen: den natlige kørsel kører hver
 * overvågning og lægger rækker i notifications. Det, der manglede, var et
 * leveringsben – uden det opdager man først, at skyr var på tilbud, når man
 * tilfældigvis åbner appen igen.
 *
 *   node src/push/send.js
 *   node src/push/send.js --dry-run    # vis beskederne, send ingenting
 *
 * Legitimation (én af delene):
 *   FCM_SERVICE_ACCOUNT   hele service account-JSON'en som miljøvariabel
 *   fcm-service-account.json  ved siden af package.json (kun lokalt – i .gitignore)
 *
 * Ingen afhængigheder. FCM's HTTP v1 vil have en OAuth2-token, og den fås
 * ved at signere en JWT med tjenestekontoens nøgle; det kan node:crypto selv.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sb = require('../sync/supabase');

/**
 * Beskeder ældre end dette sendes ikke – de markeres bare som afsendte.
 *
 * Uden loftet ville den allerførste kørsel efter at push blev slået til finde
 * HVER eneste notifikation i basen med pushed_at = NULL og sende dem alle
 * sammen på én gang. Kørslen er daglig, så alt over halvandet døgn er enten
 * sendt før eller forældet nyt.
 */
const MAX_AGE_HOURS = 36;

/** FCM tager 500 beskeder ad gangen; vi sender én ad gangen, men med loft. */
const MAX_MESSAGES = 500;

const arg = (name) => process.argv.includes(name);
const log = (...a) => console.log(...a);

// ── Legitimation ────────────────────────────────────────────────────────────

function loadServiceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    try { return JSON.parse(raw); } catch {
      throw new Error('FCM_SERVICE_ACCOUNT er sat, men er ikke gyldig JSON.');
    }
  }
  const file = path.join(__dirname, '..', '..', 'fcm-service-account.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Bytter tjenestekontoen til en adgangstoken.
 *
 * Google vil have en JWT, signeret med kontoens private nøgle, som så
 * veksles hos oauth2.googleapis.com. Token'en lever en time – rigeligt til
 * én kørsel, så der caches ikke.
 */
async function accessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const signature = b64url(
    crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key)
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Kunne ikke hente adgangstoken: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token;
}

// ── Beskedtekst ─────────────────────────────────────────────────────────────

const kr = (n) => (n == null ? null
  : `${Number(n).toLocaleString('da-DK', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} kr`);

/** "Netto, føtex og REMA 1000" */
function listNames(names) {
  const uniq = [...new Set(names.filter(Boolean))];
  if (!uniq.length) return '';
  if (uniq.length === 1) return uniq[0];
  return `${uniq.slice(0, -1).join(', ')} og ${uniq[uniq.length - 1]}`;
}

/**
 * Én besked pr. enhed, ikke pr. vare.
 *
 * Fire varer på tilbud er én god nyhed, ikke fire afbrydelser – og fire
 * notifikationer i træk er dét, der får folk til at slå dem fra.
 */
function compose(rows) {
  const first = rows[0];
  const label = first.watches?.label || first.offers?.heading || 'En vare du følger';
  const chain = first.offers?.chains?.name;
  const price = kr(first.offers?.price);

  if (rows.length === 1) {
    const bits = [];
    if (price) bits.push(chain ? `${price} hos ${chain}` : price);
    if (first.discount != null && first.discount > 0) {
      bits.push(`${Math.round(first.discount)} % under normalprisen`);
    }
    return {
      title: `${label} er på tilbud`,
      body: bits.join(' · ') || 'Se tilbuddet i appen.',
    };
  }

  const labels = rows.map((r) => r.watches?.label).filter(Boolean);
  const chains = rows.map((r) => r.offers?.chains?.name).filter(Boolean);
  return {
    title: `${rows.length} varer du følger er på tilbud`,
    body: [listNames(labels), chains.length ? `hos ${listNames(chains)}` : '']
      .filter(Boolean).join(' – ') || 'Se dem i appen.',
  };
}

// ── FCM ─────────────────────────────────────────────────────────────────────

/**
 * @returns {'ok'|'dead'|'error'} 'dead' betyder, at token'et skal slettes.
 */
async function sendOne(projectId, token, bearer, { title, body }, count) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          // Trykker brugeren på beskeden, skal appen åbne på "Følg varer" –
          // ikke på forsiden, hvor man selv skal lede.
          data: { route: '#/watch', count: String(count) },
          android: {
            priority: 'high',
            notification: {
              // Samme tag = beskeden erstatter den forrige i stedet for at
              // lægge sig oven på den. Ellers stables en uges kørsler.
              tag: 'madplan-watch',
              default_sound: true,
            },
          },
        },
      }),
    }
  );

  if (res.ok) return 'ok';

  const err = await res.json().catch(() => ({}));
  const status = err?.error?.details?.[0]?.errorCode || err?.error?.status || '';
  // Afinstalleret app eller udskiftet token. Rækken er død og skal væk,
  // ellers vokser tabellen med tokens, der aldrig kan modtage noget.
  if (status === 'UNREGISTERED' || res.status === 404 ||
      (res.status === 400 && /token/i.test(JSON.stringify(err)))) {
    return 'dead';
  }
  log(`  ! FCM ${res.status} ${status}: ${JSON.stringify(err?.error?.message || err).slice(0, 160)}`);
  return 'error';
}

// ── Kørsel ──────────────────────────────────────────────────────────────────

async function run({ dryRun = false } = {}) {
  const account = loadServiceAccount();
  if (!account) {
    // Ikke en fejl. Har man ikke sat Firebase op, virker resten af rørledningen
    // uændret – man får bare ingen push. Kørslen må ikke vælte af det.
    log('Push springes over: hverken FCM_SERVICE_ACCOUNT eller fcm-service-account.json fundet.');
    return { sent: 0, skipped: true };
  }
  if (!sb.isConfigured()) {
    log('Push springes over: Supabase er ikke konfigureret.');
    return { sent: 0, skipped: true };
  }

  const pending = await sb.selectAll('notifications', {
    select: 'id,device_id,watch_id,offer_id,discount,unit_price,created_at,' +
            'watches(label),offers(heading,price,base_unit,chains(name))',
    query: 'pushed_at=is.null',
    order: 'created_at.desc',
  });

  if (!pending.length) { log('Ingen usendte notifikationer.'); return { sent: 0 }; }

  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
  const fresh = pending.filter((n) => new Date(n.created_at).getTime() >= cutoff);
  const stale = pending.filter((n) => new Date(n.created_at).getTime() < cutoff);

  log(`${pending.length} usendte · ${fresh.length} inden for ${MAX_AGE_HOURS} t · ${stale.length} for gamle`);

  // Grupper pr. enhed – én besked, uanset hvor mange varer der blev fundet.
  const byDevice = new Map();
  for (const n of fresh) {
    if (!byDevice.has(n.device_id)) byDevice.set(n.device_id, []);
    byDevice.get(n.device_id).push(n);
  }

  // device_tokens har ingen offentlig læsepolitik – service_role omgår RLS.
  const tokens = byDevice.size
    ? await sb.selectAll('device_tokens', { select: 'token,device_id', order: 'token.asc' })
    : [];
  const tokensFor = new Map();
  for (const t of tokens) {
    if (!byDevice.has(t.device_id)) continue;
    if (!tokensFor.has(t.device_id)) tokensFor.set(t.device_id, []);
    tokensFor.get(t.device_id).push(t.token);
  }

  const bearer = dryRun ? null : await accessToken(account);
  const projectId = account.project_id;

  let sent = 0;
  let messages = 0;
  const dead = [];
  const handled = [...stale.map((n) => n.id)];

  for (const [deviceId, rows] of byDevice) {
    const text = compose(rows);
    const deviceTokens = tokensFor.get(deviceId) || [];

    if (!deviceTokens.length) {
      // Ingen app installeret på den enhed. Beskeden markeres alligevel som
      // afsendt: ellers ville den blive forsøgt igen hver nat for evigt.
      log(`  ${deviceId.slice(0, 12)}… ingen enheder – ${rows.length} markeres som sendt`);
      handled.push(...rows.map((n) => n.id));
      continue;
    }

    if (dryRun) {
      log(`  ${deviceId.slice(0, 12)}… → ${deviceTokens.length} enhed(er)`);
      log(`      "${text.title}"`);
      log(`      "${text.body}"`);
      handled.push(...rows.map((n) => n.id));
      continue;
    }

    for (const token of deviceTokens) {
      if (messages >= MAX_MESSAGES) break;
      messages++;
      const result = await sendOne(projectId, token, bearer, text, rows.length);
      if (result === 'ok') sent++;
      if (result === 'dead') dead.push(token);
    }
    handled.push(...rows.map((n) => n.id));
  }

  // Markér som afsendt. Sker det ikke, sendes de samme beskeder igen i morgen.
  if (handled.length && !dryRun) {
    const now = new Date().toISOString();
    for (let i = 0; i < handled.length; i += 200) {
      const batch = handled.slice(i, i + 200);
      await sb.patch(`notifications?id=in.(${batch.join(',')})`, { pushed_at: now });
    }
  }

  if (dead.length && !dryRun) {
    for (const token of dead) {
      await sb.del('device_tokens', `token=eq.${encodeURIComponent(token)}`);
    }
    log(`  ryddede ${dead.length} døde tokens`);
  }

  log(dryRun
    ? `--dry-run: ${byDevice.size} besked(er) ville være sendt.`
    : `${sent} push sendt til ${byDevice.size} enhed(er).`);

  return { sent, devices: byDevice.size, dead: dead.length };
}

if (require.main === module) {
  run({ dryRun: arg('--dry-run') })
    .then(() => process.exit(0))
    .catch((err) => { console.error('\n[FEJL] push:', err.message); process.exit(1); });
}

module.exports = { run, compose, listNames, MAX_AGE_HOURS };
