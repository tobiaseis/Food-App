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

// På Vercel findes der ingen /api/*-server at falde tilbage på. Uden nøgler
// ville deployet lykkes og siden være helt tom – en fejl der er svær at
// gennemskue bagefter. Stop hellere buildet med det samme.
if (process.env.VERCEL && !(url && anon)) {
  const env = process.env.VERCEL_ENV || 'ukendt';
  console.error([
    'FEJL: byg på Vercel uden Supabase-nøgler.',
    '',
    `  SUPABASE_URL       ${url ? 'sat' : 'MANGLER'}`,
    `  SUPABASE_ANON_KEY  ${anon ? 'sat' : 'MANGLER'}`,
    '',
    `Denne kørsel er miljøet "${env}".`,
    '',
    'Project Settings → Environment Variables → tilføj begge, og sæt flueben',
    'ved BÅDE Production, Preview og Development. Variabler er nemlig delt op',
    'pr. miljø: sidder de kun på Production, kan et branch-deploy (= Preview)',
    'ikke se dem, og buildet fejler præcis som her.',
    '',
    'SUPABASE_ANON_KEY skal være anon-nøglen – ikke service_role.',
  ].join('\n'));
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
