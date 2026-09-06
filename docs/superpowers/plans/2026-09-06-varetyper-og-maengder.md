# Varetyper og mængder — implementeringsplan (plan 1 af 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flytte fødevaretaksonomien fra en JavaScript-konstant ned i databasen som `items` + `item_synonyms`, give hver vare `class` og `keeps`, kuratere essentials korrekt, og materialisere ingrediensmængder — så antallet af fuldt prissætbare opskrifter går fra 416 til ~1.156, og databasen kan bære priser.

**Architecture:** `src/lib/items.js` bliver en ren indeksbygger uden databaseadgang; `src/lib/taxonomy.js` beholder sin nuværende offentlige API, men henter nu rækkerne fra basen og memoiserer indekset. Ingen af de fem eksisterende kaldssteder ændrer signatur. Enhedskonvertering flytter ud af `src/recipes/classify.js` til en fokuseret `src/lib/units.js`, som får en ny `amountOf()`, der regner om til varens `base_unit` i stedet for altid til gram.

**Tech Stack:** Node ≥20 (CommonJS), better-sqlite3 v11, `node:test` + `node:assert/strict`. Ingen nye afhængigheder.

**Spec:** `docs/superpowers/specs/2026-09-06-database-design.md` — denne plan dækker afsnit 4, skridt 1-5, plus API-undersøgelsen fra afsnit 3.2.

**Plan 2** (skridt 6-8: `item_prices`, CSV-import, `recipe_costs`, `engine.js`) skrives efter opgave 10, fordi dens indhold afhænger af, hvad API-undersøgelsen finder.

## Global Constraints

- Node ≥20, CommonJS (`require`/`module.exports`), `'use strict';` øverst i hver fil.
- Ingen nye npm-afhængigheder. `better-sqlite3` er den eneste runtime-afhængighed.
- Kommentarer skrives på dansk og forklarer **hvorfor**, ikke hvad. Følg tonen i `src/lib/taxonomy.js` og `src/lib/normalize.js`.
- `public/engine.js` skal kunne indlæses både i Node (`require`) og i en browser. Den må ikke røre databasen.
- Nye testfiler skal tilføjes til `test`-scriptet i `package.json`, ellers køres de ikke.
- Skemaændringer: nye tabeller i `src/db/schema.sql` som `CREATE TABLE IF NOT EXISTS`. Nye kolonner på eksisterende tabeller i `migrate()` i `src/db/index.js` — `schema.sql` køres ved hver åbning og rører ikke eksisterende tabeller.
- `data.db` er 12 MB produktionsdata. Ingen opgave må skrive destruktivt i den uden en kopi først.
- Commit efter hver opgave.

## Filstruktur

| fil | ansvar |
|---|---|
| `src/lib/items.js` | **ny** — ren indeksbygger: `buildIndex(items, synonyms)` → opslagsobjekt. Ingen I/O, ingen database |
| `src/lib/taxonomy.js` | **ændres** — `TAXONOMY`-arrayet bliver seed-data med `class`/`keeps`; filen henter fra basen og memoiserer `buildIndex`. Offentlig API uændret |
| `src/lib/units.js` | **ny** — `UNIT_G`, `UNIT_ML`, `PIECE_G`, `gramsOf()`, `amountOf()`. Flyttet ud af `classify.js` |
| `scripts/seed-items.js` | **ny** — skriver `items` + `item_synonyms` fra seed-arrayet |
| `scripts/backfill-amounts.js` | **ny** — udfylder `recipe_ingredients.item_key` / `amount` / `optional` på de 31.438 eksisterende rækker |
| `scripts/coverage-report.js` | **ny** — måler prissætbare opskrifter og lister de hyppigste blokkere. Acceptkriteriet for opgave 8 |
| `scripts/spike-chain-apis.js` | **ny** — tidsafgrænset undersøgelse af Rema/Salling-API'er |
| `src/db/schema.sql` | **ændres** — `items`, `item_synonyms` |
| `src/db/index.js` | **ændres** — nye kolonner i `migrate()` |
| `src/recipes/extract.js` | **ændres** — `parseIngredient` returnerer `item_key`, `amount`, `optional` |
| `src/recipes/classify.js` | **ændres** — importerer fra `units.js`, bruger `items.class` i stedet for `is_staple` |
| `test/items.test.js` | **ny** |
| `test/units.test.js` | **ny** |

Grunden til at `items.js` er ren og `taxonomy.js` gør I/O: opslagslogikken er den mest fejlfølsomme kode i projektet (sammensatte danske ord, engelske ordgrænser, rangering på position), og den skal kunne testes mod et lille fikstur uden en database. Se kommentaren over `lookup()` i den nuværende `taxonomy.js:388-408` — den beskriver regler, der kun kan holdes ved lige med hurtige tests.

---

### Task 1: Ren indeksbygger i `src/lib/items.js`

Flytter opslagsindekset ud af `taxonomy.js` uden at ændre dets opførsel. Ren funktion over injicerede rækker.

**Files:**
- Create: `src/lib/items.js`
- Create: `test/items.test.js`
- Modify: `package.json` (test-scriptet)

**Interfaces:**
- Consumes: intet
- Produces:
  - `buildIndex(items, synonyms)` → `{ get, lookup, all, isEssential, isPremium, isNonFood, isMealCapable, looksEnglish }`
    - `items`: `[{ key, name, category, class, keeps, base_unit, piece_g, density_g_ml, protein_per_100g, kcal_per_100g, carbs_per_100g, premium }]`
    - `synonyms`: `[{ item_key, lang, text }]`
    - `get(key)` → item-objekt eller `null`
    - `lookup(text)` → `{ entry, term }` eller `null` — samme form som `taxonomy.lookup` returnerer i dag
    - `isEssential(key)` → boolean (`item.class === 'essential'`)
    - `all()` → array af alle items

- [ ] **Step 1: Skriv den fejlende test**

Opret `test/items.test.js`. Casene er de regler, der står beskrevet i `src/lib/taxonomy.js:388-408` — de er ikke opdigtede, de er de fælder, data indeholder.

```js
'use strict';

/**
 * Tests for opslagsindekset.
 *
 * Reglerne her er ikke akademiske. Hver case er et sted, hvor et naivt
 * indexOf gav et forkert svar på ægte data: dansk sætter ord sammen, engelsk
 * gør ikke, og hovedordet står forrest i danske varenavne.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIndex } = require('../src/lib/items');

const ITEMS = [
  { key: 'hakket_oksekoed', name: 'Hakket oksekød', category: 'meat',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg' },
  { key: 'oksekoed', name: 'Oksekød', category: 'meat',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg' },
  { key: 'olie', name: 'Olie', category: 'pantry',
    class: 'essential', keeps: 'pantry', base_unit: 'l' },
  { key: 'ris', name: 'Ris', category: 'grain',
    class: 'baseline', keeps: 'pantry', base_unit: 'kg' },
  { key: 'lam', name: 'Lammekød', category: 'meat',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg', premium: true },
  { key: 'kyllingelaar', name: 'Kyllingelår', category: 'poultry',
    class: 'fresh', keeps: 'perishable', base_unit: 'kg' },
];

const SYNONYMS = [
  { item_key: 'hakket_oksekoed', lang: 'da', text: 'hakket oksekød' },
  { item_key: 'hakket_oksekoed', lang: 'en', text: 'minced beef' },
  { item_key: 'oksekoed',        lang: 'da', text: 'oksekød' },
  { item_key: 'oksekoed',        lang: 'en', text: 'beef' },
  { item_key: 'olie',            lang: 'da', text: 'olivenolie' },
  { item_key: 'ris',             lang: 'da', text: 'ris' },
  { item_key: 'lam',             lang: 'en', text: 'lamb' },
  { item_key: 'kyllingelaar',    lang: 'en', text: 'chicken thighs' },
];

const idx = buildIndex(ITEMS, SYNONYMS);

test('det mest specifikke synonym vinder over sin egen orddel', () => {
  assert.equal(idx.lookup('500 g hakket oksekød').entry.key, 'hakket_oksekoed');
});

test('dansk accepterer delmatch i sammensatte ord', () => {
  // 'olivenolie' er ét ord; betydningen sidder inde i ordet.
  assert.equal(idx.lookup('jomfruolivenolie').entry.key, 'olie');
});

test('engelsk kræver helt ord — "Lambi" er ikke lamb', () => {
  assert.equal(idx.lookup('Lambi crisps with the topping'), null);
});

test('korte danske synonymer lukkes ude af engelsk tekst', () => {
  // 'ris' må ikke ramme 'crisps'; 'chicken thighs' skal vinde.
  assert.equal(
    idx.lookup('3 boneless and skinless chicken thighs').entry.key,
    'kyllingelaar',
  );
});

test('get returnerer varen, ukendt nøgle giver null', () => {
  assert.equal(idx.get('ris').name, 'Ris');
  assert.equal(idx.get('findes_ikke'), null);
});

test('isEssential læser class, ikke en separat liste', () => {
  assert.equal(idx.isEssential('olie'), true);
  assert.equal(idx.isEssential('ris'), false);
  assert.equal(idx.isEssential('hakket_oksekoed'), false);
});

test('isPremium læser premium-flaget', () => {
  assert.equal(idx.isPremium('lam'), true);
  assert.equal(idx.isPremium('ris'), false);
});

test('all() giver alle varer', () => {
  assert.equal(idx.all().length, ITEMS.length);
});

// ── Brotest mod facit ────────────────────────────────────────────────────────
//
// Så længe taxonomy.js har sin egen lookup, ER den facit. Denne test er den
// eneste, der kan fange, at det nye indeks er *næsten* magen til — og næsten
// er ikke godt nok, når 26.242 ingredienslinjer skal slås op gennem det.
// Opgave 3 sletter testen igen, fordi facit forsvinder dér.

test('indekset svarer som taxonomy.js på ægte ingredienslinjer', () => {
  const taxonomy = require('../src/lib/taxonomy');
  const mirror = buildIndex(
    taxonomy.TAXONOMY.map((e) => ({
      key: e.key, name: e.name, category: e.cat,
      class: 'fresh', keeps: 'keeps', base_unit: 'kg', premium: !!e.premium,
    })),
    taxonomy.TAXONOMY.flatMap((e) => [
      ...(e.da || []).map((t) => ({ item_key: e.key, lang: 'da', text: t })),
      ...(e.en || []).map((t) => ({ item_key: e.key, lang: 'en', text: t })),
    ]),
  );

  // Hver linje er en fælde, kommentarerne i taxonomy.js navngiver.
  const CASES = [
    '500 g hakket oksekød', 'jomfruolivenolie', 'Skinkeculotte',
    'Indbagt laks med spinat', 'majskylling', 'tomat ketchup', 'butter beans',
    '3 boneless and skinless chicken thighs', 'Lambi crisps with topping',
    '2 courgettes', 'tomatoes, roughly chopped', '400 g plum tomatoes',
    '1 dåse hakkede tomater', 'friskkværnet peber', 'grillkylling',
    'reveal the pepperoni', 'pork tenderloin, sliced', '2 dl piskefløde',
  ];
  for (const text of CASES) {
    assert.equal(
      mirror.lookup(text)?.entry.key ?? null,
      taxonomy.lookup(text)?.entry.key ?? null,
      text,
    );
  }
});
```

