/**
 * Analyse-script – supermarked JSON-strukturer
 *
 * Bygger på konkret viden om de tre interceptede datakilder:
 *
 *   Netto    → ingen produktdata fanget (Salling Group / Netto bruger
 *              sandsynligvis server-side rendering og/eller kræver
 *              brugerinteraktion for at kalde produkt-API'et)
 *
 *   Rema 1000 → Tjek.com catalog-API  (squid-api.tjek.com/v2/catalogs)
 *               Giver katalogoversigt med catalog-IDs og offer_count.
 *               Næste trin: /v2/offers?catalog_id={id}
 *
 *   Føtex    → iPaper enrichments-API  (b-cdn.ipaper.io/.../Page1-64.json)
 *               Giver 93 produkt-hotspots med alttext ("Brand - Produktnavn")
 *               og URL til foetex.dk produktsider. Ingen pris i dette kald.
 *
 * Kør: node analyze.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'intercepted_data');

// ── Parsere per datastruktur ──────────────────────────────────────────────────

/**
 * Tjek.com catalog-API (Rema 1000).
 * Roden er et array af katalogobjekter.
 */
function analyzeRema(data, meta) {
  if (!Array.isArray(data)) return;

  const catalogs = data.filter((c) => c.id && c.label);
  console.log(`\n  Backend-URL:  ${meta.sourceUrl}`);
  console.log(`  API-type:     Tjek.com  (squid-api.tjek.com/v2/catalogs)`);
  console.log(`  Katalog-IDs:  ${catalogs.length} fundet\n`);

  for (const cat of catalogs) {
    console.log(`  ┌─ ${cat.label.padEnd(30)} id: ${cat.id}`);
    console.log(`  │  Gyldig:    ${cat.run_from?.substring(0, 10)} → ${cat.run_till?.substring(0, 10)}`);
    console.log(`  │  Tilbud:    ${cat.offer_count}   Sider: ${cat.page_count}`);
    console.log(`  │  PDF:       ${cat.pdf_url}`);
    console.log(`  └─ Næste kald for produkter:`);
    console.log(`     https://squid-api.tjek.com/v2/offers?catalog_id=${cat.id}&limit=100\n`);
  }

  // Eksempel på ét katalogobjekts nøgler
  if (catalogs[0]) {
    console.log('  ── Felter i ét katalogobjekt ─────────────────────────────');
    for (const [key, val] of Object.entries(catalogs[0])) {
      if (typeof val === 'object' && val !== null) {
        const sub = Array.isArray(val)
          ? `Array[${val.length}]`
          : `{ ${Object.keys(val).slice(0, 4).join(', ')} … }`;
        console.log(`  ${key.padEnd(22)}: ${sub}`);
      } else {
        console.log(`  ${key.padEnd(22)}: ${String(val).substring(0, 70)}`);
      }
    }
  }
}

/**
 * iPaper enrichments-API (Føtex).
 * Roden er { enrichments: [...] }.
 */
function analyzeFoetex(data, meta) {
  const enrichments = data?.enrichments;
  if (!Array.isArray(enrichments)) return;

  // Filtrér kun de med produkt-alttext (type === 1 = klikbart link)
  const products = enrichments.filter((e) => e.alttext && e.type === 1);
  const withProductUrl = products.filter((e) => e.url?.includes('foetex.dk/produkter/'));
  const withSearchUrl  = products.filter((e) => e.url?.includes('foetex.dk/search/'));

  console.log(`\n  Backend-URL:  ${meta.sourceUrl.substring(0, 80)}...`);
  console.log(`  API-type:     iPaper digital avis enrichments`);
  console.log(`  Enrichments:  ${enrichments.length} total  /  ${products.length} med produktnavn`);
  console.log(`  URL-typer:    ${withProductUrl.length} direkte produktlinks`);
  console.log(`                ${withSearchUrl.length} søge-links (multi-SKU)\n`);

  console.log('  ── Felter i ét enrichment-objekt ────────────────────────────');
  if (products[0]) {
    for (const [key, val] of Object.entries(products[0])) {
      console.log(`  ${key.padEnd(14)}: ${typeof val}  →  ${String(val).substring(0, 70)}`);
    }
  }

  console.log('\n  ── Eksempel: 5 produkter ─────────────────────────────────────');
  for (const p of products.slice(0, 5)) {
    const [brand, ...rest] = (p.alttext || '').split(' - ');
    const name = rest.join(' - ');
    // Udtræk SKU fra URL hvis muligt
    const skuMatch = p.url?.match(/\/(\d+)\/?$/);
    const sku = skuMatch ? skuMatch[1] : '(se URL)';
    console.log(`  Brand:    ${brand}`);
    console.log(`  Produkt:  ${name}`);
    console.log(`  Side:     ${p.pageIndex + 1}`);
    console.log(`  SKU:      ${sku}`);
    console.log(`  URL:      ${p.url?.substring(0, 75)}`);
    console.log(`  ⚠ Pris:  ikke tilgængelig i dette API-kald`);
    console.log(`           Hent pris via: GET ${p.url?.substring(0, 60)}`);
    console.log();
  }

  console.log('  ── Alle produktnavne ────────────────────────────────────────');
  products.forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. ${p.alttext}`);
  });
}

// ── Hoved-logik ──────────────────────────────────────────────────────────────

function run() {
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
    .sort();

  if (files.length === 0) {
    console.log('Ingen JSON-filer fundet i', DATA_DIR);
    console.log('Kør først: node discover.js');
    return;
  }

  console.log(`\nFandt ${files.length} fil(er) i ${DATA_DIR}`);

  for (const file of files) {
    const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }

    const meta = parsed._meta || {};
    const data = parsed.data;
    const market = file.split('_')[0];

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`FIL:  ${file}`);
    console.log(`${'═'.repeat(70)}`);

    if (meta.sourceUrl?.includes('cookieinformation.com') ||
        meta.sourceUrl?.includes('usercentrics.eu')) {
      console.log('  ⚠  FALSE POSITIVE: Consent-management API – ingen produktdata.');
      console.log(`     Kilde: ${meta.sourceUrl}`);
      continue;
    }

    if (market === 'rema1000' && meta.sourceUrl?.includes('tjek.com')) {
      analyzeRema(data, meta);
    } else if (market === 'foetex' && meta.sourceUrl?.includes('ipaper.io')) {
      analyzeFoetex(data, meta);
    } else if (market === 'netto') {
      console.log('  ℹ  Netto: Ingen produkt-API fanget under sidens indlæsning.');
      console.log('     Forklaring: Netto/Salling Group renderer sandsynligvis');
      console.log('     tilbudsdata server-side eller kræver brugerinteraktion.');
      console.log(`     Kilde: ${meta.sourceUrl}`);
    } else {
      console.log(`  Ukendt struktur – kilde: ${meta.sourceUrl}`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('SAMMENFATNING:');
  console.log('  Rema 1000 → Tjek.com API  →  brug catalog-ID til at hente tilbud');
  console.log('  Føtex     → iPaper API    →  produktnavne fanget, pris kræver ekstra kald');
  console.log('  Netto     → Ingen API fanget  →  overvej direkte Salling Group API');
  console.log('═'.repeat(70));
}

run();
