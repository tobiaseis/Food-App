/**
 * Supermarket API Discovery Script
 *
 * Besøger Netto, Rema 1000 og Føtex' online tilbudsaviser og opsnapper
 * skjulte JSON-API-kald med produkt- og prisdata.
 *
 * Kør:       node discover.js
 * Installer: npm install && npx playwright install chromium
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── Output ───────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, 'intercepted_data');

// ── Ugenummer-hjælpefunktioner (ISO 8601) ────────────────────────────────────

/**
 * Returnerer ISO-ugenummeret (1–53) for en given dato.
 * ISO 8601: ugen starter mandag; uge 1 er ugen med årets første torsdag.
 *
 * @param {Date} date
 * @returns {number}
 */
function getISOWeek(date) {
  // Klon og normaliser til UTC for at undgå DST-problemer
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // ISO: mandag = 1 … søndag = 7
  const dow = d.getUTCDay() || 7;
  // Flyt til torsdag i samme uge (ISO-referencepunkt)
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
}

/**
 * Returnerer ISO-ugenummer for næste uge.
 * Håndterer årsgrænsen (uge 52/53 → uge 1).
 *
 * @param {Date} date
 * @returns {number}
 */
function getNextISOWeek(date) {
  const nextWeekDate = new Date(date);
  nextWeekDate.setDate(date.getDate() + 7);
  return getISOWeek(nextWeekDate);
}

/**
 * Bygger den korrekte Føtex avis-URL dynamisk ud fra dagens dato.
 *
 * Eksempel: hvis i dag er i uge 15, returneres
 *   https://avis.foetex.dk/naeste-uges-avis/uge-1516/
 *
 * Mønsteret er: nuværende uge + næste uge, begge zero-padded til 2 cifre.
 *
 * @returns {string}
 */
function getFoetexAvisUrl() {
  const today = new Date();
  const current = getISOWeek(today);
  const next = getNextISOWeek(today);
  const slug = `${String(current).padStart(2, '0')}${String(next).padStart(2, '0')}`;
  const url = `https://avis.foetex.dk/naeste-uges-avis/uge-${slug}/`;
  console.log(`[foetex] Dynamisk URL beregnet: uge ${current} → ${next}  →  ${url}`);
  return url;
}

// ── Supermarkeder ────────────────────────────────────────────────────────────

/**
 * Hvert supermarked har et navn og én eller flere sider der besøges.
 * Føtex-URL'en beregnes dynamisk ved opstart.
 */
function buildSupermarkets() {
  return [
    {
      name: 'netto',
      urls: ['https://netto.dk/netto-avisen/'],
    },
    {
      name: 'rema1000',
      urls: ['https://rema1000.dk/avis'],
    },
    {
      name: 'foetex',
      urls: [getFoetexAvisUrl()],
    },
  ];
}

// ── Filtrering ───────────────────────────────────────────────────────────────

/**
 * Søgeord der indikerer produkt- eller prisdata.
 * Tjekkes mod hele den serialiserede JSON-streng (case-insensitive).
 */
const PRODUCT_KEYWORDS = [
  // Engelsk
  'price', 'offer', 'product', 'discount', 'item', 'sku', 'deal',
  'promotion', 'saving', 'category', 'brand', 'quantity', 'unit',
  // Dansk
  'tilbud', 'vare', 'pris', 'rabat', 'produkt', 'kategori',
  'maerke', 'mærke', 'styk', 'enhed', 'spar', 'uge', 'avis',
  // JSON-nøgler der indikerer produktlister
  '"products"', '"items"', '"offers"', '"promotions"',
  '"catalog"', '"catalogue"', '"deals"', '"leaflet"', '"flyer"',
  '"pages"', '"hotspots"', '"spots"',
];

// Minimum body-størrelse i bytes – undgår at gemme trivielle ping/track-kald
const MIN_JSON_BYTES = 150;

// Ventetid (ms) efter scroll er færdigt
const POST_SCROLL_WAIT_MS = 8_000;

// ── Hjælpefunktioner ─────────────────────────────────────────────────────────

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`[info] Oprettede output-mappe: ${OUTPUT_DIR}`);
  }
}

