/**
 * Supermarket Tilbud Pipeline
 *
 * 1. Finder PDF-URL for Netto, Rema 1000 og Føtex automatisk
 * 2. Downloader PDF'erne til ./pdfs/
 * 3. Sender PDF til AI for at udtrække navn, pris og mængde per tilbud
 * 4. Gemmer alle tilbud i en SQLite-database (offers.db)
 *
 * ── Opsætning ──────────────────────────────────────────────────────────────
 *   npm install
 *   npx playwright install chromium
 *
 * ── Kør med Gemini 2.0 Flash (GRATIS) ─────────────────────────────────────
 *   Hent gratis nøgle: https://aistudio.google.com/apikey
 *   GEMINI_API_KEY=din_nøgle node pipeline.js
 *
 * ── Kør med Claude Sonnet 4.6 (~$0.20-0.40 per avis) ──────────────────────
 *   MODEL=claude ANTHROPIC_API_KEY=din_nøgle node pipeline.js
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Konfiguration ─────────────────────────────────────────────────────────────

const MODEL         = process.env.MODEL || 'gemini'; // 'gemini' | 'claude'
const GEMINI_KEY    = process.env.GEMINI_API_KEY  || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PDF_DIR       = path.join(__dirname, 'pdfs');
const DB_PATH       = path.join(__dirname, 'offers.db');

// Rema 1000's faste dealer-ID på Tjek.com – ændrer sig ikke
const REMA_DEALER_ID = '11deC';

// Max PDF-størrelse der sendes inline til AI (i MB).
// Gemini-grænse: 20 MB. Claude-grænse: ~24 MB (32 MB base64-kodet).
const MAX_PDF_MB = 19;

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

  if (sizeMb > MAX_PDF_MB) {
    throw new Error(
      `PDF er ${sizeMb.toFixed(1)} MB – overskrider ${MAX_PDF_MB} MB AI-grænsen. ` +
      `Overvej at splitte filen i sider.`
    );
  }

  fs.writeFileSync(destPath, buf);
  console.log(`  ✔ Gemt: ${path.basename(destPath)} (${sizeMb.toFixed(1)} MB)`);
}

// ── PDF-opdagelse: Rema 1000 via Tjek.com (ingen browser nødvendig) ──────────

async function findRema1000Pdf(week) {
  console.log('  Kalder Tjek.com catalog-API...');
  const apiUrl = `https://squid-api.tjek.com/v2/catalogs?dealer_id=${REMA_DEALER_ID}&order_by=-publication_date&offset=0&limit=5`;
  const res = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tjek.com API: HTTP ${res.status}`);

  const catalogs = await res.json();
  const now = Date.now();

  // Foretrær det aktive katalog – ellers det nyeste
  const active = catalogs.find((c) => {
    const from = new Date(c.run_from).getTime();
    const till = new Date(c.run_till).getTime();
    return now >= from && now <= till;
  }) || catalogs[0];

  if (!active) throw new Error('Ingen Rema 1000 katalog fundet på Tjek.com');

  console.log(`  Katalog: "${active.label}"  (${active.offer_count} tilbud, ${active.page_count} sider)`);
  console.log(`  PDF-URL: ${active.pdf_url}`);
  return active.pdf_url;
}

// ── PDF-opdagelse: iPaper-aviser (Netto / Føtex) via Playwright ───────────────

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

  // ① Lyt på PDF-responses fra netværket
  page.on('response', (response) => {
    const ct  = response.headers()['content-type'] || '';
    const url = response.url();
    if (!pdfUrl && (ct.includes('application/pdf') || /\.pdf(\?|$)/i.test(url))) {
      pdfUrl = url;
      console.log(`  ✔ PDF opfanget (netværk): ${url.substring(0, 80)}`);
    }
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(4_000); // Vent på JavaScript-rendering

    // ② Søg i DOM efter PDF-link eller download-knap
    if (!pdfUrl) {
      pdfUrl = await page.evaluate(() => {
        // Direkte PDF-link
        const pdfAnchor = Array.from(document.querySelectorAll('a[href]'))
          .find(a => /\.pdf(\?|$)/i.test(a.href));
        if (pdfAnchor) return pdfAnchor.href;

        // Knap/link med download-relateret tekst
        const dlElement = Array.from(document.querySelectorAll('a, button, [role="button"]'))
          .find(el => {
            const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
            return text.includes('download') || text.includes('pdf') || text.includes('hent');
          });
        if (dlElement) return dlElement.href || dlElement.getAttribute('data-url') || null;

        return null;
      });

      if (pdfUrl) console.log(`  ✔ PDF fundet i DOM: ${pdfUrl.substring(0, 80)}`);
    }

    // ③ Prøv at klikke download-knap og opfang browser-download
    if (!pdfUrl) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 6_000 }),
          page.click(
            'a[href*=".pdf"], button:has-text("Download"), a:has-text("Download"), ' +
            'button:has-text("PDF"), a:has-text("PDF"), button:has-text("Hent")',
            { timeout: 4_000 }
          ),
        ]);
        pdfUrl = download.url();
        console.log(`  ✔ PDF via download-klik: ${pdfUrl.substring(0, 80)}`);
      } catch {
        // Ingen download-event
      }
    }

    // ④ Vent lidt mere på lazy-loaded indhold og tjek igen
    if (!pdfUrl) {
      await page.waitForTimeout(5_000);
      pdfUrl = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href]'))
          .find(el => /\.pdf(\?|$)/i.test(el.href));
        return a?.href || null;
      });
      if (pdfUrl) console.log(`  ✔ PDF fundet efter ekstra vent: ${pdfUrl.substring(0, 80)}`);
    }

  } catch (err) {
    console.log(`  ⚠ Browser-fejl: ${err.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }

  if (!pdfUrl) {
    console.log(`  ✗ Ingen PDF-URL fundet for ${label}`);
    console.log('    (Siden bruger muligvis en login-beskyttet avis eller en app-baseret viewer)');
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

// ── AI-ekstraktion: Gemini 2.0 Flash (GRATIS) ────────────────────────────────

async function extractWithGemini(pdfBase64, supermarket, week, year) {
  if (!GEMINI_KEY) {
    throw new Error(
      'GEMINI_API_KEY mangler.\n' +
      'Hent gratis nøgle: https://aistudio.google.com/apikey\n' +
      'Kør: GEMINI_API_KEY=din_nøgle node pipeline.js'
    );
  }

  // Lazy-load for at undgå fejl hvis pakken ikke er installeret
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: 'application/pdf',
        data:     pdfBase64,
      },
    },
    { text: buildPrompt(supermarket, week, year) },
  ]);

  return result.response.text();
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

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('AI returnerede ikke et JSON-array');
  return parsed;
}

// ── Hoved-pipeline per supermarked ───────────────────────────────────────────

async function processSupermarket(db, config, week, year) {
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`[${config.name.toUpperCase()}]  uge ${week} / ${year}`);
  console.log('─'.repeat(65));

  // 1. Find PDF-URL
  let pdfUrl;
  try {
    pdfUrl = await config.findPdf(week, year);
  } catch (err) {
    console.log(`  ✗ PDF-søgning fejlede: ${err.message}`);
    return 0;
  }
  if (!pdfUrl) return 0;

  // 2. Download PDF (spring over hvis allerede hentet denne uge)
  const filename = `${config.name}_uge${week}_${year}.pdf`;
  const pdfPath  = path.join(PDF_DIR, filename);

  if (fs.existsSync(pdfPath)) {
    const sizeMb = fs.statSync(pdfPath).size / 1024 / 1024;
    console.log(`  PDF allerede hentet: ${filename} (${sizeMb.toFixed(1)} MB)`);
  } else {
    console.log(`  Downloader PDF...`);
    try {
      await downloadPdf(pdfUrl, pdfPath);
    } catch (err) {
      console.log(`  ✗ Download fejlede: ${err.message}`);
      return 0;
    }
  }

  // 3. Udtræk tilbud med AI
  console.log(`  Sender PDF til AI (${MODEL === 'claude' ? 'Claude Sonnet 4.6' : 'Gemini 2.0 Flash'})...`);
  let offers;
  try {
    const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
    const rawText   = MODEL === 'claude'
      ? await extractWithClaude(pdfBase64, config.name, week, year)
      : await extractWithGemini(pdfBase64, config.name, week, year);

    offers = parseAiJson(rawText);
    console.log(`  AI udtrakte ${offers.length} produkter`);
  } catch (err) {
    console.log(`  ✗ AI-udtræk fejlede: ${err.message}`);
    return 0;
  }

  // 4. Normaliser og gem i database
  const fetchedAt = new Date().toISOString();
  const rows = offers
    .filter(o => o.name && String(o.name).trim())
    .map(o => ({
      supermarket:    config.name,
      week,
      year,
      name:           String(o.name).trim().substring(0, 255),
      brand:          o.brand          != null ? String(o.brand).trim()  : null,
      price:          typeof o.price === 'number'          ? o.price          : null,
      original_price: typeof o.original_price === 'number' ? o.original_price : null,
      unit:           o.unit           != null ? String(o.unit).trim()   : null,
      valid_from:     o.valid_from     != null ? String(o.valid_from)    : null,
      valid_to:       o.valid_to       != null ? String(o.valid_to)      : null,
      page_in_flyer:  typeof o.page === 'number' ? o.page                : null,
      fetched_at,
    }));

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
  const today = new Date();
  const week  = getISOWeek(today);
  const year  = today.getFullYear();

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Supermarket Tilbud Pipeline  –  PDF + AI              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`Model:      ${MODEL === 'claude' ? 'Claude Sonnet 4.6  (betalt ~$0.20-0.40/avis)' : 'Gemini 2.0 Flash   (gratis)'}`);
  console.log(`ISO-uge:    ${week} / ${year}`);
  console.log(`Database:   ${DB_PATH}`);
  console.log(`PDF-mappe:  ${PDF_DIR}`);

  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
  const db = setupDatabase();

  const supermarkets = [
    {
      name:    'netto',
      findPdf: async () => findIpaperPdf('https://netto.dk/netto-avisen/', 'Netto'),
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
