'use strict';

/**
 * Hvilke priser mangler, og hvilke er løbet ud?
 *
 * `valid_until` er ikke dokumentation — det er en forespørgsel. Den her.
 *
 * Listen sorterer efter, hvor LIDT vi ved, ikke efter dato. 349 af de 548
 * afledte rækker hviler på én eneste observation — to tredjedele af alt, vi
 * har. Et gæt bygget på ét tilfældigt tilbud er næsten intet værd; et bygget
 * på fem er et rimeligt gæt. Står de i samme bunke, bruger et menneske sin
 * tid det forkerte sted.
 *
 *   npm run prices:worklist -- rema1000 netto foetex
 */

const { getDb } = require('../src/db');

/**
 * Bunkerne, i den rækkefølge et menneske bør tage dem.
 *
 * Første match vinder, så rækkefølgen ER definitionen: 'derived' med n_obs > 1
 * er kun "øvrige gæt", fordi n_obs = 1 allerede er taget af bunken over.
 */
const BUCKETS = [
  { rank: 0, tag: 'MANGLER', label: 'mangler helt',
    is: (r) => !r.source },
  { rank: 1, tag: 'gæt n=1', label: 'gæt på én observation',
    is: (r) => r.source === 'derived' && !(r.n_obs > 1) },
  { rank: 2, tag: 'gæt    ', label: 'øvrige gæt',
    is: (r) => r.source === 'derived' },
  { rank: 3, tag: 'udløbet', label: 'udløbet',
    is: () => true },
];

/** Hvilken bunke hører rækken i? Altid én — den sidste tager resten. */
function bucketOf(row) {
  return BUCKETS.find((b) => b.is(row));
}

/**
 * Sorteringen ligger her og ikke i SQL, fordi det er listens hele pointe og
 * skal kunne afprøves uden en database. Inden for samme bunke kommer den
 * ældste valid_until først: den har stået længst uset.
 */
function sortByUncertainty(rows) {
  return [...rows].sort((a, z) => {
    const d = bucketOf(a).rank - bucketOf(z).rank;
    if (d) return d;
    // ISO-8601 sorterer rigtigt som ren tekst — det er hele pointen med
    // formatet. localeCompare ville kalde ind i ICU og kunne i en anden locale
    // give en anden rækkefølge for de samme to datoer.
    const x = String(a.valid_until || '');
    const y = String(z.valid_until || '');
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function main() {
  const db = getDb();
  try {
    const slugs = process.argv.slice(2);
    const all = db.prepare('SELECT id, slug, name FROM chains ORDER BY slug').all();
    const chains = slugs.length ? all.filter((c) => slugs.includes(c.slug)) : all;

    if (!chains.length) {
      console.error(`ingen kæder matchede. Kendte: ${all.map((c) => c.slug).join(' ')}`);
      process.exitCode = 1;
      return;
    }

    const now = new Date().toISOString();

    // Kun varer, der kan stå i en opskrift. Uden category-filteret beder
    // listen om hyldepriser på toiletpapir, vin og elektronik — 9 non-food
    // varer, ingen madplan nogensinde køber.
    const q = db.prepare(`
      SELECT i.key, i.name, i.class, i.base_unit,
             ip.source, ip.n_obs, ip.observed_at, ip.valid_until
        FROM items i
        LEFT JOIN item_prices ip ON ip.item_key = i.key AND ip.chain_id = ?
       WHERE i.class <> 'essential'
         AND i.category <> 'nonfood'
         AND (ip.id IS NULL OR ip.source = 'derived' OR ip.valid_until < ?)
    `);

    for (const chain of chains) {
      // En vare kan have flere pakkestørrelser hos samme kæde (nøglen er
      // vare+kæde+pakke). Listen spørger om VAREN, ikke om pakken, så den
      // mest usikre række afgør, hvor varen står — ellers ville en enkelt
      // god pris skjule et gæt ved siden af den.
      const perItem = new Map();
      for (const r of q.all(chain.id, now)) {
        const prev = perItem.get(r.key);
        if (!prev || bucketOf(r).rank < bucketOf(prev).rank) perItem.set(r.key, r);
      }
      const rows = sortByUncertainty([...perItem.values()]);

      const counts = BUCKETS.map((b) => rows.filter((r) => bucketOf(r) === b).length);

      console.log(`\n── ${chain.name} (${chain.slug}) ──`);
      console.log(BUCKETS.map((b, i) => `${b.label}: ${counts[i]}`).join(' · ')
                + ` · i alt ${rows.length}`);
      for (const r of rows.slice(0, 25)) {
        const obs = r.source === 'derived' ? ` n_obs=${r.n_obs}` : '';
        console.log(`  ${bucketOf(r).tag}  ${r.key.padEnd(24)} ${r.base_unit}  (${r.class})${obs}`);
      }
      if (rows.length > 25) console.log(`  … og ${rows.length - 25} mere`);
    }
  } finally {
    db.close();
  }
}

// Testen indlæser filen for at få fat i sorteringen og må ikke komme til at
// åbne en database som bivirkning.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('arbejdsliste afbrudt:', err.message);
    process.exitCode = 1;
  }
}

module.exports = { bucketOf, sortByUncertainty, BUCKETS };
