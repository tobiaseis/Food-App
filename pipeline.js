/**
 * Supermarket Tilbud Pipeline
 *
 * 1. Finder PDF-URL for Netto, Rema 1000 og Føtex automatisk
 * 2. Downloader PDF'erne til ./pdfs/
 * 3. Sender PDF til Gemini/Claude Vision for at udtrække tilbudsdata
 * 4. Gemmer alle tilbud i en SQLite-database (offers.db)
 *
 * ── Opsætning ──────────────────────────────────────────────────────────────
 *   npm install
 *   npx playwright install chromium
 *
 * ── Kør med Gemini 2.5 Flash (standard) ───────────────────────────────────
 *   Hent gratis nøgle: https://aistudio.google.com/apikey
 *   $env:GEMINI_API_KEY="din_nøgle"; node pipeline.js
 *
 * ── Kør med Claude Sonnet 4.6 (~$0.20-0.40 per avis) ──────────────────────
 *   $env:MODEL="claude"; $env:ANTHROPIC_API_KEY="din_nøgle"; node pipeline.js
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Konfiguration ─────────────────────────────────────────────────────────────

const MODEL         = (process.env.MODEL || 'gemini').trim().toLowerCase(); // 'gemini' | 'claude'
const GEMINI_KEY    = process.env.GEMINI_API_KEY   || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PDF_DIR       = path.join(__dirname, 'pdfs');
const DB_PATH       = path.join(__dirname, 'offers.db');

// PDFs under denne grænse sendes som inline base64 til Gemini.
// Større filer uploades via Gemini Files API (ingen øvre grænse).
const GEMINI_INLINE_MB = 19;
// Claude-grænse: ~24 MB (32 MB base64-kodet)
const MAX_CLAUDE_PDF_MB = 23;

// ── Model-hjælpere ───────────────────────────────────────────────────────────

function getModelLabel() {
  if (MODEL === 'claude') return 'Claude Sonnet 4.6  (betalt ~$0.20-0.40/avis)';
  return 'Gemini 2.5 Flash   (gratis)';
}

// ── ISO-ugehjælpere (identisk logik som discover.js) ─────────────────────────

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
}

function getNextISOWeek(date) {
  const next = new Date(date);
  next.setDate(date.getDate() + 7);
  return getISOWeek(next);
}

function getFoetexAvisUrl() {
  const today = new Date();
  const cur   = getISOWeek(today);
  const nxt   = getNextISOWeek(today);
  const slug  = `${String(cur).padStart(2, '0')}${String(nxt).padStart(2, '0')}`;
  return `https://avis.foetex.dk/naeste-uges-avis/uge-${slug}/`;
}

// ── Database ──────────────────────────────────────────────────────────────────

function setupDatabase() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS offers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      supermarket     TEXT    NOT NULL,
      week            INTEGER NOT NULL,
      year            INTEGER NOT NULL,
      name            TEXT    NOT NULL,
      brand           TEXT,
      price           REAL,
      original_price  REAL,
      unit            TEXT,
      valid_from      TEXT,
      valid_to        TEXT,
      page_in_flyer   INTEGER,
      fetched_at      TEXT    NOT NULL,
      UNIQUE(supermarket, year, week, name)
    );

    CREATE INDEX IF NOT EXISTS idx_supermarket_week
      ON offers(supermarket, year, week);
  `);

  return db;
}

function storeOffers(db, rows) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO offers
      (supermarket, week, year, name, brand, price, original_price,
       unit, valid_from, valid_to, page_in_flyer, fetched_at)
    VALUES
      (@supermarket, @week, @year, @name, @brand, @price, @original_price,
       @unit, @valid_from, @valid_to, @page_in_flyer, @fetched_at)
  `);

  const upsertAll = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });

  upsertAll(rows);
}

// ── PDF-download ──────────────────────────────────────────────────────────────

async function downloadPdf(url, destPath) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':     'application/pdf,*/*',
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fra ${url}`);

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('pdf') && !url.toLowerCase().includes('pdf')) {
    // Advars, men forsøg alligevel at gemme
    console.log(`  ⚠ Uventet Content-Type: ${contentType}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const sizeMb = buf.length / 1024 / 1024;

  // Claude-grænse: ~23 MB. Gemini bruger Files API for større filer (ingen grænse).
  if (MODEL === 'claude' && sizeMb > MAX_CLAUDE_PDF_MB) {
    throw new Error(
      `PDF er ${sizeMb.toFixed(1)} MB – overskrider Claude-grænsen på ${MAX_CLAUDE_PDF_MB} MB.`
    );
  }

  fs.writeFileSync(destPath, buf);
  console.log(`  ✔ Gemt: ${path.basename(destPath)} (${sizeMb.toFixed(1)} MB)`);
}