function sanitize(name) {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

/** Tjekker om en JSON-streng indeholder mindst ét produkt-søgeord. */
function containsProductData(jsonStr) {
  const lower = jsonStr.toLowerCase();
  return PRODUCT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Forsøger at læse og parse en Playwright-response som JSON.
 * Returnerer { ok: true, data, raw } eller { ok: false }.
 */
async function tryParseJson(response) {
  try {
    const raw = await response.text();
    if (!raw || raw.length < MIN_JSON_BYTES) return { ok: false };
    const data = JSON.parse(raw);
    return { ok: true, data, raw };
  } catch {
    return { ok: false };
  }
}

/**
 * Gemmer JSON-payload til disk inklusive metadata.
 * Returnerer filnavnet.
 */
function saveJson(supermarketName, sourceUrl, data, raw) {
  const filename = `${sanitize(supermarketName)}_${Date.now()}.json`;
  const filepath = path.join(OUTPUT_DIR, filename);

  const payload = {
    _meta: {
      supermarket: supermarketName,
      sourceUrl,
      capturedAt: new Date().toISOString(),
    },
    data,
  };

  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');

  const topKeys = Array.isArray(data)
    ? [`Array[${data.length} elementer]`]
    : Object.keys(data).slice(0, 10);

  const sizeKb = (raw.length / 1024).toFixed(1);
  console.log(`  ✔ GEM  ${filename}  (${sizeKb} KB)`);
  console.log(`         nøgler: ${topKeys.join(', ')}`);

  return filename;
}

/**
 * Scroller langsomt ned til bunden af siden i små skridt,
 * så lazy-loaded indhold og netværkskald udløses undervejs.
 *
 * Kører to omgange: ét gennemløb nedad + pause + ét gennemløb nedad igen
 * (fanget dynamisk indhold der renderes efter første scroll).
 */
async function scrollToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const STEP = 300;          // pixels per trin
      const DELAY_MS = 250;      // ms mellem hvert trin
      let scrolled = 0;

      const tick = () => {
        window.scrollBy(0, STEP);
        scrolled += STEP;
        if (scrolled < document.body.scrollHeight) {
          setTimeout(tick, DELAY_MS);
        } else {
          resolve();
        }
      };
      setTimeout(tick, DELAY_MS);
    });
  });

  // Kort pause, derefter endnu et scroll-gennemløb for dynamisk indhold
  await page.waitForTimeout(2_000);

  await page.evaluate(async () => {
    await new Promise((resolve) => {
      window.scrollTo(0, 0);      // tilbage til toppen
      setTimeout(async () => {
        const STEP = 500;
        const DELAY_MS = 200;
        let scrolled = 0;
        const tick = () => {
          window.scrollBy(0, STEP);
          scrolled += STEP;
          if (scrolled < document.body.scrollHeight) {
            setTimeout(tick, DELAY_MS);
          } else {
            resolve();
          }
        };
        tick();
      }, 500);
    });
  });
}

// ── Hoved-logik per supermarked ──────────────────────────────────────────────

async function discoverSupermarket(browser, supermarket) {
  const label = supermarket.name.toUpperCase();
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`[${label}] Starter discovery  (${supermarket.urls.length} URL(er))`);

  // Hvert supermarked kører i sin egen browser-kontekst (rene cookies/cache)
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    locale: 'da-DK',
    extraHTTPHeaders: { 'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8' },
    // Viewport svarer til en almindelig desktop-browser
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // ── Opsaml responses asynkront ───────────────────────────────────────────
  // Vi kan ikke awaite inde i on('response'), så vi parkerer dem i en kø
  // og behandler dem bagefter.
  const responseQueue = [];

  page.on('response', (response) => {
    const ct = response.headers()['content-type'] || '';
    const status = response.status();
    if (ct.includes('application/json') && status >= 200 && status < 300) {
      responseQueue.push({ response, url: response.url() });
    }
  });

  // ── Besøg hver URL ───────────────────────────────────────────────────────
  let savedCount = 0;

  for (const url of supermarket.urls) {
    console.log(`\n  → Besøger: ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });

      const pageTitle = await page.title().catch(() => '(ingen titel)');
      console.log(`    Sidetitel: "${pageTitle}"`);

      console.log('    Scroller langsomt til bunden...');
      await scrollToBottom(page);

      console.log(`    Venter ${POST_SCROLL_WAIT_MS / 1000}s på lazy-loaded kald...`);
      await page.waitForTimeout(POST_SCROLL_WAIT_MS);

      console.log(`    Opsamlede ${responseQueue.length} JSON-responses indtil nu.`);

    } catch (err) {
      console.log(`  ✗ FEJL ved indlæsning af ${url}`);
      console.log(`    ${err.message.split('\n')[0]}`);
    }
  }

  // ── Analyser opsamlede responses ────────────────────────────────────────
  console.log(`\n  Analyserer ${responseQueue.length} JSON-responses...`);

  for (const { response, url: apiUrl } of responseQueue) {
    const parsed = await tryParseJson(response);
    if (!parsed.ok) continue;

    if (containsProductData(parsed.raw)) {
      const shortUrl = apiUrl.length > 80 ? apiUrl.substring(0, 80) + '…' : apiUrl;
      console.log(`  ✔ FUND  ${shortUrl}`);
      saveJson(supermarket.name, apiUrl, parsed.data, parsed.raw);
      savedCount++;
    }
  }

  if (savedCount === 0) {
    console.log(`  ℹ Ingen produkt-JSON fundet for ${supermarket.name}.`);
    console.log('    (Siden bruger måske server-side rendering eller kræver login.)');
  }

  console.log(`\n  Resultat: ${savedCount} fil(er) gemt for [${label}]`);

  await context.close();
  return savedCount;
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  ensureOutputDir();

  const SUPERMARKETS = buildSupermarkets();

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║       Supermarket API Discovery  –  Playwright Edition        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`Dato:       ${new Date().toLocaleDateString('da-DK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  console.log(`ISO-uge:    ${getISOWeek(new Date())}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);

  const browser = await chromium.launch({ headless: true });

  let totalSaved = 0;

  try {
    for (const supermarket of SUPERMARKETS) {
      const count = await discoverSupermarket(browser, supermarket);
      totalSaved += count;
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`FÆRDIG – ${totalSaved} produktfil(er) gemt i:`);
  console.log(`  ${OUTPUT_DIR}`);
  console.log('═'.repeat(65));
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
