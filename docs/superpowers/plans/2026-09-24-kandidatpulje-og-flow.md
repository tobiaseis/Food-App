# Kandidatpuljen og de fem trin — implementeringsplan (plan 3 af 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gøre motoren brugbar fra browseren. Plan 2 byggede regnestykkerne; de har
ingen kalder. Denne plan bygger det, der mangler imellem: kandidatpuljen fra spec 2.3,
de data browseren skal bruge, og de fem trin.

**Spec:** `docs/superpowers/specs/2026-09-06-database-design.md` afsnit 2.
**Forudsætning:** plan 2 (`2026-09-15-priser-og-madspild.md`) er kørt.

## Udgangspunktet, målt

| | |
|---|---|
| Prissatte aftensmadsretter, REMA | **88** |
| Samme, alle 13 øvrige kæder tilsammen | **63** |
| Union af fem typiske favoritter | **89** |
| Deres ingrediens-linjer | 899 |
| `item_prices` for fem kæder | 316 |
| Grov datapakke | **~126 KB** |

**Det vigtigste tal er 88 mod 63.** Specets afsnit 2.2 anslog "~290 opskrifter,
~3.000 linjer" pr. spor og frygtede en for stor datapakke. Den frygt var ubegrundet:
126 KB er intet. Den virkelige begrænsning er den modsatte — **der er for få
kandidater, ikke for mange**, og de kommer næsten alle fra den ene kæde, der har
rigtige hyldepriser.

Trin 4 skal vise tre gange så mange retter som dage: 12 for en fire-dages plan.
En REMA-bruger har 88 at vælge blandt. En bruger uden REMA har 4.

**Det er ikke noget, denne plan kan bygge sig ud af.** Det kræver priser, og priser
kræver indtastning (`npm run prices:worklist`) eller flere API-kilder. Planen bygger
derfor mekanikken færdig og **siger tydeligt fra, når puljen er for tynd**, frem for
at vise fire retter og lade som om det er et valg.

## Global Constraints

- Node ≥ 20, CommonJS, `'use strict';`. **Ingen nye npm-afhængigheder.**
- Kommentarer på dansk, der forklarer **hvorfor**.
- `public/engine.js` må aldrig røre databasen og skal kunne indlæses i både Node og
  browser. Nye regler, som både server og browser skal bruge, lægges dér.
- Nye felter i browserens payload skal huskes **fire** steder: `loadRecipes`,
  `src/sync/build.js`, `supabase/schema.sql` (både `create table` og
  `alter table ... add column if not exists`) og `public/data.js`. Tre felter er
  faldet mellem dem i plan 2 — `base_qty`, `optional`, `unknown_count` — og hver gang
  virkede serveren mens browseren fik ingenting. Læg en test på kanten.
- Tests kører mod `test.db`, aldrig `data.db`. `data.db` er produktionsdata; tag en
  kopi før destruktive kørsler, og peg aldrig `DB_PATH` på en `data.db.*`-fil.
- Commit efter hver opgave.

---

### Task 1: `items` ud til browseren

Uden den kan browseren ikke bygge nogen af de to lister: `shoppingList` slår
`class`, `keeps` og `base_unit` op i den, og `recipe_index.items` har allerede
filtreret essentials fra, så lagerlisten ville komme tom tilbage. Det er grunden
til, at `shoppingList` i dag ingen produktionskalder har.

205 rækker. Det er den billigste blokering i hele projektet at fjerne.

**Files:** `src/sync/build.js`, `supabase/schema.sql`, `public/data.js`, `test/sync.test.js`

- [ ] **Step 1: Tabellen i Supabase**

Efter `taxonomy_prices`. Kun de felter, motoren faktisk læser — ikke hele varen:

```sql
-- Varekataloget. Browseren skal kunne slå class/keeps/base_unit op for at
-- bygge indkøbslisten og lagerlisten; recipe_index.items har allerede
-- filtreret essentials fra, så lagerlisten kan ikke udledes derfra.
create table if not exists items (
  key       text primary key,
  name      text not null,
  category  text,
  class     text,
  keeps     text,
  base_unit text,
  piece_g   double precision
);
```

Husk `read_all`-policyen og `enable row level security`, og læg tabellen i `DERIVED`,
så den udskiftes frem for at akkumulere.

- [ ] **Step 2: Skriv den fejlende test**

I `test/sync.test.js`, samme sted som `collectPriceTables`-testen:

```js
test('collectItems leverer det, de to lister skal bruge', () => {
  const rows = build.collectItems();
  const salt = rows.find((r) => r.key === 'salt');
  const kartofler = rows.find((r) => r.key === 'kartofler');

  assert.equal(salt.class, 'essential', 'lagerlisten hviler på class');
  assert.equal(kartofler.base_unit, 'kg', 'pakkeafrundingen hviler på base_unit');
  assert.ok(kartofler.keeps, 'spildvægtningen hviler på keeps');
  // Essentials SKAL med: de er hele pointen med lagerlisten.
  assert.ok(rows.some((r) => r.class === 'essential'));
});
```

- [ ] **Step 3: Kør, se den fejle, og skriv `collectItems`**

I `src/sync/build.js`, ved siden af `collectPriceTables`. Eksportér den, læg den i
`DERIVED` og i push-rækkefølgen.

- [ ] **Step 4: Læs den i browseren**

I `public/data.js`, samme sted som de øvrige opslagstabeller. Den skal caches som
resten — 205 rækker ændrer sig sjældnere end priserne.

