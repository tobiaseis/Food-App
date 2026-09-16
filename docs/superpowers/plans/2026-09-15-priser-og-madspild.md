# Priser og madspild — implementeringsplan (plan 2 af 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give varerne en normalpris, så en opskrift kan prissættes uden at være på tilbud, og lade madplanen regne på hele pakker i stedet for på kr/kg — så ugen kan sammensættes, så pakkerne bliver brugt op.

**Architecture:** `item_prices` holder normalprisen pr. (vare, kæde, pakke). Den effektive pris er `coalesce(aktivt tilbud, normalpris)` og beregnes af rene funktioner i `public/engine.js`, som serveren allerede indlæser med `require` — så reglen findes ét sted og kan ikke drive fra hinanden. `recipe_costs` er den forudberegnede tabel, budget-sporet sorterer efter. Madplans-motoren får pakkeafrunding, spildvægtning efter `items.keeps`, to forslag og et eksakt valg af kædedelmængde.

**Tech Stack:** Node ≥20 (CommonJS), better-sqlite3 v11, `node:test`. Ingen nye afhængigheder.

**Spec:** `docs/superpowers/specs/2026-09-06-database-design.md` — denne plan dækker afsnit 4, skridt 6-8.
**Forudsætning:** plan 1 (`2026-09-06-varetyper-og-maengder.md`) er kørt og pushet.
**API-grundlag:** `docs/superpowers/specs/2026-09-06-api-undersoegelse.md`.

## Udgangspunktet, målt

| | |
|---|---|
| Varer i basen | 204, heraf **190 der skal prissættes** (14 er `essential`) |
| Kæder | 14 |
| Prissætbare opskrifter | 1.546 af 2.224 |
| Tilbud med pakkestørrelse | 5.195 af 5.195 |
| **Varer med tilbudshistorik** | **102 af 190** |

Det sidste tal er planens vigtigste. Den afledte bootstrap kan kun gætte en normalpris for varer, der har været på tilbud — **88 varer har ingen historik og skal indtastes fra dag ét.**

> **Rettet efter opgave 1, med målte tal.** Tallet stod oprindeligt som 113. Det var talt
> uden essential-filteret: 11 af de 113 er salt, peber, olie og lignende, som aldrig skal
> prissættes. Loftet er 102. Non-food tæller heller ikke med, så nævneren er **184, ikke 190**.
>
> Bootstrappen dækker i praksis **83 af 184 varer** med 548 rækker. **101 varer skal
> indtastes manuelt.** Og det tal, der betyder mest for tilliden: **349 af de 548 rækker
> hviler på én eneste observation.** To tredjedele af de afledte priser er altså ét
> tilfældigt tilbud. Derfor findes `n_obs`, og derfor sorterer arbejdslisten efter den.

Og API-undersøgelsen flyttede grundlaget: designet regnede med 8 af 14 kæder automatisk, svaret blev **1 af 14**. Kun REMA 1000. Derfor vægter denne plan CSV-importøren tungere end API-klienten, og API-klienten er én opgave, ikke tre.

## Global Constraints

- Node ≥20, CommonJS (`require`/`module.exports`), `'use strict';` øverst i hver fil.
- Ingen nye npm-afhængigheder. `better-sqlite3` er den eneste runtime-afhængighed; `fetch` er global i Node 20.
- Kommentarer på dansk, der forklarer **hvorfor**, ikke hvad. Følg tonen i `src/lib/taxonomy.js` og `src/lib/normalize.js`.
- **`public/engine.js` skal kunne indlæses både i Node og i en browser, og må aldrig røre databasen.** Den er UMD-pakket; serveren indlæser den med `require` fra `src/mealplan/generate.js:33`. Nye regler, som både server og browser skal bruge, lægges dér — ikke i to kopier.
- Nye tabeller i `src/db/schema.sql` som `CREATE TABLE IF NOT EXISTS`; nye kolonner på eksisterende tabeller i `migrate()` i `src/db/index.js`.
- Nye testfiler skal tilføjes til `test`-scriptet i `package.json`.
- Testsuiten kører mod `test.db`, ikke `data.db` — sat af `test/helpers/set-test-db.js` via `node -r`, seedet af `pretest`. Rører du seed-data, så husk at `pretest` kun reseeder, når `items` er tom.
- `data.db` er produktionsdata. Tag en kopi før destruktive kørsler.
- Commit efter hver opgave.

## Filstruktur

| fil | ansvar |
|---|---|
| `src/db/schema.sql` | **ændres** — `item_prices`, `recipe_costs` |
| `scripts/bootstrap-prices.js` | **ny** — afledt normalpris fra tilbudshistorik (`source='derived'`) |
| `data/item_prices.csv` | **ny** — den manuelle priskilde, git-versioneret |
| `scripts/import-prices.js` | **ny** — CSV → `item_prices`, med validering |
| `src/prices/rema.js` | **ny** — REMA-klient: søg, udled pakkestørrelse |
| `scripts/fetch-rema-prices.js` | **ny** — kører klienten over alle varer, skriver `source='api:rema'` |
| `scripts/price-worklist.js` | **ny** — hvilke priser mangler eller er udløbet |
| `public/engine.js` | **ændres** — effektiv pris, pakkeafrunding, spildvægt, to forslag, kædedelmængder, to lister |
| `src/mealplan/generate.js` | **ændres** — henter `item_prices` og sender dem til motoren |
| `scripts/recompute-recipe-costs.js` | **ny** — fylder `recipe_costs` |
| `src/sync/build.js` | **ændres** — synker `item_prices` og `recipe_costs` |
| `supabase/schema.sql` | **ændres** — samme to tabeller |
| `test/prices.test.js` | **ny** |
| `test/waste.test.js` | **ny** |

Prisreglerne bor i `engine.js`, fordi de er de eneste regler, både serveren og browseren skal være enige om. Det er samme argument, som gjorde `src/lib/items.js` til en ren funktion i plan 1 — og samme grund til, at der ikke må opstå en server-kopi.

---

### Task 1: `item_prices` + afledt bootstrap

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.js` (`migrate()` — omdøbning af `products.taxonomy_key`)
- Create: `scripts/bootstrap-prices.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `items` (204 rækker), `offers` (5.195), `products`, `chains`
- Produces: tabellen `item_prices`; `npm run prices:bootstrap` fylder den for de varer, der har tilbudshistorik

- [x] **Step 1: Ryd op i en rest fra plan 1**

`products.taxonomy_key` blev aldrig omdøbt til `item_key`, selvom spec afsnit 1.3 siger det og `recipe_ingredients` fik omdøbningen. Alle 212 udfyldte nøgler peger på gyldige varer, så det er kosmetisk — men denne plan joiner `offers → products → items` mange gange, og to navne for samme fremmednøgle er en fælde.

I `migrate()` i `src/db/index.js`, i `added`-arrayet og efter det:

```js
    ['products', 'item_key', 'TEXT'],
```

og derefter, før drop-løkken:

```js
  // products.taxonomy_key blev ikke omdøbt i plan 1. Samme information, to
  // navne, og denne plan joiner offers -> products -> items igen og igen.
  {
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    if (cols.includes('taxonomy_key')) {
      db.exec(`UPDATE products SET item_key = taxonomy_key
                WHERE item_key IS NULL AND taxonomy_key IS NOT NULL`);
      // SQLite nægter at droppe en indekseret kolonne. Indekset beholder sit
      // NAVN og flytter til item_key: skifter navnet, vil schema.sql forsøge at
      // oprette det på en base, hvor item_key endnu ikke findes, og så kan
      // basen ikke åbnes. Samme fælde er dokumenteret for idx_ri_tax.
      db.exec('DROP INDEX IF EXISTS idx_products_tax');
      db.exec('ALTER TABLE products DROP COLUMN taxonomy_key');
      db.exec('CREATE INDEX IF NOT EXISTS idx_products_tax ON products(item_key)');
    }
  }
```

**`src/db/schema.sql` skal med i samme ombæring.** Den deklarerer `taxonomy_key` på
`products` og køres ved HVER åbning, før `migrate()`. Står den uændret, fødes en frisk
base med en kolonne, `migrate()` straks dropper igen. Behold indeksnavnet `idx_products_tax`.

Ret derefter de kaldssteder, grep'et finder — og vær opmærksom på, at grep'et **ikke**
fanger `SELECT * FROM products` (`src/server.js`). Den slags skal findes i hånden.
Ved kanten mod browseren og Supabase beholdes det gamle navn med `item_key AS taxonomy_key`:

```bash
grep -rn "p\.taxonomy_key\|products.*taxonomy_key" src/ scripts/ test/ --include=*.js
```

- [x] **Step 2: Tabellen**

I `src/db/schema.sql`, efter `item_synonyms`:

```sql
-- ── Normalpriser ────────────────────────────────────────────────────────────
-- Hvad varen koster, når den IKKE er på tilbud. Findes ikke i tilbudsaviserne
-- og er derfor det, hele denne plan handler om at skaffe.
--
-- Pakken står i rækken, ikke kun kr/kg. Uden den kan restvare-optimeringen
-- ikke lade sig gøre, og en opskriftspris regnet som mængde × kr/kg er
-- systematisk for lav: skal man bruge 0,5 kg kartofler, koster det hele posen.
CREATE TABLE IF NOT EXISTS item_prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key    TEXT NOT NULL REFERENCES items(key) ON DELETE CASCADE,
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  pack_qty    REAL NOT NULL CHECK (pack_qty > 0),
  pack_unit   TEXT NOT NULL CHECK (pack_unit IN ('kg','l','stk')),
  pack_price  REAL NOT NULL CHECK (pack_price > 0),
  -- kr pr. base_unit. Gemt frem for regnet, så SQL kan sortere på den.
  unit_price  REAL NOT NULL,
  -- Hvor mange ugentlige observationer et 'derived'-gæt hviler på. En række med
  -- n_obs = 1 er ét enkelt tilbud og næsten intet værd; arbejdslisten sorterer
  -- efter den. 'manual' og 'api:rema' sætter 0: de er ikke gættet frem.
  n_obs       INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL CHECK (source IN ('manual','derived','api:rema')),
  observed_at TEXT NOT NULL,
  -- Kadencen som data, ikke som en kommentar i en cronjob: fresh 3 mdr,
  -- baseline 6 mdr. Det er denne kolonne, arbejdslisten spørger til.
  valid_until TEXT NOT NULL,
  UNIQUE (item_key, chain_id, pack_qty, pack_unit)
);
CREATE INDEX IF NOT EXISTS idx_item_prices_item  ON item_prices(item_key, chain_id);
CREATE INDEX IF NOT EXISTS idx_item_prices_stale ON item_prices(valid_until);
```

`pack_unit` **skal** være varens `base_unit` — 400 g hakket oksekød indføres som `pack_qty = 0.4, pack_unit = 'kg'`. Ellers er `unit_price` meningsløs. Importøren i opgave 2 afviser rækker, der bryder det; her er det en `CHECK` på værdimængden og en regel, alle skrivere holder.

- [x] **Step 3: Skriv den fejlende test**

Opret `test/prices.test.js` og tilføj den til `package.json`s `test`-script:

```js
'use strict';

/**
 * Tests for normalpriser og pakkeregning.
 *
 * Den centrale regel: en pris uden en pakkestørrelse kan ikke bruges. Man
 * køber ikke en halv pose kartofler, og hele planens madspilds-optimering
 * hviler på at kende pakken, ikke kun kiloprisen.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('validUntilFor følger varens klasse', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // fresh: 3 måneder. baseline: 6. Essentials prissættes aldrig.
  near(Date.parse(engine.validUntilFor('fresh', new Date(t0))) - t0, 90 * 86400000);
  near(Date.parse(engine.validUntilFor('baseline', new Date(t0))) - t0, 180 * 86400000);
  assert.equal(engine.validUntilFor('essential', new Date(t0)), null);
});
```

- [x] **Step 4: Kør testen og se den fejle**

Kør: `node --test test/prices.test.js`
Forventet: FAIL — `engine.validUntilFor is not a function`.

- [x] **Step 5: Læg kadencen i `engine.js`**

I `public/engine.js`, ved de andre konstanter:

```js
  // Hvor længe en normalpris må stå, før den skal ses efter. Tallene er
  // spec afsnit 3.5: fresh svinger med sæson og leverandør, baseline gør
  // ikke. Essentials får aldrig en pris, så de har heller ingen frist.
  const PRICE_TTL_DAYS = { fresh: 90, baseline: 180, essential: null };

  function validUntilFor(itemClass, observedAt = new Date()) {
    const days = PRICE_TTL_DAYS[itemClass];
    if (days == null) return null;
    return new Date(observedAt.getTime() + days * 86400000).toISOString();
  }
```

Tilføj `validUntilFor` og `PRICE_TTL_DAYS` til returobjektet nederst i filen.

- [x] **Step 6: Skriv bootstrap-scriptet**

