# Kandidatpuljen og de fem trin — implementeringsplan (plan 3 af 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gøre motoren brugbar fra browseren. Plan 2 byggede regnestykkerne; de har
ingen kalder. Denne plan bygger det, der mangler imellem: kandidatpuljen fra spec 2.3,
de data browseren skal bruge, og de fem trin.

**Spec:** `docs/superpowers/specs/2026-09-06-database-design.md` afsnit 2.
**Forudsætning:** plan 2 (`2026-09-15-priser-og-madspild.md`) er kørt.

## Udgangspunktet, målt

> **Rettet efter version 1-skønnet (2026-09-25).** Planen blev skrevet, da REMA
> havde 88 prissatte aftensmadsretter og de tretten andre kæder 1-12 hver. Det
> var for tyndt til trin 4, der skal vise 12 retter. Brugeren besluttede derefter,
> at REMA's normalpriser er skønnet for alle kæder (`engine.withEstimates`,
> kilden `estimate:rema`). Tallene nedenfor er målt efter den beslutning.

| | |
|---|---|
| Prissatte aftensmadsretter pr. kæde | **305-400** (REMA 311, Bilka 400) |
| Fuldt prissatte opskrift-kæde-par | 7.297 (før skønnet: 412) |
| `item_prices` i alt | 653: 102 `api:rema`, 12 `manual`, 539 `derived` |
| Grov datapakke, fem favoritter | ~150 KB priser — **men `recipe_index` alene er 3,0 MB rå, 314 KB gzippet** (målt i den afsluttende gennemgang; skønnet her talte kun priserne) |

Tyndheden er løst for alle kæder, så `thin` fyrer sjældent. Den bygges alligevel:
en bruger, der fravælger alt kød, eller et spor med få opskrifter, kan stadig
ende under `3 × dage`, og så skal det siges frem for at vise fire retter som et
frit valg.

**Hvad skønnet betyder for denne plan:** browseren skal lægge det ind præcis som
serveren gør. Ellers prissætter appen en ret, serveren kalder uprissat, og de to
tal på skærmen og i `recipe_costs` er uenige — den drift, der har ramt denne
kodebase tre gange. Se opgave 1.

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

### Task 1: Det browseren skal have — varekataloget og normalpriserne

To ting mangler i browseren, og uden dem kan ingen af de to lister bygges:

**Varekataloget.** `shoppingList` slår `class`, `keeps` og `base_unit` op i
`items`, og `recipe_index.items` har allerede filtreret essentials fra, så
lagerlisten ville komme tom tilbage. Det er grunden til, at `shoppingList` i dag
ingen produktionskalder har. 205 rækker — den billigste blokering i projektet.

**Normalpriserne med skønnet.** Browseren henter i dag slet ikke `item_prices`;
den bruger den gamle `taxonomy_prices` (median af tilbudshistorik). `effectivePrice`
og dermed hele plan 2's motor kan ikke køre uden normalpriskortet. Og det skal
bygges **præcis** som `normalPricesFor` gør det på serveren — med REMA's rækker
lagt ind via `engine.withEstimates` — ellers er appens pris og `recipe_costs`
uenige om den samme ret.

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

- [ ] **Step 5: Normalpriskortet i browseren, med skønnet**

`item_prices` synkes allerede (plan 2, opgave 8). Hent rækkerne for brugerens
favoritter **og for REMA**, også når REMA ikke er en favorit — skønnet kommer
derfra. Byg kortet `item|chain → rows[]` og kald
`PlanEngine.withEstimates(kort, remaRækker, favoritter, remaId)`. REMA's id slås
op på `slug = 'rema1000'` i `chains`, ikke skrevet ind som en konstant.

Det er den samme regel, serveren kører i `normalPricesFor`, og det er hele
grunden til, at `withEstimates` ligger i `engine.js` og ikke i `generate.js`.

**Læg en test, der binder de to sammen.** Med samme rækker ind skal serverens
`normalPricesFor` og browserens kort give samme `effectivePrice` for en håndfuld
(vare, kæde)-par — inklusive et par, hvor prisen kun findes som skøn. Uden den
test er det kun et spørgsmål om tid, før de to driver fra hinanden; det er sket
med `base_qty`, `optional` og `unknown_count`.

- [ ] **Step 6: Kør suiten, `sync:dry`, og commit**

---

### Task 2: Kandidatpuljen (spec 2.3)

