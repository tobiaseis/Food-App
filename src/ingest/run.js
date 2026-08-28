'use strict';

/**
 * Ingest: henter alle aktive tilbudsaviser og skriver dem i databasen som
 * normaliserede tilbud, koblet til kanoniske varetyper.
 *
 * Kørslen er idempotent – et tilbud identificeres på Tjeks `external_id`, så
 * gentagne kørsler i samme uge tilføjer ikke dubletter, men fanger nye aviser.
 *
 *   node src/ingest/run.js                  # alle kæder
 *   node src/ingest/run.js netto rema1000   # udvalgte kæder
 *   node src/ingest/run.js --stores         # opdatér også butiksregister
 */

const { getDb } = require('../db');
const tjek = require('./tjek');
const norm = require('../lib/normalize');

// ── Produkter ────────────────────────────────────────────────────────────────

function makeProductResolver(db) {
  const selectBySlug = db.prepare('SELECT id FROM products WHERE slug = ?');
  const insert = db.prepare(`
    INSERT INTO products (slug, name, category, taxonomy_key, fat_grade, organic,
                          prepared, protein_per_100g, kcal_per_100g, created_at)
    VALUES (@slug, @name, @category, @taxonomy_key, @fat_grade, @organic,
            @prepared, @protein_per_100g, @kcal_per_100g, @created_at)
  `);
  const cache = new Map();

  return function resolve(identity) {
    if (cache.has(identity.slug)) return cache.get(identity.slug);
    let row = selectBySlug.get(identity.slug);
    if (!row) {
      insert.run({ ...identity, created_at: new Date().toISOString() });
      row = selectBySlug.get(identity.slug);
    }
    cache.set(identity.slug, row.id);
    return row.id;
  };
}

// ── Kæder ────────────────────────────────────────────────────────────────────