- [ ] **Step 2: Tilføj testfilen til `package.json`**

Erstat `test`-scriptet i `package.json`:

```json
"test": "node --test test/normalize.test.js test/sync.test.js test/mealplan.test.js test/push.test.js test/items.test.js",
```

- [ ] **Step 3: Kør testen og se den fejle**

Kør: `node --test test/items.test.js`
Forventet: FAIL med `Cannot find module '../src/lib/items'`

- [ ] **Step 4: Skriv `src/lib/items.js`**

Flyt `isWordChar`, `EN_HINT`, `DA_HINT`, `looksEnglish` og hele `lookup`-kroppen fra `src/lib/taxonomy.js:371-440` uændret. Kun kilden til `SYNONYMS` og `BY_KEY` ændrer sig: de bygges nu af argumenterne i stedet for af `TAXONOMY`.

```js
'use strict';

/**
 * Opslagsindeks over varetyper.
 *
 * Ren funktion over rækker: ingen database, ingen filer. Det er med vilje.
 * Opslagsreglerne nedenfor er projektets mest fejlfølsomme kode, og de skal
 * kunne testes mod seks fikstur-varer på et millisekund.
 *
 * Kilden til rækkerne er `src/lib/taxonomy.js`, som henter dem fra basen.
 */

const NONFOOD_CATS  = new Set(['nonfood']);
const NON_MEAL_CATS = new Set(['nonfood', 'drink', 'snack']);

const isWordChar = (c) => c !== undefined && /[a-zæøå0-9]/.test(c);

// (uændret fra taxonomy.js — se kommentaren dér for hvorfor hvert ord står på listen)
const EN_HINT = /(^|[^a-zæøå])(and|the|with|into|chopped|sliced|diced|finely|boneless|skinless|freshly|roughly|thinly|drained|deseeded|peeled|grated|halved|plus|about|handful|bunch|large|small|fresh|ground|cut)([^a-zæøå]|$)/i;
const DA_HINT = /[æøå]|(^|[^a-z])(og|eller|med|uden|frit|valg|hakket|dansk|danske|stk|pr|kg|gram)([^a-z]|$)/i;

function looksEnglish(text) {
  return EN_HINT.test(text) && !DA_HINT.test(text);
}

function buildIndex(items, synonyms) {
  const byKey = new Map(items.map((it) => [it.key, it]));

  // Længst først, så det mest specifikke match vinder:
  // "hakket oksekød" slår "oksekød".
  const syns = synonyms
    .filter((s) => byKey.has(s.item_key))
    .map((s) => ({ term: String(s.text).toLowerCase(), lang: s.lang, entry: byKey.get(s.item_key) }))
    .sort((a, b) => b.term.length - a.term.length);

  // Kopiér denne krop TEGN FOR TEGN fra src/lib/taxonomy.js. Den er
  // aftrykket af den nuværende lookup(); enhver omskrivning — også en, der
  // ser pænere ud — ændrer hvilke af 26.242 ingredienslinjer der matcher.
  function lookup(text) {
    if (!text) return null;
    const hay = String(text).toLowerCase();
    const english = looksEnglish(hay);
    let best = null;

    for (const syn of syns) {
      const i = hay.indexOf(syn.term);
      if (i === -1) continue;

      const leftOK = !isWordChar(hay[i - 1]);
      const after  = hay.slice(i + syn.term.length);
      let rightOK  = !isWordChar(after[0]);

      if (syn.lang === 'en') {
        if (!leftOK) continue;                         // ikke en orddel på engelsk
        if (!rightOK) {
          if (!/^e?s(?![a-zæøå])/.test(after)) continue;
          rightOK = true;                              // flertal: "courgettes"
        }
      } else if (english && syn.term.length < 5) {
        continue;                                      // kort dansk ord i engelsk tekst
      }

      const exact = (leftOK ? 1 : 0) + (rightOK ? 1 : 0);
      if (exact === 0) continue;                       // midt inde i et ord
      if (exact < 2 && syn.term.length < 4) continue;  // for kort til delmatch

      const cand = { entry: syn.entry, term: syn.term, exact, pos: i, len: syn.term.length };
      const wins = !best
        || cand.exact > best.exact
        || (cand.exact === best.exact && cand.pos < best.pos)
        || (cand.exact === best.exact && cand.pos === best.pos && cand.len > best.len);
      if (wins) best = cand;
    }

    return best ? { entry: best.entry, term: best.term } : null;
  }

  const get = (key) => byKey.get(key) || null;
  const flag = (key, fn) => { const e = byKey.get(key); return !!e && fn(e); };

  return {
    get,
    lookup,
    all: () => items,
    isEssential:   (key) => flag(key, (e) => e.class === 'essential'),
    isPremium:     (key) => flag(key, (e) => !!e.premium),
    isNonFood:     (key) => flag(key, (e) => NONFOOD_CATS.has(e.category)),
    isMealCapable: (key) => flag(key, (e) => !NON_MEAL_CATS.has(e.category)),
    looksEnglish,
  };
}

module.exports = { buildIndex, looksEnglish, NON_MEAL_CATS };
```

- [ ] **Step 5: Kør testen og se den passere**

Kør: `node --test test/items.test.js`
Forventet: PASS, 8 tests

- [ ] **Step 6: Kør hele suiten — intet må være brudt endnu**

Kør: `npm test`
Forventet: PASS. `taxonomy.js` er urørt i denne opgave, så `normalize.test.js` og `mealplan.test.js` skal stå uændret.

- [ ] **Step 7: Commit**

```bash
git add src/lib/items.js test/items.test.js package.json
git commit -m "Ren indeksbygger for varetyper, uden database"
```

---

### Task 2: `class` og `keeps` på alle varetyper

Kurateringsarbejdet fra spec afsnit 1.1. Tilføjer to felter til hver post i `TAXONOMY`, sletter `STAPLE_KEYS`, og retter de fejlklassificeringer, spec'en navngiver.

**Files:**
- Modify: `src/lib/taxonomy.js` (hver post i `TAXONOMY`; `STAPLE_KEYS` slettes; `isStaple` slettes)
- Modify: `test/items.test.js` (ny test-blok)

**Interfaces:**
- Consumes: intet
- Produces: hver post i `TAXONOMY` har nu `class: 'fresh'|'baseline'|'essential'` og `keeps: 'perishable'|'keeps'|'pantry'`. `taxonomy.isStaple` og `taxonomy.STAPLE_KEYS` findes ikke længere.

- [ ] **Step 1: Skriv den fejlende test**

Tilføj til `test/items.test.js`. Casene er præcis de beslutninger, spec'en traf — de skal være aflæselige som regler, ikke som en liste:

```js
// ── Kurateringen fra spec afsnit 1.1 ─────────────────────────────────────────

const taxonomy = require('../src/lib/taxonomy');

test('essentials er hvad der reelt står i et dansk køkkenskab', () => {
  for (const key of ['salt', 'peber', 'olie', 'eddike', 'sukker', 'mel',
                     'bouillon', 'soja', 'ketchup', 'honning', 'rasp']) {
    assert.equal(taxonomy.get(key).class, 'essential', `${key} skal være essential`);
  }
});

test('hvidløg, ingefær og frisk persille skal købes — de er ikke essentials', () => {
  for (const key of ['hvidloeg', 'ingefaer', 'persille']) {
    assert.notEqual(taxonomy.get(key).class, 'essential', `${key} skal købes`);
  }
});

test('specialkrydderier er baseline: de købes, men holder i månedsvis', () => {
  for (const key of ['sesamfroe', 'garam_masala', 'gurkemeje', 'kardemomme']) {
    const it = taxonomy.get(key);
    assert.equal(it.class, 'baseline', `${key} skal være baseline`);
    assert.equal(it.keeps, 'pantry', `${key} skal holde i månedsvis`);
  }
});

test('alle varer har gyldig class og keeps', () => {
  const CLASSES = new Set(['fresh', 'baseline', 'essential']);
  const KEEPS   = new Set(['perishable', 'keeps', 'pantry']);
  for (const it of taxonomy.all()) {
    assert.ok(CLASSES.has(it.class), `${it.key} har ugyldig class: ${it.class}`);
    assert.ok(KEEPS.has(it.keeps),   `${it.key} har ugyldig keeps: ${it.keeps}`);
  }
});

test('essentials må aldrig være perishable — så ville de ikke kunne stå i skabet', () => {
  for (const it of taxonomy.all()) {
    if (it.class === 'essential') {
      assert.notEqual(it.keeps, 'perishable', `${it.key} kan ikke være essential og perishable`);
    }
  }
});

test('isStaple findes ikke længere — informationen bor i class', () => {
  assert.equal(typeof taxonomy.isStaple, 'undefined');
});
```

