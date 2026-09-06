# Databasedesign: opskrifter, varepriser og madspildsoptimeret madplan

**Dato:** 2026-09-06
**Status:** design godkendt, klar til implementeringsplan

## Formål

Gøre appen i stand til at svare præcist på "hvad koster den her ret at lave i mine
butikker i denne uge" og derefter bygge en ugeplan, hvor pakkerne fra butikken
bliver brugt op i stedet for smidt ud.

I dag kan appen ingen af delene. Alt hvad den ved om priser, kommer fra
tilbudsaviser, og den kender kun kr/kg — ikke hvad en pakke koster.

## Nuværende tilstand

| | |
|---|---|
| `chains` / `stores` | 14 kæder, 2.702 butikker |
| `offers` | 5.195 tilbud, alle med `base_qty` + `base_unit` |
| `products` | 2.111 varer, hvoraf 212 er koblet til taksonomien |
| `recipes` | 2.224 opskrifter |
| `recipe_ingredients` | 31.438 linjer, 26.242 med `taxonomy_key` |
| `taxonomy.js` | ~150 varetyper som JavaScript-konstant |

Tre problemer, som designet løser:

1. **Der findes ingen normalpriser.** `taxonomy_prices.unit_price` er medianen af
   tidligere *tilbud* — altså medianen af rabatpriser. Systematisk for lav, og
   kun for de 113 varetyper, der overhovedet har været på tilbud.
2. **Kun 416 af 2.224 opskrifter kan prissættes fuldt ud.** Resten har mindst én
   ikke-staple ingrediens uden `taxonomy_key`.
3. **Pakkestørrelser findes kun på tilbud, ikke på normalpriser.** Uden dem kan
   restvare-optimeringen ikke lade sig gøre, og opskriftspriser regnet som
   `mængde × kr/kg` er systematisk for lave: skal du bruge 0,5 kg kartofler,
   koster det 8 kr i Rema, ikke 4 — du kan ikke købe en halv pose.

## Trufne beslutninger

| # | Spørgsmål | Valg |
|---|---|---|
| 1 | Kilde til normalpriser | Hybrid: API hvor muligt, manuelt ellers. `source` pr. prisrække |
| 2 | Prisens granularitet | Pr. kæde, ikke pr. butik |
| 3 | Essentials | Helt ude af pris og købsliste; vises som separat lagerliste |
| 4 | Restvare-optimering | Pakkebevidst prissætning + genbrug i kandidatudvælgelsen |
| 4c | De to forslag | Begge "delt indkøb", to forskellige velscorende uger |
| 5 | Opskriftsdækning | Kurateret essentials + ~150 nye synonymer (~120 varetyper) → ~1.156 opskrifter |
| 6 | Portioner | Vælges pr. plan, sammen med antal dage |

---

# 1. Datamodellen

Tre lag: opskrifter, varer og priser, forbundet af varetypen.

```
  BASE 1: OPSKRIFTER              BINDELED              BASE 2: VARER & PRISER

  recipes                    ┌──────────────┐          chains ── stores
    └ recipe_ingredients ────┤    items     ├──── products ── offers
                             │  (varetype)  │          └ item_prices
                             └──────────────┘
                                    │
                              recipe_costs   ← afledt, genberegnes ugentligt
```

## 1.1 `items` — varetypen

Den største enkeltændring: taksonomien flyttes fra `src/lib/taxonomy.js` ned i
databasen. Den skal bære pris, kadence og holdbarhed, og det kan en
JavaScript-konstant ikke.

```sql
create table items (
  key              text primary key,   -- 'kartofler', 'hakket_oksekoed'
  name             text not null,
  category         text not null,      -- meat|poultry|fish|dairy|cheese|eggs|
                                       -- veg|fruit|grain|legume|pantry|bakery
  class            text not null,      -- 'fresh' | 'baseline' | 'essential'
  keeps            text not null,      -- 'perishable' | 'keeps' | 'pantry'
  base_unit        text not null,      -- 'kg' | 'l' | 'stk'
  piece_g          real,               -- "2 løg" -> gram
  density_g_ml     real,               -- "2 dl fløde" -> gram
  protein_per_100g real,
  kcal_per_100g    real,
  carbs_per_100g   real,
  fat_grades       boolean default false,  -- er fedtprocent del af identiteten
  premium          boolean default false,
  check (class in ('fresh','baseline','essential')),
  check (keeps in ('perishable','keeps','pantry')),
  check (base_unit in ('kg','l','stk'))
);

create table item_synonyms (
  item_key text not null references items(key) on delete cascade,
  lang     text not null,              -- 'da' | 'en'
  text     text not null,
  primary key (item_key, lang, text)
);
create index idx_item_syn_text on item_synonyms(text);
```