// ── Gemini visuel klik-hjælper ────────────────────────────────────────────────

/**
 * Tager et screenshot af `page`, sender det til Gemini og beder den finde
 * et element beskrevet med `description`. Returnerer {x, y} pixelkoordinater
 * eller null hvis elementet ikke kan lokaliseres.
 */
async function geminiLocateElement(page, description) {
  if (!GEMINI_KEY) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const viewport   = page.viewportSize();

    const response = await ai.models.generateContent({
      model:    'gemini-2.5-flash',
      contents: [
        { inlineData: { mimeType: 'image/png', data: screenshot.toString('base64') } },
        { text:
          `Se på dette screenshot af en webside (${viewport.width}×${viewport.height} pixels).\n` +
          `Find: "${description}"\n` +
          `Svar KUN med et JSON-objekt: {"x": <pixel fra venstre>, "y": <pixel fra top>}\n` +
          `Koordinaterne skal pege på midten af elementet. Hvis elementet ikke er synligt, svar med: {"x": null, "y": null}`
        },
      ],
    });

    const text  = response.text;
    const match = text.match(/\{[^}]+\}/);
    if (!match) return null;
    const { x, y } = JSON.parse(match[0]);
    if (x == null || y == null) return null;
    return { x: Math.round(x), y: Math.round(y) };
  } catch (err) {
    console.log(`  ⚠ Gemini lokalisering fejlede: ${err.message.split('\n')[0]}`);
    return null;
  }
}

/**
 * Vælger den bedste tilgængelige visuelle lokalisator.
 * Bruger Gemini hvis GEMINI_KEY er sat, ellers null.
 */
async function locateElement(page, description) {
  if (GEMINI_KEY) return geminiLocateElement(page, description);
  return null;
}

// ── PDF-opdagelse: Rema 1000 via rema1000.dk/avis (Playwright) ───────────────

/**
 * Finder Rema 1000's tilbudsavis PDF via rema1000.dk/avis:
 *  1. Åbner rema1000.dk/avis og finder billedet for den aktuelle uge (f.eks. alt="Uge 15")
 *  2. Klikker billedet/kortet → navigerer til rema1000.dk/avis/<ID>/1
 *  3. Klikker knappen med aria-label="Handlinger"
 *  4. Klikker "Hent som PDF" i dropdown-menuen
 *  5. Opfanger PDF-download og returnerer URL'en
 */