Bemærk: `sesamfroe`, `garam_masala`, `gurkemeje` og `kardemomme` findes ikke endnu. De oprettes i denne opgave, fordi testen ovenfor kræver dem — resten af de ~120 nye varer kommer i opgave 8.

- [ ] **Step 2: Kør testen og se den fejle**

Kør: `node --test test/items.test.js`
Forventet: FAIL — `taxonomy.get(...)` giver `null` for `rasp`, og `it.class` er `undefined`.

- [ ] **Step 3: Tilføj `class` og `keeps` til hver post i `TAXONOMY`**

Regler for tildelingen, i den rækkefølge:

| | class | keeps |
|---|---|---|
| kød, fjerkræ, fisk, mejeri, ost, æg, friske grøntsager, frugt, brød | `fresh` | `perishable` |
| **rodfrugter, løg, kartofler, kål** | **`baseline`** | `keeps` |
| ris, pasta, mel-produkter, tørrede bønner, konserves, krydderier der skal købes | `baseline` | `pantry` |
| listen i `STAPLE_KEYS` minus `hvidloeg`, `ingefaer`, `persille`, plus `rasp` | `essential` | `pantry` |

Rodfrugtrækken er `baseline`, ikke `fresh`, og det er hele pointen med kategorien: en gulerod koster stort set det samme hele året, så dens normalpris behøver ikke ses efter hver tredje måned. Spec afsnit 1.1 nævner netop "kartofler, gulerødder" som baseline-eksempler. `keeps` fortæller separat, at en rest ikke er spild med det samme — de to felter svarer på hver sit spørgsmål, og en rodfrugt er den vare, hvor forskellen er tydeligst.

Bemærk at `class` og `keeps` ikke følges ad. `hvidloeg` er `fresh`/`keeps`: prisen svinger som friske varer, men et fed hvidløg rådner ikke i næste uge.

Eksempler på den ændrede form:

```js
  { key: 'hakket_oksekoed', name: 'Hakket oksekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable',
    p: 20, kcal: 175, c: 0, fatGrades: true,
    da: ['hakket oksekød', 'hakket okse', 'oksefars', 'hakket kalv og flæsk', 'hakket kalv & flæsk'],
    en: ['minced beef', 'ground beef', 'beef mince'] },

  { key: 'kartofler', name: 'Kartofler', cat: 'veg',
    class: 'baseline', keeps: 'keeps',
    p: 2, kcal: 80, c: 17,
    da: ['kartofler', 'kartoffel'], en: ['potatoes', 'potato'] },

  { key: 'olie', name: 'Olie', cat: 'pantry',
    class: 'essential', keeps: 'pantry',
    p: 0, kcal: 880, c: 0,
    da: ['olivenolie', 'rapsolie', 'solsikkeolie', 'madolie', 'olie'],
    en: ['olive oil', 'vegetable oil', 'rapeseed oil', 'sunflower oil', 'oil'] },
```

**`base_unit` og `density_g_ml` sættes samtidig.** De hører til samme kuratering: en vare, der måles i liter, skal sige det selv i stedet for at blive gættet af en hardkodet liste i et script. Standarden er `kg`, så feltet skrives kun, hvor det ikke passer:

```js
  { key: 'floede', name: 'Fløde', cat: 'dairy',
    class: 'fresh', keeps: 'perishable',
    base_unit: 'l', density_g_ml: 1.0,
    p: 2, kcal: 340, c: 3,
    da: ['piskefløde', 'madlavningsfløde', 'fløde'], en: ['double cream', 'cream'] },

  { key: 'aeg', name: 'Æg', cat: 'eggs',
    class: 'fresh', keeps: 'keeps', base_unit: 'stk',
    p: 13, kcal: 145, c: 1,
    da: ['æg'], en: ['eggs', 'egg'] },
```

`base_unit: 'l'` med `density_g_ml`: fløde, mælk, yoghurt (1,0), olie (0,92), eddike (1,01), soja (1,2).
`base_unit: 'stk'`: æg, tortilla, brød.
Alt andet: udelad felterne — `kg` er standarden.

Fire poster ændrer klasse i forhold til i dag — det er spec'ens rettelser:

```js
  // Stod i STAPLE_KEYS, men købes: de bruges i portioner, ikke i teskefulde.
  { key: 'hvidloeg', ..., class: 'fresh', keeps: 'keeps' },
  { key: 'ingefaer', ..., class: 'fresh', keeps: 'keeps' },
  { key: 'persille', ..., class: 'fresh', keeps: 'perishable' },
```

Og fire nye poster, som testen kræver:

```js
  { key: 'rasp', name: 'Rasp', cat: 'pantry', class: 'essential', keeps: 'pantry',
    p: 11, kcal: 350, c: 70,
    da: ['rasp', 'pankorasp', 'panko'],
    en: ['breadcrumbs', 'panko breadcrumbs', 'panko', 'brioche crumbs'] },
  { key: 'sesamfroe', name: 'Sesamfrø', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 18, kcal: 570, c: 12,
    da: ['sesamfrø', 'sesam'], en: ['sesame seeds', 'sesame'] },
  { key: 'garam_masala', name: 'Garam masala', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 380, c: 45,
    da: ['garam masala'], en: ['garam masala'] },
  { key: 'gurkemeje', name: 'Gurkemeje', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 350, c: 65,
    da: ['stødt gurkemeje', 'gurkemeje'], en: ['ground turmeric', 'turmeric'] },
  { key: 'kardemomme', name: 'Kardemomme', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 310, c: 68,
    da: ['stødt kardemomme', 'kardemomme'], en: ['ground cardamom', 'cardamom', 'cardamom pods'] },
```

- [ ] **Step 4: Slet `STAPLE_KEYS` og `isStaple`**

I `src/lib/taxonomy.js`: fjern `const STAPLE_KEYS = new Set([...])` (linje 344-350 i den nuværende fil), funktionen `isStaple` (linje 523), og begge navne fra `module.exports`. Erstat med `isEssential`, der læser `class`:

```js
function isEssential(key) { const e = BY_KEY.get(key); return !!e && e.class === 'essential'; }
```

Tilføj samtidig `all` til `module.exports`:

```js
  all: () => TAXONOMY,
```

Den findes ikke i dag, men testene i trin 1 bruger den, og opgave 3 peger den om til basen. Lægges den på nu, behøver testene aldrig at blive skrevet om.

Behold kommentaren over det gamle `STAPLE_KEYS` (linje 340-343), men flyt den op over `class`-feltets forklaring — begrundelsen holder stadig, den hører bare til et andet sted nu.

- [ ] **Step 5: Ret de tre kaldssteder, der bruger `isStaple`**

```bash
grep -rn "isStaple" src/ public/ test/ scripts/ --include=*.js
```
Der er præcis tre. Alle tre er midlertidige rettelser — opgave 6 og 9 skriver dem om igen.

`src/recipes/extract.js:268`:
```js
    is_staple: key ? (taxonomy.isEssential(key) ? 1 : 0) : 0,
```

`src/mealplan/generate.js:250`:
```js
      staple: Boolean(ing.is_staple) || taxonomy.isEssential(ing.taxonomy_key),
```

`test/mealplan.test.js:287` og `:290` — testen hedder noget med "basisvare":
```js
    assert.ok(taxonomy.isEssential(k), `${k} bør være basisvare`);
```
```js
    assert.ok(!taxonomy.isEssential(k), `${k} bør IKKE være basisvare`);
```

**Bemærk:** den test hævder i dag, at `hvidloeg` er en basisvare. Efter denne opgave er den ikke, så listen i testen skal også rettes — det er hele pointen med opgaven.

- [ ] **Step 6: Kør testene**

Kør: `npm test`
Forventet: PASS, efter at listen i `mealplan.test.js` er rettet i trin 5.

- [ ] **Step 7: Commit**

```bash
git add src/lib/taxonomy.js src/recipes/extract.js test/items.test.js
git commit -m "class og keeps paa varetyper; essentials kurateret"
```

---

### Task 3: `items` + `item_synonyms` i basen, og `taxonomy.js` som indlæser

**Files:**
- Modify: `src/db/schema.sql` (to nye tabeller)
- Create: `scripts/seed-items.js`
- Modify: `src/lib/taxonomy.js` (henter fra basen, memoiserer)
- Modify: `package.json` (nyt script)

**Interfaces:**
- Consumes: `buildIndex()` fra opgave 1; `TAXONOMY` med `class`/`keeps` fra opgave 2
- Produces:
  - Tabellerne `items` og `item_synonyms`
  - `npm run seed:items` fylder dem
  - `taxonomy.js` eksporterer uændret: `get`, `lookup`, `all`, `isEssential`, `isPremium`, `isNonFood`, `isMealCapable`, `looksEnglish`, `hintsAtMainIngredient`, `preparedForm`, `PREPARED_FORMS`, `NON_MEAL_CATS`

