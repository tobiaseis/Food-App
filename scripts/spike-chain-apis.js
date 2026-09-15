'use strict';

/**
 * Undersøgelse: kan vi hente normalpriser fra kædernes egne API'er?
 *
 * Skriver ingenting i basen. Formålet er ét svar pr. kæde, så plan 2 kan
 * skrives på fakta i stedet for på et håb.
 *
 *   node scripts/spike-chain-apis.js "<url>"
 */

/** Fladgør et svar til nøglestier, så formen kan ses på én skærm. */
function shape(value, prefix = '', out = new Map(), depth = 0) {
  if (depth > 6) return out;
  if (Array.isArray(value)) {
    // Et array beskrives af sit første element – resten har samme form.
    if (value.length) shape(value[0], `${prefix}[]`, out, depth + 1);
    else out.set(`${prefix}[]`, '(tom)');
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      shape(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  } else if (!out.has(prefix)) {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

// Det undersøgelsen leder efter. Er der hverken pris eller mængde, er
// API'et ikke brugbart til normalpriser, uanset hvor pænt det ellers er.
const WANTED = /pris|price|amount|value|unit|size|weight|vaegt|volume|quantity|pack/i;

async function probe(url) {
  console.log(`\n=== ${url} ===`);
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'accept-language': 'da-DK,da;q=0.9',
      'user-agent': 'Mozilla/5.0',
    },
  });
  console.log(`HTTP ${res.status} ${res.headers.get('content-type') || ''}`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 300));
    return;
  }

  const paths = shape(await res.json());
  console.log(`${paths.size} nøglestier. Kandidater til pris og pakkestørrelse:`);
  for (const [k, v] of paths) if (WANTED.test(k)) console.log(`  ${k} = ${v}`);
}

const url = process.argv[2];
if (!url) {
  console.error('brug: node scripts/spike-chain-apis.js "<url>"');
  process.exit(1);
}
probe(url).catch((e) => { console.error(e.message); process.exit(1); });