async function findRema1000Pdf(week) {
  console.log('  Åbner browser → https://rema1000.dk/avis');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'da-DK',
    acceptDownloads: true,
  });

  const page = await context.newPage();
  let pdfUrl = null;

  // Opfang PDF via netværk (nogle viewers åbner PDF direkte)
  page.on('response', (response) => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (!pdfUrl && (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(url))) {
      pdfUrl = url;
      console.log(`  ✔ PDF opfanget (netværk): ${url.substring(0, 80)}`);
    }
  });
  context.on('page', async (newPage) => {
    newPage.on('response', (response) => {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!pdfUrl && (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(url))) {
        pdfUrl = url;
        console.log(`  ✔ PDF opfanget (ny fane): ${url.substring(0, 80)}`);
      }
    });
  });

  try {
    await page.goto('https://rema1000.dk/avis', {
      waitUntil: 'domcontentloaded',
      timeout: 40_000,
    });
    await page.waitForTimeout(4_000);

    // ① Find og klik billedet for den aktuelle uge
    console.log(`  ↳ Leder efter Uge ${week}-billedet...`);
    const weekAlt = `Uge ${week}`;

    const clickedWeek = await page.evaluate((alt) => {
      // Forsøg 1: direkte img[alt="Uge N"]
      const img = Array.from(document.querySelectorAll('img'))
        .find(i => i.alt && i.alt.trim().startsWith(alt));
      if (img) {
        const clickable = img.closest('a, button, [role="button"]') || img;
        clickable.click();
        return true;
      }
      // Forsøg 2: tekst der indeholder uge-nummeret
      const el = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .find(e => (e.textContent || '').includes(alt));
      if (el) { el.click(); return true; }
      return false;
    }, weekAlt);

    if (!clickedWeek) {
      console.log(`  ↳ DOM-klik fejlede – prøver Gemma visuel lokalisering...`);
      const coords = await locateElement(page, `billede eller kort med teksten "${weekAlt}"`);
      if (coords) {
        await page.mouse.click(coords.x, coords.y);
      } else {
        console.log(`  ⚠ Kunne ikke finde uge-billedet – hverken via DOM eller Gemma`);
        return null;
      }
    }

    console.log('  ↳ Uge-billede klikket – venter på avis-siden...');
    await page.waitForTimeout(4_000);

    if (pdfUrl) { await browser.close(); return pdfUrl; }

    // ② Klik "Handlinger"-knappen
    console.log('  ↳ Leder efter "Handlinger"-knap...');
    let handlingerFound = false;
    try {
      await page.waitForSelector('button[aria-label="Handlinger"]', { timeout: 10_000 });
      handlingerFound = true;
    } catch {
      console.log('  ↳ "Handlinger"-knap ikke fundet via selector – prøver Gemma...');
    }

    if (handlingerFound) {
      await page.evaluate(() => {
        document.querySelector('button[aria-label="Handlinger"]').click();
      });
    } else {
      const coords = await locateElement(page, '"Handlinger" knap (tre prikker eller actions-menu)');
      if (coords) {
        await page.mouse.click(coords.x, coords.y);
      } else {
        console.log('  ⚠ "Handlinger"-knap ikke fundet');
        return null;
      }
    }

    await page.waitForTimeout(1_500);

    // ③ Klik "Hent som PDF" i dropdown-menuen
    console.log('  ↳ Klikker "Hent som PDF"...');
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        page.evaluate(() => {
          const link = Array.from(document.querySelectorAll('a, [role="menuitem"]'))
            .find(el => (el.textContent || '').trim().includes('Hent som PDF'));
          if (link) { link.click(); return true; }
          return false;
        }),
      ]);
      pdfUrl = download.url();
      console.log(`  ✔ PDF via download-event: ${pdfUrl.substring(0, 80)}`);
    } catch {
      // Ikke et download-event – prøv at fange via netværk
      await page.waitForTimeout(6_000);
    }

    if (!pdfUrl) {
      // Sidst: forsøg at finde link direkte i DOM
      pdfUrl = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href]'))
          .find(el => /\.pdf(\?|$)/i.test(el.href));
        return a?.href || null;
      });
      if (pdfUrl) console.log(`  ✔ PDF fundet i DOM: ${pdfUrl.substring(0, 80)}`);
    }

  } catch (err) {
    console.log(`  ⚠ Browser-fejl: ${err.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }

  if (!pdfUrl) console.log('  ✗ Ingen PDF-URL fundet for Rema 1000');
  return pdfUrl;
}

// ── PDF-opdagelse: Netto via Tjek.com viewer (Playwright) ────────────────────

/**
 * Netto bruger Tjek.com's viewer på netto.dk/netto-avisen/:
 *  1. Siden viser en liste af ugeknapper med billeder fra image-transformer-api.tjek.com
 *  2. Vi klikker den første (aktuelle) knap
 *  3. Vieweren åbner – vi klikker "Download leaflet"-knappen
 *  4. Vi opfanger download-eventet og returnerer PDF-URL'en
 */
async function findNettoPdf() {
  console.log('  Åbner browser → https://netto.dk/netto-avisen/');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'da-DK',
    acceptDownloads: true,
  });

  const page = await context.newPage();
  let pdfUrl = null;

  // S3 pre-signerede URL'er har ikke .pdf i sig – match på domænet i stedet
  const isTjekS3 = (url) => url.includes('sgn-prd-assets.s3') || url.includes('sgn-prd-assets.s3.eu-west');
  const isPdf    = (url, ct) =>
    ct.includes('application/pdf') ||
    /\.pdf(\?|$)/i.test(url)       ||
    isTjekS3(url);

  // Lyt på netværkssvar – opfang S3-URL'en så snart browseren rammer den
  page.on('response', (response) => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (!pdfUrl && isPdf(url, ct)) {
      pdfUrl = url;
      console.log(`  ✔ PDF opfanget (netværk): ${url.substring(0, 80)}`);
    }
  });

  // Opfang S3-URL hvis download-knappen åbner en ny fane
  context.on('page', async (newPage) => {
    const url = newPage.url();
    if (!pdfUrl && isTjekS3(url)) {
      pdfUrl = url;
      console.log(`  ✔ PDF opfanget (ny fane): ${url.substring(0, 80)}`);
    }
    // Lyt også på responses i den nye fane
    newPage.on('response', (response) => {
      const u  = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!pdfUrl && isPdf(u, ct)) {
        pdfUrl = u;
        console.log(`  ✔ PDF opfanget (ny fane, netværk): ${u.substring(0, 80)}`);
      }
    });
  });

  try {
    await page.goto('https://netto.dk/netto-avisen/', {
      waitUntil: 'domcontentloaded',
      timeout: 40_000,
    });
    // Vent på at React/JS-komponenter er renderet
    await page.waitForTimeout(4_000);

    // ① Vent på at ugeknapperne renderes, og klik via JS (bypasser scroll/viewport-check)
    console.log('  ↳ Venter på avisknapper...');
    try {
      await page.waitForSelector('button:has(img[src*="image-transformer-api.tjek.com"])', {
        timeout: 15_000,
      });
    } catch {
      console.log('  ⚠ Fandt ingen ugeknapper på netto.dk/netto-avisen/');
      return null;
    }

    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.querySelector('img[src*="image-transformer-api.tjek.com"]'));
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    });

    if (!clicked) {
      // Fallback: bed Gemini om at finde knappen visuelt
      console.log('  ↳ JS-klik fejlede – prøver Gemini visuel lokalisering...');
      const coords = await locateElement(page, 'tilbudsavis / ugeavis knap med billedet af avisforsiden');
      if (coords) {
        console.log(`  ↳ Gemini fandt knap på (${coords.x}, ${coords.y}) – klikker...`);
        await page.mouse.click(coords.x, coords.y);
      } else {
        console.log('  ⚠ Avisknap ikke fundet – hverken via DOM eller Gemini');
        return null;
      }
    }
    console.log('  ↳ Avisknap klikket – venter på viewer...');
    await page.waitForTimeout(4_000);

    if (pdfUrl) {
      await browser.close();
      return pdfUrl;
    }

    // ② Vent på "Download leaflet"-knappen og klik den via JS
    let downloadBtnFound = false;
    try {
      await page.waitForSelector('button[aria-label="Download leaflet"]', { timeout: 15_000 });
      downloadBtnFound = true;
    } catch {
      console.log('  ⚠ "Download leaflet"-knap ikke fundet via selector – prøver Gemini...');
    }

    // Fallback: Gemini finder download-knappen visuelt
    if (!downloadBtnFound) {
      const coords = await locateElement(page, 'Download leaflet knap (download-ikon)');
      if (coords) {
        console.log(`  ↳ Gemini fandt download-knap på (${coords.x}, ${coords.y}) – klikker...`);
        try {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 12_000 }),
            page.mouse.click(coords.x, coords.y),
          ]);
          pdfUrl = download.url();
          console.log(`  ✔ PDF via Gemini + download-event: ${pdfUrl.substring(0, 80)}`);
        } catch {
          await page.waitForTimeout(5_000);
        }
      }
    } else {
      console.log('  ↳ Klikker "Download leaflet"...');
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15_000 }),
          page.evaluate(() => {
            const btn = document.querySelector('button[aria-label="Download leaflet"]');
            if (btn) btn.click();
          }),
        ]);
        pdfUrl = download.url();
        console.log(`  ✔ PDF via download-event: ${pdfUrl.substring(0, 80)}`);
      } catch {
        // Ikke et download-event – URL fanges via netværk/ny-fane listener ovenfor
        await page.waitForTimeout(5_000);
      }
    }

  } catch (err) {
    console.log(`  ⚠ Browser-fejl: ${err.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }

  if (!pdfUrl) console.log('  ✗ Ingen PDF-URL fundet for Netto');
  return pdfUrl;
}

// ── PDF-opdagelse: iPaper-aviser (Føtex) via Playwright ──────────────────────

/**
 * Besøger en iPaper-baseret avis-URL med en rigtig browser.
 *
 * Strategi (i prioriteret rækkefølge):
 *  1. Opfang direkte PDF-netværkskald (Content-Type: application/pdf)
 *  2. Find <a href="…pdf…"> eller download-knapper i DOM
 *  3. Klik på download-knap og opfang Download-event
 */
async function findIpaperPdf(pageUrl, label) {
  console.log(`  Åbner browser → ${pageUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'da-DK',
    acceptDownloads: true,
  });

  const page = await context.newPage();
  let pdfUrl = null;
  const candidateUrls = [];

  // ① Lyt på ALLE netværkskald – opfang PDF + iPaper/iframe-URLs
  page.on('response', (response) => {
    const ct  = response.headers()['content-type'] || '';
    const url = response.url();
    if (!pdfUrl && (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(url))) {
      pdfUrl = url;
      console.log(`  ✔ PDF opfanget (netværk): ${url.substring(0, 80)}`);
    }
    // Gem iPaper/viewer API-kald der kan indeholde publication-ID
    if (/ipaper|viewer|publication|catalog|flyer/i.test(url) && !url.includes('analytics')) {
      candidateUrls.push(url);
    }
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(5_000); // Vent på JavaScript-rendering

    // ② Søg i DOM: PDF-links, iframes, script-tags med JSON-data
    if (!pdfUrl) {
      pdfUrl = await page.evaluate(() => {
        // Direkte PDF-link
        const pdfAnchor = Array.from(document.querySelectorAll('a[href]'))
          .find(a => /\.pdf(\?|$)/i.test(a.href));
        if (pdfAnchor) return pdfAnchor.href;

        // iframe der peger på en avis-viewer
        const iframe = Array.from(document.querySelectorAll('iframe[src]'))
          .find(f => /ipaper|viewer|avis|flyer|catalog/i.test(f.src));
        if (iframe) return iframe.src; // returnerer viewer-URL til videre behandling

        // Knap/link med download-relateret tekst
        const dlElement = Array.from(document.querySelectorAll('a, button, [role="button"]'))
          .find(el => {
            const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
            return text.includes('download') || text.includes('pdf') || text.includes('hent');
          });
        if (dlElement) return dlElement.href || dlElement.getAttribute('data-url') || null;

        // JSON i script-tags der indeholder pdf-URL
        for (const script of document.querySelectorAll('script:not([src])')) {
          const m = script.textContent.match(/"(https?:[^"]+\.pdf[^"]*)"/i);
          if (m) return m[1];
          // iPaper publication pattern
          const p = script.textContent.match(/publication[_-]?(?:id|url)['":\s]+['"]([^'"]+)['"]/i);
          if (p) return p[1];
        }

        return null;
      });

      if (pdfUrl) console.log(`  ✔ PDF/viewer fundet i DOM: ${pdfUrl.substring(0, 80)}`);
    }

    // ③ Hvis vi fandt en iframe-viewer-URL, gå ind i den og søg efter PDF der
    if (pdfUrl && /ipaper|viewer|avis|flyer/i.test(pdfUrl) && !/\.pdf/i.test(pdfUrl)) {
      console.log(`  ↳ Følger viewer-URL efter PDF...`);
      const viewerUrl = pdfUrl;
      pdfUrl = null;

      const iframePage = await context.newPage();
      iframePage.on('response', (response) => {
        const ct  = response.headers()['content-type'] || '';
        const url = response.url();
        if (!pdfUrl && (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(url))) {
          pdfUrl = url;
          console.log(`  ✔ PDF opfanget i viewer (netværk): ${url.substring(0, 80)}`);
        }
      });

      await iframePage.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await iframePage.waitForTimeout(5_000);

      if (!pdfUrl) {
        pdfUrl = await iframePage.evaluate(() => {
          const a = Array.from(document.querySelectorAll('a[href]'))
            .find(el => /\.pdf(\?|$)/i.test(el.href));
          return a?.href || null;
        });
        if (pdfUrl) console.log(`  ✔ PDF fundet i viewer-DOM: ${pdfUrl.substring(0, 80)}`);
      }
      await iframePage.close();
    }

    // ④ Prøv at klikke download-knap og opfang browser-download
    if (!pdfUrl) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 8_000 }),
          page.click(
            'a[href*=".pdf"], button:has-text("Download"), a:has-text("Download"), ' +
            'button:has-text("PDF"), a:has-text("PDF"), button:has-text("Hent"), ' +
            '[aria-label*="download" i], [aria-label*="pdf" i], [title*="download" i]',
            { timeout: 5_000 }
          ),
        ]);
        pdfUrl = download.url();
        console.log(`  ✔ PDF via download-klik: ${pdfUrl.substring(0, 80)}`);
      } catch {
        // Ingen download-event
      }
    }

    // ⑤ Vent lidt mere og prøv igen
    if (!pdfUrl) {
      await page.waitForTimeout(5_000);
      pdfUrl = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href]'))
          .find(el => /\.pdf(\?|$)/i.test(el.href));
        return a?.href || null;
      });
      if (pdfUrl) console.log(`  ✔ PDF fundet efter ekstra vent: ${pdfUrl.substring(0, 80)}`);
    }

    // ⑥ Debug: log interessante netværkskald der blev opfanget
    if (!pdfUrl && candidateUrls.length > 0) {
      console.log('  ℹ Mulige viewer-API-kald opfanget (til debugging):');
      candidateUrls.slice(0, 5).forEach(u => console.log(`    ${u.substring(0, 100)}`));
    }

  } catch (err) {
    console.log(`  ⚠ Browser-fejl: ${err.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }

  if (!pdfUrl) {
    console.log(`  ✗ Ingen PDF-URL fundet for ${label}`);
    console.log('    Tip: Kør med headless:false for at se hvad browseren ser.');
  }

  return pdfUrl;
}

// ── AI-prompt ─────────────────────────────────────────────────────────────────

function buildPrompt(supermarket, week, year) {
  return `
Du er en assistent der udtrækker tilbudsdata fra danske supermarked tilbudsaviser.

Analyser denne PDF fra ${supermarket.toUpperCase()} tilbudsavis (uge ${week}, år ${year}).

Udtræk ALLE produkter med tilbudspriser fra ALLE sider og returner et JSON-array.

Hvert element i arrayet skal have præcis disse felter (brug null hvis værdien ikke fremgår):
{
  "name":           "Fuld produktnavn inkl. størrelse og variant – f.eks. 'Arla Kærgården smør 200g'",
  "brand":          "Mærke/brand – f.eks. 'Arla' – eller null",
  "price":          24.95,
  "original_price": null,
  "unit":           "Enhed – f.eks. 'stk', '200g', '2-pak', 'pr. kg' – eller null",
  "valid_from":     "YYYY-MM-DD eller null",
  "valid_to":       "YYYY-MM-DD eller null",
  "page":           1
}

Regler:
- Inkluder KUN produkter med en synlig pris
- price skal være et tal (DKK), ikke en streng
- Svar KUN med et rent JSON-array – ingen markdown, ingen kodeblok, ingen forklaring
`.trim();
}

// ── AI-ekstraktion: Gemini 2.5 Flash ─────────────────────────────────────────

const GEMINI_VISION_PROMPT =
  'Du er en data-ekstraktor. Kig på dette billede fra en dansk tilbudsavis. ' +
  'Find alle varer og returnér KUN et validt JSON-array med objekter på præcis dette format: ' +
  '[{ "navn": "Produktets navn", "pris": 25.50, "maengde": "F.eks. 400g eller 1 stk" }]. ' +
  'Inkluder kun produkter med en synlig pris. Skriv INTET andet end JSON-arrayet.';

// Maks sider pr. chunk når vi splitter store PDFs.
// 4 sider à ~2.4 MB = ~10 MB pr. chunk – godt under Geminis 20 MB inline-grænse.
const CHUNK_PAGES = 4;
// Pause mellem chunk-kald for at undgå rate-limit
const CHUNK_DELAY_MS = 15_000;

/**
 * Splitter en PDF-buffer op i chunks à max CHUNK_PAGES sider.
 * Returnerer array af Buffer (én pr. chunk).
 */
async function splitPdfIntoChunks(pdfBuffer) {
  const { PDFDocument } = require('pdf-lib');
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();
  const chunks = [];

  for (let start = 0; start < totalPages; start += CHUNK_PAGES) {
    const end = Math.min(start + CHUNK_PAGES, totalPages);
    const chunkDoc = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const copiedPages = await chunkDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => chunkDoc.addPage(p));
    const chunkBytes = await chunkDoc.save();
    chunks.push(Buffer.from(chunkBytes));
  }

  return chunks;
}

/**
 * Sender ét Gemini-kald med en inline base64-PDF og returnerer parsed JSON-array.
 * Prøver op til 5 gange med eksponentiel backoff ved 429/503.
 */
async function callGeminiWithChunk(ai, base64Data) {
  const contents = [
    { inlineData: { mimeType: 'application/pdf', data: base64Data } },
    GEMINI_VISION_PROMPT,
  ];

  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model:   'gemini-2.5-flash',
        contents,
        config:  { responseMimeType: 'application/json' },
      });
      const text = response.text.trim();
      // Gem råt svar – parser håndterer tom eller ugyldig JSON
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      const isRetryable = err.message && (err.message.includes('429') || err.message.includes('503'));
      if (!isRetryable || attempt === 5) throw err;
      const waitSec = 30 * Math.pow(2, attempt - 1); // 30s → 60s → 120s → 240s
      console.log(`  ↳ API fejl (forsøg ${attempt}/5) – venter ${waitSec}s...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }
  throw lastErr;
}

/**
 * Sender en PDF til Gemini Vision og returnerer råt JSON-svar (samlet array).
 *
 * Bruger udelukkende inlineData (ingen Files API).
 * Store PDFs splittes i chunks à max CHUNK_PAGES sider, der sendes enkeltvis.
 */
async function extractWithGemini(pdfPath) {
  if (!GEMINI_KEY) {
    throw new Error(
      'GEMINI_API_KEY mangler. Hent gratis nøgle: https://aistudio.google.com/apikey\n' +
      'Kør: $env:GEMINI_API_KEY="din_nøgle"; node pipeline.js'
    );
  }

  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

  const pdfBuffer = fs.readFileSync(pdfPath);
  const sizeMb    = pdfBuffer.length / 1024 / 1024;

  let chunks;
  if (sizeMb <= GEMINI_INLINE_MB) {
    // Lille PDF: ét enkelt chunk
    chunks = [pdfBuffer];
  } else {
    // Stor PDF: split i sider-chunks
    console.log(`  ↳ PDF (${sizeMb.toFixed(1)} MB) – splitter i chunks à ${CHUNK_PAGES} sider...`);
    chunks = await splitPdfIntoChunks(pdfBuffer);
    console.log(`  ↳ ${chunks.length} chunks oprettet`);
  }

  const allOffers = [];

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      console.log(`  ↳ Sender chunk ${i + 1}/${chunks.length}...`);
    }

    const base64Data = chunks[i].toString('base64');
    const offers = await callGeminiWithChunk(ai, base64Data);

    if (Array.isArray(offers)) {
      allOffers.push(...offers);
    }

    // Vent mellem kald for at undgå rate-limit (spring over efter sidste chunk)
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
    }
  }

  return JSON.stringify(allOffers);
}

// ── AI-ekstraktion: Claude Sonnet 4.6 (~$0.20-0.40 per avis) ─────────────────

async function extractWithClaude(pdfBase64, supermarket, week, year) {
  if (!ANTHROPIC_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY mangler.\n' +
      'Kør: MODEL=claude ANTHROPIC_API_KEY=din_nøgle node pipeline.js'
    );
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role:    'user',
      content: [
        {
          type:   'document',
          source: {
            type:       'base64',
            media_type: 'application/pdf',
            data:        pdfBase64,
          },
        },
        {
          type: 'text',
          text: buildPrompt(supermarket, week, year),
        },
      ],
    }],
  });

  return response.content[0].text;
}


// ── Parse AI-svar til array ───────────────────────────────────────────────────

function parseAiJson(rawText) {
  // Fjern eventuelle markdown-fences som AI'en måske returnerede
  const cleaned = rawText
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im,     '')
    .replace(/\s*```$/m,      '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.offers)) return parsed.offers;
    throw new Error('AI returnerede hverken et JSON-array eller {"offers": [...]}');
  } catch {
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsedArray = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsedArray)) return parsedArray;
      } catch {
        // Prøv næste fallback.
      }
    }

    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsedObject = JSON.parse(objectMatch[0]);
        if (Array.isArray(parsedObject?.offers)) return parsedObject.offers;
      } catch {
        // Ingen flere fallbacks.
      }
    }

    throw new Error('Kunne ikke parse AI-svar som gyldig JSON med tilbuds-array');
  }
}