`item_synonyms` er de nuværende `da:`/`en:`-arrays. Som tabel kan man tilføje
"forårsløg" uden at deploye kode — og det er præcis det arbejde, der skal laves
(afsnit 4.1).

### `class` — hvad kategorien styrer

| class | på købslisten | tæller i prisen | normalpris opdateres | eksempler |
|---|---|---|---|---|
| `fresh` | ja | ja | hver 3. måned | kød, fisk, mejeri, ost, friske grøntsager |
| `baseline` | ja | ja | hver 6. måned | kartofler, gulerødder, ris, pasta, sesamfrø, garam masala |
| `essential` | **nej** | **nej** | aldrig — de har ingen pris | salt, peber, olie, eddike, sukker, mel, bouillon, soja, ketchup, honning, rasp |

`essential` er en **kurateret liste over hvad der reelt står i et dansk
køkkenskab** — ikke et mønster for "krydderi-agtig". Sesamfrø, garam masala,
gurkemeje, kardemomme og tahini er *ikke* essentials; de er `baseline`, fordi de
skal købes, men holder i månedsvis. Omvendt er rasp og panko essentials.

Essentials optræder aldrig med en pris og aldrig på købslisten. De vises i en
**separat lagerliste** ("tjek at du har") udledt af de valgte opskrifter.

### `keeps` — hvad der tæller som spild

Styrer alene optimeringen. Rest af `perishable` tæller fuldt, `keeps` halvt,
`pantry` nul. Uden den ville optimeringen bruge kræfter på at få 5 kg kartofler
til at gå op, og kartofler holder en måned. Det er forskellen på at optimere mod
madspild og at optimere mod et regneark.

## 1.2 `item_prices` — normalprisen

```sql
create table item_prices (
  id          bigserial primary key,
  item_key    text not null references items(key) on delete cascade,
  chain_id    text not null references chains(id),
  pack_qty    real not null,       -- 2
  pack_unit   text not null,       -- 'kg'
  pack_price  real not null,       -- 12.00
  unit_price  real generated always as (pack_price / nullif(pack_qty,0)) stored,
  source      text not null,       -- 'manual' | 'derived' | 'api:rema' | 'api:salling' | 'api:coop'
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  unique (item_key, chain_id, pack_qty, pack_unit)
);
create index idx_item_prices_item  on item_prices(item_key, chain_id);
-- pack_unit SKAL være varens base_unit, ellers er unit_price meningsløs:
-- 400 g hakket oksekød indføres som pack_qty = 0.4, pack_unit = 'kg'.
-- Importøren afviser rækker, hvor pack_unit != items.base_unit.
create index idx_item_prices_stale on item_prices(valid_until);
```

Fem bevidste valg:

**Pakken står i rækken, ikke kun kr/kg.** Det er forudsætningen for både
restvare-optimeringen og for at opskriftspriser ikke bliver for lave. Ægte
kartoffelpriser fra basen viser hvorfor:

| kæde | pakke | pris | kr/kg |
|---|---|---|---|
| REMA 1000 | 1 kg | 8 kr | 8,00 |
| Lidl | 1,5 kg | 12 kr | 8,00 |
| REMA 1000 | 2 kg | 12 kr | 6,00 |
| Bilka | 5 kg | 25 kr | 5,00 |

**Flere pakkestørrelser pr. kæde er tilladt.** Det er den variation,
optimeringen vælger imellem. Man kan starte med én række pr. (vare, kæde) og
tilføje flere senere uden skemaændring.

**`source` pr. række.** En manuelt indtastet Rema-pris og en API-hentet
Netto-pris ligger side om side og kan skelnes. Det gør API'erne til en
tilføjelse frem for en forudsætning.

**`valid_until` er kadencen som data**, ikke som en kommentar i en cronjob.
`observed_at + 3 mdr` for `fresh`, `+ 6 mdr` for `baseline`. Kolonnen er
arbejdslisten (afsnit 3.4).

**Ingen rækker for `class = 'essential'`.** Det er derfor listen er
overkommelig: ~240 varer skal prissættes, ikke ~270.

