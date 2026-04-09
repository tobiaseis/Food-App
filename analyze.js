/**
 * Midlertidigt analyse-script
 *
 * Læser alle filer i ./intercepted_data/, finder produkt-arrays
 * og udskriver strukturen for ét eksempelprodukt per supermarked.
 *
 * Kør: node analyze.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'intercepted_data');

// ── Hjælpefunktioner ─────────────────────────────────────────────────────────

/**
 * Traverserer et objekt rekursivt og returnerer alle arrays af objekter
 * der er store nok til at ligne en produktliste.
 * Returnerer: [{ keyPath, array }]
 */
function findProductArrays(obj, keyPath = 'root', results = []) {
  if (Array.isArray(obj)) {
    // Kig kun på arrays med mindst 2 elementer af typen object
    const objectItems = obj.filter((el) => el && typeof el === 'object' && !Array.isArray(el));
    if (objectItems.length >= 2) {
      results.push({ keyPath, array: objectItems });
    }
    // Gå også dybere i hvert element (op til 3 niveauer)
    if (keyPath.split('.').length < 4) {
      obj.slice(0, 3).forEach((el, i) => findProductArrays(el, `${keyPath}[${i}]`, results));
    }
  } else if (obj && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      findProductArrays(val, `${keyPath}.${key}`, results);
    }
  }
  return results;
}

/**
 * Scorer et array på sandsynlighed for at være en produktliste.
 * Højere score = mere sandsynligt produktdata.
 */
const PRODUCT_SCORE_KEYS = [
  'price', 'pris', 'name', 'title', 'navn', 'titel',
  'description', 'beskrivelse', 'image', 'billede', 'img',
  'quantity', 'maengde', 'mængde', 'unit', 'enhed',
  'offer', 'tilbud', 'discount', 'rabat', 'sku', 'id',
  'brand', 'maerke', 'category', 'kategori',
];

function scoreArray(arr) {
  if (!arr.length) return 0;
  const sample = arr[0];
  const keys = Object.keys(sample).map((k) => k.toLowerCase());
  const hits = PRODUCT_SCORE_KEYS.filter((kw) =>
    keys.some((k) => k.includes(kw))
  ).length;
  return hits * 10 + arr.length; // bonus for størrelse
}

/**
 * Laver en "schema-visning" af ét objekt:
 * { key: typeof value  (+ eksempelværdi hvis primitiv) }
 */
function describeObject(obj, indent = '  ') {
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === null) {
      lines.push(`${indent}${key}: null`);
    } else if (Array.isArray(val)) {
      lines.push(`${indent}${key}: Array[${val.length}]${val[0] && typeof val[0] === 'object' ? ' af objekter' : ` (${typeof val[0]})`}`);
    } else if (typeof val === 'object') {
      lines.push(`${indent}${key}: {`);
      lines.push(describeObject(val, indent + '  '));
      lines.push(`${indent}}`);
    } else {
      const preview = String(val).substring(0, 80);
      lines.push(`${indent}${key}: ${typeof val}  →  ${preview}`);
    }
  }
  return lines.join('\n');
}

// ── Hoved-logik ──────────────────────────────────────────────────────────────

function analyzeFile(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parsed;
}

function run() {
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
    .sort();

  if (files.length === 0) {
    console.log('Ingen JSON-filer fundet i', DATA_DIR);
    console.log('Kør først:  node discover.js');
    return;
  }

  console.log(`\nFandt ${files.length} fil(er) i ${DATA_DIR}\n`);

  // Gruppér filer per supermarked (prefix før første _)
  const byMarket = {};
  for (const file of files) {
    const market = file.split('_')[0];
    if (!byMarket[market]) byMarket[market] = [];
    byMarket[market].push(file);
  }

  for (const [market, marketFiles] of Object.entries(byMarket)) {
    console.log('═'.repeat(70));
    console.log(`SUPERMARKED: ${market.toUpperCase()}  (${marketFiles.length} fil(er))`);
    console.log('═'.repeat(70));

    let bestArray = null;
    let bestScore = -1;
    let bestMeta = null;
    let bestKeyPath = '';

    // Gennemgå alle filer for dette supermarked — find bedste produkt-array
    for (const file of marketFiles) {
      const parsed = analyzeFile(path.join(DATA_DIR, file));
      if (!parsed) continue;

      const meta = parsed._meta || {};
      const data = parsed.data !== undefined ? parsed.data : parsed;

      const candidates = findProductArrays(data);
      for (const { keyPath, array } of candidates) {
        const score = scoreArray(array);
        if (score > bestScore) {
          bestScore = score;
          bestArray = array;
          bestMeta = { file, ...meta };
          bestKeyPath = keyPath;
        }
      }
    }

    if (!bestArray) {
      console.log('  Ingen produkt-arrays fundet.\n');
      continue;
    }

    console.log(`\nKilde-fil:   ${bestMeta.file}`);
    console.log(`Backend-URL: ${bestMeta.sourceUrl || '(ikke registreret)'}`);
    console.log(`Fanget:      ${bestMeta.capturedAt || '?'}`);
    console.log(`Array-sti:   ${bestKeyPath}`);
    console.log(`Antal varer: ${bestArray.length}`);

    console.log('\n── Eksempel på ét produkt ──────────────────────────────────────');
    console.log(describeObject(bestArray[0]));

    // Prøv at identificere de mest sandsynlige felter for navn, pris, mængde
    const keys = Object.keys(bestArray[0]).map((k) => k.toLowerCase());
    const guesses = {
      'Navn/titel': findKey(bestArray[0], ['name', 'title', 'navn', 'titel', 'description', 'productName', 'product_name']),
      'Pris':       findKey(bestArray[0], ['price', 'pris', 'salesPrice', 'currentPrice', 'offerPrice', 'sale_price']),
      'Mængde':     findKey(bestArray[0], ['quantity', 'amount', 'volume', 'size', 'unit', 'enhed', 'maengde', 'weight']),
      'Billede':    findKey(bestArray[0], ['image', 'img', 'imageUrl', 'image_url', 'photo', 'thumbnail', 'picture']),
    };

    console.log('\n── Sandsynlige nøglefelter ─────────────────────────────────────');
    for (const [label, result] of Object.entries(guesses)) {
      if (result) {
        console.log(`  ${label.padEnd(12)}: "${result.key}"  →  ${String(result.value).substring(0, 60)}`);
      } else {
        console.log(`  ${label.padEnd(12)}: (ikke fundet – se struktur ovenfor)`);
      }
    }

    console.log('');
  }

  console.log('═'.repeat(70));
  console.log('Analyse færdig.');
}

/** Finder første matching nøgle i et objekt (case-insensitive). */
function findKey(obj, candidates) {
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.toLowerCase() === candidate.toLowerCase() && value !== null && value !== undefined) {
        return { key, value };
      }
    }
  }
  // Prøv partial match
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.toLowerCase().includes(candidate.toLowerCase()) && value !== null && value !== undefined) {
        return { key, value };
      }
    }
  }
  return null;
}

run();
