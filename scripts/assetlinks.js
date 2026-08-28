'use strict';

/**
 * Skriver public/.well-known/assetlinks.json.
 *
 * Filen er den ene halvdel af App Links: den fortæller Android, at
 * madplan-domænet og APK'en hører sammen, så et delt link åbner appen i
 * stedet for browseren. Den anden halvdel er intent-filteret i
 * AndroidManifest.xml med samme værtsnavn.
 *
 *   node scripts/assetlinks.js AB:CD:EF:... [flere fingeraftryk]
 *
 * Fingeraftrykket er SHA-256 af det certifikat, APK'en ER SIGNERET MED –
 * ikke nødvendigvis din egen nøgle. Bruger du Play App Signing (og det gør
 * du, hvis Play har tilbudt det), signerer Google appen om efter upload, og
 * det er DERES fingeraftryk, der skal stå her:
 *
 *   Play Console → Test og udgivelse → Appsignering
 *   → "Certifikat til appsigneringsnøgle" → SHA-256
 *
 * Angiv gerne begge: upload-nøglen OG appsigneringsnøglen. Så virker både
 * en lokalt bygget APK og den, Play udleverer.
 *
 * Dit eget uploadcertifikat kan læses med:
 *
 *   keytool -list -v -keystore upload.jks -alias upload
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'dk.madplan.app';

const fingerprints = process.argv.slice(2)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

if (!fingerprints.length) {
  console.error([
    'Brug: node scripts/assetlinks.js <SHA-256-fingeraftryk> [flere]',
    '',
    'Fingeraftrykket hentes i Play Console under Appsignering, eller for en',
    'lokal nøgle med:',
    '',
    '  keytool -list -v -keystore upload.jks -alias upload',
    '',
    'Formatet er 32 hex-par adskilt af kolon:',
    '  A1:B2:C3:...:FF',
  ].join('\n'));
  process.exit(1);
}

// Et forkert formateret fingeraftryk giver ingen fejl nogen steder – App
// Links holder bare op med at virke, og det er ikke til at fejlsøge fra en
// telefon. Derfor tjekkes formen her.
const SHA256 = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const bad = fingerprints.filter((f) => !SHA256.test(f));
if (bad.length) {
  console.error('Ser ikke ud som SHA-256-fingeraftryk (32 hex-par med kolon):');
  for (const f of bad) console.error(`  ${f}`);
  process.exit(1);
}

const doc = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: PACKAGE,
    sha256_cert_fingerprints: fingerprints,
  },
}];

const outDir = path.join(__dirname, '..', 'public', '.well-known');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'assetlinks.json');
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');

console.log(`assetlinks.json skrevet med ${fingerprints.length} fingeraftryk.`);
console.log('');
console.log('Mangler stadig:');
console.log('  1. sæt appLinkHost i android/variables.gradle til dit domæne');
console.log('  2. deploy, så filen kan hentes på');
console.log('     https://<dit-domæne>/.well-known/assetlinks.json');
console.log('  3. geninstallér appen – Android verificerer ved installation');