Det eneste i spec afsnit 2, der er beskrevet og aldrig bygget. Uden den findes
trin 4 ikke: `sharedWeek` scorer den liste, den får, og ingen laver listen.

**Files:** `public/engine.js`, `test/waste.test.js`

**Interfaces:** `candidatePool(recipes, { days, items })` → `{ pool, thin }`;
`mainCategoryOf(recipe, items)` → hovedkategorien, eller `null`

> **Rettet før dispatch.** Testene nedenfor kaldte `engine.mainCategoryOf` og
> fiksturen `MANGE`, og ingen af dem fandtes — to pladsholdere i planens egen
> kode. `mainCategoryOf` er en tynd indpakning af det, der allerede findes
> (`roleLines` → `assignRoles` → `varietyKeys(...).main`), ikke ny logik: den
> skal svare det samme, som variationsspærren tæller på. Og `MANGE` står nu
> skrevet ud herunder.

- [ ] **Step 1: Skriv de fejlende tests**

Fiksturen øverst i blokken, efter `W_ITEMS`. Den er bygget, så testen for
spredning **skelner**: fjerkræ har de fem højeste scorer, kød de næste fem.
Uden loft ville de 12 bedste være fem fjerkræ, fem kød og to fisk — med loftet
på 3 bliver det tre af hver af de fire kategorier.

```js
// Tyve middage i fire hovedkategorier, fem af hver, faldende score. Tilbehøret
// skifter, så stivelse ikke er det, der spreder dem.
const KAT = [
  ['kyllingebryst', 'poultry'], ['hakket_oksekoed', 'meat'],
  ['laks', 'fish'], ['aeg', 'eggs'],
];
const MANGE = [];
KAT.forEach(([key], k) => {
  for (let i = 0; i < 5; i++) {
    const id = 100 + k * 5 + i;
    const side = i % 2 ? line('pasta', 0.3) : line('kartofler', 0.6);
    MANGE.push(recipe(id, 1 - (k * 5 + i) / 100,
      [line(key, key === 'aeg' ? 4 : 0.5), side]));
  }
});

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
dens hovedkategori har under 3 i puljen.

**Genbrug mekanikken, ikke tallene.** `varietyKeys` og `varietyTally` er det,
der afgør hvad en ret tæller som, og det skal puljen og ugen være enige om — to
steder, der hver har deres egen idé om variation, driver fra hinanden; det
skete med `bestPriceFor` i plan 2. Men `VARIETY_PASSES` er `[[2, 3], [99, 3],
[99, 99]]` og er bygget til en **uge** på fire-syv retter. Puljen har tolv, og
specet siger **3** pr. hovedkategori. Giv puljen sine egne lofter med samme
struktur — et strengt første gennemløb og et løsnende, så puljen stadig fyldes,
hvis en bruger kun har to kategorier at vælge imellem.

`thin` sættes, når puljen ikke når `3 × days`. Den er ikke en fejl — den er
den oplysning, brugeren skal have, før hun vælger.

Specets **overlap**-bibetingelse bygges IKKE i denne omgang. Den kræver et mål
for "nok delte råvarer til at gode delmængder eksisterer", og med 305-400
kandidater pr. kæde er spredningen alene bindende. Skriv det i kommentaren, så næste læser ved, at
det er udeladt med vilje og ikke glemt.

- [ ] **Step 3: Kør suiten og commit**

---

### Task 3: De fem trin i brugerfladen

**Files:** `public/app.js`, `public/index.html`, `public/styles.css`, `public/data.js`,
`src/server.js`

Ruten `#/plan` viser i dag en forudberegnet uge fra `meal_plans` (`viewPlan`,
`Data.mealPlan`). **Flowet erstatter den.** `meal_plans` og `buildPlan` bliver
stående på serveren — de rører ikke flowet og skal ikke fjernes i denne opgave.