```js
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
// cream" hænger på produktet Fløde, "Apple Macbook Pro" på æble. 39 af 2.333
// tilbud ligger over 5 gange medianen for deres egen vare. En forkert pris er
// værre end en manglende: den manglende gør opskriften uprissaetbar og synlig,
// den forkerte gør den forkert og tavs. Derfor kasseres de — og de PRINTES,
// så taksonomifejlen bag dem ikke forsvinder ned i et filter.
const OUTLIER_FACTOR = 5;

function main() {
  const db = getDb();
  const since = new Date(Date.now() - HORIZON_DAYS * 86400000).toISOString();

  // Én observation pr. (vare, kæde, uge): den samme vare optræder flere gange
  // i samme avis, og uden grupperingen vægter en travl uge tungere.
  //
  // Prisen og pakken SKAL komme fra samme tilbud. To uafhængige MIN()-aggregater
  // parrer den billigste pris med den mindste pakke, og de to stammer fra hver
  // sin række: 171 af 786 ugegrupper gav en kombination, der ikke findes i nogen
  // butik. row_number() vælger én række og tager begge værdier fra den.
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

  // Kassér fejlkoblingerne, før de bliver til priser. Medianen regnes pr. vare
  // på tværs af kæder, så grænsen kalibrerer sig selv i stedet for at være et
  // tal, nogen har gættet.
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

  const items = new Map(db.prepare('SELECT key, class, base_unit FROM items').all()
    .map((i) => [i.key, i]));

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
  // nedenfor er stadig nødvendig — efter sletningen kan et sammenstoed kun
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
  db.close();
}

try {
  main();
} catch (err) {
  // Scriptet skriver som standard i data.db. En rå stacktrace midt i en
  // transaktion siger ikke, om noget nåede at blive skrevet.
  console.error('bootstrap afbrudt:', err.message);
  process.exitCode = 1;
}
```

- [x] **Step 7: Tilføj scriptet og kør det mod en kopi**

```json
"prices:bootstrap": "node scripts/bootstrap-prices.js",
```

```bash
cp data.db data.db.pre-prices
npm run prices:bootstrap
```

Forventet: `varer med mindst én pris` lander omkring **83 af 184**. Ligger det væsentligt lavere, filtrerer `o.base_unit = i.base_unit` mere fra end ventet — undersøg hvilke varer der falder ud, før du går videre.

Loftet er 102: kun så mange ikke-essentielle varer har overhovedet et tilbud bag sig. 9 af de
resterende er non-food (vin, rengøring, toiletpapir, elektronik) og skal aldrig prissættes.

- [x] **Step 8: Stikprøve mod virkeligheden**

```bash
node -e "
const db=require('better-sqlite3')('data.db',{readonly:true});
for(const r of db.prepare(\"select ip.item_key, c.name chain, ip.pack_qty, ip.pack_unit, ip.pack_price, ip.unit_price from item_prices ip join chains c on c.id=ip.chain_id where ip.item_key in ('kartofler','hakket_oksekoed','floede') order by ip.item_key, ip.unit_price\").all())
  console.log(r.item_key.padEnd(18), r.chain.padEnd(14), r.pack_qty+r.pack_unit, r.pack_price+' kr', '('+r.unit_price+'/'+r.pack_unit+')');
"
```

Tallene skal ligne butikspriser. Kartofler under 5 kr/kg eller hakket oksekød under 40 kr/kg
betyder, at estimatoren rammer for lavt — rapportér det frem for at justere `OUTLIER_FACTOR`
eller `leastDiscounted` i blinde.

**Læs også listen over kasserede linjer, scriptet printer til sidst.** Hver af dem er en
fejlkobling mellem et tilbud og en vare. De er filtreret væk fra priserne, men de står stadig
i den tilbudsliste, brugeren ser.

En ting må stå klart om det, der bliver tilbage: den afledte pris er bygget af TILBUDSpriser.
En kæde, der rabatterer dybt og ofte, får derfor systematisk for lav normalpris — målt står
REMA's hakkede oksekød til 62,50 kr/kg mod Brugsens 122,50, og forskellen er større end den
virkelige. Det kan ikke rettes med tilbudsdata alene, og det er derfor opgave 8 ikke må vælge
kæde på 'derived'-priser uden at sige det højt.

- [ ] **Step 9: Lad være med at omregne stk-tilbud — og skriv hvorfor**

> **Dette trin bad oprindeligt om det modsatte.** Det blev skrevet, rullet ud og rullet
> tilbage igen, fordi implementeringen afdækkede noget, planen ikke vidste. Historikken
> bliver stående, så ingen genopfinder idéen.

Enhedsfiltret taber 7 grøntsager, hvor avisen skriver "1 stk" og varen regnes i kg, og det
lød oplagt at hente dem ind med `items.piece_g`. Det må man ikke, og grunden står i
`src/lib/units.js`: *"Typisk stykvægt når opskriften bare siger '1 løg'"*. `piece_g` er
den **brugbare** vægt — det, der ender i gryden — ikke det, man lægger i kurven.
Blomkål står til 500 g, mens et helt hoved vejer omkring et kilo. Porre står til 150 g
mod en hel porres ~250 g.

Omregner man alligevel, kommer `item_prices.unit_price` til at betyde to forskellige ting
afhængigt af, hvor rækken kom fra: kroner pr. **købt** kilo for de 544 rækker fra rigtige
kg-tilbud, og kroner pr. **brugbart** kilo for de 39 omregnede. De to kan ikke sammenlignes,
og det er netop sammenligning på tværs af kæder, hele tabellen findes for. Målt på porre:
93 kr/kg omregnet mod 25-40 kr/kg i virkeligheden.

**Derfor: ingen omregning.** De 7 grøntsager får ingen afledt pris og går i den manuelle
bunke i opgave 2, hvor et menneske læser hyldeprisen. Færre og rigtige slår flere og
skæve — samme regel som alle andre steder i denne plan. Fjern også
`PIECE_CONVERSION_BLOCKED`: når ingen omregnes, er der intet at blokere.

Forventet efter dette trin: **83 varer af 184**, og 101 i den manuelle bunke.

> **Til opgave 5, og det er en ægte mangel:** opskriftsmængder er i brugbare gram, mens
> man køber hele grøntsager. "400 g broccoli" kræver et hoved på ~570 g. Prissættes der
> på købt vægt uden et udbytte-forhold, bliver enhver grøntsagstung ret for billig.
> Det hører hjemme i pakkeafrundingen, ikke i priskolonnen — afklares i opgave 5 med
> rigtige tal i hånden.

- [x] **Step 10: Bind de to farlige veje til testsuiten**

Hverken omdøbningen i `migrate()` eller `bootstrap-prices.js` kører nogensinde i CI:
`pretest` bygger `test.db` frisk fra `schema.sql`, hvor `taxonomy_key` aldrig har eksisteret.
I plan 1 var det netop en utestet migrationsvej, der slettede 26.242 nøgler.

I `test/prices.test.js`:

1. Byg en midlertidig base i `os.tmpdir()`, opret `products` med den GAMLE kolonne
   `taxonomy_key` og en række med en nøgle i, sæt `DB_PATH` til den, åbn via `getDb()`,
   og fastslå: kolonnen hedder nu `item_key`, værdien er bevaret, indekset findes, og
   en anden åbning ændrer intet.
2. Test `leastDiscounted` direkte: `[1,2,3]` → `2` (næsthøjeste), `[1,2]` → `2`
   (højeste, for få til at kassere noget), `[]` → `null`.
3. Test outlier-filtret på en håndskrevet rækkeliste: en vare med priser
   `[10, 11, 12, 300]` skal kassere de 300 og vælge 11.

Punkt 2 og 3 kræver, at `leastDiscounted` og filterfunktionen kan indlæses. Læg dem i
`module.exports` i `scripts/bootstrap-prices.js`, og lad `main()` køre som nu — scriptet
må ikke køre ved `require`. Brug `require.main === module`.

- [x] **Step 11: Kør suiten og commit**

```bash
npm test
git add src/db/schema.sql src/db/index.js scripts/bootstrap-prices.js test/prices.test.js package.json src/
git commit -m "item_prices med pakkestoerrelse, og afledt bootstrap fra tilbudshistorik"
```

---

### Task 2: CSV-importøren

Den manuelle priskilde. Efter API-undersøgelsen er det hovedvejen, ikke reservevejen.

**Files:**
- Create: `data/item_prices.csv`
- Create: `scripts/import-prices.js`
- Create: `scripts/price-worklist.js`
- Modify: `package.json`
- Modify: `test/prices.test.js`

**Interfaces:**
- Consumes: `items`, `chains`, `engine.validUntilFor`
- Produces: `npm run prices:import` og `npm run prices:worklist`

- [ ] **Step 1: Formatet**

Opret `data/item_prices.csv` med en håndfuld ægte rækker som skabelon:

```csv
item_key,chain_slug,pack_qty,pack_unit,pack_price,observed_at
kartofler,rema1000,2,kg,15.95,2026-09-15
hakket_oksekoed,rema1000,0.4,kg,32.00,2026-09-15
floede,netto,0.25,l,9.50,2026-09-15
```

Kolonnen er `chain_slug`, ikke `chain_id`: kædernes id'er er uigennemsigtige Tjek-id'er (`bdf5A` er føtex), og ingen kan redigere dem i hånden. Importøren slår op via `chains.slug`.

Filen er git-versioneret med vilje. Ændrer en pris sig fra 15,95 til 18,50, kan man se hvornår og hvorfor — det kan en admin-side i appen ikke.

- [ ] **Step 2: Skriv de fejlende tests**

Tilføj til `test/prices.test.js`:

```js
const { parsePriceRow } = require('../scripts/import-prices');

test('importøren afviser en pakkeenhed, der ikke er varens egen', () => {
  // 400 g hakket oksekød skal ind som 0.4 kg. Med 'g' ville unit_price
  // blive 0,08 kr/g og alle sammenligninger med tilbud skride.
  const items = new Map([['hakket_oksekoed', { key: 'hakket_oksekoed', class: 'fresh', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const bad = parsePriceRow(
    { item_key: 'hakket_oksekoed', chain_slug: 'rema1000', pack_qty: '400',
      pack_unit: 'g', pack_price: '32', observed_at: '2026-09-15' },
    { items, chains, line: 2 },
  );
  assert.ok(bad.error, 'skulle være afvist');
  assert.match(bad.error, /pack_unit/);
});

test('importøren afviser ukendt vare og ukendt kæde', () => {
  const items = new Map();
  const chains = new Map();
  const a = parsePriceRow({ item_key: 'findes_ikke', chain_slug: 'rema1000', pack_qty: '1',
    pack_unit: 'kg', pack_price: '10', observed_at: '2026-09-15' }, { items, chains, line: 2 });
  assert.match(a.error, /item_key/);
});

test('importøren regner unit_price og valid_until selv', () => {
  const items = new Map([['kartofler', { key: 'kartofler', class: 'baseline', base_unit: 'kg' }]]);
  const chains = new Map([['rema1000', '11deC']]);
  const row = parsePriceRow(
    { item_key: 'kartofler', chain_slug: 'rema1000', pack_qty: '2',
      pack_unit: 'kg', pack_price: '15.95', observed_at: '2026-09-15' },
    { items, chains, line: 2 },
  );
  assert.equal(row.error, undefined);
  near(row.unit_price, 7.975);
  // baseline = 180 dage
  assert.equal(row.valid_until.slice(0, 10), '2027-03-14');
});
```

- [ ] **Step 3: Kør testene og se dem fejle**

Kør: `node --test test/prices.test.js`
Forventet: FAIL — `Cannot find module '../scripts/import-prices'`.

- [ ] **Step 4: Skriv importøren**

