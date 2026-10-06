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

// v3: madplanen blev til de fem trin (plan 3, opgave 3). app.js, data.js og
// styles.css skal skiftes samlet — ellers taler en gammel app.js med et nyt
// datalag, eller omvendt.
// v4: sider fra Supabase fik hver deres cache-nøgle (se staleWhileRevalidate).
// Versionen skal op, så de forkerte, sammenblandede sider fra v3 kasseres.
// v5: det lyse design. Ny markup i app.js (fliser, afkrydsning) passer kun
// til den nye styles.css, så skallen skiftes samlet.
// v6: opskriftsarket (recipe_details) og ny markup i app.js.
// v7: brug det, jeg har, swipe og madlavningstilstand.
const VERSION = 'v7';
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
const CACHEABLE_TABLES = /\/rest\/v1\/(offer_index|recipe_index|recipe_details|taxonomy_prices|chains|price_stats|price_series|deals|offers|products|sync_state|meal_plans|stores|items|item_prices|recipe_costs)\b/;

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
  // Store tabeller hentes i sider à 1.000 rækker (sbAll), og hver side har
  // SAMME adresse — kun `Range`-hovedet skiller dem ad. Cachen nøgler på
  // adressen alene, så siderne overskrev hinanden. Målt i den afsluttende
  // gennemgang af plan 3: recipe_index er tre sider, og puljen på tolv retter
  // indeholdt fem forskellige; efter en genindlæsning var den gemte side den
  // tomme sidste, og siden viste "Kunne ikke hente opskrifter". Siden skal
  // derfor med i nøglen.
  const range = request.headers.get('Range');
  const key = range
    ? new Request(request.url + (request.url.includes('?') ? '&' : '?') +
        '__range=' + encodeURIComponent(range))
    : request;
  const hit = await cache.match(key);
  const fresh = fetch(request).then((res) => {
    if (res.ok) cache.put(key, res.clone());
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

  // /api/ er data, ikke skal. shellFirst ignorerer forespørgselsstrengen, så
  // /api/item-prices?chains=netto og ?chains=netto,rema1000 fik det SAMME
  // gemte svar — prislisten låste sig fast på den første butik, man valgte,
  // og listen sagde "Alt kan købes i Netto" med REMA som favorit.
  if (url.origin === self.location.origin && !url.pathname.startsWith('/api/')) {
    event.respondWith(shellFirst(request));
    return;
  }

  if (CACHEABLE_TABLES.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // Alt andet – watches, notifications, billeder fra tredjepart – går
  // uberørt til nettet.
});