- [ ] **Step 1: Tilføj tabellerne til `src/db/schema.sql`**

Sæt dem ind lige før afsnittet `-- ── Opskrifter ──`:

```sql
-- ── Varetyper ───────────────────────────────────────────────────────────────
-- Kanonisk varetype. Dét prishistorik, opskriftsmatch og indkøbsliste hænger
-- på. Lå tidligere som en konstant i src/lib/taxonomy.js; ligger her, fordi
-- den skal bære pris og kadence, og det kan en JavaScript-konstant ikke.
CREATE TABLE IF NOT EXISTS items (
  key              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  -- fresh: prisen flytter sig ugentligt · baseline: sjældent · essential:
  -- står i skabet, købes ikke pr. madplan og prissættes derfor aldrig
  class            TEXT NOT NULL CHECK (class IN ('fresh','baseline','essential')),
  -- Hvor længe en rest holder. Styrer alene madspilds-optimeringen: en rest
  -- kartofler er ikke spild, en rest fløde er.
  keeps            TEXT NOT NULL CHECK (keeps IN ('perishable','keeps','pantry')),
  base_unit        TEXT NOT NULL CHECK (base_unit IN ('kg','l','stk')),
  piece_g          REAL,
  density_g_ml     REAL,
  protein_per_100g REAL,
  kcal_per_100g    REAL,
  carbs_per_100g   REAL,
  fat_grades       INTEGER DEFAULT 0,
  premium          INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_class ON items(class);

CREATE TABLE IF NOT EXISTS item_synonyms (
  item_key TEXT NOT NULL REFERENCES items(key) ON DELETE CASCADE,
  lang     TEXT NOT NULL,
  text     TEXT NOT NULL,
  PRIMARY KEY (item_key, lang, text)
);
CREATE INDEX IF NOT EXISTS idx_item_syn_text ON item_synonyms(text);
```

- [ ] **Step 2: Skriv `scripts/seed-items.js`**

`base_unit` udledes af kategorien, fordi det ikke står i seed-arrayet:

```js
'use strict';

/**
 * Fylder items + item_synonyms fra seed-arrayet i src/lib/taxonomy.js.
 *
 * Idempotent: kan køres igen efter en rettelse i seed-data uden at duplikere.
 * Synonymer slettes og skrives forfra pr. vare, så et fjernet synonym også
 * forsvinder i basen.
 *
 *   npm run seed:items
 */

const { getDb } = require('../src/db');
const { SEED } = require('../src/lib/taxonomy');

// base_unit er kurateret på posten selv (opgave 2). Kg er standarden, fordi
// langt de fleste varer vejes — en liste over undtagelser her ville være et
// andet sted at holde ved lige end der, hvor varen defineres.
const baseUnitFor = (entry) => entry.base_unit || 'kg';

function main() {
  const db = getDb();

  const upsertItem = db.prepare(`
    INSERT INTO items (key, name, category, class, keeps, base_unit, piece_g,
                       density_g_ml, protein_per_100g, kcal_per_100g,
                       carbs_per_100g, fat_grades, premium)
    VALUES (@key, @name, @category, @class, @keeps, @base_unit, @piece_g,
            @density_g_ml, @protein_per_100g, @kcal_per_100g,
            @carbs_per_100g, @fat_grades, @premium)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name, category = excluded.category, class = excluded.class,
      keeps = excluded.keeps, base_unit = excluded.base_unit,
      piece_g = excluded.piece_g, density_g_ml = excluded.density_g_ml,
      protein_per_100g = excluded.protein_per_100g,
      kcal_per_100g = excluded.kcal_per_100g,
      carbs_per_100g = excluded.carbs_per_100g,
      fat_grades = excluded.fat_grades, premium = excluded.premium
  `);
  const clearSyn  = db.prepare('DELETE FROM item_synonyms WHERE item_key = ?');
  const insertSyn = db.prepare(
    'INSERT OR IGNORE INTO item_synonyms (item_key, lang, text) VALUES (?, ?, ?)'
  );

  const { PIECE_G } = require('../src/lib/units');

  const run = db.transaction(() => {
    for (const e of SEED) {
      upsertItem.run({
        key: e.key, name: e.name, category: e.cat,
        class: e.class, keeps: e.keeps,
        base_unit: baseUnitFor(e),
        piece_g: PIECE_G[e.key] ?? null,
        density_g_ml: e.density_g_ml ?? null,
        protein_per_100g: e.p ?? null,
        kcal_per_100g: e.kcal ?? null,
        carbs_per_100g: e.c ?? null,
        fat_grades: e.fatGrades ? 1 : 0,
        premium: e.premium ? 1 : 0,
      });
      clearSyn.run(e.key);
      for (const s of e.da || []) insertSyn.run(e.key, 'da', s.toLowerCase());
      for (const s of e.en || []) insertSyn.run(e.key, 'en', s.toLowerCase());
    }
  });
  run();

  const items = db.prepare('SELECT count(*) c FROM items').get().c;
  const syns  = db.prepare('SELECT count(*) c FROM item_synonyms').get().c;
  console.log(`items: ${items} · synonymer: ${syns}`);
}

main();
```

**Udfør opgave 4 før denne opgave.** `PIECE_G` importeres fra `src/lib/units.js`, som oprettes dér, og opgave 4 afhænger ikke af noget i opgave 3. Køres de i nummerorden, skal importen midlertidigt pege på `../src/recipes/classify` og rettes bagefter — unødigt arbejde for ingenting.

- [ ] **Step 3: Gør `taxonomy.js` til indlæser**

Omdøb `TAXONOMY` til `SEED` og eksportér den (seed-scriptet skal bruge den). Erstat bunden af filen — `BY_KEY`, `SYNONYMS`, `lookup`, `get`, `isEssential`, `isPremium`, `isNonFood`, `isMealCapable` — med et memoiseret indeks hentet fra basen:

```js
const { buildIndex, NON_MEAL_CATS } = require('./items');
const { PIECE_G } = require('./units');

/**
 * Indekset bygges én gang pr. proces, ud fra basen.
 *
 * Falder tilbage til seed-arrayet, hvis tabellerne endnu ikke findes: så kan
 * scripts køre på en frisk base, før seed-scriptet har kørt, og testene
 * behøver ikke en database.
 */
let _index = null;

function index() {
  if (_index) return _index;
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const items = db.prepare('SELECT * FROM items').all();
    if (items.length) {
      const syns = db.prepare('SELECT item_key, lang, text FROM item_synonyms').all();
      _index = buildIndex(items, syns);
      return _index;
    }
  } catch { /* ingen base tilgængelig – brug seed */ }

  _index = buildIndex(
    SEED.map((e) => ({
      key: e.key, name: e.name, category: e.cat, class: e.class, keeps: e.keeps,
      base_unit: e.base_unit || 'kg', piece_g: PIECE_G[e.key] ?? null,
      density_g_ml: e.density_g_ml ?? null,
      protein_per_100g: e.p ?? null, kcal_per_100g: e.kcal ?? null,
      carbs_per_100g: e.c ?? null, premium: !!e.premium, fat_grades: !!e.fatGrades,
    })),
    SEED.flatMap((e) => [
      ...(e.da || []).map((t) => ({ item_key: e.key, lang: 'da', text: t })),
      ...(e.en || []).map((t) => ({ item_key: e.key, lang: 'en', text: t })),
    ]),
  );
  return _index;
}

/** Tømmer memoiseringen. Kun til brug efter seed-scriptet har skrevet. */
function reload() { _index = null; }

module.exports = {
  SEED, PREPARED_FORMS, NON_MEAL_CATS, reload,
  get:           (k) => index().get(k),
  lookup:        (t) => index().lookup(t),
  all:           ()  => index().all(),
  isEssential:   (k) => index().isEssential(k),
  isPremium:     (k) => index().isPremium(k),
  isNonFood:     (k) => index().isNonFood(k),
  isMealCapable: (k) => index().isMealCapable(k),
  looksEnglish,
  hintsAtMainIngredient,
  preparedForm,
};
```

- [ ] **Step 4: Ret den ene forbruger af `TAXONOMY`**

```bash
grep -rn "taxonomy.TAXONOMY" src/ public/ test/ scripts/ --include=*.js
```
Der er ét: `src/sync/build.js:161` bygger `taxonomyPrices` ud fra arrayet. Arrayet hedder nu `SEED` og er kun seed-data — den rigtige kilde er basen:

```js
  const taxonomyPrices = taxonomy.all()
```

Blokken læser kun `t.key` og `t.name`, og de hedder det samme i basens rækker som i seed-arrayet, så det er hele ændringen. Poster fra `all()` bruger ellers databasens feltnavne (`category`, `protein_per_100g`) og ikke seedets korte (`cat`, `p`) — det får betydning i opgave 9, ikke her.

Slet også brotesten `'indekset svarer som taxonomy.js på ægte ingredienslinjer'` i `test/items.test.js`. Den sammenlignede det nye indeks med `taxonomy.js`' egen `lookup`, og den findes ikke længere — fra nu af *er* indekset facit. Testen ville fra dette punkt sammenligne indekset med sig selv og bekræfte ingenting.

Kør `node --test test/sync.test.js` og `node --test test/items.test.js` bagefter.

- [ ] **Step 5: Tilføj scriptet til `package.json`**

```json
"seed:items": "node scripts/seed-items.js",
```

- [ ] **Step 6: Kør seed-scriptet mod en kopi af basen**

```bash
cp data.db data.db.pre-items
DB_PATH=data.db node scripts/seed-items.js
```