```js
'use strict';

/**
 * data/item_prices.csv -> item_prices.
 *
 * Validerer hårdt og afviser hele filen ved den første fejl. En prisliste,
 * der er halvt indlæst, er værre end en, der ikke er indlæst: man opdager
 * det først, når en madplan koster det forkerte.
 *
 *   npm run prices:import
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../src/db');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

const CSV = path.join(__dirname, '..', 'data', 'item_prices.csv');
const COLUMNS = ['item_key', 'chain_slug', 'pack_qty', 'pack_unit', 'pack_price', 'observed_at'];

/** Én CSV-række til en item_prices-række, eller `{ error }`. */
function parsePriceRow(raw, { items, chains, line }) {
  const at = (msg) => ({ error: `linje ${line}: ${msg}` });

  const item = items.get(raw.item_key);
  if (!item) return at(`ukendt item_key '${raw.item_key}'`);
  if (item.class === 'essential') {
    return at(`'${raw.item_key}' er essential og skal aldrig prissættes`);
  }

  const chainId = chains.get(raw.chain_slug);
  if (!chainId) return at(`ukendt chain_slug '${raw.chain_slug}'`);

  if (raw.pack_unit !== item.base_unit) {
    return at(`pack_unit '${raw.pack_unit}' er ikke varens base_unit `
            + `'${item.base_unit}' — 400 g skal skrives som 0.4 kg`);
  }

  const qty = Number(raw.pack_qty);
  const price = Number(raw.pack_price);
  if (!(qty > 0)) return at(`pack_qty '${raw.pack_qty}' skal være et tal over 0`);
  if (!(price > 0)) return at(`pack_price '${raw.pack_price}' skal være et tal over 0`);

  const observed = new Date(raw.observed_at);
  if (Number.isNaN(observed.getTime())) return at(`observed_at '${raw.observed_at}' er ikke en dato`);

  return {
    item_key: item.key,
    chain_id: chainId,
    pack_qty: qty,
    pack_unit: raw.pack_unit,
    pack_price: price,
    unit_price: Math.round((price / qty) * 1000) / 1000,
    source: 'manual',
    observed_at: observed.toISOString(),
    valid_until: engine.validUntilFor(item.class, observed),
  };
}

/** Minimal CSV: ingen citationstegn, ingen indlejrede kommaer. Prisdata har ingen. */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const header = lines.shift().split(',').map((h) => h.trim());
  for (const c of COLUMNS) {
    if (!header.includes(c)) throw new Error(`CSV mangler kolonnen '${c}'`);
  }
  return lines.map((l) => {
    const cells = l.split(',').map((c) => c.trim());
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

function main() {
  const db = getDb();
  const items = new Map(db.prepare('SELECT key, class, base_unit FROM items').all()
    .map((i) => [i.key, i]));
  const chains = new Map(db.prepare('SELECT id, slug FROM chains').all()
    .map((c) => [c.slug, c.id]));

  const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
  const parsed = rows.map((r, i) => parsePriceRow(r, { items, chains, line: i + 2 }));
  const errors = parsed.filter((p) => p.error);

  if (errors.length) {
    for (const e of errors) console.error(e.error);
    console.error(`\n${errors.length} fejl — intet er skrevet.`);
    process.exit(1);
  }

  const ins = db.prepare(`
    INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit,
                             pack_price, unit_price, source, observed_at, valid_until)
    VALUES (@item_key, @chain_id, @pack_qty, @pack_unit,
            @pack_price, @unit_price, @source, @observed_at, @valid_until)
    ON CONFLICT(item_key, chain_id, pack_qty, pack_unit) DO UPDATE SET
      pack_price = excluded.pack_price, unit_price = excluded.unit_price,
      source = excluded.source, observed_at = excluded.observed_at,
      valid_until = excluded.valid_until
  `);
  db.transaction(() => { for (const p of parsed) ins.run(p); })();

  console.log(`${parsed.length} priser importeret fra ${path.relative(process.cwd(), CSV)}`);
}

if (require.main === module) main();

module.exports = { parsePriceRow, parseCsv };
```

Bemærk `if (require.main === module)`: testen indlæser filen for at få fat i `parsePriceRow`, og må ikke komme til at køre importen som bivirkning.

- [ ] **Step 4b: `isPlausiblePrice` i `engine.js` — og afskaf blokeringslisten**

Opgave 1 efterlod et hul, den ikke selv kunne lukke. Outlier-filtret måler en vare mod
dens EGEN median på tværs af kæder, og det er blindt over for en vare, hvis observationer
alle er forkerte. Den levende sag: `appelsin`s eneste stk-tilbud er **"Orange ilddæmon",
1999,20 kr hos Bilka** — et stykke legetøj. Med én observation ER medianen selve
fejlen, og uden en håndskrevet blokering ville der stå  14.280 kr/kg.

En vare kan kun måles mod noget, der kommer udefra. Mad har kendte prisintervaller, og
det er den viden, der mangler. Den hører hjemme i `engine.js` af samme grund som resten
af prisreglerne: tre skrivere skal være enige om den — bootstrappen, denne importør og
REMA-klienten i opgave 3 — og en tastefejl på 1500 i stedet for 15,00 skal afvises alle
tre steder.

```js
  // Hvad mad kan koste pr. kg/l/stk i en dansk butik. Intervallerne er vide med
  // vilje: de skal fange en tastefejl og en fejlkobling, ikke en dyr økovare.
  // Kilden til en pris uden for båndet er næsten altid, at tilbuddet hører til
  // noget andet end varen — "Apple iPad" på æble, ansigtscreme på fløde.
  const PRICE_BAND = {
    veg:    [2, 150],   fruit:  [2, 200],   meat:  [20, 600],
    poultry:[20, 300],  fish:   [20, 700],  dairy: [5, 200],
    cheese: [30, 500],  eggs:   [5, 200],   grain: [2, 150],
    legume: [5, 200],   bakery: [5, 200],
    // Pinjekerner 480, pistacier 480, stødt kardemomme 590, husblas 512 —
    // alle målt hos REMA og alle ægte. Tørvarer, nødder og krydderier sælges
    // i små pakker, og høj kilopris er reglen, ikke fejlen. Loftet fanger
    // stadig en tierfejl, og fejlmatch i dette interval fanges af
    // taksonomien og af outlier-filteret, ikke af båndet.
    pantry: [3, 900],   snack:  [10, 900],
    // 'drink' blander sodavand og juice solgt pr. LITER med kaffe og te solgt
    // som TØRVÆGT. Målt i basen: te 450 kr/kg og kaffe 421 er ægte hyldepriser,
    // og loftet følger dem og ikke sodavanden.
    //
    // Det bliver på 600 og følger IKKE pantry op på 900, selv om tebreve målt
    // hos REMA når 835 kr/kg og de er ægte: en Melitta kaffemaskine til 799
    // ligger i samme interval, og en kaffemaskine gemt som tepris er værre end
    // en manglende tepris. Det er et bevidst valg, ikke en glemt grænse.
    drink:  [2, 600],
  };

  // Et stk-loft er en helt anden størrelsesorden end et kiloloft, og de to kan
  // ikke dele tal. Kun tre varer sælges pr. stk — brod, tortilla, aeg — mens
  // deres kategorier også rummer kg-varer (æggeblomme, æggehvide). Målt:
  // ægte brod topper ved 35 kr/stk, æg ligger på 2,90-3,60. Uden det her
  // slipper "Bodum brødkasse" (99) og "Køkkenchef brødrister" (79) igennem
  // som brødpriser, og et æg til 32 kr regnes for en rimelig hyldepris.
  const PRICE_BAND_STK = { bakery: 60, eggs: 10 };

  /**
   * Kan denne kr/base_unit være en rigtig hyldepris?
   *
   * `true` ja · `false` nej · `null` vi har intet bånd for kategorien.
   * De tre svar skal holdes adskilt: en kalder, der læser "ved det ikke" som
   * et nej, ville kassere hver eneste vare i en kategori, ingen har sat
   * grænser for endnu.
   */
  function isPlausiblePrice(category, unitPrice, baseUnit) {
    const band = PRICE_BAND[category];
    if (!band) return null;
    // Infinity og NaN slipper ellers igennem hver eneste sammenligning og
    // videre ned i en REAL-kolonne, der kun kræver > 0.
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return false;
    if (baseUnit === 'stk') {
      // Ingen undergrænse pr. stk: ét æble og én kasse æbler er begge "1 stk".
      return unitPrice <= (PRICE_BAND_STK[category] ?? band[1]);
    }
    return unitPrice >= band[0] && unitPrice <= band[1];
  }
```

Returnerer `null` for en ukendt kategori — så kan en kalder skelne "ved det ikke" fra
"nej". Eksportér både funktionen og `PRICE_BAND`.

Brug den tre steder: importøren afviser rækken med en tydelig fejl, `bootstrap-prices.js`
erstatter sin `PIECE_CONVERSION_BLOCKED`-liste med den, og opgave 3 kalder den, før den
skriver. **Fjern blokeringslisten helt** — to varer navngivet i kode er en lap, og den
næste vare, der går galt, står der ikke.

Test at `appelsin` (fruit) afvises ved 14.280 kr/kg, at `selleri` (veg) afvises ved
250 kr/kg, og at en dyr, men ægte vare — oksemørbrad omkring 400 kr/kg — stadig går igennem.

- [ ] **Step 5: Skriv arbejdslisten**

```js
'use strict';

/**
 * Hvilke priser mangler, og hvilke er løbet ud?
 *
 * `valid_until` er ikke dokumentation — det er en forespørgsel. Den her.
 * Afledte gæt står forrest, fordi de er de mindst pålidelige tal i basen.
 *
 *   npm run prices:worklist -- rema1000 netto foetex
 */

const { getDb } = require('../src/db');

function main() {
  const db = getDb();
  const slugs = process.argv.slice(2);
  const all = db.prepare('SELECT id, slug, name FROM chains').all();
  const chains = slugs.length ? all.filter((c) => slugs.includes(c.slug)) : all;

  if (!chains.length) {
    console.error(`ingen kæder matchede. Kendte: ${all.map((c) => c.slug).join(' ')}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  for (const chain of chains) {
    const rows = db.prepare(`
      SELECT i.key, i.name, i.class, i.base_unit,
             ip.source, ip.observed_at, ip.valid_until
        FROM items i
        LEFT JOIN item_prices ip ON ip.item_key = i.key AND ip.chain_id = ?
       WHERE i.class <> 'essential'
         AND (ip.id IS NULL OR ip.source = 'derived' OR ip.valid_until < ?)
       ORDER BY (ip.id IS NULL) DESC, (ip.source = 'derived') DESC, ip.valid_until
    `).all(chain.id, now);

    const mangler = rows.filter((r) => !r.source).length;
    const gaet = rows.filter((r) => r.source === 'derived').length;
    const udloebet = rows.length - mangler - gaet;

    console.log(`\n── ${chain.name} (${chain.slug}) ──`);
    console.log(`mangler helt: ${mangler} · kun gæt: ${gaet} · udløbet: ${udloebet}`);
    for (const r of rows.slice(0, 25)) {
      const status = !r.source ? 'MANGLER' : r.source === 'derived' ? 'gæt    ' : 'udløbet';
      console.log(`  ${status}  ${r.key.padEnd(24)} ${r.base_unit}  (${r.class})`);
    }
    if (rows.length > 25) console.log(`  … og ${rows.length - 25} mere`);
  }
}

main();
```

**Arbejdslisten skal sortere efter, hvor lidt vi ved.** 349 af de 548 afledte rækker hviler
på én eneste observation — to tredjedele. En række med `source='derived'` og `n_obs = 1`
er ét tilfældigt tilbud og næsten intet værd; en med `n_obs = 5` er et rimeligt gæt.
Rækkefølgen er: helt manglende pris først, så `derived` med `n_obs = 1`, så øvrige
`derived`, så udløbne `manual`. Og tæl kun varer, der kan stå i en opskrift —
`class <> 'essential' AND category <> 'nonfood'` — ellers beder listen om priser på
toiletpapir og elektronik.

- [ ] **Step 6: Tilføj scripts, kør, commit**

```json
"prices:import": "node scripts/import-prices.js",
"prices:worklist": "node scripts/price-worklist.js",
```

```bash
npm run prices:import
npm run prices:worklist -- rema1000
npm test
```

Forventet: importen skriver de tre eksempelrækker; arbejdslisten viser, at langt de fleste af de 190 varer mangler eller kun har et gæt. Det tal er det ærlige billede af, hvor meget indtastning der ligger foran.

```bash
git add data/item_prices.csv scripts/import-prices.js scripts/price-worklist.js test/prices.test.js package.json
git commit -m "CSV-importoer og prisarbejdsliste"
```

---

### Task 3: REMA 1000-klienten

Den eneste kæde, der kan hentes automatisk. Undersøgelsen bekræftede endpointet uden login.

**Files:**
- Create: `src/prices/rema.js`
- Create: `scripts/fetch-rema-prices.js`
- Modify: `package.json`, `test/prices.test.js`

**Interfaces:**
- Produces: `parseRemaProduct(raw)` → `{ name, pack_qty, pack_unit, pack_price, unit_price }` eller `null`; `npm run prices:rema`

- [ ] **Step 1: Skriv den fejlende test**

Feltnavnene er dem, undersøgelsen dokumenterede. Testen bruger et ægte svar, ikke et opdigtet:

```js
const { parseRemaProduct } = require('../src/prices/rema');

test('REMA-svar til pris og pakkestørrelse', () => {
  // Ægte svar fra api.digital.rema1000.dk, gengivet i API-undersøgelsen.
  const p = parseRemaProduct({
    name: 'SKRÆLLE KARTOFLER',
    underline: '2 KG. / DANMARK KL. 1',
    prices: [{ price: 18, compare_unit: 'kg', compare_unit_price: 9 }],
  });
  assert.equal(p.pack_unit, 'kg');
  near(p.pack_qty, 2);
  near(p.pack_price, 18);
  near(p.unit_price, 9);
});

test('REMA: pakkestørrelse udledes også når underline ikke siger den', () => {
  const p = parseRemaProduct({
    name: 'HAKKET OKSEKØD 4-7%',
    underline: 'DANSK',
    prices: [{ price: 25.95, compare_unit: 'kg', compare_unit_price: 64.88 }],
  });
  near(p.pack_qty, 0.4);       // 25.95 / 64.88
  assert.equal(p.pack_unit, 'kg');
});

test('REMA: styk-varer får ingen vægt påduttet', () => {
  const p = parseRemaProduct({
    name: 'ØKOLOGISKE ÆG M/L 10 STK.',
    underline: '10 STK.',
    prices: [{ price: 32.95, compare_unit: 'stk', compare_unit_price: 3.295 }],
  });
  assert.equal(p.pack_unit, 'stk');
  near(p.pack_qty, 10);
});