> **Samlet op før dispatch — fire krav, der er kommet til undervejs:**
>
> 1. **Første gang motoren kører i browseren.** `Data.items()`,
>    `Data.normalPrices()`, `candidatePool`, `twoProposals` og `shoppingList` har
>    aldrig haft en produktionskalder. Alt, der er testet, er testet i Node.
> 2. **`tier_score` → `score`.** `recipe_index` bærer sporets score som
>    `tier_score`; `candidatePool` læser `score` og udelader med vilje en ret uden
>    score (højlydt tom pulje frem for en stille nul-rangering). Glemmes
>    omsætningen, er puljen tom og `thin` sat — det er meningen, men det skal ikke
>    ske i produktion.
> 3. **Frøet er ugen.** `candidatePool({ seed })` med `år × 100 + uge`, som
>    `data.js` allerede regner det. Samme uge giver samme 12 på server og i app.
>    Hvor mange der skifter fra uge til uge afhænger af sporet, målt over 52 uger:
>    klassisk median 9 af 12, sund 4, **gourmet 1**. Gourmet er ikke en
>    sorteringsfejl: kun 37 af 224 gourmetmiddage kan prissættes, fordi de bruger
>    varer, REMA ikke fører, og nummer tolv scorer 0,49. Scorebånd blev målt og
>    forkastet — de lod enten intet ske eller lod en tydeligt dårligere ret ind.
>    Det løses af rigtige priser fra flere kæder, ikke af koden.
> 5. **`chainIds` SKAL med til `candidatePool`.** Udelades den, er puljen tom og
>    `thin` sat — med vilje, efter reviewet fandt, at den ellers sprang
>    prischecket over i stilhed (151 af 228 retter uprissaetbare).
> 4. **Designretningen er fastlagt:** neutral grund, farve kun fra maden, fra
>    kædernes egne brandfarver (`chains.color`) og ét sjældent varmt signal. Byg på
>    tokens og kommentarer i `public/styles.css` (`--ground`, `--surface`, `--bay`,
>    `--saffron`, `--clay` …) — **indfør ikke et nyt system.** CSP'en i `vercel.json`
>    sætter `font-src 'self'`, så webfonte kan ikke indlæses; typografien hviler på
>    systemstakken, hvor `ui-serif` giver New York på Apple-platforme.
>
> **Budget-sporet** er det fjerde spor i specets trin 2 og findes ikke i dag
> (`TIER_INFO` har sund, klassisk, gourmet). Det rangerer efter
> `recipe_costs.cost_per_serving` blandt `has_main`-rækker — `candidatePool` har
> en `rank`-indgang til netop det. For en bruger med flere favoritter er rettens
> pris den **laveste** `cost_per_serving` blandt favoritterne. `recipe_costs` er
> allerede synket; browseren henter den ikke endnu.

> **Tilføjet efter opgave 1.** `Data.items()` og `Data.normalPrices()` kaster en
> fejl mod den lokale server (`npm start`), fordi den ikke har ruter til dem —
> med vilje: et tomt kort ville give to tomme lister uden et ord. Skal flowet virke
> lokalt, skal `src/server.js` have `/api/items` og `/api/item-prices`, der svarer
> med samme form som Supabase-vejen, og den lokale ruté for normalpriser skal
> kalde `normalPricesFor` — ikke bygge kortet en tredje gang.

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

Hver linje på købslisten bærer sin kilde. **Vis den ikke som jargon**, men sig det,
når prisen er et skøn: "pris fra REMA" ved en vare, hvor kæden selv ingen pris har.
Ellers tror brugeren, at 29 kr i Netto er Nettos pris.

- [ ] **Step 4: Kør alt igennem, og se på det**

Byg en plan i browseren med rigtige data og sammenlign tallene med serverens.
De to skal være enige — det er hele grunden til, at motoren er én fil.

---

## Efter planen

- **Rigtige priser fra de andre kæder.** Version 1 bruger REMA's normalpris som
  skøn overalt, så butiksvalget i dag kun reagerer på tilbud og på indtastede
  priser — det kan ikke opdage, at løg er billigere i Netto. Hver pris, der
  tastes ind i `data/item_prices.csv`, overskriver skønnet for den kæde.
  `npm run prices:worklist -- <kæde>` viser hullerne; ~10 varer pr. kæde
  (persille, hvidløg, citron, løg, squash, selleri, champignon, peberfrugt, vin,
  fløde) dækker det meste.
- **REMA-priserne skal fornyes.** Hentningen kører ikke i den natlige kørsel, fordi
  den kontakter REMA's API. Friske varer udløber efter 90 dage.
- **Justering af de tre skøn:** `WASTE_AVERSION`, `EXTRA_STORE_PENALTY` og
  `MISSING_ITEM_NUISANCE`. Relationen mellem de to sidste er målt og bærende;
  de absolutte værdier er ikke. De skal ses efter på rigtige lister.
- **Taksonomi-fejlkoblingerne.** "Apple iPad" → æble og ansigtscreme → fløde
  står stadig i den tilbudsliste, brugeren ser. Priserne er beskyttet mod dem.