Forventet: `items: ~155 · synonymer: ~900`

- [ ] **Step 7: Bekræft at opslaget stadig virker gennem basen**

```bash
node -e "
const t=require('./src/lib/taxonomy');
console.log(t.lookup('500 g kyllingebrystfilet').entry.key);   // kyllingebryst
console.log(t.lookup('jomfruolivenolie').entry.key);           // olie
console.log(t.get('rasp').class);                              // essential
console.log(t.all().length);
"
```

- [ ] **Step 8: Kør hele suiten**

Kør: `npm test`
Forventet: PASS. `normalize.test.js` tester `parseIngredient`, som slår op gennem `taxonomy` — den er nu databasedrevet, og testen bekræfter dermed også, at seedet er korrekt.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql scripts/seed-items.js src/lib/taxonomy.js src/sync/build.js package.json
git commit -m "items og item_synonyms i basen; taxonomy.js bliver indlaeser"
```

---

### Task 4: `src/lib/units.js` med `amountOf()`

**Files:**
- Create: `src/lib/units.js`
- Create: `test/units.test.js`
- Modify: `src/recipes/classify.js` (importerer i stedet for at definere)
- Modify: `package.json` (test-scriptet)

**Interfaces:**
- Consumes: intet
- Produces:
  - `UNIT_G`, `UNIT_ML`, `PIECE_G`, `DEFAULT_PIECE_G`
  - `gramsOf(ing, item)` → gram eller `null`
  - `amountOf(ing, item)` → mængde i `item.base_unit` eller `null`
    - `ing`: `{ qty, unit, item_key }`
    - `item`: `{ base_unit, piece_g, density_g_ml }`

- [ ] **Step 1: Skriv den fejlende test**

Opret `test/units.test.js`:

```js
'use strict';

/**
 * Tests for enhedskonvertering.
 *
 * Den vigtige regel: rumfang må ikke gå gennem gram, når varen måles i liter.
 * "2 dl fløde" er 0,2 l uanset fløderens massefylde — regner man om til gram
 * og tilbage, får man 0,22 l, og indkøbslisten køber en karton for meget.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { gramsOf, amountOf } = require('../src/lib/units');

const KG   = { base_unit: 'kg' };
const L    = { base_unit: 'l', density_g_ml: 1.0 };
const OLIE = { base_unit: 'l', density_g_ml: 0.92 };
const LOEG = { base_unit: 'kg', piece_g: 110 };
const AEG  = { base_unit: 'stk', piece_g: 58 };

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('masse til kg', () => {
  near(amountOf({ qty: 500, unit: 'g' }, KG), 0.5);
  near(amountOf({ qty: 1.5, unit: 'kg' }, KG), 1.5);
});

test('rumfang til liter går IKKE gennem gram', () => {
  near(amountOf({ qty: 2, unit: 'dl' }, L), 0.2);
  // Massefylden må ikke smitte af, når begge sider er rumfang.
  near(amountOf({ qty: 2, unit: 'dl' }, OLIE), 0.2);
});

test('rumfang til kg bruger massefylden', () => {
  near(amountOf({ qty: 1, unit: 'l' }, { base_unit: 'kg', density_g_ml: 0.92 }), 0.92);
});

test('masse til liter bruger massefylden den anden vej', () => {
  near(amountOf({ qty: 920, unit: 'g' }, OLIE), 1.0);
});

test('stykvarer tælles, de vejes ikke', () => {
  near(amountOf({ qty: 4, unit: null }, AEG), 4);
  near(amountOf({ qty: 4, unit: 'stk' }, AEG), 4);
  // 200 g æg er ~3,4 æg
  near(amountOf({ qty: 200, unit: 'g' }, AEG), 200 / 58);
});

test('"2 løg" bruger stykvægten', () => {
  near(amountOf({ qty: 2, unit: null }, LOEG), 0.22);
});

test('ukendt mængde giver null, ikke nul', () => {
  assert.equal(amountOf({ qty: null, unit: 'g' }, KG), null);
  assert.equal(amountOf({ qty: 0, unit: 'g' }, KG), null);
  assert.equal(amountOf({ qty: 2, unit: 'g' }, null), null);
});

test('gramsOf er stadig til rådighed for næringsberegningen', () => {
  near(gramsOf({ qty: 2, unit: 'dl' }, L), 200);
  near(gramsOf({ qty: 2, unit: null }, LOEG), 220);
});
```

- [ ] **Step 2: Tilføj testfilen til `package.json`**

Tilføj `test/units.test.js` til `test`-scriptet.

- [ ] **Step 3: Kør testen og se den fejle**

Kør: `node --test test/units.test.js`
Forventet: FAIL med `Cannot find module '../src/lib/units'`

- [ ] **Step 4: Skriv `src/lib/units.js`**

Flyt `UNIT_G`, `PIECE_G` og `DEFAULT_PIECE_G` uændret fra `src/recipes/classify.js:17-38`. Del enhederne i masse og rumfang, og tilføj `amountOf`:

```js
'use strict';

/**
 * Enhedskonvertering fra opskriftstekst til varens egen enhed.
 *
 * Opskrifter måler i alt muligt — gram, dl, spsk, "2 løg" — og varen måles i
 * kg, l eller stk. Det er her de to mødes.
 *
 * Masse og rumfang holdes adskilt med vilje. Regner man rumfang om til gram
 * og tilbage til rumfang, ganger og dividerer man med massefylden, og små
 * fejl bliver til en ekstra karton fløde på indkøbslisten.
 */

// Rene massemål.
const UNIT_G = {
  g: 1, gram: 1, gr: 1, kg: 1000, oz: 28.35,
  lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6,
};

// Rene rumfangsmål, i ml.
const UNIT_ML = {
  ml: 1, cl: 10, dl: 100, l: 1000, liter: 1000, ltr: 1000,
  spsk: 15, tsk: 5, tbsp: 15, tablespoon: 15, tablespoons: 15,
  tsp: 5, teaspoon: 5, teaspoons: 5, cup: 240, cups: 240,
};

// Upræcise mål, som vi kun kan give en vægt. De optræder næsten kun på
// krydderier og friske urter, hvor præcisionen alligevel er ligegyldig.
const UNIT_APPROX_G = {
  knivspids: 1, pinch: 1, nip: 1,
  fed: 3, clove: 3, cloves: 3,
  håndfuld: 30, handful: 30, bundt: 30, bunch: 30, sprig: 2, sprigs: 4,
  dåse: 400, dåser: 400, can: 400, cans: 400, tin: 400, tins: 400,
  skive: 25, skiver: 25, slice: 25, slices: 25, rasher: 25, rashers: 25,
  pakke: 250, pakker: 250, pack: 250, packs: 250, pose: 250, poser: 250,
};

// Typisk stykvægt når opskriften bare siger "1 løg".
const PIECE_G = {
  aeg: 58, loeg: 110, hvidloeg: 4, gulerod: 70, tomat: 90, kartofler: 120,
  citron: 90, appelsin: 140, banan: 120, aeble: 150, peberfrugt: 150,
  agurk: 300, squash: 200, aubergine: 250, porre: 150, avocado: 150,
  selleri: 40, broccoli: 350, blomkaal: 500, kyllingebryst: 150,
  brod: 500, tortilla: 60, sodkartoffel: 150, ingefaer: 15,
};
const DEFAULT_PIECE_G = 100;
const COUNT_UNITS = new Set(['stk', 'stykker', 'styk', 'piece', 'pieces']);

const norm = (u) => (u ? String(u).toLowerCase() : null);

/** Rumfang i ml, hvis enheden er et rumfangsmål. Ellers null. */
function mlOf(ing) {
  if (!ing || !ing.qty || ing.qty <= 0) return null;
  const f = UNIT_ML[norm(ing.unit)];
  return f ? ing.qty * f : null;
}

/**
 * Vægt i gram. `item` bruges kun til stykvægt og massefylde og må gerne
 * mangle — så falder den tilbage til 100 g pr. stk, som hidtil.
 */
function gramsOf(ing, item = null) {
  if (!ing || !ing.qty || ing.qty <= 0) return null;
  const u = norm(ing.unit);

  if (u && UNIT_G[u])        return ing.qty * UNIT_G[u];
  if (u && UNIT_APPROX_G[u]) return ing.qty * UNIT_APPROX_G[u];
  if (u && UNIT_ML[u])       return ing.qty * UNIT_ML[u] * (item?.density_g_ml ?? 1);

  // Ingen enhed: opskriften tæller stykker.
  return ing.qty * (item?.piece_g ?? DEFAULT_PIECE_G);
}

/**
 * Mængden i varens egen enhed: kg, l eller stk.
 * Det er dette tal, indkøbslisten lægger sammen og runder op til hele pakker.
 */
function amountOf(ing, item) {
  if (!item || !ing || !ing.qty || ing.qty <= 0) return null;
  const u = norm(ing.unit);

  if (item.base_unit === 'stk') {
    if (!u || COUNT_UNITS.has(u)) return ing.qty;
    const g = gramsOf(ing, item);
    const per = item.piece_g ?? DEFAULT_PIECE_G;
    return g == null ? null : g / per;
  }

  if (item.base_unit === 'l') {
    // Rumfang til rumfang: massefylden skal ikke ind over.
    const ml = mlOf(ing);
    if (ml != null) return ml / 1000;
    const g = gramsOf(ing, item);
    return g == null ? null : g / (1000 * (item.density_g_ml ?? 1));
  }

  const g = gramsOf(ing, item);
  return g == null ? null : g / 1000;
}