test('REMA: et svar uden sammenligningspris kan ikke bruges', () => {
  assert.equal(parseRemaProduct({ name: 'X', prices: [{ price: 10 }] }), null);
});
```

- [ ] **Step 2: Kør testene og se dem fejle**

Kør: `node --test test/prices.test.js`
Forventet: FAIL — modulet findes ikke.

- [ ] **Step 3: Skriv klienten**

```js
'use strict';

/**
 * REMA 1000s eget shop-API.
 *
 * Den eneste af de 14 kæder, der kan hentes automatisk — se
 * docs/superpowers/specs/2026-09-06-api-undersoegelse.md for hvorfor Salling
 * og Coop ikke kan. Endpointet er udokumenteret og kan forsvinde uden varsel;
 * derfor står kilden i item_prices.source, så en række herfra kan skelnes
 * fra en indtastet og erstattes, hvis dagen kommer.
 *
 * Pakkestørrelsen står ikke som et tal. Den udledes af pris ÷ kilopris, og
 * krydstjekkes mod `underline`, som ofte siger den i klartekst ("2 KG.").
 */

const BASE = 'https://api.digital.rema1000.dk/api';

// REMAs compare_unit mod vores base_unit. Andet end disse tre kan vi ikke
// sammenligne med en opskriftsmængde.
const UNITS = { kg: 'kg', l: 'l', ltr: 'l', stk: 'stk', pcs: 'stk' };

