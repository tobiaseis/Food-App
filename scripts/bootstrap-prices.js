'use strict';

/**
 * Et kvalificeret gæt på normalprisen, gratis og med det samme.
 *
 * For en vare med tilbudshistorik er den HØJESTE observerede kr/kg tættere
 * på normalprisen end medianen: det er den uge, hvor rabatten var mindst.
 * Det er ikke rigtigt — det er et udgangspunkt, der er bedre end ingenting,
 * og det markeres som 'derived', så arbejdslisten sætter det forrest.
 *
 * Kun 83 af de 184 varer, der skal prissættes, har brugbar historik.
 * De øvrige skal indtastes. Scriptet siger hvor mange.
 *
 *   npm run prices:bootstrap
 */

const { getDb } = require('../src/db');
const path = require('node:path');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

// Tilbud ældre end dette siger intet om prisen i dag.
const HORIZON_DAYS = 400;

// En vare har højst 5 ugentlige observationer i denne base. Ved den slags
// stikprøvestørrelser kan INGEN percentil udelukke den øverste værdi:
// Math.floor(n * 0.9) giver n-1 for ethvert n <= 10. Derfor er reglen skrevet
// som det, den faktisk er — næsthøjeste når der er nok at vælge imellem,
// ellers højeste — i stedet for en percentil, der lover robusthed, den ikke har.
function leastDiscounted(sorted) {
  if (!sorted.length) return null;
  return sorted.length >= 3 ? sorted[sorted.length - 2] : sorted[sorted.length - 1];
}

// Tilbudsrækkerne indeholder fejlkoblinger: "Cerave moisturising lotion eller
// cream" hænger på produktet Fløde, "Apple iPad" på æble. En forkert pris er
// værre end en manglende: den manglende gør opskriften uprissaetbar og synlig,
// den forkerte gør den forkert og tavs. Derfor kasseres de — og de PRINTES,
// så taksonomifejlen bag dem ikke forsvinder ned i et filter.
const OUTLIER_FACTOR = 5;

/**
 * Kassér fejlkoblingerne, før de bliver til priser. Medianen regnes pr. vare
 * på tværs af kæder, så grænsen kalibrerer sig selv i stedet for at være et
 * tal, nogen har gættet.
 */
function rejectMislinks(rows) {
  const perItem = new Map();
  for (const r of rows) {
    if (!perItem.has(r.item_key)) perItem.set(r.item_key, []);
    perItem.get(r.item_key).push(r.unit_price);
  }
  const medians = new Map();
  for (const [k, v] of perItem) {
    const s2 = [...v].sort((a, z) => a - z);
    medians.set(k, s2[Math.floor(s2.length / 2)]);
  }
  const rejected = [];
  const kept = rows.filter((r) => {
    const med = medians.get(r.item_key);
    if (med && r.unit_price > med * OUTLIER_FACTOR) { rejected.push({ ...r, med }); return false; }
    return true;
  });
  return { kept, rejected };
}