**Pr. kæde, ikke pr. butik.** 2.702 butikker × 240 varer = 650.000 rækker, hvoraf
langt de fleste ville være identiske: Netto, REMA 1000, 365discount, Lidl, føtex,
Bilka og ABC Lavpris har national ensprisning (1.666 af butikkerne). Skulle
butiksniveau blive nødvendigt for franchisekæderne, er det en nullable
`store_id` og et `COALESCE` — ikke en omskrivning.

## 1.3 `offers` — uændret, og adskilt fra normalprisen

Tilbudsprisen **overskriver aldrig** normalprisen. De to tabeller lever hver for
sig, og prisopslaget er ét udtryk:

```
effektiv pris (vare, kæde, dato)
  = coalesce(billigste aktive tilbud, billigste item_prices-række)
```

Så bliver "midlertidigt opdateret ved tilbud" gratis: prisen falder tilbage af
sig selv, når tilbuddet udløber, historikken er intakt, og der er ingen særregel
for `baseline` kontra `fresh`. Tilbuddene har allerede `base_qty` + `base_unit`
på 5.195 ud af 5.195 rækker og passer ind i pakkemodellen uden ændringer.

`products.taxonomy_key` omdøbes til `products.item_key` med fremmednøgle til
`items`.

## 1.4 `recipe_ingredients` — to nye kolonner

```sql
alter table recipe_ingredients
  rename column taxonomy_key to item_key;
alter table recipe_ingredients
  add column amount   real,              -- forbrug i items.base_unit
  add column optional boolean default false;
alter table recipe_ingredients
  drop column is_staple;
```

**`amount`** er i dag en runtime-beregning i `gramsOf()` i
`src/recipes/classify.js`. Materialiseret som kolonne kan SQL regne planpriser,
browseren behøver ikke kende enhedstabellen, og det er dét felt,
restvare-regnestykket summerer over.

**`optional`** markerer "til servering", "evt." — de skal ikke drive et indkøb.

**`is_staple` udgår.** Informationen bor nu ét sted, som `items.class =
'essential'`, i stedet for at være kopieret ud på 12.798 ingredienslinjer.

## 1.5 `recipe_costs` — afledt

```sql
create table recipe_costs (
  recipe_id   bigint not null references recipes(id) on delete cascade,
  chain_id    text   not null references chains(id),
  cost        real,      -- Σ amount × effektiv enhedspris   (til rangering)
  cost_packs  real,      -- Σ hele pakker                     (retten alene)
  coverage    real,      -- andel ikke-essentielle ingredienser med pris
  priceable   boolean,   -- coverage = 1
  computed_at timestamptz not null,
  primary key (recipe_id, chain_id)
);
create index idx_recipe_costs_cheap on recipe_costs(chain_id, cost)
  where priceable;
```

~1.156 opskrifter × 14 kæder ≈ 16.000 rækker, genberegnet ugentligt når
tilbuddene lander.

To pristal, fordi de svarer på hver sit spørgsmål: `cost` er proportional og
rigtig til at *rangere* opskrifter; `cost_packs` er rigtig, hvis retten står
alene. Den faktiske madplanspris regnes på hele ugen, hvor pakkerne deles, og er
derfor lavere end summen af `cost_packs`.

**Budget-sporet er denne tabel sorteret stigende**, filtreret på brugerens kæder.
Der er bevidst ingen `score_budget`-kolonne: om en ret er billig afhænger af
denne uges tilbud og af brugerens kæder, så den kan ikke gemmes som en egenskab
ved opskriften. `score_healthy`, `score_classic` og `score_premium` bliver, hvor
de er — de *er* egenskaber ved retten.

---

# 2. Motoren og flowet

## 2.1 De to interaktionsmodeller

Kravet om at brugeren vælger blandt 3× kandidater og kravet om to foreslåede uger
er lag på det samme: **de 12 kandidater er puljen, og de to forslag er to
præ-markerede delmængder af de 12.** Ét tryk accepterer et forslag; vælger man
frit, opdateres spild- og prisregnskabet løbende.

## 2.2 Flowet, og hvorfor rækkefølgen er som den er

Motoren kører i browseren — det gør den allerede i dag, fordi 14 kæder giver
16.383 mulige favoritkombinationer, som ikke kan forudberegnes. Trin 1–3 er det
filter, der gør datapakken lille nok til at hentes:

| trin | valg | hentes | ca. |
|---|---|---|---|
| 1 | favoritkæder | `item_prices` + `offer_index` for de kæder | ~2.000 rækker |
| 2 | spor: budget / sund / klassisk / gourmet | sporets opskrifter med ingredienser | ~290 opskrifter, ~3.000 linjer |
| 3 | antal dage + antal personer | intet | — |
| 4 | vælg blandt 3× dage kandidater | — | — |
| 5 | indkøbsliste + lagerliste | — | — |

Uden filteret skulle browseren hente alle 1.156 opskrifter og 14 kæders priser.
Med det er vi omkring 400 KB, som kan caches.

Antal personer vælges pr. plan, ikke som en fast indstilling, og feltet
forudfyldes med sidste valg.

## 2.3 Kandidatpuljen (trin 4)

To trin, fordi det ene ikke kan gøre begges arbejde.

**Udvælgelse (top ~100).** Filtrér på `priceable` og sporets score. For
budget-sporet er rangeringen `recipe_costs.cost`.

**Sammensætning (de 12).** Vælger man de 12 højest scorende hver for sig, kan de
ende med ikke at dele en eneste råvare, og så findes der ingen spildfri uge at
vælge. Puljen sammensættes derfor med to bibetingelser:

- **spredning** — højst 3 retter pr. hovedråvare, så listen ikke bliver 12
  pastaretter. *Hovedråvare* = rettens `meat`/`poultry`/`fish`/`legume`-vare;
  har den ingen, den ikke-essentielle ingrediens med størst `amount`
- **overlap** — puljen skal kollektivt indeholde nok delte råvarer til, at gode
  delmængder eksisterer

Grundlaget er der: løg optræder i 1.136 opskrifter, citron i 832, æg i 586,
hakkede tomater i 324, kartofler i 300, og 375 opskrifter bruger kylling.

## 2.4 De to forslag

Grådig algoritme over de 12. Start med én ret, tilføj derefter gentagne gange
den ret, der maksimerer

```
sporets score  −  marginal pris  +  sparet spild
```

hvor "sparet spild" vægtes efter `items.keeps` (perishable fuldt, keeps halvt,
pantry nul). Køres to gange med forskelligt startvalg; de to bedste, der deler
højst én ret, bliver Forslag A og B.

Hvert forslag får en forklaring i én linje: *"deler 800 g hakket oksekød over 2
retter og 2 kg kartofler over 3"*.

En uge må gerne indeholde både kylling og oksekød. Forslagene er ikke bygget op
om én bærende råvare; de er blot to forskellige velscorende sammensætninger.

## 2.5 Indkøbslisten (trin 5)

```
1. Læg alle amount sammen pr. vare, skaleret til antal personer
2. Udelad class = 'essential'  ->  lagerlisten "tjek at du har"
3. Udelad optional = true
4. For hver vare: vælg kæde + pakkestørrelse, rund op til hele pakker
5. Vis pakker, pris, og rest
```

Trin 4 har en faldgrube: vælger man bare den billigste kæde pr. vare, ender
listen fordelt over alle favoritter, og en plan, der kræver tre butikker for at
spare 18 kr, er ikke en bedre plan.

Løsning: **brute-force over delmængder af favoritkæderne.** Med højst 5
favoritter er det ≤32 kombinationer, hver med et fuldt kurveregnestykke og en
fast bod pr. ekstra butik. Eksakt, ikke en heuristik, og millisekunder i
browseren.

Boden starter på **25 kr pr. ekstra butik** og er en enkelt konstant i
`engine.js`. Tallet er et skøn, ikke et resultat — det bør justeres, når de
første rigtige lister er set.

Resultatet er to lister: **køb ind** (fresh + baseline, med pakker og pris) og
**tjek at du har** (essentials fra de valgte opskrifter, uden pris).

## 2.6 Når data mangler

| situation | opførsel |
|---|---|
| vare uden pris i nogen valgt kæde | opskriften er ikke `priceable`: ude af budget-sporet, med i de øvrige med markeret usikkerhed |
| for få kandidater i et spor | scoregrænsen sænkes, og brugeren får det at vide — ikke en tom liste |
| pris ældre end `valid_until` | bruges stadig, men markeres. `valid_until` er en arbejdsliste, ikke en spærre |
| `recipes.servings` mangler | antages 4, som i dag |
| ingrediens uden `amount` | tæller ikke i indkøbet; sænker `coverage` |

## 2.7 Test

Fire nye områder, alle rene funktioner uden database, i forlængelse af det
eksisterende `test/mealplan.test.js`:

- **pakkeafrunding** — 1,3 kg behov mod pakker på 1 / 1,5 / 2 kg giver den
  rigtige pakke og den rigtige rest
- **spildvægtning** — `perishable` / `keeps` / `pantry` vægtes forskelligt
- **kædevalg** — en besparelse på 18 kr udløser ikke en ekstra butik
- **essentials** — optræder aldrig på købslisten og altid på lagerlisten

---

# 3. Vedligehold

En prisdatabase, der er kedelig at vedligeholde, bliver ikke vedligeholdt.

## 3.1 Omfanget

~150 navne er ikke ~150 varetyper: `ground turmeric`, `turmeric` og `stødt
gurkemeje` er tre navne og én vare. Målt på top-25-blokkerne er forholdet ca.
0,8, så ~150 nye navne giver ~120 nye varetyper.

150 nuværende + ~120 nye = **~270 varetyper**, minus ~30 essentials uden pris =
**~240 varer at prissætte.**

| kæder | rækker |
|---|---|
| 3 favoritter | 720 |
| 5 favoritter | 1.200 |
| alle 14 | 3.360 — urealistisk manuelt |

## 3.2 Tre kilder, i rækkefølge

**1. Afledt bootstrap — gratis, med det samme.** For en vare med tilbudshistorik
er den *højeste* observerede kr/kg tættere på normalprisen end medianen: det er
den uge, hvor rabatten var mindst. Ikke rigtigt, men et kvalificeret
udgangspunkt for de ~113 varetyper med historik. Skrives med `source =
'derived'`, så de er synligt foreløbige og ryger først på arbejdslisten.

**2. API — de store kæder.** REMA 1000 og Salling (Bilka, føtex, Netto) har
app-API'er med fuldt sortiment og priser; Coop tilsvarende for Kvickly,
SuperBrugsen, Brugsen og 365discount. Holder det, dækker det 8 af 14 kæder
automatisk.

Det er uofficielle API'er, og designet hviler ikke på dem. **Første skridt er en
afgrænset undersøgelse** — en dag: kan vi hente prisen på en kendt vare fra Rema
og fra Salling, ja eller nej. Falder svaret ud til nej, er intet i skemaet
spildt; rækkerne bliver `manual` i stedet for `api:rema`.

**3. Manuelt — resten.** Lidl og franchisekæderne.

## 3.3 Hvor de manuelle priser bor

`data/item_prices.csv` i repoet, importeret af et script.

```csv
item_key,chain_slug,pack_qty,pack_unit,pack_price,observed_at
kartofler,rema1000,2,kg,15.95,2026-09-06
hakket_oksekoed,rema1000,0.4,kg,32.00,2026-09-06
floede,netto,0.25,l,9.50,2026-09-06
```

Kolonnen er `chain_slug`, ikke `chain_id`: kædernes id'er er uigennemsigtige
Tjek-id'er (`bdf5A` = føtex), som ikke kan redigeres i hånden. Importøren slår
id'et op via `chains.slug`.

CSV frem for en admin-side i appen, fordi filen kan redigeres i et regneark,
virker uden at appen kører, og **diff'er i git** — ændrer en pris sig fra 15,95
til 18,50, kan man se hvornår. En admin-side gemmer ændringen og glemmer
historien. Skal priser senere kunne tastes fra telefonen i butikken, kan siden
lægges ovenpå; CSV forbliver kilden.

## 3.4 Arbejdslisten

```sql
select item_key, chain_id, source, observed_at
  from item_prices
 where valid_until < now() or source = 'derived'
 order by (source = 'derived') desc, valid_until;
```

## 3.5 Kadencer

| hvad | hvornår | hvordan |
|---|---|---|
| tilbud → `offer_index` | ugentligt | findes (`npm run update`) |
| `recipe_costs` genberegnes | ugentligt, efter tilbud | nyt job |
| `fresh` normalpriser | hver 3. måned | API hvor muligt, ellers ~80 rækker |
| `baseline` normalpriser | hver 6. måned | ~160 rækker |
| `essential` | aldrig | de har ingen pris |

Med tre favoritkæder er den halvårlige opgave ~160 rækker og den kvartalsvise
~80 — en aften hvert kvartal. Det er hele pointen med kategoriseringen.

---

# 4. Rækkefølge ind i den eksisterende kode

Otte skridt, hvert kørbart og testbart for sig. Skridt 1–5 rører kun
opskriftssiden og kan køres uden en eneste normalpris i basen.