module.exports = {
  UNIT_G, UNIT_ML, UNIT_APPROX_G, PIECE_G, DEFAULT_PIECE_G,
  gramsOf, amountOf, mlOf,
};
```

- [ ] **Step 5: Kør testen og se den passere**

Kør: `node --test test/units.test.js`
Forventet: PASS, 8 tests

- [ ] **Step 6: Lad `classify.js` importere i stedet for at definere**

I `src/recipes/classify.js`: slet `UNIT_G`, `PIECE_G`, `DEFAULT_PIECE_G` og `gramsOf` (linje 17-49), og importér i stedet:

```js
const { gramsOf, UNIT_G, PIECE_G } = require('../lib/units');
```

Ret kaldet inde i `estimateNutrition` (linje 60), så varen sendes med — den kender nu stykvægten:

```js
    const g = gramsOf(ing, entry);
```

Behold `module.exports = { estimateNutrition, scoreTiers, primaryTier, gramsOf, UNIT_G, PIECE_G };` uændret, så eksisterende kaldssteder ikke brækker.

- [ ] **Step 7: Kør hele suiten**

Kør: `npm test`
Forventet: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/units.js test/units.test.js src/recipes/classify.js package.json
git commit -m "units.js: amountOf regner til varens egen enhed"
```

---

### Task 5: Nye kolonner på `recipe_ingredients` + backfill

**Files:**
- Modify: `src/db/index.js` (`migrate()`)
- Create: `scripts/backfill-amounts.js`
- Modify: `package.json` (nyt script)

**Interfaces:**
- Consumes: `amountOf()` fra opgave 4; `items`-tabellen fra opgave 3
- Produces: `recipe_ingredients` har kolonnerne `item_key TEXT`, `amount REAL`, `optional INTEGER DEFAULT 0`. `npm run backfill:amounts` udfylder dem.

`is_staple` og `taxonomy_key` bliver stående i denne opgave. De fjernes i opgave 9, når alle forbrugere er flyttet — en kolonne, der droppes for tidligt, tager basen med sig.

- [ ] **Step 1: Tilføj kolonnerne i `migrate()`**

I `src/db/index.js`, i `added`-arrayet:

```js
    ['recipe_ingredients', 'item_key', 'TEXT'],
    ['recipe_ingredients', 'amount',   'REAL'],
    ['recipe_ingredients', 'optional', 'INTEGER DEFAULT 0'],
```

- [ ] **Step 2: Skriv `scripts/backfill-amounts.js`**

```js
'use strict';

/**
 * Udfylder item_key, amount og optional på de eksisterende ingredienslinjer.
 *
 * item_key er indtil videre en kopi af taxonomy_key — de peger på samme
 * nøgler. Linjer uden nøgle slås op igen, fordi taksonomien har fået nye
 * varer siden de blev skrevet.
 *
 *   npm run backfill:amounts
 */

const { getDb } = require('../src/db');
const taxonomy  = require('../src/lib/taxonomy');
const { amountOf } = require('../src/lib/units');

// "til servering", "evt.", "to serve" driver ikke et indkøb.
const OPTIONAL_RE = /(til servering|til pynt|til garniture|evt\.?\s|eventuelt|efter smag|to serve|to garnish|optional|for serving|if you like)/i;

function main() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, raw, qty, unit, ingredient, taxonomy_key FROM recipe_ingredients'
  ).all();

  const upd = db.prepare(
    'UPDATE recipe_ingredients SET item_key = ?, amount = ?, optional = ? WHERE id = ?'
  );

  let keyed = 0, amounts = 0, optional = 0, rekeyed = 0;

  const run = db.transaction(() => {
    for (const r of rows) {
      let key = r.taxonomy_key;
      if (!key) {
        // Taksonomien er vokset siden linjen blev skrevet — prøv igen.
        const hit = taxonomy.lookup(r.ingredient) || taxonomy.lookup(r.raw);
        if (hit) { key = hit.entry.key; rekeyed++; }
      }

      const item = key ? taxonomy.get(key) : null;
      const amount = item ? amountOf({ qty: r.qty, unit: r.unit }, item) : null;
      const opt = OPTIONAL_RE.test(r.raw || '') ? 1 : 0;

      if (key)    keyed++;
      if (amount != null) amounts++;
      if (opt)    optional++;

      upd.run(key, amount, opt, r.id);
    }
  });
  run();

  console.log(`linjer: ${rows.length}`);
  console.log(`  med item_key: ${keyed} (heraf ${rekeyed} nye match)`);
  console.log(`  med amount:   ${amounts}`);
  console.log(`  optional:     ${optional}`);
}

main();
```

- [ ] **Step 3: Tilføj scriptet til `package.json`**

```json
"backfill:amounts": "node scripts/backfill-amounts.js",
```

- [ ] **Step 4: Kør backfill mod en kopi**

```bash
cp data.db data.db.pre-amounts
node scripts/backfill-amounts.js
```

Forventet, i omegnen af:
```
linjer: 31438
  med item_key: 26242+ (heraf 200+ nye match)
  med amount:   28000+
  optional:     500+
```

- [ ] **Step 5: Stikprøve — er tallene rimelige?**

```bash
node -e "
const db=require('better-sqlite3')('data.db',{readonly:true});
console.log(db.prepare(\"select raw, qty, unit, item_key, amount from recipe_ingredients where item_key in ('floede','kartofler','aeg','hakket_oksekoed') and amount is not null limit 15\").all());
console.log('mistaenkeligt store:', db.prepare('select count(*) c from recipe_ingredients where amount > 10').get().c);
"
```

Forventet: `500 g hakket oksekød` → `0.5`; `2 dl fløde` → `0.2`; `4 æg` → `4`.
`amount > 10` skal være et lille tal (under ~100). Er det stort, er en enhed regnet forkert — undersøg før du går videre.

- [ ] **Step 6: Commit**

```bash
git add src/db/index.js scripts/backfill-amounts.js package.json
git commit -m "item_key, amount og optional paa recipe_ingredients"
```

---

### Task 6: `parseIngredient` skriver de nye felter

Så nye opskrifter, der hentes ind, får felterne fra starten og ikke først ved næste backfill.

**Files:**
- Modify: `src/recipes/extract.js:217-272` (`parseIngredient`)
- Modify: `src/recipes/crawl.js` (INSERT-sætningen for `recipe_ingredients`)
- Modify: `test/normalize.test.js` (nye cases)

**Interfaces:**
- Consumes: `amountOf()` fra opgave 4
- Produces: `parseIngredient(raw, position)` returnerer nu `{ raw, qty, unit, ingredient, item_key, amount, optional, position }`. Feltet `taxonomy_key` bevares som alias for `item_key`, indtil opgave 9 fjerner det.

- [ ] **Step 1: Skriv de fejlende tests**

Tilføj til `test/normalize.test.js`, i afsnittet der allerede tester `parseIngredient`:

```js
// ── Mængde i varens egen enhed ───────────────────────────────────────────────

test('parseIngredient regner mængden om til varens enhed', () => {
  const cases = [
    ['500 g hakket oksekød', 'hakket_oksekoed', 0.5],
    ['2 dl fløde',           'floede',          0.2],
    ['1 kg kartofler',       'kartofler',       1.0],
  ];
  for (const [raw, key, amount] of cases) {
    const p = parseIngredient(raw);
    assert.equal(p.item_key, key, raw);
    assert.ok(Math.abs(p.amount - amount) < 1e-6, `${raw}: ${p.amount} != ${amount}`);
  }
});

test('parseIngredient markerer det, der ikke driver et indkøb', () => {
  assert.equal(parseIngredient('frisk persille til servering').optional, 1);
  assert.equal(parseIngredient('evt. et skvæt fløde').optional, 1);
  assert.equal(parseIngredient('500 g hakket oksekød').optional, 0);
});
```

- [ ] **Step 2: Kør testene og se dem fejle**

Kør: `node --test test/normalize.test.js`
Forventet: FAIL — `p.item_key` er `undefined`.

- [ ] **Step 3: Ret `parseIngredient`**

Tilføj øverst i `src/recipes/extract.js`:

```js
const { amountOf } = require('../lib/units');

// "til servering", "evt.", "to serve" driver ikke et indkøb.
const OPTIONAL_RE = /(til servering|til pynt|til garniture|evt\.?\s|eventuelt|efter smag|to serve|to garnish|optional|for serving|if you like)/i;
```

Erstat retur-objektet (linje 261-271):

```js
  const hit = taxonomy.lookup(s) || taxonomy.lookup(original);
  const key = hit ? hit.entry.key : null;
  const item = key ? taxonomy.get(key) : null;

  return {
    raw: original,
    qty,
    unit,
    ingredient: s || original.toLowerCase(),
    item_key: key,
    // Alias, indtil de sidste forbrugere er flyttet.
    taxonomy_key: key,
    amount: item ? amountOf({ qty, unit }, item) : null,
    optional: OPTIONAL_RE.test(original) ? 1 : 0,
    position,
  };
```

- [ ] **Step 4: Kør testene og se dem passere**

Kør: `node --test test/normalize.test.js`
Forventet: PASS

- [ ] **Step 5: Lad crawleren skrive de nye kolonner**

`src/recipes/crawl.js:136-142`. `taxonomy_key` og `is_staple` bliver stående, så en delvist migreret base ikke får NULL i kolonner, andre dele endnu læser — opgave 9 fjerner dem:

```js
  const ins = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient,
                                    item_key, amount, optional,
                                    taxonomy_key, is_staple, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const ing of parsed.ingredients) {
    ins.run(recipeId, ing.raw, ing.qty, ing.unit, ing.ingredient,
            ing.item_key, ing.amount, ing.optional,
            ing.taxonomy_key, ing.is_staple, ing.position);
  }
```