- [ ] **Step 5: Kør suiten, `sync:dry`, og commit**

---

### Task 2: Kandidatpuljen (spec 2.3)

Det eneste i spec afsnit 2, der er beskrevet og aldrig bygget. Uden den findes
trin 4 ikke: `sharedWeek` scorer den liste, den får, og ingen laver listen.

**Files:** `public/engine.js`, `test/waste.test.js`

**Interfaces:** `candidatePool(recipes, { days, items })` → `{ pool, thin }`

- [ ] **Step 1: Skriv de fejlende tests**

```js
test('puljen er tre gange så mange retter som dage', () => {
  const { pool } = engine.candidatePool(MANGE, { days: 4, items: W_ITEMS });
  assert.equal(pool.length, 12);
});

test('højst tre retter deler hovedråvare', () => {
  // Uden spredningen kan de 12 blive 12 pastaretter, og så findes der ingen
  // spildfri uge at vælge imellem — puljen ville være et valg uden valg.
  const { pool } = engine.candidatePool(MANGE, { days: 4, items: W_ITEMS });
  const tally = new Map();
  for (const r of pool) {
    const m = engine.mainCategoryOf(r, W_ITEMS);
    tally.set(m, (tally.get(m) || 0) + 1);
  }
  assert.ok([...tally.values()].every((n) => n <= 3));
});

test('puljen melder selv, når den er for tynd', () => {
  // Fire kandidater til en fire-dages plan er ikke et valg. Målt: en bruger
  // uden REMA blandt sine favoritter har præcis så få.
  const { pool, thin } = engine.candidatePool(MANGE.slice(0, 4), { days: 4, items: W_ITEMS });
  assert.equal(pool.length, 4);
  assert.equal(thin, true, 'brugeren skal have det at vide, ikke opdage det');
});
```

- [ ] **Step 2: Kør, se dem fejle, og skriv funktionen**

To trin, som specet siger, fordi det ene ikke kan gøre begges arbejde:

**Udvælgelse.** Filtrér på `isDinner` og sporets score; ranger efter sporet —
for budget-sporet efter `cost_per_serving`. Tag de bedste ~100.

**Sammensætning.** Gå ned gennem de ~100 og tag en ret ad gangen, så længe
dens hovedkategori har under 3 i puljen. Samme struktur som `VARIETY_PASSES`
i `sharedWeek` — og **genbrug den, skriv ikke en ny.** To steder, der skal
være enige om hvad variation er, driver fra hinanden; det skete med
`bestPriceFor` i plan 2.

`thin` sættes, når puljen ikke når `3 × days`. Den er ikke en fejl — den er
den oplysning, brugeren skal have, før hun vælger.

Specets **overlap**-bibetingelse bygges IKKE i denne omgang. Den kræver et mål
for "nok delte råvarer til at gode delmængder eksisterer", og med 89 kandidater
er spredningen alene bindende. Skriv det i kommentaren, så næste læser ved, at
det er udeladt med vilje og ikke glemt.

- [ ] **Step 3: Kør suiten og commit**

---

### Task 3: De fem trin i brugerfladen

**Files:** `public/app.js`, `public/index.html`, `public/style.css`, `public/data.js`

Ruten `#/plan` viser i dag en forudberegnet uge fra `meal_plans`. Den erstattes af
flowet; den gamle visning bliver til ugens forslag på forsiden, ikke til planen.

- [ ] **Step 1: Trin 1-3 — filteret**

Favoritkæder findes allerede (`Data.setFavorites`). Tilføj spor og
dage/personer. **Højst fem favoritter** — `chooseChains` regner på delmængder,
og loftet skal håndhæves dér, hvor brugeren vælger, ikke opdages som en
manglende vare senere (plan 2, opgave 8, I2).

- [ ] **Step 2: Trin 4 — de 12**

`candidatePool` giver puljen, `twoProposals` giver de to markerede delmængder.
Ét tryk accepterer et forslag; vælger man frit, opdateres pris og spild løbende.

**Er `thin` sat, siges det rent ud** — "vi kan kun prissætte 4 retter i dine
butikker" — med en henvisning til at vælge flere butikker. Fire retter vist som
et frit valg er en løgn.

- [ ] **Step 3: Trin 5 — de to lister**

`shoppingList` giver `buy` og `pantry`. Essentials har aldrig en pris.
Vis `dropped_chains`, hvis der blev afkortet.

- [ ] **Step 4: Kør alt igennem, og se på det**

Byg en plan i browseren med rigtige data og sammenlign tallene med serverens.
De to skal være enige — det er hele grunden til, at motoren er én fil.

---

## Efter planen

- **Priserne.** 96 varer har ingen pris, og 13 af 14 kæder er næsten tomme.
  Det er det, der afgør, om flowet er brugbart for andre end en REMA-kunde.
  `npm run prices:worklist` er indgangen.
- **Justering af de tre skøn:** `WASTE_AVERSION`, `EXTRA_STORE_PENALTY` og
  `MISSING_ITEM_NUISANCE`. Relationen mellem de to sidste er målt og bærende;
  de absolutte værdier er ikke. De skal ses efter på rigtige lister.
- **Taksonomi-fejlkoblingerne.** "Apple iPad" → æble og ansigtscreme → fløde
  står stadig i den tilbudsliste, brugeren ser. Priserne er beskyttet mod dem.