function main() {
  const db = getDb();
  try {
    const since = new Date(Date.now() - HORIZON_DAYS * 86400000).toISOString();

    const items = new Map(db.prepare('SELECT key, class FROM items').all()
      .map((i) => [i.key, i]));

    // Én observation pr. (vare, kæde, uge): den samme vare optræder flere gange
    // i samme avis, og uden grupperingen vægter en travl uge tungere.
    //
    // Prisen og pakken SKAL komme fra samme tilbud. To uafhængige MIN()-aggregater
    // parrer den billigste pris med den mindste pakke, og de to stammer fra hver
    // sin række: 171 af 786 ugegrupper gav en kombination, der ikke findes i nogen
    // butik. row_number() vælger én række og tager begge værdier fra den.
    //
    // Enhedskravet er skarpt med vilje: tilbuddets enhed SKAL være varens egen.
    // Det koster 7 grøntsager en pris, hvor avisen kun skriver "1 stk", og det
    // er fristende at hente dem ind med items.piece_g. Man må ikke. piece_g er
    // den BRUGBARE stykvægt — "1 løg" i en opskrift — ikke den købte: blomkål
    // står til 500 g mod et helt hoveds ~1 kg, porre til 150 g mod ~250 g.
    // Omregnede man, ville unit_price betyde kroner pr. KØBT kilo på de rigtige
    // kg-rækker og kroner pr. BRUGBART kilo på de omregnede, og sammenligning
    // på tværs af kæder — hele grunden til at tabellen findes — ville falde.
    // Målt på porre: 93 kr/kg omregnet mod 25-40 i virkeligheden. De 7 går i
    // den manuelle bunke i stedet, hvor et menneske læser hyldeprisen.
    const rows = db.prepare(`
      SELECT item_key, chain_id, base_unit, year, week, unit_price, base_qty
        FROM (
          SELECT p.item_key, o.chain_id, o.base_unit, o.year, o.week,
                 o.unit_price, o.base_qty,
                 row_number() OVER (
                   PARTITION BY p.item_key, o.chain_id, o.base_unit, o.year, o.week
                   ORDER BY o.unit_price ASC, o.id ASC
                 ) AS rn
            FROM offers o
            JOIN products p ON p.id = o.product_id
            JOIN items    i ON i.key = p.item_key
           WHERE p.item_key IS NOT NULL
             AND i.class <> 'essential'
             AND i.category <> 'nonfood'
             AND COALESCE(p.prepared, 0) = 0
             AND o.unit_price IS NOT NULL AND o.unit_price > 0
             AND o.base_qty  IS NOT NULL AND o.base_qty  > 0
             AND o.base_unit = i.base_unit
             AND COALESCE(o.run_from, o.observed_at) >= ?
        )
       WHERE rn = 1
    `).all(since);

    const { kept, rejected } = rejectMislinks(rows);

    const buckets = new Map();
    for (const r of kept) {
      const k = `${r.item_key}|${r.chain_id}`;
      if (!buckets.has(k)) {
        buckets.set(k, { item_key: r.item_key, chain_id: r.chain_id,
                         base_unit: r.base_unit, obs: [] });
      }
      // Pris og pakke bliver i par. Bucket'en må ikke blande dem sammen igen,
      // efter SQL'en netop har holdt dem sammen.
      buckets.get(k).obs.push({ price: r.unit_price, pack: r.base_qty });
    }

    const ins = db.prepare(`
      INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit,
                               pack_price, unit_price, n_obs, source, observed_at, valid_until)
      VALUES (@item_key, @chain_id, @pack_qty, @pack_unit,
              @pack_price, @unit_price, @n_obs, 'derived', @observed_at, @valid_until)
      ON CONFLICT(item_key, chain_id, pack_qty, pack_unit) DO UPDATE SET
        pack_price = excluded.pack_price, unit_price = excluded.unit_price,
        n_obs = excluded.n_obs,
        observed_at = excluded.observed_at, valid_until = excluded.valid_until
       -- Et gæt må aldrig overskrive en rigtig pris.
       WHERE item_prices.source = 'derived'
    `);

    // Pakken indgår i nøglen, og den valgte pakke flytter sig, når nye tilbud
    // kommer ind (målt: 17 af 548 bøtter skifter pakke mellem et 400- og et
    // 120-dages vindue). Uden en oprydning bliver den gamle række liggende for
    // evigt ved siden af den nye. Og udelukker et nyt filter en vare helt — som
    // non-food nu bliver — ville dens gamle gæt aldrig blive rørt igen.
    //
    // Derfor er kørslen en fuld genopbygning af det gættede: alle 'derived'
    // ryddes først, 'manual' og 'api:rema' røres ikke. ON CONFLICT-guarden
    // ovenfor er stadig nødvendig — efter sletningen kan et sammenstød kun
    // være med en rigtig pris, og der skal gættet holde sig væk.
    const clearAllDerived = db.prepare("DELETE FROM item_prices WHERE source = 'derived'");

    // Men en genopbygning uden noget at bygge med er bare en sletning. Er
    // offers tom eller forældet, eller udelukker et fremtidigt filter alt,
    // ville item_prices tavst blive skrabet ned til 'manual' og 'api:rema'.
    // Transaktionen ruller kun tilbage på en undtagelse, så det SKAL kastes:
    // en advarsel og et return ville lade sletningen stå.
    if (!buckets.size) {
      throw new Error(
        `ingen brugbare tilbud inden for ${HORIZON_DAYS} dage — afbryder uden at røre `
        + 'basen, frem for at slette alle gættede priser og skrive nul nye');
    }

    const now = new Date();
    let written = 0;
    const run = db.transaction(() => {
      const dropped = clearAllDerived.run().changes;
      if (dropped) console.log(`ryddede ${dropped} tidligere gæt`);
      for (const b of buckets.values()) {
        const item = items.get(b.item_key);
        if (!item) continue;
        // Vælg observationen, ikke tallet: den uge, hvor rabatten var mindst,
        // og den pakke, DEN uge blev solgt i.
        const sorted = [...b.obs].sort((a, z) => a.price - z.price);
        const pick = leastDiscounted(sorted);
        if (!pick || !pick.price || !pick.pack) continue;

        written += ins.run({
          item_key: b.item_key, chain_id: b.chain_id,
          pack_qty: pick.pack, pack_unit: b.base_unit,
          pack_price: Math.round(pick.price * pick.pack * 100) / 100,
          unit_price: Math.round(pick.price * 100) / 100,
          n_obs: b.obs.length,
          observed_at: now.toISOString(),
          valid_until: engine.validUntilFor(item.class, now),
        }).changes;
      }
    });
    run();

    const priceable = db.prepare(
      "SELECT count(*) c FROM items WHERE class <> 'essential' AND category <> 'nonfood'").get().c;
    const covered = db.prepare('SELECT count(DISTINCT item_key) c FROM item_prices').get().c;
    console.log(`rækker skrevet: ${written}`);
    console.log(`varer med mindst én pris: ${covered} af ${priceable}`);
    console.log(`mangler helt: ${priceable - covered} — de skal i data/item_prices.csv`);
    console.log(`bygget på én enkelt observation: ${
      db.prepare("SELECT count(*) c FROM item_prices WHERE source='derived' AND n_obs = 1").get().c
    } rækker — dem skal arbejdslisten tage først`);

    // Det kasserede printes. Hver linje er en fejlkobling i taksonomien, og den
    // findes stadig i tilbudslisten, brugeren ser — filteret her skjuler den kun
    // for priserne.
    if (rejected.length) {
      console.log(`
kasseret som fejlkobling (> ${OUTLIER_FACTOR}x medianen for varen):`);
      for (const r of rejected.sort((a, z) => z.unit_price / z.med - a.unit_price / a.med)) {
        console.log(`  ${r.item_key.padEnd(16)} ${String(Math.round(r.unit_price)).padStart(6)}/${r.base_unit}` +
                    ` (median ${Math.round(r.med)})`);
      }
    }
  } finally {
    // Skal i finally. Kastes der — tom genopbygning, en låst base — ville en
    // close() til sidst i main() aldrig blive nået, og håndtaget blive hængende
    // med sine WAL-filer åbne.
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // Scriptet skriver som standard i data.db. En rå stacktrace midt i en
    // transaktion siger ikke, om noget nåede at blive skrevet.
    console.error('bootstrap afbrudt:', err.message);
    process.exitCode = 1;
  }
}

module.exports = { leastDiscounted, rejectMislinks, OUTLIER_FACTOR, HORIZON_DAYS };