`ing.is_staple` sættes stadig af `parseIngredient` fra opgave 2, trin 5.

- [ ] **Step 6: Kør hele suiten**

Kør: `npm test`
Forventet: PASS

- [ ] **Step 7: Commit**

```bash
git add src/recipes/extract.js src/recipes/crawl.js test/normalize.test.js
git commit -m "parseIngredient skriver item_key, amount og optional"
```

---

### Task 7: Dækningsrapport

Målestokken for opgave 8. Uden den er "tilføj ~150 synonymer" gætværk.

**Files:**
- Create: `scripts/coverage-report.js`
- Modify: `package.json` (nyt script)

**Interfaces:**
- Consumes: `items`, `recipe_ingredients.item_key`, `recipe_ingredients.amount`
- Produces: `npm run coverage` skriver antal prissætbare opskrifter og de hyppigste blokkere til stdout

- [ ] **Step 1: Skriv `scripts/coverage-report.js`**

```js
'use strict';

/**
 * Hvor mange opskrifter kan prissættes, og hvad står i vejen?
 *
 * "Prissætbar" = hver ikke-essentiel, ikke-valgfri ingrediens har en item_key.
 * Rapporten er arbejdslisten for synonym-arbejdet: den øverste blokker er
 * altid den næste, det bedst kan betale sig at tilføje.
 *
 *   npm run coverage
 */

const { getDb } = require('../src/db');

function main() {
  const db = getDb();

  const rows = db.prepare(`
    SELECT ri.recipe_id, ri.ingredient, ri.item_key, ri.amount,
           i.class AS item_class
      FROM recipe_ingredients ri
      LEFT JOIN items i ON i.key = ri.item_key
     WHERE COALESCE(ri.optional, 0) = 0
  `).all();

  const byRecipe = new Map();
  for (const r of rows) {
    if (!byRecipe.has(r.recipe_id)) byRecipe.set(r.recipe_id, []);
    byRecipe.get(r.recipe_id).push(r);
  }

  // En linje blokerer, hvis den hverken er essential eller kendt.
  const blocks = (r) => r.item_class !== 'essential' && !r.item_key;

  let priceable = 0, withAmount = 0;
  const blockers = new Map();

  for (const [, ings] of byRecipe) {
    const bad = ings.filter(blocks);
    if (!bad.length) {
      priceable++;
      if (ings.every((r) => r.item_class === 'essential' || r.amount != null)) withAmount++;
    }
    for (const r of bad) {
      const name = (r.ingredient || '').toLowerCase().trim();
      if (name) blockers.set(name, (blockers.get(name) || 0) + 1);
    }
  }

  console.log(`opskrifter:            ${byRecipe.size}`);
  console.log(`  prissætbare:         ${priceable}`);
  console.log(`  heraf med alle mængder: ${withAmount}`);
  console.log(`distinkte blokkere:    ${blockers.size}`);
  console.log('\nTop 40 blokkere — næste synonym-arbejde:');
  [...blockers]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .forEach(([name, n]) => console.log(String(n).padStart(5), name));
}

main();
```

- [ ] **Step 2: Tilføj scriptet til `package.json`**

```json
"coverage": "node scripts/coverage-report.js",
```

- [ ] **Step 3: Kør rapporten og notér udgangspunktet**

Kør: `npm run coverage`
Forventet: `prissætbare` ligger omkring **631** (spec afsnit 4.1). Ligger tallet langt fra det, er noget i opgave 2, 3 eller 5 gået galt — undersøg før du fortsætter.

- [ ] **Step 4: Commit**

```bash
git add scripts/coverage-report.js package.json
git commit -m "daekningsrapport: prissaetbare opskrifter og blokkere"
```

---

### Task 8: ~150 nye synonymer, i målte batches

**Files:**
- Modify: `src/lib/taxonomy.js` (`SEED`)

**Interfaces:**
- Consumes: `npm run coverage` fra opgave 7
- Produces: `npm run coverage` viser ≥1.100 prissætbare opskrifter

Dette er dataarbejde, ikke kodearbejde. Arbejd i batches af ~25 navne og mål efter hver batch. Bliver udbyttet under ~2 opskrifter pr. navn, så stop: spec afsnit 4.1 viser, at kurven knækker der, og resten af halen er ikke arbejdet værd.

Hver ny post skal have `key`, `name`, `cat`, `class`, `keeps`, `p`, `kcal`, `c`, `da` og `en` — samme form som posterne i opgave 2. Poster uden `class`/`keeps` fanges af testen fra opgave 2.

- [ ] **Step 1: Første batch — de 20 hyppigste blokkere**

Tilføj til `SEED` i `src/lib/taxonomy.js`:

```js
  { key: 'foraarsloeg', name: 'Forårsløg', cat: 'veg', class: 'fresh', keeps: 'perishable',
    p: 2, kcal: 32, c: 6,
    da: ['stængler forårsløg', 'forårsløg'], en: ['spring onions', 'spring onion', 'scallions'] },
  { key: 'pinjekerner', name: 'Pinjekerner', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 14, kcal: 670, c: 13, da: ['pinjekerner'], en: ['pine nuts'] },
  { key: 'mynte', name: 'Mynte', cat: 'veg', class: 'fresh', keeps: 'perishable',
    p: 3, kcal: 44, c: 8, da: ['frisk mynte', 'mynte'], en: ['fresh mint', 'mint'] },
  { key: 'nudler', name: 'Nudler', cat: 'grain', class: 'baseline', keeps: 'pantry',
    p: 12, kcal: 350, c: 71,
    da: ['risnudler', 'æggenudler', 'nudler'], en: ['rice noodles', 'egg noodles', 'noodles'] },
  { key: 'kapers', name: 'Kapers', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 2, kcal: 23, c: 5, da: ['kapers'], en: ['capers'] },
  { key: 'aeggeblomme', name: 'Æggeblommer', cat: 'eggs', class: 'fresh', keeps: 'perishable',
    p: 16, kcal: 320, c: 4, da: ['æggeblommer', 'æggeblomme'], en: ['egg yolks', 'egg yolk'] },
  { key: 'creme_fraiche', name: 'Crème fraîche', cat: 'dairy', class: 'fresh', keeps: 'perishable',
    p: 3, kcal: 200, c: 3,
    da: ['crème fraîche', 'creme fraiche', 'fraiche'], en: ['creme fraiche', 'soured cream'] },
  { key: 'ricotta', name: 'Ricotta', cat: 'cheese', class: 'fresh', keeps: 'perishable',
    p: 11, kcal: 174, c: 3, da: ['ricotta'], en: ['ricotta'] },
  { key: 'tahini', name: 'Tahin', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 17, kcal: 595, c: 21, da: ['tahin', 'tahini'], en: ['tahini'] },
  { key: 'halloumi', name: 'Halloumi', cat: 'cheese', class: 'fresh', keeps: 'keeps',
    p: 22, kcal: 320, c: 2, da: ['halloumi'], en: ['halloumi'] },
  { key: 'mango', name: 'Mango', cat: 'fruit', class: 'fresh', keeps: 'perishable',
    p: 1, kcal: 60, c: 15, da: ['mango'], en: ['mango', 'mangoes'] },
  { key: 'fennikelfroe', name: 'Fennikelfrø', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 16, kcal: 345, c: 52, da: ['fennikelfrø'], en: ['fennel seeds'] },
  { key: 'jalapeno', name: 'Jalapeños', cat: 'veg', class: 'fresh', keeps: 'keeps',
    p: 1, kcal: 29, c: 6, da: ['jalapenos', 'jalapeño', 'jalapeños'], en: ['jalapenos', 'jalapeño'] },
  { key: 'pesto', name: 'Pesto', cat: 'pantry', class: 'baseline', keeps: 'keeps',
    p: 5, kcal: 450, c: 6, da: ['pesto'], en: ['pesto'] },
  { key: 'roedbede', name: 'Rødbeder', cat: 'veg', class: 'fresh', keeps: 'keeps',
    p: 2, kcal: 43, c: 10, da: ['rødbeder', 'rødbede'], en: ['beetroot', 'beets'] },
  { key: 'cornichoner', name: 'Cornichoner', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 1, kcal: 15, c: 3, da: ['cornichoner', 'asier', 'syltede agurker'], en: ['cornichons', 'gherkins'] },
  { key: 'stjerneanis', name: 'Stjerneanis', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 18, kcal: 337, c: 50, da: ['stjerneanis'], en: ['star anise'] },
  { key: 'mirin', name: 'Mirin', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 250, c: 43, da: ['mirin'], en: ['mirin'] },
  { key: 'burrata', name: 'Burrata', cat: 'cheese', class: 'fresh', keeps: 'perishable',
    p: 17, kcal: 330, c: 2, da: ['burrata'], en: ['burrata'] },
  { key: 'kaernemaelk', name: 'Kærnemælk', cat: 'dairy', class: 'fresh', keeps: 'perishable',
    p: 3, kcal: 37, c: 4, base_unit: 'l', da: ['kærnemælk'], en: ['buttermilk'] },
```

- [ ] **Step 2: Seed og mål**

```bash
npm run seed:items && npm run backfill:amounts && npm run coverage
```
Forventet: `prissætbare` går fra ~631 til ~**780**.

- [ ] **Step 3: Kør testene**

Kør: `npm test`
Forventet: PASS. Testen "alle varer har gyldig class og keeps" fra opgave 2 fanger en post, der mangler felterne.

- [ ] **Step 4: Commit batchen**

