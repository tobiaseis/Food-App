'use strict';

/**
 * Den ugentlige rutine – ét kald, der holder databasen aktuel.
 *
 *   1. Henter alle aktive tilbudsaviser (idempotent på Tjeks offer-id)
 *   2. Opdaterer butiksregisteret én gang om ugen
 *   3. Kører overvågninger og danner notifikationer for nye træf
 *   4. Skriver et resumé til loggen og til `settings`
 *
 * Kør den gerne dagligt. Kæderne udgiver ikke deres aviser på samme ugedag,
 * og nye tilbud dukker op løbende – kørslen indsætter kun det, den ikke har
 * set før, så der er ingen omkostning ved at køre for ofte.
 *
 *   node src/update.js
 *   node src/update.js --stores      # tving butiksopdatering
 *   node src/update.js --quiet       # kun resumé (til planlagt kørsel)
 */

const fs = require('node:fs');
const path = require('node:path');

const { getDb, getSetting, setSetting } = require('./db');
const { ingest, ingestStores } = require('./ingest/run');
const { recompute } = require('./ingest/recompute');
const tjek = require('./ingest/tjek');
const watches = require('./watch/notify');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'update.log');

const STORES_MAX_AGE_DAYS = 7;

function makeLogger({ quiet = false } = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  return (msg = '') => {
    const line = String(msg);
    stream.write(`${new Date().toISOString()}  ${line}\n`);
    if (!quiet) console.log(line);
  };
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

async function update({ quiet = false, forceStores = false } = {}) {
  const log = makeLogger({ quiet });
  const started = Date.now();
  const db = getDb();

  log('─'.repeat(58));
  log('Ugentlig opdatering starter');

  // 1. Tilbud
  const before = db.prepare('SELECT COUNT(*) n FROM offers').get().n;
  let stats;
  try {
    stats = await ingest({ log });
  } catch (err) {
    log(`FEJL under ingest: ${err.message}`);
    throw err;
  }
  const after = db.prepare('SELECT COUNT(*) n FROM offers').get().n;

  // 2. Butikker – kun hvis registeret er ved at blive gammelt
  const storesAge = daysSince(getSetting('stores_updated_at', null));
  if (forceStores || storesAge > STORES_MAX_AGE_DAYS) {
    log(`Butiksregister er ${storesAge === Infinity ? 'aldrig hentet' : Math.round(storesAge) + ' dage gammelt'} – opdaterer`);
    try {
      const n = await ingestStores(db, tjek.CHAINS);
      setSetting('stores_updated_at', new Date().toISOString());
      log(`${n} butikker opdateret`);
    } catch (err) {
      log(`Butiksopdatering fejlede (ikke kritisk): ${err.message}`);
    }
  }

  // 3. Normalisering af de nye rækker.
  //    Kun nødvendigt hvis der faktisk kom noget nyt ind.
  if (stats.inserted > 0) {
    const r = recompute({ log: () => {} });
    log(`Normalisering: ${r.priceChanged} enhedspriser, ${r.productChanged} vare-koblinger justeret`);
  }

  // 4. Overvågninger
  let created = [];
  try {
    created = watches.runWatches();
  } catch (err) {
    log(`Overvågninger fejlede: ${err.message}`);
  }

  const summary = {
    at: new Date().toISOString(),
    offers_seen: stats.offers,
    offers_new: stats.inserted,
    total_offers: after,
    chains: stats.chains,
    catalogs: stats.catalogs,
    new_products: stats.products,
    notifications: created.length,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  setSetting('last_update', summary);

  log('');
  log(`Færdig på ${summary.seconds} s`);
  log(`  ${stats.inserted} nye tilbud (${before} → ${after})`);
  log(`  ${stats.chains} kæder · ${stats.catalogs} aviser · ${stats.products} nye varetyper`);
  log(`  ${created.length} nye notifikationer`);
  for (const n of created.slice(0, 10)) {
    log(`    ${n.watch_label}: ${n.chain} – ${n.heading} (${n.discount_pct ?? '?'} % under normal)`);
  }
  log('─'.repeat(58));

  return { summary, notifications: created };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  update({ quiet: args.includes('--quiet'), forceStores: args.includes('--stores') })
    .then(({ summary, notifications }) => {
      // Exitkode 0 uanset hvad – en planlagt opgave skal ikke rapportere fejl,
      // bare fordi der ikke var nye tilbud i denne uge.
      if (args.includes('--quiet')) {
        console.log(`${summary.offers_new} nye tilbud, ${notifications.length} notifikationer`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[FEJL]', err.message);
      process.exit(1);
    });
}

module.exports = { update };
