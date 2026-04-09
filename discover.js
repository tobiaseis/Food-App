/**
 * Supermarket API Discovery Script
 *
 * Besøger danske supermarkeders online tilbudsaviser og opsnapper
 * skjulte JSON-API-kald med produkt- og prisdata.
 *
 * Kør:  node discover.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── Konfiguration ────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, 'intercepted_data');

/**
 * Supermarkeder med navn, URL til tilbudsavis og eventuelle
 * ekstra URL'er der er værd at besøge (f.eks. direkte avis-link).
 */
const SUPERMARKETS = [
  {
    name: 'netto',
    urls: [
      'https://www.netto.dk/tilbud',
      'https://www.netto.dk/tilbud/tilbudsavis',
    ],
  },
  {
    name: 'foetex',
    urls: [
      'https://www.foetex.dk/tilbud',
      'https://www.foetex.dk/tilbud/tilbudsavis',
    ],
  },
  {
    name: 'rema1000',
    urls: [
      'https://www.rema1000.dk/ugens-tilbud',
      'https://www.rema1000.dk/tilbud',
    ],
  },
];

/**
 * Søgeord der indikerer, at en JSON-respons indeholder produkt/pris-data.
 * Tjekkes på tværs af hele den serialiserede JSON-streng (case-insensitive).
 */
const PRODUCT_KEYWORDS = [
  // Engelsk
  'price', 'offer', 'product', 'discount', 'item', 'sku', 'deal',
  'promotion', 'saving', 'category', 'brand', 'quantity', 'unit',
  // Dansk
  'tilbud', 'vare', 'pris', 'rabat', 'produkt', 'kategori', 'maerke',
  'mærke', 'styk', 'enhed', 'spar', 'uge', 'avis',
  // Strukturelle nøgler der peger på produktlister
  '"products"', '"items"', '"offers"', '"promotions"', '"catalog"',
  '"catalogue"', '"deals"', '"leaflet"', '"flyer"',
];

// Minimum JSON-størrelse (bytes) for at undgå at gemme trivielle svar
const MIN_JSON_SIZE = 100;

// Ventetid (ms) på siden, mens vi scroller
const PAGE_WAIT_MS = 10_000;

// ── Hjælpefunktioner ─────────────────────────────────────────────────────────

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`[info] Oprettede mappe: ${OUTPUT_DIR}`);
  }
}

function timestamp() {
  return Date.now();
}

function sanitizeName(name) {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

/**
 * Returnerer true hvis den serialiserede JSON indeholder mindst ét søgeord.
 */
function containsProductData(jsonString) {
  const lower = jsonString.toLowerCase();
  return PRODUCT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Forsøger at parse en response-body som JSON.
 * Returnerer { ok: true, data, raw } eller { ok: false }.
 */
async function tryParseJson(response) {
  try {
    const raw = await response.text();
    if (!raw || raw.length < MIN_JSON_SIZE) return { ok: false };
    const data = JSON.parse(raw);
    return { ok: true, data, raw };
  } catch {
    return { ok: false };
  }
}

/**
 * Gemmer JSON-data til disk og logger fundne nøgler.
 */
function saveJson(supermarketName, url, data, raw) {
  const ts = timestamp();
  const filename = `${sanitizeName(supermarketName)}_${ts}.json`;
  const filepath = path.join(OUTPUT_DIR, filename);

  const payload = {
    _meta: {
      supermarket: supermarketName,
      sourceUrl: url,
      capturedAt: new Date().toISOString(),
    },
    data,
  };

  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');

  // Vis en kort oversigt over toplevel-nøgler
  const keys = Array.isArray(data)
    ? [`Array[${data.length}]`]
    : Object.keys(data).slice(0, 8);

  console.log(`  [gem] ${filename}  (${(raw.length / 1024).toFixed(1)} KB)`);
  console.log(`        nøgler: ${keys.join(', ')}`);
}

/**
 * Scroller langsomt ned på siden for at udløse lazy-loaded kald.
 */
async function scrollPage(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let scrolled = 0;
      const step = 400;
      const delay = 300;
      const interval = setInterval(() => {
        window.scrollBy(0, step);
        scrolled += step;
        if (scrolled >= document.body.scrollHeight) {
          clearInterval(interval);
          resolve();
        }
      }, delay);
    });
  });
}

// ── Hoved-logik ──────────────────────────────────────────────────────────────

async function discoverSupermarket(browser, supermarket) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${supermarket.name.toUpperCase()}] Starter discovery...`);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    locale: 'da-DK',
    extraHTTPHeaders: {
      'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
    },
  });

  const page = await context.newPage();

  // Opsaml responses her, da vi ikke kan kalde async-kode direkte i on('response')
  const capturedResponses = [];

  page.on('response', (response) => {
    const contentType = response.headers()['content-type'] || '';
    const status = response.status();

    if (
      contentType.includes('application/json') &&
      status >= 200 &&
      status < 300
    ) {
      capturedResponses.push({ response, url: response.url() });
    }
  });

  let foundCount = 0;

  for (const url of supermarket.urls) {
    console.log(`\n  [url] ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      // Scroll for at udløse lazy-loading
      await scrollPage(page);

      // Vent på yderligere netværkskald
      console.log(`  [vent] ${PAGE_WAIT_MS / 1000}s på lazy-loaded kald...`);
      await page.waitForTimeout(PAGE_WAIT_MS);

    } catch (err) {
      console.log(`  [fejl] Kunne ikke indlæse ${url}: ${err.message}`);
    }
  }

  // Behandl alle opsamlede responses
  console.log(`\n  [analyse] Behandler ${capturedResponses.length} JSON-responses...`);

  for (const { response, url } of capturedResponses) {
    const parsed = await tryParseJson(response);
    if (!parsed.ok) continue;

    if (containsProductData(parsed.raw)) {
      console.log(`  [fund] Produkt-data fundet: ${url.substring(0, 90)}...`);
      saveJson(supermarket.name, url, parsed.data, parsed.raw);
      foundCount++;
    }
  }

  console.log(`\n  [resultat] ${foundCount} produktfil(er) gemt for ${supermarket.name}`);

  await context.close();
  return foundCount;
}

async function main() {
  ensureOutputDir();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Supermarket API Discovery  –  Playwright Edition     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Gemmer data i: ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({
    headless: true,
  });

  let totalFound = 0;

  try {
    for (const supermarket of SUPERMARKETS) {
      const count = await discoverSupermarket(browser, supermarket);
      totalFound += count;
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`FÆRDIG – ${totalFound} produktfil(er) gemt i ${OUTPUT_DIR}`);
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