/** "2 KG." / "400 GR." / "1 LTR." / "10 STK." -> mængde i base_unit, eller null. */
function packFromUnderline(underline, baseUnit) {
  if (!underline) return null;
  // REMA staver gram "GR." og liter "LTR.". Uden deres stavemåde i mønstret
  // fanger krydstjekket ingenting, og pakkestørrelsen bliver altid regnet ud.
  const m = String(underline).match(/(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ltr|l|dl|cl|ml|stk)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  const toBase = { kg: 1, gr: 0.001, g: 0.001, ltr: 1, l: 1, dl: 0.1, cl: 0.01, ml: 0.001, stk: 1 };
  const unitBase = (u === 'g' || u === 'gr' || u === 'kg') ? 'kg' : u === 'stk' ? 'stk' : 'l';
  if (unitBase !== baseUnit) return null;
  return n * toBase[u];
}

/**
 * Hvilken af produktets priser er HYLDEPRISEN?
 *
 * `prices` er ikke én pris. Er varen på tilbud, står kampagneprisen FØRST og
 * normalprisen bagefter — "HK. OKSEKØD, 35% GRØNT" stod med 29 kr (is_campaign)
 * og 29,95 kr samme dag. item_prices er normalprisen, og den effektive pris
 * regnes som coalesce(aktivt tilbud, normalpris): tog vi kampagneprisen, ville
 * ugens tilbud blive skrevet ind som varens normale niveau, og rabatten
 * forsvinde ud af regnestykket for evigt efter. `is_advertised` alene er ikke
 * et tilbud — en vare kan være i avisen til sin almindelige hyldepris.
 */

function shelfPrice(prices) {
  if (!Array.isArray(prices) || !prices.length) return null;
  return prices.find((p) => p && !p.is_campaign) || null;
}

/** Ét produkt fra søgesvaret til en prisrække, eller null hvis det ikke kan bruges. */
function parseRemaProduct(raw) {
  const price = shelfPrice(raw && raw.prices);
  if (!price || !(price.price > 0)) return null;
  if (!(price.compare_unit_price > 0)) return null;

  const baseUnit = UNITS[String(price.compare_unit || '').toLowerCase()];
  if (!baseUnit) return null;

  // Klartekst slår regnestykket, når den er der: den er ikke afrundet.
  const stated = packFromUnderline(raw.underline, baseUnit);
  const derived = price.price / price.compare_unit_price;
  const packQty = stated != null && Math.abs(stated - derived) / derived < 0.05
    ? stated
    : Math.round(derived * 1000) / 1000;

  if (!(packQty > 0)) return null;

  return {
    name: raw.name,
    pack_qty: packQty,
    pack_unit: baseUnit,
    pack_price: price.price,
    unit_price: price.compare_unit_price,
  };
}

/** Søger og returnerer de rå produkter. Kaster ved HTTP-fejl. */
async function searchRema(query, { perPage = 20 } = {}) {
  const url = `${BASE}/search/products?query=${encodeURIComponent(query)}`
            + `&page=1&per_page=${perPage}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'accept-language': 'da-DK,da;q=0.9' },
  });
  if (!res.ok) throw new Error(`REMA svarede HTTP ${res.status} på "${query}"`);
  const body = await res.json();
  return body.data || body.results || [];
}

module.exports = {
  parseRemaProduct, packFromUnderline, shelfPrice, searchRema,
  // De to kuraterede lister kommer til i step 7 og bor i samme fil.
  derailingWord, DERAILING_WORDS,
  wrongPriceBasis, PRICE_BASIS_WORDS,
  BASE,
};
```

`searchRema` tager et `fetchImpl` med `fetch` som standard, så en test kan give
den et svar uden at røre nettet.

- [ ] **Step 4: Kør testene og se dem passere**

Kør: `node --test test/prices.test.js`
Forventet: PASS.

- [ ] **Step 5: Skriv hente-scriptet**

Det søger på varens navn, vælger det billigste troværdige match pr. vare, og
skriver med `source='api:rema'`. Én søgning pr. vare — ikke synonymerne også,
for det ville gange kaldene op med fem mod et API, vi ikke er inviteret til.

Scriptet står i `scripts/fetch-rema-prices.js`, og filen er kilden. Her står
kun det, der skal være rigtigt i den, og hvorfor:

**Fire sier, før en pris tælles med.** Rækkefølgen er billigst-først:

1. `taxonomy.lookup(product.name)?.entry.key === item.key` — samme vare.
2. `derailingWord(product, "<nøgle> <navn>")` — er det overhovedet den vare?
3. `wrongPriceBasis(product, "<nøgle> <navn>")` — er tallet varens kilopris?
4. `engine.isPlausiblePrice(item.category, unit_price, base_unit) !== false` —
   er det overhovedet en hyldepris? Bemærk `!== false`: `null` betyder "ingen
   bånd for kategorien", og en kalder, der læser det som et nej, ville kassere
   hver eneste vare i en kategori, ingen har sat grænser for endnu.

Hver afvisning i 2, 3 og 4 printes med produktnavnet, i tre adskilte lister.
Det er ikke pynt: en afvisning er et produkt, taksonomien slap igennem, og de
tre lister kræver hver sin rettelse.

**Arbejdslisten** er `class <> 'essential' AND category <> 'nonfood'` — 184
varer. Essentials prissættes aldrig (plan 1), og non-food skal ikke i en madplan.

**Skrivningen** skal have tre ting rigtige:

```sql
INSERT INTO item_prices (...) VALUES (..., 'api:rema', ...)
ON CONFLICT(item_key, chain_id, pack_qty, pack_unit) DO UPDATE SET
  pack_price = excluded.pack_price, unit_price = excluded.unit_price,
  source = excluded.source, observed_at = excluded.observed_at,
  valid_until = excluded.valid_until,
  -- En hentet pris er ikke gættet frem. Ramte den et 'derived'-gæt på samme
  -- (vare, kæde, pakke), ville gættets n_obs blive hængende og få rækken til
  -- at se ud som et gæt bygget på n observationer.
  n_obs = 0
 -- En indtastet pris er set af et menneske. Den vinder over et API.
 WHERE item_prices.source <> 'manual'
```

`valid_until` sættes af `engine.validUntilFor(item.class, now)`, og `pack_unit`
er varens `base_unit` — triggerne fra opgave 2 afbryder, hvis den ikke er.

`--dry-run` springer `ins.run()` over og kun det. Alt andet — søgning, sier,
tælling, udskrift — kører ens, så en tørkørsel viser præcis det, en rigtig
kørsel ville skrive.


- [ ] **Step 6: Gem de rå svar, så matchningen kan rettes gratis**

En tørkørsel koster 184 forespørgsler — én pr. vare, der skal prissættes — mod
et API, vi ikke er inviteret til, og
matchningen skal justeres flere gange. Derfor skal svarene kunne gemmes og spilles
om uden netværk:

- `--save-raw <fil>` skriver hvert søgesvar som JSON, nøglet på varens nøgle.
- `--from-raw <fil>` kører hele resten af scriptet mod filen i stedet for netværket.

Med de to kan matchningen strammes og båndene efterregnes, uden at REMA hører
fra os igen. Filen hører ikke i git — den er et øjebliksbillede, ikke en kilde.

- [ ] **Step 7: Stram matchningen — taksonomien alene er ikke nok**

Målt på en rigtig tørkørsel: 109 fundet, 75 uden match, 715 forkastet på
taksonomi, 29 på prisbånd. Men blandt de 109 accepterede stod disse:

| vare | REMA gav | hvad det er |
|---|---|---|
| `rejer` | KATTEMAD, FISK & REJER | kattemad |
| `troffel` | TRØFFELKUGLER | chokolade |
| `ymer` | YMERDRYS | drysset ovenpå |
| `porre` | KARTOFFEL-PORRE SUPPE | suppe |
| `torsk` | TORSKEROGN | rogn |
| `skinke` | SKINKESALAT | pålægssalat |
| `suppe` | SUPPEHORN | pasta |

Alle syv indeholder varens ord, så `taxonomy.lookup` giver den rigtige nøgle.
Det er samme familie som "Apple iPad" på æble — bare fra en ny kilde.

`taxonomy.preparedForm()` findes allerede, men fanger ingen af dem, og den må
**ikke** udvides: den bruges også til at klassificere opskrifter, og et nyt ord
som `salat` ville gøre hovedsalat til en færdigvare. Stramningen hører hjemme i
`src/prices/rema.js` og kun der.

Byg en navngiven, kommenteret liste over ord, der gør en råvare til noget andet
— `-salat`, `-suppe`, `-drys`, `-rogn`, `-kugler`, `kattemad`, `hundemad`,
`-horn`, `-dej` — og afvis matchet, når produktnavnet bærer et af dem, **med
mindre varen selv er den ting** (`suppe` må gerne matche en suppe, `salat` en
salat). Print hver afvisning med produktnavnet. Det er en kurateret liste, ikke
en regel, der kan udledes — præcis som `essential` blev det i plan 1.

Målet er ikke flest mulige match. En forkert normalpris er værre end en
manglende, fordi ingenting gør opmærksom på den.

**Hvad de rå svar viste, da listen blev bygget** (skrevet ned bagefter, så
næste kæde ikke skal opdage det forfra):

- De ni ord ovenfor var et udgangspunkt, ikke svaret. Det tog ~25 poster at
  dække de fejlmatch, ét øjebliksbillede af 184 søgninger indeholdt: pålægssalat
  og mayo, suppe, drys, rogn, lever, kugler, horn, dej, færdigret (`farserede`,
  `indbagt`, `fyldt`, `risotto`, `bolognese`, `carbonara`, `lasagne(?!plader)`),
  tilbehør (`sauce`, `sovs`, `dressing`, `chutney`, `marmelade`, `relish`,
  `bearnaise`, `sky`), pizza, mejeri (`yoghurt`, `yoggi`, `skyr`), granola,
  slik, kage, bagværk, chips, nudler, `smag`, kartoffel, smøreost, vegansk og
  dyrefoder.
- **Ordet står ikke altid i navnet.** Mærket i `underline` er tit det eneste,
  der afslører produktet: "SELECTION LAKS" er kattemad fra SHEBA, "POÉSIE
  KALKUN" fra VITAKRAFT, "PÆRE/BANAN" er yoghurt fra ARLA, "PASSION & BANAN" er
  skyr fra CHEASY, og pålægssalaterne kommer fra K-SALAT. Listen prøves derfor
  mod navn OG underline. Prisen er til at tro på i alle fem tilfælde — det er
  varen, der er en anden.
- **Undtagelsen "varen er selv den ting" åbner et hul for netop den vare.**
  `salat` slipper den generelle `salat`-regel forbi, og så vandt ITALIENSK
  SALAT til 36,50 kr/kg over et hoved salat til 133. Mayonnaisesalaterne skal
  derfor nævnes ved navn i en egen post.
- **Mønstrene skal slutte et dansk ord.** Uden et negativt lookahead rammer
  `horn` HORNFISK og `dej` "dejlig". Og `lasagne` skal undtage LASAGNEPLADER,
  som ER pasta — samme undtagelse, som allerede står i `taxonomy.js`.

- [ ] **Step 7b: Den anden liste — prisen er ikke pr. kilo af varen**

Da den første liste var på plads, stod der stadig seks match tilbage, hvor
varen var rigtig, men tallet ikke var varens kilopris:

| vare | REMA gav | hvorfor ikke |
|---|---|---|
| `blomkaal` | BLOMKÅLSBLANDING 18,50 | vægten er også broccoli og gulerod |
| `broccoli` | BROCCOLIBLANDING 21,58 | samme |
| `laks` | LAKS I OLIVENOLIE 163,64 | olien vejer med |
| `hvidloeg` | HVIDLØG KRYDDEROLIE 61,38 | samme |
| `oksekoed` | HK. OKSEKØD, 35% GRØNT 74,88 | hver tredje kilo er grøntsager |
| `paere` | PÆRER I BK. MADSPILD 18,00 | ryddepris, ikke normalpris |

Det er en ANDEN slags afvisning, og derfor en anden liste, `PRICE_BASIS_WORDS`,
med sin egen udskrift. Den første svarer på "er det den vare?", den anden på
"er tallet varens kilopris?". `unit_price` skal betyde kroner pr. kilo AF
VAREN, ellers kan rækken ikke sammenlignes med de andre kæders — samme
invariant, som fik opgave 1 til at droppe stk→kg-omregningen.

Poster: `-blanding` (sammensat, så "MIN EGEN BLANDING TE" slipper forbi —
blandingen dér er te og kun te), `olie` (og "i chili", som er samme 290 g glas),
`grønt` (uden efterfølgende bogstav, så "grøntsager" og "grønne" går fri) og
`madspild`.

**Grænsen, der er trukket med vilje:** `i lage` og `i vand` står IKKE på listen,
selv om lagen også vejer. Dåsen er den normale form for tun, muslinger, oliven,
kapers, cornichoner, bønner og asparges, og de andre kæders rækker på de varer
er den samme slags dåse. Sammenligneligheden, som er hele formålet, er i behold.
Glasset med hvidløg i olie er derimod ikke den normale form for hvidløg.

**Og en skævhed, de to lister kun lapper på:** "billigst vinder" foretrækker
systematisk den forarbejdede, blandede eller nedsatte variant, for den er
næsten altid billigere pr. kilo end råvaren. Alle seks fejl ovenfor var
BILLIGSTE match på deres vare. Det er spejlbilledet af den skævhed, opgave 1
fjernede, og så længe den billigste overlevende vinder, er det kun de fejl,
nogen har sat ord på, der ikke slipper igennem.

- [ ] **Step 8: Kør tørt og læs resultatet**

```json
"prices:rema": "node scripts/fetch-rema-prices.js",
```

```bash
npm run prices:rema -- --dry-run --save-raw tmp/rema-raw.json > tmp/rema.log 2>&1
# og derefter, så tit det skal være, uden at REMA hører fra os igen:
npm run prices:rema -- --dry-run --from-raw tmp/rema-raw.json > tmp/rema.log 2>&1
```

Læs `tmp/rema.log` fra toppen: de accepterede match står FØRST og de tre
afvisningslister bagefter. `tail -30` viser derfor kun afvisninger og ikke en
eneste af de priser, der faktisk bliver skrevet.

Gennemgå HELE listen af accepterede match med øjnene — ikke en stikprøve. Er der
varer, hvor prisen åbenlyst hører til et andet produkt, så stram listerne i
`src/prices/rema.js` frem for at acceptere dem: en forkert normalpris er værre
end en manglende, fordi ingenting gør opmærksom på den.

Og læs listen igen efter HVER stramning. Afvises det billigste match, rykker det
næste op på pladsen, og det næste kan være værre: da "HK. OKSEKØD, 35% GRØNT"
blev afvist, kom "CUPNUDLER OKSEKØD" frem som billigste match på oksekød.

Kør derefter rigtigt og commit.

---

### Task 4: Den effektive pris

Reglen, der binder tilbud og normalpris sammen. Ren funktion i `engine.js`, så server og browser ikke kan blive uenige.

**Files:**
- Modify: `public/engine.js`
- Modify: `test/prices.test.js`

**Interfaces:**
- Consumes: `plans.normalPricesFor()` (opgave 6, men nøgleformen aftales her)
- Produces: `effectivePrice(itemKey, chainId, { offers, normals })` → `{ pack_qty, pack_unit, pack_price, unit_price, on_offer, source }` eller `null`; `plans.activeOfferMap()` nøgler nu på `item|chain`

- [x] **Step 1: Ret tilbudskortets nøgle — det er en forudsætning**

`activeOfferMap()` i `src/mealplan/generate.js` nøgler i dag på varen alene og springer over, hvis nøglen findes:

```js
    if (map.has(row.item_key)) continue;
    map.set(row.item_key, { ... });
```

Fordi rækkerne er sorteret på `unit_price ASC`, betyder det **ét tilbud pr. vare, billigst på tværs af alle kæder**. Det var rigtigt, da motoren kun spurgte "er varen på tilbud et sted?" — men denne plan skal vide, hvad varen koster i *hver* kæde, for at kunne vælge mellem dem.

Skift nøglen til `item|chain`, samme form som normalpriserne:

```js
  const map = new Map();
  for (const row of db.prepare(sql).all(...params)) {
    // Drikkevarer, slik og non-food kan ikke bære en ret.
    if (!taxonomy.isMealCapable(row.item_key)) continue;

    // Nøglen er vare OG kæde. Med varen alene beholdt vi kun det billigste
    // tilbud på tværs af kæderne, og så kan man ikke vælge butik bagefter.
    const k = `${row.item_key}|${row.chain_id}`;
    if (map.has(k)) continue;            // rækkerne er sorteret billigst først

    const baseline = getBaseline(row.product_id, row.base_unit);
    map.set(k, { ...row, normal_unit_price: baseline?.median ?? null });
  }
```

Grep efter kaldssteder og ret dem — `scoreRecipe` i `engine.js` slår op i kortet og skal bruge den nye form:

```bash
grep -rn "activeOfferMap\|offers.get(" src/ public/ test/ --include=*.js
```

- [x] **Step 2: Læg `optional` i opskriftens items**

`shoppingList` i opgave 8 skal kunne springe "evt."-linjer over, men payloaden bærer dem ikke. I `src/mealplan/generate.js`, i `items`-objektet:

```js
      optional: Boolean(ing.optional),
```

og tilsvarende i `src/sync/build.js`s `recipeIndex`-map, så browseren får det samme. De to filer definerer payloaden sammen og skal ændres i samme commit — det er den kontrakt, opgave 9 i plan 1 lagde en test på.

Udvid den test i `test/sync.test.js`, så den også kræver `optional`.

- [x] **Step 3: Skriv de fejlende tests**

```js
const OFFERS = new Map([['kartofler|11deC', {
  item_key: 'kartofler', chain_id: '11deC', base_qty: 2, base_unit: 'kg',
  price: 12, unit_price: 6,
}]]);
const NORMALS = new Map([['kartofler|11deC', [
  { item_key: 'kartofler', chain_id: '11deC', pack_qty: 2, pack_unit: 'kg',
    pack_price: 15.95, unit_price: 7.975, source: 'manual' },
]]]);

test('tilbud slår normalpris, når det er billigere', () => {
  const p = engine.effectivePrice('kartofler', '11deC', { offers: OFFERS, normals: NORMALS });
  near(p.unit_price, 6);
  assert.equal(p.on_offer, true);
});

test('normalprisen gælder, når der ikke er tilbud', () => {
  const p = engine.effectivePrice('kartofler', '11deC', { offers: new Map(), normals: NORMALS });
  near(p.unit_price, 7.975);
  assert.equal(p.on_offer, false);
  assert.equal(p.source, 'manual');
});

test('et dyrere "tilbud" overskriver ikke normalprisen', () => {
  // Den klassiske avis-fælde: tilbudspris = normalpris. Vi tager den billigste.
  const dyrt = new Map([['kartofler|11deC', { base_qty: 2, base_unit: 'kg', price: 20, unit_price: 10 }]]);
  const p = engine.effectivePrice('kartofler', '11deC', { offers: dyrt, normals: NORMALS });
  near(p.unit_price, 7.975);
  assert.equal(p.on_offer, false);
});

test('ingen pris i kæden giver null, ikke nul', () => {
  assert.equal(engine.effectivePrice('kartofler', 'ukendt', { offers: new Map(), normals: new Map() }), null);
});
```

- [x] **Step 4: Kør, se dem fejle, og skriv funktionen**

I `public/engine.js`:

```js
  /**
   * Hvad koster varen i den kæde i dag?
   *
   * Tilbudsprisen overskriver aldrig normalprisen i basen — de to lever i
   * hver sin tabel, og valget træffes her, ved opslaget. Så falder prisen
   * tilbage af sig selv, når tilbuddet udløber, historikken er intakt, og
   * der er ingen særregel for baseline kontra fresh.
   *
   * Billigste vinder. Et "tilbud" til normalpris er ikke et tilbud.
   */
  // Leksikografisk sammenligning af to taltupler. Bruges til at rangere
  // normalpriser paa (kilde, udloebet, pris) i den raekkefoelge.
  function cmp(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  }

  function effectivePrice(itemKey, chainId, { offers, normals, now = new Date() }) {
    const k = `${itemKey}|${chainId}`;
    const nowIso = now.toISOString();

    const offer = offers.get(k);
    const fromOffer = offer && offer.unit_price > 0 && offer.base_qty > 0
      ? { pack_qty: offer.base_qty, pack_unit: offer.base_unit,
          pack_price: offer.price, unit_price: offer.unit_price,
          on_offer: true, source: 'offer' }
      : null;

    // Kilden gaar FORUD for prisen. De afledte priser er bygget af
    // TILBUDSpriser og ligger systematisk under den rigtige normalpris, saa
    // "billigste vinder" ville lade et gaet slaa en hyldepris: maalt paa
    // basen vinder et gaet i 10 af de 30 vare/kaede-par, der har flere
    // kilder — boef 199,90 mod 219,44, flaeskesteg 65,83 mod 83,33.
    // Saa var hele REMA-hentningen spildt.
    //
    //   manual   — et menneske har set hylden
    //   api:rema — kaedens egen hyldepris
    //   derived  — et gaet ud fra hvad varen har kostet PAA TILBUD
    //
    // Foerst inden for det bedste niveau, der findes, afgoer prisen: flere
    // pakkestoerrelser er tilladt, og den billigste pr. enhed er
    // udgangspunktet. Selve pakkevalget sker senere, naar behovet er kendt.
    const SOURCE_RANK = { manual: 0, 'api:rema': 1, derived: 2 };
    const rows = (normals.get(k) || []).filter((r) => r.unit_price > 0);
    let fromNormal = null;
    for (const r of rows) {
      const rank = SOURCE_RANK[r.source] ?? 3;
      // En udloebet pris taber til en gyldig paa samme niveau, men slaar
      // stadig et daarligere niveau: gammelt og rigtigt slaar nyt og gaettet.
      const stale = r.valid_until != null && r.valid_until < nowIso;
      const score = [rank, stale ? 1 : 0, r.unit_price];
      if (!fromNormal || cmp(score, fromNormal.score) < 0) {
        fromNormal = { score,
                       pack_qty: r.pack_qty, pack_unit: r.pack_unit,
                       pack_price: r.pack_price, unit_price: r.unit_price,
                       on_offer: false, source: r.source, stale };
      }
    }
    if (fromNormal) delete fromNormal.score;

    if (!fromOffer) return fromNormal;
    if (!fromNormal) return fromOffer;

    // Kr/stk og kr/kg kan ikke sammenlignes. Tilbuddets base_unit er avisens,
    // ikke varens, og de to er forskellige i 973 af 2.376 tilbudsraekker.
    // Uden dette slaar et tilbud paa "1 stk blomkaal 12 kr" en indtastet pris
    // paa 18 kr/KG — den hoejeste tillidskilde i hele rangordenen, kastet vaek
    // for et tal, der ikke maaler det samme. item_prices har en TRIGGER mod
    // praecis denne fejl; her er der ingen base at spoerge, saa reglen skal
    // staa i koden.
    //
    // Tilbuddet forkastes, ikke omregnes: piece_g er den BRUGBARE vaegt, ikke
    // koebsvaegten, og den vej er allerede proevet og rullet tilbage i opgave 1.
    if (fromOffer.pack_unit !== fromNormal.pack_unit) return fromNormal;

    return fromOffer.unit_price <= fromNormal.unit_price ? fromOffer : fromNormal;
  }
```

Tilføj `effectivePrice` til returobjektet.

Og en test for rangordenen, med tal fra basen:

```js
test('en hyldepris slår et gæt, også når gættet er billigere', () => {
  // Målt i data.db: boef hos REMA har begge dele. Gættet er bygget af
  // TILBUDSpriser og er derfor systematisk for lavt — det er ikke en
  // normalpris, bare det laveste varen har været nede på.
  const normals = new Map([['boef|11deC', [
    { pack_qty: 0.5,  pack_unit: 'kg', pack_price: 99.95, unit_price: 199.9,  source: 'derived' },
    { pack_qty: 0.36, pack_unit: 'kg', pack_price: 79,    unit_price: 219.44, source: 'api:rema' },
  ]]]);
  const p = engine.effectivePrice('boef', '11deC', { offers: new Map(), normals });
  near(p.unit_price, 219.44);
  assert.equal(p.source, 'api:rema');
});

test('en indtastet pris slår både API og gæt', () => {
  const normals = new Map([['kartofler|11deC', [
    { pack_qty: 1, pack_unit: 'kg', pack_price: 8,     unit_price: 8,     source: 'derived' },
    { pack_qty: 2, pack_unit: 'kg', pack_price: 15.95, unit_price: 7.975, source: 'manual' },
  ]]]);
  assert.equal(engine.effectivePrice('kartofler', '11deC',
    { offers: new Map(), normals }).source, 'manual');
});
```

- [x] **Step 5: Kør suiten og commit**

---

### Task 5: Pakkeafrunding og ægte kurvepris

**Files:**
- Modify: `public/engine.js`
- Create: `test/waste.test.js` (+ `package.json`)

**Interfaces:**
- Produces: `choosePack(need, packs, { keeps })` → `{ pack_qty, pack_price, packs, bought, leftover, waste, cost }`

**Hvilke pakker må med i `packs`?** Kun dem fra det bedste kildeniveau, der findes for
(vare, kæde) — samme rangorden som `effectivePrice` i opgave 4: `manual` > `api:rema` >
`derived`. Grunden er, at en pakkestørrelse fra en `derived`-række er et *gæt* på hvilke
pakker butikken overhovedet sælger, udledt af hvad varen tilfældigvis har været på tilbud i.
Blander man niveauerne, kan indkøbslisten komme til at bede om en pose, der ikke findes.

> ### Den manglende udbytte-faktor, og hvorfor den ikke bygges her
>
> Opgave 1 parkerede denne: **opskriftsmængder er i BRUGBARE gram, mens man køber hele
> grøntsager.** `items.piece_g` er kommenteret *"Typisk stykvægt når opskriften bare siger
> '1 løg'"* — broccoli står til 350 g mod et helt hoveds ~500 g, blomkål 500 mod ~1000.
> En ret, der skal bruge 400 g broccolibuketter, kræver altså et hoved på omkring 570 g.
>
> Uden en udbytte-faktor bliver enhver grøntsagstung ret for billig, og fejlen er ensrettet.
> Størrelsen er skønnet til groft **3-5 % på en ugekurv** — ikke ingenting, men langt under
> usikkerheden på de 540 `derived`-priser, hvoraf 348 hviler på én observation.
>
> **Den bygges ikke i denne opgave.** En udbytte-faktor for ~30 grøntsager er tal, ingen af
> os har, og at digte dem ville være at bytte en kendt, lille, ensrettet fejl ud med en
> ukendt. Den hører sammen med at få rigtige priser på de 58 varer, der mangler helt.
> Når tallene findes, er stedet her — `need` ganges med `1 / yield` før afrundingen —
> og ikke i priskolonnen.

- [x] **Step 1: Skriv de fejlende tests**

```js
'use strict';

/**
 * Tests for pakkeafrunding og spild.
 *
 * Reglen, hele planen hviler på: man køber hele pakker. Skal man bruge
 * 1,3 kg kartofler, koster det to 1 kg-poser eller én 1,5 kg-pose — ikke
 * 1,3 × kiloprisen. Og resten er kun spild, hvis varen ikke holder.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const PACKS = [
  { pack_qty: 1,   pack_price: 8,  unit_price: 8 },
  { pack_qty: 1.5, pack_price: 12, unit_price: 8 },
  { pack_qty: 2,   pack_price: 12, unit_price: 6 },
];

test('behovet rundes op til hele pakker', () => {
  const c = engine.choosePack(1.3, PACKS, { keeps: 'keeps' });
  near(c.bought, 1.5);
  near(c.pack_price * c.packs, 12);
  near(c.leftover, 0.2);
});

test('billigst vinder, når resten alligevel ikke er spild', () => {
  // 2 kg og 1,5 kg koster begge 12 kr, og for en pantry-vare vejer resten
  // ingenting. De to får altså samme score, og den første i listen vinder.
  // Testen siger derfor kun at PRISEN er 12 — ikke hvilken pose der blev valgt.
  const c = engine.choosePack(1.3, PACKS, { keeps: 'pantry' });
  near(c.pack_price * c.packs, 12);
  near(c.waste, 0);
});

test('for en letfordærvelig vare tæller resten fuldt', () => {
  const c = engine.choosePack(1.3, PACKS, { keeps: 'perishable' });
  near(c.bought, 1.5);
  near(c.waste, 0.2);
});

test('to pakker, når ingen enkelt er stor nok', () => {
  const c = engine.choosePack(3.4, [{ pack_qty: 2, pack_price: 12, unit_price: 6 }], { keeps: 'keeps' });
  assert.equal(c.packs, 2);
  near(c.bought, 4);
  near(c.leftover, 0.6);
});

test('intet behov giver ingen pakke', () => {
  assert.equal(engine.choosePack(0, PACKS, { keeps: 'keeps' }), null);
  assert.equal(engine.choosePack(1, [], { keeps: 'keeps' }), null);
});
```

- [x] **Step 2: Kør, se dem fejle, og skriv funktionen**

```js
  // Hvor tungt en rest tæller som spild. Kartofler til overs er ikke spild;
  // fløde til overs er. Det er forskellen på at optimere mod madspild og at
  // optimere mod et regneark.
  const WASTE_WEIGHT = { perishable: 1, keeps: 0.5, pantry: 0 };

  // Hvor meget det er værd at betale for at undgå en rest, målt som en andel
  // af hvad resten SELV er værd. 0,5 betyder: jeg betaler gerne 50 øre ekstra
  // for at slippe for at smide mad ud for en krone.
  //
  // Det var først et fast kronebeløb pr. enhed, og det var dimensionelt
  // forkert: én 'stk'-enhed er ét æg til 3 kr, mens én 'kg'-enhed kan være
  // oksekød til 200. Målt gav 15 kr/enhed en straf på 22,50 kr for at have
  // 3 æg til overs fra en 6-pakke, der kostede 20 — mere end pakken.
  // Ganget på varens egen enhedspris skalerer reglen af sig selv.
  const WASTE_AVERSION = 0.5;

  /**
   * Vælg pakkestørrelse og antal til et behov.
   *
   * Man kan ikke købe en halv pose. Behovet rundes op, og valget mellem to
   * pakkestørrelser afgøres af pris PLUS vægtet spild — ellers ville
   * 5 kg-posen altid vinde, fordi den er billigst pr. kilo.
   */
  function choosePack(need, packs, { keeps = 'keeps' } = {}) {
    if (!(need > 0) || !packs || !packs.length) return null;
    const w = WASTE_WEIGHT[keeps] ?? 0.5;

    let best = null;
    for (const p of packs) {
      if (!(p.pack_qty > 0) || !(p.pack_price > 0)) continue;
      const n = Math.ceil(need / p.pack_qty);
      const bought = n * p.pack_qty;
      const leftover = bought - need;
      const waste = leftover * w;
      const cost = n * p.pack_price;
      // Prisen pr. enhed kan mangle på en håndskrevet række; den kan altid
      // regnes.
      const unit = p.unit_price > 0 ? p.unit_price : p.pack_price / p.pack_qty;
      const score = cost + waste * unit * WASTE_AVERSION;

      if (!best || score < best.score) {
        best = { pack_qty: p.pack_qty, pack_price: p.pack_price, packs: n,
                 bought, leftover, waste, cost, score };
      }
    }
    return best;
  }
```

`score` er et internt sorteringstal og må **ikke** med ud af funktionen — samme fejl som
`effectivePrice` fik rettet i opgave 4. `cost` må gerne: opgave 6 skal bruge den.

Tilføj `choosePack`, `WASTE_WEIGHT` og `WASTE_AVERSION` til returobjektet, og frys
`WASTE_WEIGHT` med `Object.freeze`, som `SOURCE_RANK` blev det.

- [x] **Step 3: Kør suiten og commit**

`WASTE_AVERSION` er et skøn, ikke et resultat. Notér i commit-beskeden, at det skal
justeres, når de første rigtige lister er set.

> **Målt efter første implementering:** alle **620** (vare, kæde)-par i basen har præcis
> **én** pakkestørrelse i deres bedste kildeniveau. `choosePack` *vælger* derfor ikke
> endnu — den runder op, og det er den halvdel, der betyder mest (0,5 kg kartofler koster
> en hel 2 kg-pose til 15,95, ikke 3,99). Spildvægtningen er inert, indtil
> `data/item_prices.csv` bærer flere pakker pr. par.
>
> Det er en datamangel, ikke en designfejl, og den rører **ikke** madspildsoptimeringen i
> opgave 7: at dele en rest mellem to retter virker uanset hvor mange poser butikken
> sælger varen i.

---

### Task 6: `recipe_costs`

**Files:**
- Modify: `src/db/schema.sql`
- Create: `scripts/recompute-recipe-costs.js`
- Modify: `src/mealplan/generate.js` (hent `item_prices`), `package.json`

**Interfaces:**
- Produces: tabellen `recipe_costs`; `npm run costs:recompute`; `plans.normalPricesFor(chainIds)` → `Map<'item|chain', rows[]>`

- [x] **Step 1: Tabellen**

```sql
-- ── Opskriftspriser ─────────────────────────────────────────────────────────
-- Forudberegnet, fordi budget-sporet skal kunne sortere 1.546 opskrifter uden
-- at regne noget. Genberegnes ugentligt, når tilbuddene er hentet.
CREATE TABLE IF NOT EXISTS recipe_costs (
  recipe_id   INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  chain_id    TEXT    NOT NULL REFERENCES chains(id),
  -- Σ mængde × enhedspris. Proportional, og derfor den rigtige til at
  -- RANGERE opskrifter mod hinanden.
  cost        REAL,
  -- Σ hele pakker. Den rigtige, hvis retten står alene — men for høj for en
  -- uge, hvor flere retter deles om samme pose.
  cost_packs  REAL,
  coverage    REAL,
  priceable   INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, chain_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_costs_cheap
  ON recipe_costs(chain_id, cost) WHERE priceable = 1;
```

- [x] **Step 2: Hent normalpriser i `generate.js`**

Ved siden af `normalPriceMap()`:

```js
/**
 * Normalpriser pr. (vare, kæde), grupperet så motoren kan vælge pakke.
 *
 * Nøglen er `item|chain` — samme form som tilbudskortet, så effectivePrice()
 * kan slå begge op med den samme streng.
 */
function normalPricesFor(chainIds = null) {
  const db = getDb();
  let sql = `SELECT item_key, chain_id, pack_qty, pack_unit, pack_price,
                    unit_price, source, valid_until
               FROM item_prices`;
  const params = [];
  if (chainIds && chainIds.length) {
    sql += ` WHERE chain_id IN (${chainIds.map(() => '?').join(',')})`;
    params.push(...chainIds);
  }
  const map = new Map();
  for (const r of db.prepare(sql).all(...params)) {
    const k = `${r.item_key}|${r.chain_id}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}
```

Eksportér den sammen med de øvrige.

- [x] **Step 3: Skriv jobbet**

```js
'use strict';

/**
 * Fylder recipe_costs for hver (opskrift, kæde).
 *
 * To pristal, fordi de svarer på hver sit spørgsmål. `cost` er proportional
 * og rigtig til at rangere opskrifter; `cost_packs` er rigtig, hvis retten
 * står alene. Den faktiske madplanspris regnes på hele ugen, hvor pakkerne
 * deles, og er derfor lavere end summen af cost_packs.
 *
 *   npm run costs:recompute
 */

const path = require('node:path');
const { getDb } = require('../src/db');
const plans = require('../src/mealplan/generate');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

function main() {
  const db = getDb();
  const chains = db.prepare('SELECT id, name FROM chains').all();
  const recipes = plans.loadRecipes({});
  const items = new Map(db.prepare('SELECT key, class, keeps, base_unit FROM items').all()
    .map((i) => [i.key, i]));

  // Ingredienser, taksonomien ikke kender, naar ALDRIG ind i r.items:
  // loadRecipes springer dem over. Talte man kun de kendte, ville en ret med
  // 5 kendte og 2 ukendte faa coverage = 1 og en pris, der mangler to
  // ingredienser — og budget-sporet ville rangere den som billig, netop
  // fordi vi ved mindst om den. 678 af 2.224 opskrifter (30,5 %) har mindst
  // en ukendt linje, saa det er ikke en randtilfaelde.
  // Kategorier, hvor et 'optional'-flag ikke skal tros. En ret med valgfri
  // kylling er ikke en ret.
  const MAIN_PROTEIN = new Set(['meat', 'poultry', 'fish']);

  const unknownCount = new Map(db.prepare(`
    SELECT recipe_id, count(*) n FROM recipe_ingredients
     WHERE item_key IS NULL AND COALESCE(optional, 0) = 0
     GROUP BY recipe_id`).all().map((r) => [r.recipe_id, r.n]));

  const ins = db.prepare(`
    INSERT INTO recipe_costs (recipe_id, chain_id, cost, cost_packs,
                              coverage, priceable, computed_at)
    VALUES (@recipe_id, @chain_id, @cost, @cost_packs, @coverage, @priceable, @computed_at)
    ON CONFLICT(recipe_id, chain_id) DO UPDATE SET
      cost = excluded.cost, cost_packs = excluded.cost_packs,
      coverage = excluded.coverage, priceable = excluded.priceable,
      computed_at = excluded.computed_at
  `);

  const now = new Date().toISOString();
  let written = 0;

  for (const chain of chains) {
    const offers = plans.activeOfferMap({ chainIds: [chain.id] });
    const normals = plans.normalPricesFor([chain.id]);

    const run = db.transaction(() => {
      for (const r of recipes) {
        let cost = 0, costPacks = 0, known = 0, total = 0;

        for (const it of r.items) {
          const item = items.get(it.key);
          if (!item || item.class === 'essential') continue;   // essentials købes ikke
          // "evt. et skvæt fløde" købes ikke, og skal derfor hverken koste
          // noget eller kunne gøre en ret uprissaetbar. Samme regel som
          // indkøbslisten i opgave 8.
          //
          // Men en hovedprotein er aldrig valgfri, uanset hvad flaget siger.
          // Flaget fjerner linjen fra BÅDE prisen og nævneren, så et fejlflag
          // bliver til "fuldt prissat og næsten gratis" — og lander dermed
          // øverst i budget-sporet. Det er ikke hypotetisk: OPTIONAL_RE i
          // src/recipes/extract.js matcher `optional` og `if you like` hvor
          // som helst i linjen, mens de danske mønstre er forankret til
          // linjestart, og "4 chicken breasts (skinless, if you like)" blev
          // derfor den billigste prissatte ret i hele basen til 0,08 kr.
          //
          // At forankre de engelske mønstre er målt til at være netto
          // negativt: det ville miste 17 ægte flag ("few sprigs thyme
          // optional") for at rette 5. Forskellen på "(optional; see tip)" og
          // "(see tip, optional)" er ordstilling. Så grænsen trækkes her i
          // stedet, hvor den kan siges enkelt.
          const isProtein = MAIN_PROTEIN.has(item.category);
          if (it.optional && !isProtein) continue;
          total++;
          const need = it.amount;   // ikke weight — se note nedenfor
          if (!(need > 0)) continue;

          const price = engine.effectivePrice(it.key, chain.id,
            { offers, normals, baseUnit: item.base_unit });
          if (!price) continue;
          known++;

          cost += need * price.unit_price;
          const pack = engine.choosePack(need, [price], { keeps: item.keeps });
          if (pack) costPacks += pack.cost;
        }

        // De ukendte tæller med i nævneren, aldrig i tælleren.
        total += unknownCount.get(r.id) || 0;
        const coverage = total ? known / total : 0;
        ins.run({
          recipe_id: r.id, chain_id: chain.id,
          cost: Math.round(cost * 100) / 100,
          cost_packs: Math.round(costPacks * 100) / 100,
          coverage: Math.round(coverage * 1000) / 1000,
          priceable: coverage === 1 ? 1 : 0,
          computed_at: now,
        });
        written++;
      }
    });
    run();
    console.log(`${chain.name.padEnd(16)} ${recipes.length} opskrifter`);
  }

  const p = db.prepare('SELECT count(*) c FROM recipe_costs WHERE priceable = 1').get().c;
  console.log(`\nrækker: ${written} · fuldt prissatte (opskrift × kæde): ${p}`);
}

main();
```

- [x] **Step 4: Kør og stikprøv**

```json
"costs:recompute": "node scripts/recompute-recipe-costs.js",
```

```bash
npm run costs:recompute
node -e "
const db=require('better-sqlite3')('data.db',{readonly:true});
for(const r of db.prepare(\"select r.title, rc.cost, rc.cost_packs, rc.coverage from recipe_costs rc join recipes r on r.id=rc.recipe_id join chains c on c.id=rc.chain_id where c.slug='rema1000' and rc.priceable=1 order by rc.cost limit 10\").all())
  console.log(String(r.cost).padStart(7), String(r.cost_packs).padStart(7), ' ', r.title.slice(0,50));
"
```

> ### `amount`, aldrig `weight` — og hvorfor
>
> Planen sagde oprindeligt `it.weight ?? it.amount` alle tre steder. Det er forkert, og
> fejlen går altid i den billige retning, så den ville have samlet sig øverst i
> budget-sporet.
>
> `weightFor()` i `generate.js` regner en **stk**-vares antal om til kilo
> (`amount × piece_g / 1000`), så `assignRoles` kan veje 6 æg mod 0,4 kg kylling. Dens
> egen docstring siger, at `amount` med vilje ikke røres, fordi *"indkøbslisten og
> prisberegningen skal stadig kunne regne på det ægte stykantal"*.
>
> Og `item_prices.unit_price` for en stk-vare er **kr/stk**. Ganger man vægten i kilo med
> prisen pr. stykke, bliver 6 æg til 6 × 0,058 × 3,295 = **1,15 kr i stedet for 19,77**.
> `aeg`, `brod` og `tortilla` er de tre stk-varer, og **748 af 2.208 opskrifter** har mindst
> én af dem — en tredjedel af korpuset, 17× for lavt på æg og tortillas, 2× på brød.
>
> `amount` er allerede i varens egen enhed. Det er facit.

**Forudsat i `effectivePrice`:** funktionen skal tage `baseUnit` med og forkaste enhver
kandidat — tilbud som normalpris — hvis dens `pack_unit` ikke er varens egen enhed.
Opgave 4 lagde vagten ind, men kun i sammenligningen MELLEM et tilbud og en normalpris;
er der slet ingen normalpris, returneres tilbuddet i den enhed, avisen nævnte. Det er
ikke teoretisk: **292 (vare, kæde)-par har et tilbud i en anden enhed og ingen normalpris**,
og `brod` er et af dem — 33,33 kr/**kg** på en vare, der måles i **stk**. Uden vagten
ganger dette job `behov × enhedspris` på tværs af to forskellige enheder.

**Læs tallene, før du går videre.** En hverdagsret til fire personer ligger typisk mellem 25 og 90 kr i `cost`. Ligger de billigste under 10 kr, mangler der priser frem for at retten er billig — `coverage` skal være 1, og hvis den er, er det enhedspriserne, der er forkerte. `cost_packs` skal være højere end `cost`, aldrig lavere.

- [x] **Step 5: Kør suiten og commit**

---

### Task 7: De to forslag

**Files:**
- Modify: `public/engine.js`
- Modify: `test/waste.test.js`

**Interfaces:**
- Produces: `sharedWeek(candidates, { days, servings, items, offers, normals, chainIds })` → `{ picks, cost, waste, shared }`; `twoProposals(...)` → `[A, B]`

- [ ] **Step 1: Skriv de fejlende tests**

```js
test('delt indkøb foretrækker retter, der bruger samme pose op', () => {
  // To retter deles om 1 kg hakket oksekød; den tredje bruger en helt ny vare
  // til samme score. Ugen skal vælge de to, der deler.
  const week = engine.sharedWeek(FIXTURE.candidates, { days: 2, ...FIXTURE.ctx });
  assert.deepEqual(week.picks.map((p) => p.id).sort(), [1, 2]);
  assert.ok(week.shared.length >= 1, 'skal kunne forklare hvad der deles');
});

test('de to forslag deler højst én ret', () => {
  const [a, b] = engine.twoProposals(FIXTURE.candidates, { days: 3, ...FIXTURE.ctx });
  const overlap = a.picks.filter((p) => b.picks.some((q) => q.id === p.id));
  assert.ok(overlap.length <= 1, `delte ${overlap.length} retter`);
});

test('et forslag kan forklare sig selv i én linje', () => {
  const [a] = engine.twoProposals(FIXTURE.candidates, { days: 3, ...FIXTURE.ctx });
  assert.match(a.explanation, /deler/);
});
```

Fiksturen er skrevet, så svaret kan regnes i hovedet. Læg den øverst i `test/waste.test.js`; opgave 8 bruger den samme.

```js
// ── Fikstur ──────────────────────────────────────────────────────────────────
//
// Tre retter. 1 og 2 deler hakket oksekød; 3 er lige så god, men trækker en
// helt ny vare. Med to dage skal ugen vælge 1 og 2.
//
// Hakket oksekød sælges i 1 kg til 80 kr. Ret 1 og 2 bruger 0,5 kg hver, så
// sammen bruger de posen op. Vælges 1 og 3, skal der købes en pose oksekød
// (80 kr, halvdelen til overs) OG en pose laks (120 kr).

const ITEMS = new Map([
  ['hakket_oksekoed', { key: 'hakket_oksekoed', name: 'Hakket oksekød', category: 'meat', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['laks',            { key: 'laks',            name: 'Laks',            category: 'fish', class: 'fresh', keeps: 'perishable', base_unit: 'kg' }],
  ['kartofler',       { key: 'kartofler',       name: 'Kartofler',       category: 'veg',  class: 'baseline', keeps: 'keeps',   base_unit: 'kg' }],
  ['salt',            { key: 'salt',            name: 'Salt',            category: 'pantry', class: 'essential', keeps: 'pantry', base_unit: 'kg' }],
]);

const NORMALS = new Map([
  ['hakket_oksekoed|c1', [{ pack_qty: 1, pack_unit: 'kg', pack_price: 80,  unit_price: 80,  source: 'manual' }]],
  ['laks|c1',            [{ pack_qty: 1, pack_unit: 'kg', pack_price: 120, unit_price: 120, source: 'manual' }]],
  ['kartofler|c1',       [{ pack_qty: 2, pack_unit: 'kg', pack_price: 16,  unit_price: 8,   source: 'manual' }]],
]);

const recipe = (id, score, items) => ({ id, title: `Ret ${id}`, score, items });
const line = (key, amount) => ({ key, amount, weight: amount, optional: false });

const CANDIDATES = [
  recipe(1, 0.8, [line('hakket_oksekoed', 0.5), line('kartofler', 0.6), line('salt', 0.01)]),
  recipe(2, 0.8, [line('hakket_oksekoed', 0.5), line('kartofler', 0.6)]),
  recipe(3, 0.8, [line('laks', 0.5),            line('kartofler', 0.6)]),
];

const CTX = { items: ITEMS, offers: new Map(), normals: NORMALS, chainIds: ['c1'] };
const FIXTURE = { candidates: CANDIDATES, ctx: CTX };
```

- [ ] **Step 2: Kør, se dem fejle, og skriv algoritmen**

```js
  /**
   * Byg en uge ved grådigt at tilføje den ret, der giver mest for pengene.
   *
   * Målet er ikke laveste pris alene: en uge, hvor hver ret trækker sin egen
   * pose op af fryseren, er dyrere i spild end i kroner. Derfor scorer vi
   * marginalt — hvad koster retten OVEN I det, vi allerede køber — så en ret,
   * der bruger resten af noget, vi har, vinder over en lige så god ret, der
   * kræver en ny vare.
   */
  function sharedWeek(candidates, { days, seed = 0, items, offers, normals, chainIds }) {
    const picks = [];
    const basket = new Map();   // item_key -> samlet behov

    const needsOf = (recipe) => {
      const out = new Map();
      for (const it of recipe.items || []) {
        const meta = items.get(it.key);
        if (!meta || meta.class === 'essential') continue;
        const need = it.amount;   // ikke weight — se note nedenfor
        if (need > 0) out.set(it.key, (out.get(it.key) || 0) + need);
      }
      return out;
    };

    // Spildet akkumuleres i KRONER, ikke i enheder. En kurv indeholder både
    // kilo kartofler og stykker æg, og lægger man dem sammen først og ganger
    // bagefter, adderer man to ting, der ikke har samme enhed. Det var samme
    // fejl som det faste WASTE_PENALTY_PER_UNIT, bare et niveau højere oppe.
    //
    // `choosePack` giver ikke sin interne score fra sig — med vilje — så
    // sammenligningen mellem kæder regnes her, af de felter den DA giver.
    const basketCost = (b) => {
      let cost = 0, wasteKr = 0;
      for (const [key, need] of b) {
        const meta = items.get(key);
        let best = null;
        for (const chainId of chainIds) {
          const price = effectivePrice(key, chainId, { offers, normals });
          if (!price) continue;
          const pack = choosePack(need, [price], { keeps: meta.keeps });
          if (!pack) continue;
          const unit = price.unit_price > 0
            ? price.unit_price
            : price.pack_price / price.pack_qty;
          const kr = pack.waste * unit * WASTE_AVERSION;
          const score = pack.cost + kr;
          if (!best || score < best.score) best = { ...pack, kr, score };
        }
        if (best) { cost += best.cost; wasteKr += best.kr; }
      }
      return { cost, wasteKr };
    };

    let current = basketCost(basket);

    while (picks.length < days) {
      let bestPick = null;

      for (const cand of candidates) {
        if (picks.some((p) => p.id === cand.id)) continue;

        const merged = new Map(basket);
        for (const [k, v] of needsOf(cand)) merged.set(k, (merged.get(k) || 0) + v);
        const after = basketCost(merged);

        // Marginal pris + marginalt spild, modregnet sporets score. Begge led
        // er kroner, så der er intet at gange med. Støjen gør, at "Ny plan"
        // ikke giver præcis samme uge hver gang.
        const marginal = (after.cost - current.cost)
                       + (after.wasteKr - current.wasteKr);
        const score = (cand.score || 0) * 40 - marginal + seededNoise(seed, cand.id);

        if (!bestPick || score > bestPick.score) bestPick = { cand, merged, after, score };
      }

      if (!bestPick) break;
      picks.push(bestPick.cand);
      basket.clear();
      for (const [k, v] of bestPick.merged) basket.set(k, v);
      current = bestPick.after;
    }

    // Hvad deles der faktisk? Det er forklaringen, brugeren får at se.
    const shared = [];
    for (const [key, need] of basket) {
      const used = picks.filter((p) => (p.items || []).some((i) => i.key === key)).length;
      if (used >= 2) shared.push({ key, used, need: round2(need) });
    }
    shared.sort((a, b) => b.used - a.used || b.need - a.need);

    return { picks, cost: round2(current.cost), waste: round2(current.waste), shared };
  }

  /**
   * To uger, der er tilstrækkeligt forskellige til at være et valg.
   *
   * Samme algoritme, forskelligt udgangspunkt. Vi prøver flere frø og tager
   * det første par, der deler højst én ret — to forslag med fire fælles
   * retter er ikke to forslag.
   */
  function twoProposals(candidates, opts) {
    const MAX_SHARED = 1;
    const a = sharedWeek(candidates, { ...opts, seed: 1 });

    let b = null;
    for (let seed = 2; seed <= 12; seed++) {
      const cand = sharedWeek(candidates, { ...opts, seed });
      const overlap = cand.picks.filter((p) => a.picks.some((q) => q.id === p.id)).length;
      if (overlap <= MAX_SHARED) { b = cand; break; }
      if (!b) b = cand;   // fald tilbage på den mindst ens, hvis ingen er nok
    }

    return [a, b].map((w) => ({ ...w, explanation: explainWeek(w) }));
  }

  /** "deler 800 g hakket oksekød over 2 retter og 2 kg kartofler over 3" */
  function explainWeek(week) {
    if (!week.shared.length) return 'ingen råvarer deles på tværs af retterne';
    const parts = week.shared.slice(0, 2)
      .map((s) => `${s.need} ${s.key} over ${s.used} retter`);
    return `deler ${parts.join(' og ')}`;
  }
```

Tilføj `sharedWeek`, `twoProposals` og `explainWeek` til returobjektet.

- [ ] **Step 3: Kør suiten og commit**

---

### Task 8: Kædevalg, de to lister, og synkning

**Files:**
- Modify: `public/engine.js` (`shoppingList`), `src/sync/build.js`, `supabase/schema.sql`
- Modify: `test/waste.test.js`

**Interfaces:**
- Produces: `chooseChains(basket, { chainIds, items, offers, normals })` → `{ chains, assignment, cost }`; `shoppingList` returnerer `{ buy, pantry, waste, chains }`

- [ ] **Step 1: Skriv de fejlende tests**

Boden er 25 kr pr. ekstra butik, så grænsen ligger dér. Fiksturen lægger den ene vare billigere i kæde 2 med præcis kendt forskel:

```js
// Kæde 2 har laks billigere. To varianter: 18 kr sparet (under boden) og
// 120 kr sparet (klart over).
const NORMALS_2 = new Map([
  ...NORMALS,
  ['laks|c2',      [{ pack_qty: 1, pack_unit: 'kg', pack_price: 102, unit_price: 102, source: 'manual' }]],
  ['kartofler|c2', [{ pack_qty: 2, pack_unit: 'kg', pack_price: 16,  unit_price: 8,   source: 'manual' }]],
]);
const NORMALS_BILLIG = new Map([
  ...NORMALS,
  ['laks|c2',      [{ pack_qty: 1, pack_unit: 'kg', pack_price: 0.5, unit_price: 0.5, source: 'manual' }]],
  ['kartofler|c2', [{ pack_qty: 2, pack_unit: 'kg', pack_price: 16,  unit_price: 8,   source: 'manual' }]],
]);
const BASKET = new Map([['laks', 1], ['kartofler', 1]]);

test('en besparelse på 18 kr udløser ikke en ekstra butik', () => {
  // Laks: 120 kr i c1, 102 i c2. De 18 kr sparede er mindre end boden på 25.
  const r = engine.chooseChains(BASKET, {
    chainIds: ['c1', 'c2'], items: ITEMS, offers: new Map(), normals: NORMALS_2,
  });
  assert.deepEqual(r.chains, ['c1']);
});

test('en stor besparelse gør den ekstra butik det værd', () => {
  const r = engine.chooseChains(BASKET, {
    chainIds: ['c1', 'c2'], items: ITEMS, offers: new Map(), normals: NORMALS_BILLIG,
  });
  assert.deepEqual([...r.chains].sort(), ['c1', 'c2']);
});

test('indkøbslisten deler i køb og lagertjek', () => {
  // Ret 1 har salt (essential) og kartofler (købes).
  const plan = { days: [{ recipe: CANDIDATES[0] }] };
  const list = engine.shoppingList(plan, CTX);

  assert.ok(list.buy.some((b) => b.key === 'kartofler'));
  assert.ok(list.buy.every((b) => b.key !== 'salt'), 'essentials må ikke købes');
  assert.ok(list.pantry.some((p) => p.key === 'salt'), 'salt skal på lagerlisten');
  assert.ok(list.pantry.every((p) => p.est_cost === undefined),
    'essentials må aldrig have en pris');
});

test('valgfrie linjer driver ikke et indkøb', () => {
  const plan = { days: [{ recipe: recipe(9, 0.5, [
    line('kartofler', 0.6),
    { ...line('laks', 0.4), optional: true },
  ]) }] };
  const list = engine.shoppingList(plan, CTX);
  assert.ok(list.buy.every((b) => b.key !== 'laks'), 'optional skal springes over');
});
```

- [ ] **Step 2: Kædevalget**

```js
  // Hvad en ekstra indkøbstur "koster". En plan, der kræver tre butikker for
  // at spare 18 kr, er ikke en bedre plan. Tallet er et skøn og skal justeres,
  // når de første rigtige lister er set.
  const EXTRA_STORE_PENALTY = 25;

  /**
   * Hvilke af favoritkæderne skal man handle i?
   *
   * Med højst fem favoritter er der 31 ikke-tomme delmængder. Vi prøver dem
   * alle med et fuldt kurveregnestykke og en fast bod pr. ekstra butik. Det
   * er eksakt, ikke en heuristik, og det tager millisekunder.
   */
  function chooseChains(basket, { chainIds, items, offers, normals }) {
    const ids = chainIds.slice(0, 5);
    let best = null;

    for (let mask = 1; mask < (1 << ids.length); mask++) {
      const subset = ids.filter((_, i) => mask & (1 << i));
      const assignment = new Map();
      let cost = 0, covered = 0;

      for (const [key, need] of basket) {
        const meta = items.get(key);
        let pick = null;
        for (const chainId of subset) {
          const price = effectivePrice(key, chainId, { offers, normals });
          if (!price) continue;
          const pack = choosePack(need, [price], { keeps: meta ? meta.keeps : 'keeps' });
          if (pack && (!pick || pack.score < pick.score)) pick = { ...pack, chainId, price };
        }
        if (pick) { assignment.set(key, pick); cost += pick.cost; covered++; }
      }

      // En delmængde, der ikke kan skaffe varerne, er ikke billigere — den er
      // ufuldstændig. Manglende varer straffes, så de ikke ser gratis ud.
      const missing = basket.size - covered;
      const total = cost + (subset.length - 1) * EXTRA_STORE_PENALTY + missing * 50;

      if (!best || total < best.total) best = { chains: subset, assignment, cost, total };
    }

    return best;
  }
```

- [ ] **Step 3: Skriv `shoppingList` om**

Den nuværende grupperer i `on_offer` og `rest`. Spec afsnit 2.5 vil have **køb ind** og **tjek at du har** — to lister med hver sit formål.

```js
  /**
   * De to lister, brugeren får: hvad der skal købes, og hvad der skal stå i
   * skabet. Essentials optræder aldrig med en pris — det var hele pointen
   * med kategorien.
   */
  function shoppingList(plan, { items, offers, normals, chainIds }) {
    const basket = new Map();
    const pantry = new Map();
    const usedIn = new Map();

    for (const day of plan.days || []) {
      for (const it of day.recipe.items || []) {
        const meta = items.get(it.key);
        if (!meta) continue;

        if (!usedIn.has(it.key)) usedIn.set(it.key, []);
        usedIn.get(it.key).push(day.recipe.title);

        if (meta.class === 'essential') {
          pantry.set(it.key, { key: it.key, name: meta.name });
          continue;
        }
        if (it.optional) continue;          // "evt." driver ikke et indkøb
        const need = it.amount;   // ikke weight — se note nedenfor
        if (need > 0) basket.set(it.key, (basket.get(it.key) || 0) + need);
      }
    }

    const chosen = chooseChains(basket, { chainIds, items, offers, normals });

    const buy = [];
    for (const [key, need] of basket) {
      const pick = chosen.assignment.get(key);
      const meta = items.get(key);
      buy.push({
        key, name: meta.name, chain: pick ? pick.chainId : null,
        need: round2(need),
        packs: pick ? pick.packs : null,
        pack_qty: pick ? pick.pack_qty : null,
        unit: meta.base_unit,
        est_cost: pick ? round2(pick.cost) : null,
        leftover: pick ? round2(pick.leftover) : null,
        on_offer: pick ? pick.price.on_offer : false,
        used_in: usedIn.get(key) || [],
      });
    }
    buy.sort((a, b) => (b.est_cost || 0) - (a.est_cost || 0));

    return {
      buy,
      pantry: [...pantry.values()].sort((a, b) => a.name.localeCompare(b.name, 'da')),
      chains: chosen.chains,
      total: round2(buy.reduce((a, i) => a + (i.est_cost || 0), 0)),
      waste: round2([...chosen.assignment.values()].reduce((a, p) => a + p.leftover, 0)),
    };
  }
```

`shoppingList` får nu et kontekst-argument. Ret kaldsstederne — grep efter `shoppingList(`.

- [ ] **Step 4: Supabase-skemaet og synkningen**

I `supabase/schema.sql`, efter `taxonomy_prices`:

```sql
-- Normalpriser. Ikke brugerdata: det er hvad varen koster i butikken, og
-- frontenden skal kunne læse dem for at prissætte en plan i browseren.
create table if not exists item_prices (
  item_key    text not null,
  chain_id    text not null references chains(id),
  pack_qty    double precision not null,
  pack_unit   text not null,
  pack_price  double precision not null,
  unit_price  double precision not null,
  source      text not null,
  observed_at timestamptz,
  valid_until timestamptz,
  primary key (item_key, chain_id, pack_qty, pack_unit)
);
create index if not exists idx_item_prices_chain on item_prices(chain_id);

-- Forudberegnet opskriftspris. Budget-sporet sorterer på cost.
create table if not exists recipe_costs (
  recipe_id   bigint not null,
  chain_id    text not null references chains(id),
  cost        double precision,
  cost_packs  double precision,
  coverage    double precision,
  priceable   boolean default false,
  computed_at timestamptz,
  primary key (recipe_id, chain_id)
);
create index if not exists idx_recipe_costs_cheap on recipe_costs(chain_id, cost)
  where priceable;

alter table item_prices  enable row level security;
alter table recipe_costs enable row level security;
```

Tilføj `'item_prices'` og `'recipe_costs'` til `foreach t in array array[...]`-listen i `do $$`-blokken nederst, så de får `read_all`-policyen som de øvrige katalogtabeller.

Bemærk at `item_key` her **ikke** har en fremmednøgle til `items`: den tabel synkes ikke til Supabase i dag. Vil du have nøglen, skal `items` synkes først — det er en selvstændig beslutning, ikke en del af denne opgave.

I `src/sync/build.js`: synk `item_prices` for alle kæder (190 varer × 14 kæder er højst ~2.700 rækker) og `recipe_costs` for de prissætbare. Følg mønsteret fra `offer_index` — samme `upsert`-hjælper, samme batchstørrelse.

- [ ] **Step 5: Kør alt igennem**

```bash
npm run prices:bootstrap && npm run prices:import && npm run costs:recompute && npm test
npm run sync:dry
```

- [ ] **Step 6: Commit**

---

## Efter planen

Motoren kan nu regne rigtigt. Det, der mangler, er at brugeren kan se det:

- **Trin 1-5 i brugerfladen** (spec afsnit 2.2): vælg kæder → vælg spor → vælg dage og personer → vælg blandt 3× kandidater med de to forslag markeret → de to lister. `public/app.js` er urørt af denne plan.
- **Budget-sporet som fjerde valg** — `recipe_costs` er der nu; det er en sortering og en knap.
- **Justering af de to skøn:** `WASTE_AVERSION` og `EXTRA_STORE_PENALTY` er sat efter mavefornemmelse. De skal ses efter på rigtige lister, ikke før.
- **Prisindtastningen selv.** ~240 rækker pr. kæde, minus det REMA kan hente. Arbejdslisten (`npm run prices:worklist`) er indgangen.
