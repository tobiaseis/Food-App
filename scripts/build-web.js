'use strict';

/**
 * Skriver public/config.js ud fra miljøvariabler. Køres som Vercels
 * build-kommando, så nøglerne ikke behøver ligge i git.
 *
 *   SUPABASE_URL       https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY  den offentlige anon-nøgle
 *
 * anon-nøglen ER beregnet til at ligge i frontenden – adgangen styres af
 * Row Level Security i Supabase, ikke af at nøglen er hemmelig.
 * service_role-nøglen må derimod ALDRIG havne her; den hører kun hjemme
 * i GitHub Actions.
 */

const fs = require('node:fs');
const path = require('node:path');

const url = process.env.SUPABASE_URL || '';
const anon = process.env.SUPABASE_ANON_KEY || '';

if (/service_role/.test(anon)) {
  console.error('FEJL: SUPABASE_ANON_KEY ligner en service_role-nøgle. Den må ikke i frontenden.');
  process.exit(1);
}

const out = path.join(__dirname, '..', 'public', 'config.js');
fs.writeFileSync(out, `// Genereret af scripts/build-web.js – rediger ikke i hånden.
window.APP_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(url)},
  SUPABASE_ANON_KEY: ${JSON.stringify(anon)},
};
`);

console.log(url
  ? `config.js skrevet – frontenden læser fra ${url}`
  : 'config.js skrevet uden Supabase – frontenden bruger den lokale server på /api/*');
