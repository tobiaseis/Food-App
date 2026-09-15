'use strict';

/**
 * Et kvalificeret gæt på normalprisen, gratis og med det samme.
 *
 * For en vare med tilbudshistorik er den HØJESTE observerede kr/kg tættere
 * på normalprisen end medianen: det er den uge, hvor rabatten var mindst.
 * Det er ikke rigtigt — det er et udgangspunkt, der er bedre end ingenting,
 * og det markeres som 'derived', så arbejdslisten sætter det forrest.
 *
 * Kun 102 af de 190 varer, der skal prissættes, har overhovedet historik.
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

// Varer, hvor stk -> kg-omregningen giver en pris, der ikke findes i nogen
// butik. De står her frem for at blive fanget af OUTLIER_FACTOR, fordi filtret
// måler mod varens EGEN median: er alle varens observationer forkerte, bliver
// medianen selv forkert, og filtret ser ingenting. Hver linje er en fejl, der
// skal rettes et andet sted — ikke en konstant, der skal justeres her.
const PIECE_CONVERSION_BLOCKED = new Map([
  ['selleri',
   'items.piece_g = 40 g er ÉN stang bladselleri. Avisens "1 stk selleri" er '
   + 'hele bundtet eller knolden (400-800 g), så omregningen giver 250-300 kr/kg '
   + 'mod en virkelig pris omkring 20-30. piece_g er forkert og skal rettes i plan 1.'],
  ['appelsin',
   'varens eneste stk-tilbud er "Orange ilddæmon" til 1999 kr i Bilka — en '
   + 'fejlkobling til et stykke legetøj. Omregnet 14.280 kr/kg. Medianfiltret er '
   + 'blindt for den netop fordi den er den eneste observation, varen har.'],
]);

/**
 * "1 stk blomkål 15 kr" er en kilopris, så snart man kender stykvægten.
 * Muterer rækkerne på plads og returnerer de varer, der blev holdt udenfor.
 */
function convertPieceOffers(rows, items) {
  const blocked = new Map();
  const out = [];
  for (const r of rows) {
    const item = items.get(r.item_key);
    if (!item || r.base_unit !== 'stk' || item.base_unit !== 'kg' || item.piece_g == null) {
      out.push(r);
      continue;
    }
    const kg = item.piece_g / 1000;
    const perKg = r.unit_price / kg;
    if (PIECE_CONVERSION_BLOCKED.has(r.item_key)) {
      const b = blocked.get(r.item_key)
        || { reason: PIECE_CONVERSION_BLOCKED.get(r.item_key), piece_g: item.piece_g, prices: [] };
      b.prices.push(perKg);
      blocked.set(r.item_key, b);
      continue;
    }
    // Pakken omregnes med, ellers kommer pris og pakke i forskellige enheder.
    // Afrundingen er kun mod flydertals-støj: 6 stk à 150 g er 0,9 kg, ikke
    // 0,8999999999999999, og pack_qty indgår i tabellens unikke nøgle.
    r.unit_price = perKg;
    r.base_qty = Math.round(r.base_qty * kg * 1000) / 1000;
    r.base_unit = 'kg';
    out.push(r);
  }
  return { rows: out, blocked };
}

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
  const since = new Date(Date.now() - HORIZON_DAYS * 86400000).toISOString();

  const items = new Map(db.prepare('SELECT key, class, base_unit, piece_g FROM items').all()
    .map((i) => [i.key, i]));

  // Én observation pr. (vare, kæde, uge): den samme vare optræder flere gange
  // i samme avis, og uden grupperingen vægter en travl uge tungere.
  //
  // Prisen og pakken SKAL komme fra samme tilbud. To uafhængige MIN()-aggregater
  // parrer den billigste pris med den mindste pakke, og de to stammer fra hver
  // sin række: 171 af 786 ugegrupper gav en kombination, der ikke findes i nogen
  // butik. row_number() vælger én række og tager begge værdier fra den.
  //
  // Enhedskravet slipper stk-tilbud på kg-varer igennem, når stykvægten kendes:
  // 16 varer — heraf 7 grøntsager — sælges kun "pr. stk" i aviserne og ville
  // ellers slet ikke få en pris.
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
           AND (o.base_unit = i.base_unit
                OR (i.base_unit = 'kg' AND o.base_unit = 'stk' AND i.piece_g IS NOT NULL))
           AND COALESCE(o.run_from, o.observed_at) >= ?
      )
     WHERE rn = 1
  `).all(since);

  const { rows: usable, blocked } = convertPieceOffers(rows, items);
  const { kept, rejected } = rejectMislinks(usable);

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

  // Og de varer, omregningen blev holdt væk fra. De står ikke i basen og har
  // heller ingen pris — hvilket er meningen. Linjen her er den eneste grund
  // til, at fejlen ikke bliver glemt.
  if (blocked.size) {
    console.log('\nikke omregnet fra stk til kg:');
    for (const [key, b] of blocked) {
      const s = [...b.prices].sort((a, z) => a - z);
      const med = Math.round(s[Math.floor(s.length / 2)]);
      console.log(`  ${key.padEnd(16)} ville give ~${med} kr/kg af ${s.length} tilbud (piece_g = ${b.piece_g})`);
      console.log(`    ${b.reason}`);
    }
  }
  db.close();
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

module.exports = {
  leastDiscounted, rejectMislinks, convertPieceOffers,
  OUTLIER_FACTOR, HORIZON_DAYS, PIECE_CONVERSION_BLOCKED,
};
