'use strict';

/**
 * Service worker – app-skallen offline, og et hurtigt førstebillede online.
 *
 * To slags indhold, to strategier:
 *
 *   · skallen (html/css/js/ikoner)  cache-first. Filerne skifter kun ved
 *     deploy, og et versioneret cache-navn rydder de gamle.
 *
 *   · madplans-indekset i Supabase  stale-while-revalidate. Tabellerne
 *     skifter kun, når den natlige kørsel har været forbi, så et sekund
 *     gammelt svar er lige så rigtigt som et nyt – og planen står på
 *     skærmen med det samme i stedet for efter et par hundrede kilobyte.
 *
 * Brugerens egne data (watches, notifications) caches ikke. En ulæst
 * notifikation, der bliver ved med at være ulæst, fordi svaret kom fra
 * cachen, er værre end en langsom indlæsning.
 *
 * BEMÆRK: køres appen i Capacitor, ligger skallen allerede lokalt i APK'en.
 * Der registreres derfor ingen service worker der – se registerServiceWorker()
 * i public/app.js.
 */

const VERSION = 'v1';
const SHELL_CACHE = `madplan-shell-${VERSION}`;
const DATA_CACHE = `madplan-data-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/engine.js',
  '/native.js',
  '/auth.js',
  '/data.js',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

/** Tabeller, der kun ændrer sig efter den natlige kørsel. */
const CACHEABLE_TABLES = /\/rest\/v1\/(offer_index|recipe_index|taxonomy_prices|chains|price_stats|price_series|deals|offers|products|sync_state|meal_plans|stores)\b/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fejler samlet, hvis bare én fil mangler. Skallen skal kunne
    // installeres alligevel, så filerne hentes hver for sig.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('madplan-') && !keep.has(n))
                           .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

/** Cache-first med baggrundsopdatering. */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) {
    // Opdatér i baggrunden, så næste besøg er friskt.
    fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); }).catch(() => {});
    return hit;
  }
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

/** Svar fra cachen med det samme, hent nyt til næste gang. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(request);
  const fresh = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const res = await fresh;
  if (res) return res;
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skrivninger må aldrig røre cachen.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Hash-ruter er alle sammen "/" for browseren. Offline skal en genindlæsning
  // stadig give app-skallen, ikke browserens fejlside.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) ||
               Response.error();
      }
    })());
    return;
  }

  // Nøglerne kan roteres. Hentes de fra cachen, peger appen på et forkert
  // projekt, indtil cachen ryddes – derfor nettet først her.
  if (url.pathname === '/config.js') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(request, { cache: 'no-store' });
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch {
        return (await cache.match(request)) || Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellFirst(request));
    return;
  }

  if (CACHEABLE_TABLES.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // Alt andet – watches, notifications, billeder fra tredjepart – går
  // uberørt til nettet.
});