function upsertChain(db, chain, dealer) {
  db.prepare(`
    INSERT INTO chains (id, name, slug, logo, color, website)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, logo = excluded.logo,
      color = excluded.color, website = excluded.website
  `).run(
    chain.id, chain.name, chain.slug,
    dealer?.logo || null,
    dealer?.color ? '#' + String(dealer.color).replace(/^#/, '') : null,
    dealer?.website || null
  );
}

// ── Tilbud ───────────────────────────────────────────────────────────────────

function buildOfferRow(offer, chainId, productId, observedAt) {
  const up = norm.computeUnitPrice(offer);
  const runFrom = offer.run_from ? new Date(offer.run_from) : null;
  const { week, year } = runFrom && !isNaN(runFrom)
    ? norm.isoWeek(runFrom)
    : norm.isoWeek(new Date());

  return {
    external_id: offer.id,
    product_id:  productId,
    chain_id:    chainId,
    heading:     String(offer.heading || '').trim(),
    description: offer.description ? String(offer.description).trim() : null,
    brand:       norm.detectBrand(offer.heading) || null,
    price:       offer.pricing?.price ?? null,
    pre_price:   offer.pricing?.pre_price ?? null,
    currency:    offer.pricing?.currency || 'DKK',
    ...up,
    run_from:    offer.run_from || null,
    run_till:    offer.run_till || null,
    week, year,
    page:        offer.catalog_page ?? null,
    image:       offer.images?.thumb || offer.images?.view || null,
    catalog_id:  offer.catalog_id || null,
    observed_at: observedAt,
  };
}

const INSERT_OFFER = `
  INSERT INTO offers (
    external_id, product_id, chain_id, heading, description, brand,
    price, pre_price, currency,
    size_from, size_to, unit_symbol, si_symbol, si_factor,
    pieces_from, pieces_to, base_qty, base_unit, unit_price, size_is_range,
    run_from, run_till, week, year, page, image, catalog_id, observed_at
  ) VALUES (
    @external_id, @product_id, @chain_id, @heading, @description, @brand,
    @price, @pre_price, @currency,
    @size_from, @size_to, @unit_symbol, @si_symbol, @si_factor,
    @pieces_from, @pieces_to, @base_qty, @base_unit, @unit_price, @size_is_range,
    @run_from, @run_till, @week, @year, @page, @image, @catalog_id, @observed_at
  )
  ON CONFLICT(external_id) DO NOTHING
`;

// ── Butikker ─────────────────────────────────────────────────────────────────

async function ingestStores(db, chains) {
  const stmt = db.prepare(`
    INSERT INTO stores (id, chain_id, name, street, city, zip, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, street = excluded.street, city = excluded.city,
      zip = excluded.zip, lat = excluded.lat, lng = excluded.lng
  `);
  const known = db.prepare('SELECT 1 FROM chains WHERE id = ?');

  let total = 0;
  for (const chain of chains) {
    // Butikker peger på chains. En kæde uden aktive aviser har aldrig fået
    // en række dér, og indsættelsen ville fejle på fremmednøglen.
    if (!known.get(chain.id)) {
      console.log(`  ${chain.name.padEnd(14)} sprunget over (ingen aktive aviser)`);
      continue;
    }
    try {
      // Tjek pagineres ikke frit på stores; 100 ad gangen over flere kald.
      let seen = 0;
      for (let page = 0; page < 12; page++) {
        const batch = await tjek.api(
          `/stores?dealer_ids=${chain.id}&limit=100&offset=${page * 100}`
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        const tx = db.transaction((rows) => {
          for (const s of rows) {
            stmt.run(s.id, chain.id, s.name || null, s.street || null,
                     s.city || null, s.zip_code || null, s.latitude ?? null, s.longitude ?? null);
          }
        });
        tx(batch);
        seen += batch.length;
        if (batch.length < 100) break;
        await tjek.sleep(150);
      }
      total += seen;
      console.log(`  ${chain.name.padEnd(14)} ${seen} butikker`);
    } catch (err) {
      console.log(`  ${chain.name.padEnd(14)} butikker fejlede: ${err.message}`);
    }
  }
  return total;
}

// ── Hovedkørsel ──────────────────────────────────────────────────────────────

async function ingest({ chains = tjek.CHAINS, withStores = false, log = console.log } = {}) {
  const db = getDb();
  const resolveProduct = makeProductResolver(db);
  const insertOffer = db.prepare(INSERT_OFFER);
  const observedAt = new Date().toISOString();

  const stats = { chains: 0, catalogs: 0, offers: 0, inserted: 0, products: 0, skipped: 0 };
  const before = db.prepare('SELECT COUNT(*) n FROM products').get().n;

  for (const chain of chains) {
    let catalogs = [];
    try {
      catalogs = await tjek.getCatalogs(chain.id);
    } catch (err) {
      log(`  ${chain.name.padEnd(14)} kataloger fejlede: ${err.message}`);
      continue;
    }
    if (!catalogs.length) { log(`  ${chain.name.padEnd(14)} ingen aktive aviser`); continue; }

    upsertChain(db, chain, catalogs[0]?.dealer || catalogs[0]?.branding);
    stats.chains++;

    let chainInserted = 0, chainOffers = 0;
    for (const cat of catalogs) {
      let offers = [];
      try {
        offers = await tjek.getOffers(cat.id);
      } catch (err) {
        log(`    katalog ${cat.label}: ${err.message}`);
        continue;
      }
      stats.catalogs++;
      chainOffers += offers.length;

      const rows = [];
      for (const o of offers) {
        if (typeof o?.pricing?.price !== 'number') { stats.skipped++; continue; }
        const identity = norm.productIdentity(o.heading, o.description);
        const productId = resolveProduct(identity);
        rows.push(buildOfferRow(o, chain.id, productId, observedAt));
      }

      const tx = db.transaction((items) => {
        let n = 0;
        for (const r of items) n += insertOffer.run(r).changes;
        return n;
      });
      chainInserted += tx(rows);
      await tjek.sleep(200);
    }

    stats.offers += chainOffers;
    stats.inserted += chainInserted;
    log(`  ${chain.name.padEnd(14)} ${String(chainOffers).padStart(4)} tilbud  (${chainInserted} nye)  ${catalogs.length} avis(er)`);
  }

  stats.products = db.prepare('SELECT COUNT(*) n FROM products').get().n - before;

  if (withStores) {
    log('\nButikker:');
    await ingestStores(db, chains);
  }

  return stats;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const withStores = args.includes('--stores');
  const slugs = args.filter((a) => !a.startsWith('--'));
  const chains = slugs.length
    ? slugs.map((s) => tjek.CHAIN_BY_SLUG.get(s)).filter(Boolean)
    : tjek.CHAINS;

  if (slugs.length && chains.length !== slugs.length) {
    console.error('Ukendt kæde. Gyldige:', tjek.CHAINS.map((c) => c.slug).join(', '));
    process.exit(1);
  }

  console.log(`Henter tilbud fra ${chains.length} kæde(r)...\n`);
  ingest({ chains, withStores })
    .then((s) => {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`${s.offers} tilbud fra ${s.catalogs} aviser i ${s.chains} kæder`);
      console.log(`${s.inserted} nye tilbud gemt  ·  ${s.products} nye varetyper`);
      if (s.skipped) console.log(`${s.skipped} sprunget over (ingen pris)`);
    })
    .catch((err) => { console.error('\n[FEJL]', err.message); process.exit(1); });
}

module.exports = { ingest, ingestStores };