```bash
git add src/lib/taxonomy.js
git commit -m "Synonymer batch 1: 20 varer, daekning 631 -> 780"
```

- [ ] **Step 5: Gentag for batch 2-6**

Kør `npm run coverage`, tag de øverste ~25 blokkere fra listen, opret dem som poster efter samme form, og gentag trin 2-4. Slå både det danske og det engelske navn op — halvdelen af opskrifterne er britiske, og `bay leaves` og `laurbærblade` er samme vare.

Gate for at gå videre til opgave 9: `npm run coverage` viser **≥1.100 prissætbare opskrifter**. Stop tidligere, hvis en batch giver under 2 opskrifter pr. tilføjet navn.

---

### Task 9: Flyt de sidste forbrugere, og fjern `is_staple`

**Files:**
- Modify: `src/recipes/classify.js` (`scoreTiers` bruger `is_staple`, linje 95)
- Modify: `src/mealplan/generate.js` (`gramsOf`-kald, `staple`-felt i `items`-payload)
- Modify: `src/sync/build.js` (`recipe_index.items`-payload)
- Modify: `public/engine.js` (`staple` → `essential`)
- Modify: `test/mealplan.test.js` (`item()`-hjælperen)
- Modify: `src/db/index.js` (drop-migrering)

**Interfaces:**
- Consumes: alt fra opgave 1-8
- Produces: `is_staple` og `taxonomy_key` findes ikke længere i `recipe_ingredients`; `recipe_index.items` har `{ key, cat, essential, amount, ingredient }` i stedet for `{ key, cat, staple, grams, ingredient }`

- [ ] **Step 1: Find alle forbrugere**

```bash
grep -rn "is_staple\|staple\|taxonomy_key\|gramsOf\|\.grams" src/ public/ test/ scripts/ --include=*.js
```

Arbejd listen igennem ovenfra. Der er ét mønster: `staple` → `essential` læst fra `items.class`, og `grams` → `amount` læst fra kolonnen.

- [ ] **Step 2: Ret `recipe_index`-payloaden i `src/sync/build.js`**

Feltnavnene her er kontrakten mod browseren, så de skal ændres i samme commit som `engine.js`:

```js
  items: ings.map((i) => ({
    key: i.item_key,
    cat: i.category,
    essential: i.item_class === 'essential',
    amount: i.amount,
    ingredient: i.ingredient,
  })),
```

- [ ] **Step 3: Ret `public/engine.js`**

Erstat hver læsning af `it.staple` med `it.essential` og hver `it.grams` med `it.amount`. Bemærk at `amount` nu er i kg/l/stk, ikke gram — enhver tærskel udtrykt i gram (fx `g > 5000`) skal divideres med 1000.

- [ ] **Step 4: Ret `test/mealplan.test.js`**

```js
const item = (key, cat, amount, extra = {}) => ({ key, cat, amount, ingredient: key, ...extra });
```

og i `FAJITA` m.fl.: `600` → `0.6`, `{ staple: true }` → `{ essential: true }`.

- [ ] **Step 5: Kør hele suiten**

Kør: `npm test`
Forventet: PASS. Fejler `mealplan.test.js`, er en tærskel ikke omregnet fra gram til kg.

- [ ] **Step 6: Drop de gamle kolonner**

Tilføj til `migrate()` i `src/db/index.js`, efter `added`-løkken:

```js
  // Informationen bor nu i items.class og i amount. Droppes til sidst, så en
  // delvist opdateret arbejdskopi ikke mister data undervejs.
  for (const col of ['is_staple', 'taxonomy_key']) {
    const cols = db.prepare('PRAGMA table_info(recipe_ingredients)').all().map((c) => c.name);
    if (cols.includes(col)) db.exec(`ALTER TABLE recipe_ingredients DROP COLUMN ${col}`);
  }
```

Fjern også `taxonomy_key`-aliaset fra `parseIngredient` (opgave 6, trin 3) og de to kolonner fra INSERT-sætningen i `src/recipes/crawl.js`.

- [ ] **Step 7: Kør alt igen mod en frisk kopi**

```bash
cp data.db.pre-items data.db.migrationstest
DB_PATH=data.db.migrationstest npm run seed:items
DB_PATH=data.db.migrationstest npm run backfill:amounts
DB_PATH=data.db.migrationstest npm run coverage
npm test
```
Forventet: hele kæden kører fra en base fra før opgave 1 og ender på ≥1.100 prissætbare.

- [ ] **Step 8: Commit**

```bash
git add src/ public/ test/
git commit -m "Sidste forbrugere flyttet til items.class og amount; is_staple fjernet"
```

---

### Task 10: Undersøgelse — kan vi hente priser fra Rema og Salling?

Tidsafgrænset til én dag. Svaret afgør indholdet af plan 2 (spec afsnit 3.2). Der skrives ikke produktionskode i denne opgave.

**Files:**
- Create: `scripts/spike-chain-apis.js`
- Create: `docs/superpowers/specs/2026-09-06-api-undersoegelse.md`

**Interfaces:**
- Consumes: intet
- Produces: et dokument, der for hver kæde svarer ja/nej på: kan vi hente pris og pakkestørrelse for en kendt vare uden login, og hvor stabilt ser endpointet ud

- [ ] **Step 1: Skriv undersøgelsesscriptet**

Scriptet er et færdigt værktøj, ikke en skabelon: det tager en URL, kalder den, og udskriver svarets *form* — nøglestier med eksempelværdier — så man kan se, om pris og pakkestørrelse overhovedet er der, uden at læse 400 KB JSON.

```js
'use strict';

/**
 * Undersøgelse: kan vi hente normalpriser fra kædernes egne API'er?
 *
 * Skriver ingenting i basen. Formålet er ét svar pr. kæde, så plan 2 kan
 * skrives på fakta i stedet for på et håb.
 *
 *   node scripts/spike-chain-apis.js "<url>"
 */

/** Fladgør et svar til nøglestier, så formen kan ses på én skærm. */
function shape(value, prefix = '', out = new Map(), depth = 0) {
  if (depth > 6) return out;
  if (Array.isArray(value)) {
    // Et array beskrives af sit første element – resten har samme form.
    if (value.length) shape(value[0], `${prefix}[]`, out, depth + 1);
    else out.set(`${prefix}[]`, '(tom)');
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      shape(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  } else if (!out.has(prefix)) {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

// Det undersøgelsen leder efter. Er der hverken pris eller mængde, er
// API'et ikke brugbart til normalpriser, uanset hvor pænt det ellers er.
const WANTED = /pris|price|amount|value|unit|size|weight|vaegt|volume|quantity|pack/i;

async function probe(url) {
  console.log(`\n=== ${url} ===`);
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'accept-language': 'da-DK,da;q=0.9',
      'user-agent': 'Mozilla/5.0',
    },
  });
  console.log(`HTTP ${res.status} ${res.headers.get('content-type') || ''}`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 300));
    return;
  }

  const paths = shape(await res.json());
  console.log(`${paths.size} nøglestier. Kandidater til pris og pakkestørrelse:`);
  for (const [k, v] of paths) if (WANTED.test(k)) console.log(`  ${k} = ${v}`);
}

const url = process.argv[2];
if (!url) {
  console.error('brug: node scripts/spike-chain-apis.js "<url>"');
  process.exit(1);
}
probe(url).catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Undersøg Rema 1000**

Åbn `shop.rema1000.dk` med netværksfanen i browserens udviklerværktøjer, søg på "kartofler", og find det kald, der returnerer søgeresultaterne. Kopiér URL'en og kør:

```bash
node scripts/spike-chain-apis.js "<url fra netværksfanen>"
```

Notér: svarer den uden login? Er der både en pris og en pakkestørrelse blandt kandidaterne? Hvilket felt holder mængden, og i hvilken enhed? Gentag med "hakket oksekød", som har en pakkestørrelse, der ikke er et rundt tal.

- [ ] **Step 3: Undersøg Salling Group**

Salling har et officielt udviklerprogram på `developer.sallinggroup.com`. Undersøg først, om det dækker priser på almindeligt sortiment eller kun madspild og butiksdata — et officielt API er langt at foretrække frem for et uofficielt, selv med lavere dækning.

- [ ] **Step 4: Undersøg Coop**

Samme fremgangsmåde som Rema, mod `coop.dk`.

- [ ] **Step 5: Skriv konklusionen**

Opret `docs/superpowers/specs/2026-09-06-api-undersoegelse.md` med en tabel:

| kæde | endpoint | login? | pris? | pakkestørrelse? | vurdering |
|---|---|---|---|---|---|

og et afsnit på 3-5 linjer med anbefalingen: hvilke kæder kan hentes automatisk, hvilke skal i CSV, og hvor mange rækker det efterlader som manuelt arbejde.

- [ ] **Step 6: Commit**

```bash
git add scripts/spike-chain-apis.js docs/superpowers/specs/2026-09-06-api-undersoegelse.md
git commit -m "Undersoegelse: prisAPI'er hos Rema, Salling og Coop"
```

---

## Efter planen

Når opgave 10 er færdig, skrives **plan 2** (spec skridt 6-8):

- `item_prices`-tabellen, CSV-importøren og den afledte bootstrap fra tilbudshistorikken
- `recipe_costs`-jobbet
- `engine.js`: pakkeafrunding, spildvægtning efter `keeps`, de to forslag, brute-force over kædedelmængder
- Supabase-skemaet og `src/sync/build.js`

Plan 2 kan ikke skrives før, fordi opgave 10 afgør, om `item_prices` fyldes af et script eller af en CSV — og dermed hvor stor importøren skal være.