// ── Hoved-pipeline per supermarked ───────────────────────────────────────────

async function processSupermarket(db, config, week, year) {
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`[${config.name.toUpperCase()}]  uge ${week} / ${year}`);
  console.log('─'.repeat(65));

  // 1. Check om PDF allerede er hentet denne uge – spring scraping over hvis ja
  const filename = `${config.name}_uge${week}_${year}.pdf`;
  const pdfPath  = path.join(PDF_DIR, filename);

  // 1b. Check om tilbud allerede er udtrukket denne uge – spring alt over hvis ja
  const existing = db.prepare(
    'SELECT COUNT(*) AS cnt FROM offers WHERE supermarket = ? AND week = ? AND year = ?'
  ).get(config.name, week, year);
  if (existing.cnt > 0) {
    console.log(`  Allerede i database (${existing.cnt} tilbud) – springer over`);
    return existing.cnt;
  }

  if (fs.existsSync(pdfPath)) {
    const sizeMb = fs.statSync(pdfPath).size / 1024 / 1024;
    console.log(`  PDF allerede hentet: ${filename} (${sizeMb.toFixed(1)} MB) – springer scraping over`);
  } else {
    // 2. Find PDF-URL via browser/API
    let pdfUrl;
    try {
      pdfUrl = await config.findPdf(week, year);
    } catch (err) {
      console.log(`  ✗ PDF-søgning fejlede: ${err.message}`);
      return 0;
    }
    if (!pdfUrl) return 0;

    // 3. Download PDF
    console.log(`  Downloader PDF...`);
    try {
      await downloadPdf(pdfUrl, pdfPath);
    } catch (err) {
      console.log(`  ✗ Download fejlede: ${err.message}`);
      return 0;
    }
  }

  // 3. Udtræk tilbud med AI
  const aiProvider = MODEL === 'claude' ? 'Claude Sonnet 4.6' : 'Gemini 2.5 Flash';
  console.log(`  Sender PDF til AI (${aiProvider})...`);
  let offers;
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const rawText   = MODEL === 'claude'
      ? await extractWithClaude(pdfBuffer.toString('base64'), config.name, week, year)
      : await extractWithGemini(pdfPath);

    offers = parseAiJson(rawText);
    console.log(`  AI udtrakte ${offers.length} produkter`);
  } catch (err) {
    console.log(`  ✗ AI-udtræk fejlede: ${err.message}`);
    return 0;
  }

  // 4. Normaliser og gem i database
  // Understøtter både danske feltnavne fra Gemini (navn/pris/maengde)
  // og engelske feltnavne fra Claude (name/price/unit).
  const fetchedAt = new Date().toISOString();
  const rows = offers
    .filter(o => (o.navn || o.name) && String(o.navn ?? o.name).trim())
    .map(o => {
      const price = o.pris ?? o.price;
      return {
        supermarket:    config.name,
        week,
        year,
        name:           String(o.navn ?? o.name).trim().substring(0, 255),
        brand:          o.brand != null ? String(o.brand).trim() : null,
        price:          typeof price === 'number' ? price : null,
        original_price: typeof o.original_price === 'number' ? o.original_price : null,
        unit:           (o.maengde ?? o.unit) != null ? String(o.maengde ?? o.unit).trim() : null,
        valid_from:     o.valid_from != null ? String(o.valid_from) : null,
        valid_to:       o.valid_to   != null ? String(o.valid_to)   : null,
        page_in_flyer:  typeof o.page === 'number' ? o.page : null,
        fetched_at:     fetchedAt,
      };
    });

  storeOffers(db, rows);
  console.log(`  ✔ ${rows.length} tilbud gemt i databasen`);

  // Vis de 5 første som preview
  if (rows.length > 0) {
    console.log('\n  Preview:');
    rows.slice(0, 5).forEach(r => {
      const price = r.price != null ? `${r.price} kr` : '(pris ukendt)';
      const unit  = r.unit  ? ` / ${r.unit}` : '';
      console.log(`  • ${r.name.substring(0, 55).padEnd(55)}  ${price}${unit}`);
    });
    if (rows.length > 5) console.log(`    … og ${rows.length - 5} tilbud mere`);
  }

  return rows.length;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (!['gemini', 'claude'].includes(MODEL)) {
    throw new Error(`Ukendt MODEL="${MODEL}". Brug: gemini (standard) eller claude.`);
  }

  const today = new Date();
  const week  = getISOWeek(today);
  const year  = today.getFullYear();

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Supermarket Tilbud Pipeline  –  PDF + AI              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`Model:      ${getModelLabel()}`);
  console.log(`ISO-uge:    ${week} / ${year}`);
  console.log(`Database:   ${DB_PATH}`);
  console.log(`PDF-mappe:  ${PDF_DIR}`);

  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
  const db = setupDatabase();

  const supermarkets = [
    {
      name:    'netto',
      findPdf: async () => findNettoPdf(),
    },
    {
      name:    'rema1000',
      findPdf: async (w) => findRema1000Pdf(w),
    },
    {
      name:    'foetex',
      findPdf: async () => {
        const url = getFoetexAvisUrl();
        console.log(`  Dynamisk Føtex-URL: ${url}`);
        return findIpaperPdf(url, 'Føtex');
      },
    },
  ];

  let totalSaved = 0;
  for (const sm of supermarkets) {
    totalSaved += await processSupermarket(db, sm, week, year);
  }

  db.close();

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`FÆRDIG – ${totalSaved} tilbud gemt i: ${DB_PATH}`);
  console.log('\nHurtige forespørgsler:');
  console.log('  sqlite3 offers.db "SELECT supermarket, COUNT(*) as antal FROM offers GROUP BY supermarket;"');
  console.log('  sqlite3 offers.db "SELECT name, price, unit FROM offers WHERE supermarket=\'rema1000\' AND price IS NOT NULL ORDER BY price LIMIT 20;"');
  console.log('  sqlite3 offers.db "SELECT name, price FROM offers WHERE price < 20 ORDER BY price;"');
  console.log('═'.repeat(65));
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