1. `items` + `item_synonyms` genereres fra `taxonomy.js`; filen bliver en tynd
   indlæser oven på tabellerne
2. `class` og `keeps` sættes på de ~300 varer (kurateringsarbejde)
3. Essentials rettes: rasp og panko ind; sesamfrø, garam masala, gurkemeje og
   kardemomme ud til `baseline`; hvidløg, ingefær og frisk persille ud af
   `STAPLE_KEYS` — de skal købes
4. ~150 nye synonymer (~120 nye varetyper) tilføjes → prissætbare opskrifter går fra 631 til ~1.156
5. `recipe_ingredients.amount` materialiseres fra `gramsOf()`; `optional` udledes
   af råteksten; `is_staple` fjernes
6. `item_prices` + CSV-import + afledt bootstrap
7. `recipe_costs`-job, kørt efter den ugentlige ingest
8. `engine.js`: pakkeafrunding, spildvægtning, to forslag, kædedelmængder

Supabase-skemaet (`supabase/schema.sql`) og `src/sync/build.js` følger med
skridt 1, 6 og 7.

**Naturligt snit:** skridt 1–5 er ét stykke arbejde (opskriftssiden, ingen
priser involveret) og 6–8 et andet (prissiden og motoren). Bliver én
implementeringsplan for stor, er det dér, den skal deles.

## 4.1 Om skridt 3 og 4: hvorfor tallene ser ud som de gør

Målt på den nuværende base. "Prissætbar" = hver ikke-essentiel ingrediens har en
`item_key`.

Med **den nuværende** `STAPLE_KEYS` (15 nøgler, `taxonomy.js:344`): 416 af 2.224.

Med **kurateret** essentials-liste, hvor hvidløg, ingefær og frisk persille er
flyttet ud til "skal købes":

| nye synonymer | prissætbare opskrifter |
|---|---|
| 0 | 631 |
| 50 | 897 |
| 100 | 1.047 |
| **150** | **1.156** |
| 200 | 1.236 |
| 300 | 1.355 |

Knækket ligger omkring 150. Derefter koster hver ny opskrift 1–3 synonymer, og de
sjældne råvarer (burrata, liquid glucose, mango chutney) er også dem, det er
sværest at finde en dansk normalpris på. 1.156 opskrifter er ~290 pr. spor —
rigeligt til 21 kandidater i en 7-dagesplan.

De hyppigste manglende navne, som skridt 4 begynder med: forårsløg, sesamfrø,
gurkemeje, garam masala, fennikelfrø, pinjekerner, mynte, nudler, kapers,
æggeblommer, crème fraîche, ricotta, tahini, halloumi, jalapeños, mango.

---

# 5. Bevidst udeladt

| | hvorfor det kan tilføjes senere |
|---|---|
| **Skabsstyring** — appen husker hvad du har hjemme | `essential` er en antagelse, ikke en beholdning. Kræver holdbarhed og "er den brugt op?" — et eget delsystem |
| **Butiksniveau-priser** | nullable `store_id` på `item_prices` + `COALESCE` i opslaget |
| **Live-omrangering** af kandidatlisten mens man vælger | ren `engine.js`-ændring; bør først bygges når kandidatlisterne er set på ægte data |
| **Opskalering til madpakker** | retter skaleres til antal personer, ikke op til hele pakker. En kontakt oven på det eksisterende |
| **Indkøbsstrategi "alt i én butik"** | butiksboden i 2.5 er allerede parameteren; skal den være en knap, er det UI, ikke skema |

# 6. Risici

**API'erne kan lukke.** Derfor `source` pr. række og undersøgelsen som første
skridt. Værste udfald er mere manuelt arbejde, ikke et ubrugeligt skema.

**Normalpriser forældes hurtigere end kadencen.** Fødevarepriser kan flytte sig
mere end 6 måneder tåler. `valid_until` gør det synligt frem for skjult, og
kadencen kan strammes pr. `class` uden skemaændring.

**~150 synonymer er et skøn.** Tallene i 4.1 er målt, men hvert nyt navn skal
også kunne matches mod et tilbud for at have værdi. Skridt 4 bør måles undervejs,
ikke leveres i ét hug.

**Enhedskonvertering er stadig upræcis.** 10.189 ingredienslinjer har ingen enhed
("2 løg", "1 bundt persille") og hviler på `piece_g`. Det påvirker `amount` og
dermed pakkeafrundingen. Det er en forbedring af de eksisterende gæt, ikke en
løsning på dem.
