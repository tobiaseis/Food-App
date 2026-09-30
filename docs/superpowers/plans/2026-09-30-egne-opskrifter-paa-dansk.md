# Egne opskrifter på dansk — implementeringsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Appen viser sine egne danske opskrifter — ingredienser og fremgangsmåde i appen, ingen links ud — med arbejdstid og tid i alt hver for sig, lam koblet til lam, og en lille rest af en frisk vare lagt i en af retterne i stedet for at gå til spilde.

**Architecture:** Kildesiderne hentes igen og gemmes lokalt som råmateriale (`tmp/kilder/`, gitignoret). Claude Code i headless-tilstand (`claude -p`) skriver én dansk udgave pr. opskrift — på brugerens Claude-abonnement, uden API og uden ekstra udgift; udgaverne ligger som JSON i git (`data/opskrifter/`), kan rettes i hånden og læses ind i `data.db` af en idempotent importer, som også kører i den natlige kørsel. Appen henter én opskrift ad gangen fra en ny Supabase-tabel `recipe_details`. Rest-påfyldningen bor i `engine.choosePack`, så ugens valg, indkøbslisten og spildtallet regner med samme regel.

**Tech Stack:** Node ≥ 20 (CommonJS), better-sqlite3, Claude Code-CLI'en (`claude -p --json-schema`, følger med VS Code-udvidelsen), Supabase/PostgREST, vanilla JS i `public/`.

---

## Udgangspunktet, målt 2026-09-30

| | |
|---|---|
| Opskrifter | 2.224: Valdemarsro 678 (da), Arla 325 (da), BBC Good Food 821 (en), Great British Chefs 400 (en) |
| Ingredienslinjer | 31.438 — 1.051 uden vare (`item_key`), 3.696 uden mængde |
| Fremgangsmåde i basen | **Ingen.** `src/recipes/extract.js` henter den bevidst ikke: "Brugeren sendes til kilden for selve opskriften." |
| Lam koblet forkert | 2 linjer: `600 g lammeculotte` → `boef` (Bøf/steak), `500 g lammemørbrad` → `svinemoerbrad`. Årsag: `culotte` og `mørbrad` er synonymer på andre varer, og de sammensatte lammeord mangler på `lam`. |
| Valdemarsros tider | **Byttet om i deres markup.** "Tid i alt" står i `itemprop="cookTime"`, "Arbejdstid" i `itemprop="totalTime"`. Vi læser `totalTime`, så alle 678 retter har arbejdstiden som tid i alt. Målt på lammeculotte + tre tilfældige sider (45/30, 50/30, 60/25). |
| Arla | `prepTime` = arbejdstid, `totalTime` = tid i alt (kyllingelasagne: PT30M / PT1H15M) |
| BBC / GBC | `prepTime`, `cookTime`, `totalTime` efter bogen |
| Kildens fremgangsmåde | JSON-LD `recipeInstructions` (BBC: `HowToStep[]`; Arla: `HowToSection` med `type` uden `@`); Valdemarsro: ét `itemprop="recipeInstructions"` pr. trin |
| Tidsgrænsen | `engine.DINNER_MAX_MINUTES = 60` gælder **tid i alt** (brugerens valg 2026-09-28). Med de rigtige Valdemarsro-tider falder flere retter ud af puljen — det skal måles (opgave 14). |

> **Lammeculotten:** Brugeren så "15 min" i appen og "1 t 30 min / 15 min arbejdstid" hos Valdemarsro. Siden siger i dag "Tid i alt 45 min, Arbejdstid 30 min", og basen har 30. Planen retter princippet — to tider, læst fra de synlige etiketter — og bruger det, siden siger på hentetidspunktet.

## Beslutninger (brugerens, 2026-09-30)

1. **Ingen API, ingen udgift.** Omskrivningen kører gennem Claude Code-CLI'en på brugerens abonnement (`claude -p`). Prøvet 2026-09-30: CLI'en fra VS Code-udvidelsen (2.1.285) svarer med et skemavalideret objekt i `structured_output` på få sekunder. Abonnementets forbrugsgrænse gælder: rammes den, stopper kørslen pænt og fortsætter, hvor den slap, næste gang den startes. Regn med flere dage for alle 2.224, afhængigt af abonnementet. Standardmodellen er `sonnet` (bruger mindst af grænsen); `--model opus` kan vælges.
2. **Så lidt om som muligt.** Samme ret, samme råvarer, samme teknik. Mængderne rundes til danske pakninger og runde tal (højst ±20 % pr. vare), så de ikke er kildens egne tal. Fremgangsmåden skrives på dansk med modellens egne ord i korte trin — ikke ordret. Mængder er fakta og ikke det, ophavsretten beskytter; teksten er. Det er de egne ord i fremgangsmåden, der gør det forsvarligt at udelade kreditering, og kildens tekst forlader aldrig maskinen (`tmp/kilder/`).
3. **Ingen kreditering af opskriften.** Intet "efter en opskrift fra …", og kildens navn står ikke længere som rettens oprindelse.
4. **Billederne krediteres.** Opskriftsfotoet hentes stadig fra kildens server og står med "Foto: <kilde>" — i opskriftsarket og på rettens kort. Tilbudsbillederne står allerede ved kædens navn.
5. **Påfyldningsloftet** (godkendt): højst 25 % mere end retten selv bruger, kun friske varer (`keeps: 'perishable'`), kun varer der vejes eller måles (kg/l). Æg, citroner og kartofler røres ikke.

## Filstruktur

| Fil | Ansvar |
|---|---|
| `src/lib/taxonomy.js` (ændres) | lammeord og kalveord på de rigtige varer |
| `src/recipes/times.js` (ny) | arbejdstid og tid i alt — rene funktioner |
| `src/recipes/instructions.js` (ny) | kildens trin fra JSON-LD eller microdata — rene funktioner |
| `src/recipes/edition.js` (ny) | den danske udgaves form: enheder, JSON-skema, stier, ingredienslinjen |
| `src/recipes/fetch-sources.js` (ny) | henter kildesiderne igen → `tmp/kilder/` |
| `src/recipes/rewrite.js` (ny) | Claude Code headless på abonnementet: `run`, `one` → `data/opskrifter/` |
| `src/recipes/import-da.js` (ny) | kontrol og indlæsning af `data/opskrifter/` i `data.db` |
| `src/recipes/extract.js`, `crawl.js` (ændres) | tiderne, `(valgfri)`, værn mod at overskrive en dansk udgave |
| `src/db/index.js`, `schema.sql` (ændres) | nye kolonner og `recipe_steps` |
| `src/mealplan/generate.js` (ændres) | `active_minutes` i indlæsningen; kun danske udgaver, når indstillingen er sat |
| `src/sync/build.js`, `supabase/schema.sql`, `src/server.js` (ændres) | `recipe_details`; `active_minutes` på `recipe_index` |
| `public/data.js`, `public/app.js`, `public/styles.css`, `public/sw.js` (ændres) | opskriftsarket, tiderne, resten |
| `public/engine.js` (ændres) | `absorbable`, `choosePack.absorbed`, `shoppingList.topups` |
| `test/recipes.test.js` (ny) | tests for alt under `src/recipes/` |
| `data/opskrifter/**.json` (nye, i git) | de danske udgaver — opskriftsdatabasen |

## Global Constraints

- Node ≥ 20, CommonJS, `'use strict';`. Kommentarer på dansk, der forklarer **hvorfor**.
- **Ingen nye npm-afhængigheder.** Omskrivningen kalder Claude Code-CLI'en som underproces; der bruges hverken API-nøgle eller SDK.
- `public/engine.js` rører aldrig databasen og skal kunne indlæses i både Node og browser.
- Nye felter i browserens payload skal huskes **fire** steder: `loadRecipes`, `src/sync/build.js`, `supabase/schema.sql` (`create table` OG `alter table ... add column if not exists`) og `public/data.js` (begge mappinger). Læg en test på kanten.
- Tests kører mod `test.db`, aldrig `data.db`. Tag en kopi før enhver kørsel mod `data.db`: `cp data.db data.db.pre-dansk`.
- **Kildens tekst forlader aldrig maskinen:** `tmp/kilder/` er gitignoret; intet fra den skrives til `data.db`, git eller Supabase.
- Omskrivningen kører kun lokalt, på brugerens maskine og abonnement — aldrig i CI.
- Commit efter hver opgave.

---

## Fase 1 — lam er lam

### Task 1: Sammensatte kødord kobles til det rigtige dyr

**Files:**
- Modify: `src/lib/taxonomy.js` (posterne `lam` og `kalvekoed`, ca. linje 102–110)
- Create: `test/recipes.test.js`
- Modify: `package.json` (test-scriptet)

`items.lookup` foretrækker et helt ord (`exact = 2`) frem for et ord, der kun er forankret i den ene side (`exact = 1`). "lammeculotte" rammer i dag kun `culotte` (højre-forankret, `boef`), fordi `lam` ikke kender det sammensatte ord. Tilføjes det fulde ord, vinder det.

- [ ] **Step 1: Skriv den fejlende test**

Opret `test/recipes.test.js`:

```js
'use strict';

/**
 * Tests for src/recipes/: kobling, tider, fremgangsmåde, den danske udgave og
 * indlæsningen af den.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIngredient } = require('../src/recipes/extract');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('dyret i et sammensat kødord bestemmer varen', () => {
  // "lammeculotte" blev til Bøf/steak, og appen foreslog at købe bøf på
  // tilbud til en lammeret. Det generiske stykke (culotte, mørbrad) må kun
  // vinde, når der ikke står et dyr foran.
  const cases = [
    ['600 g lammeculotte', 'lam'],
    ['500 g lammemørbrad', 'lam'],
    ['400 g lammeinderlår', 'lam'],
    ['1 kg lammeskulder', 'lam'],
    ['500 g hakket lammekød', 'lam'],
    ['600 g kalveculotte', 'kalvekoed'],
    ['500 g kalvemørbrad', 'kalvekoed'],
    ['500 g oksemørbrad', 'oksemoerbrad'],
    ['500 g svinemørbrad', 'svinemoerbrad'],
    ['600 g culotte', 'boef'],
  ];
  for (const [raw, key] of cases) assert.equal(parseIngredient(raw).item_key, key, raw);
});
```

De følgende opgaver tilføjer deres tests sidst i samme fil.

Tilføj filen til test-scriptet i `package.json` — sidst i listen:

```json
"test": "node -r ./test/helpers/set-test-db.js --test test/normalize.test.js test/sync.test.js test/mealplan.test.js test/push.test.js test/items.test.js test/units.test.js test/classify.test.js test/prices.test.js test/waste.test.js test/recipes.test.js",
```

- [ ] **Step 2: Kør testen og se den fejle**

Run: `npm test 2>&1 | grep -A3 "dyret i et sammensat"`
Expected: FAIL — `600 g lammeculotte`: `'boef' !== 'lam'`

- [ ] **Step 3: Tilføj ordene**

I `src/lib/taxonomy.js`, erstat `lam`- og `kalvekoed`-posterne:

```js
  { key: 'lam', name: 'Lammekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 230, c: 0,
    // De sammensatte ord SKAL stå her. Uden dem vinder det generiske stykke
    // bagerst i ordet: "lammeculotte" blev til bøf (culotte) og
    // "lammemørbrad" til svinemørbrad (mørbrad) — et helt ord slår et, der
    // kun er forankret i den ene ende (se lookup i src/lib/items.js).
    da: ['lammekølle', 'lammekød', 'lammekoteletter', 'lammefilet',
         'lammekrone', 'lammebov', 'lammehals', 'lammeskank',
         'lammeculotte', 'lammeculotter', 'lammemørbrad', 'lammeinderlår',
         'lammeryg', 'lammekam', 'lammecarré', 'lammeskulder', 'lammesteg',
         'lammetyndsteg', 'lammeribben', 'lammespyd', 'lammefars', 'hakket lammekød'],
    en: ['lamb', 'rack of lamb', 'leg of lamb'], premium: true },
  { key: 'kalvekoed', name: 'Kalvekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 150, c: 0,
    // Samme grund som lam: "kalvemørbrad" må ikke blive svinemørbrad.
    da: ['kalveculotte', 'kalvekød', 'kalvefilet', 'kalvetykkam', 'kalveschnitzel',
         'kalvemørbrad', 'kalveinderlår', 'kalvebryst', 'kalvekoteletter', 'hakket kalvekød'],
    en: ['veal'], premium: true },
```

(Behold de øvrige felter i posterne uændret, hvis de adskiller sig fra ovenstående — kun `da`-listerne er nye.)

- [ ] **Step 4: Kør testen og se den bestå**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0` (pretest sår `test.db` forfra fra SEED, så de nye synonymer er med)

- [ ] **Step 5: Ret koblingerne i data.db og kontrollér**

```bash
cp data.db data.db.pre-lam
npm run seed:items && npm run reclassify && npm run costs:recompute
node -e "const db=require('better-sqlite3')('data.db',{readonly:true});console.log(db.prepare(\"select item_key, count(*) n from recipe_ingredients where ingredient like '%lamme%' group by 1\").all())"
```
Expected: kun `{ item_key: 'lam', ... }`. Den natlige kørsel gør det samme på release-basen (`seed:items` + `reclassify` + `costs:recompute` står allerede i `update.yml`), så rettelsen er i produktion efter næste nat.

- [ ] **Step 6: Commit**

```bash
git add src/lib/taxonomy.js test/recipes.test.js package.json
git commit -m "Lammeculotte er lam, ikke bøf: sammensatte kødord på det rigtige dyr"
```

---

## Fase 2 — råmaterialet og de to tider

### Task 2: Arbejdstid og tid i alt

**Files:**
- Create: `src/recipes/times.js`
- Modify: `src/recipes/extract.js:338-365` (tiderne i `extractRecipe`)
- Test: `test/recipes.test.js`

- [ ] **Step 1: Skriv de fejlende tests**

Tilføj sidst i `test/recipes.test.js`:

```js
const { danishMinutes, labelledTimes, pickTimes } = require('../src/recipes/times');

test('timer og minutter på dansk', () => {
  assert.equal(danishMinutes('1 t. 30 min.'), 90);
  assert.equal(danishMinutes('1 time og 30 min'), 90);
  assert.equal(danishMinutes('2 timer'), 120);
  assert.equal(danishMinutes('45 min.'), 45);
  assert.equal(danishMinutes('ingen tid'), null);
  assert.deepEqual(labelledTimes('Tid i alt 1 t. 30 min. Arbejdstid 15 min. Antal 4 pers.'),
    { total: 90, active: 15 });
});

test('Valdemarsros etiketter vinder over deres byttede schema.org-felter', () => {
  // Siden: "Tid i alt 45 min. Arbejdstid 30 min." — men markup'en siger
  // cookTime = PT45M og totalTime = PT30M. Læste vi totalTime, blev
  // arbejdstiden til tiden i alt.
  const labelled = labelledTimes('Tid i alt 45 min. Arbejdstid 30 min. Antal 4 pers.');
  assert.deepEqual(labelled, { total: 45, active: 30 });
  assert.deepEqual(pickTimes({ labelled, prep: null, cook: 45, total: 30 }),
    { total_minutes: 45, active_minutes: 30 });
});

test('uden etiketter: tid i alt fra schema.org, arbejdstid fra forberedelsen', () => {
  const none = { total: null, active: null };
  // Arla: prepTime PT30M, cookTime PT00M, totalTime PT1H15M.
  assert.deepEqual(pickTimes({ labelled: none, prep: 30, cook: 0, total: 75 }),
    { total_minutes: 75, active_minutes: 30 });
  // Uden totalTime: forberedelse + tilberedning.
  assert.deepEqual(pickTimes({ labelled: none, prep: 15, cook: 50, total: null }),
    { total_minutes: 65, active_minutes: 15 });
  // En arbejdstid over tiden i alt er to felter i byttet rækkefølge.
  assert.deepEqual(pickTimes({ labelled: { total: 20, active: 60 } }),
    { total_minutes: 60, active_minutes: 20 });
  assert.deepEqual(pickTimes({ labelled: none }), { total_minutes: null, active_minutes: null });
});
```

- [ ] **Step 2: Kør og se dem fejle**

Run: `npm test 2>&1 | grep -E "✖|Cannot find module" | head`
Expected: `Cannot find module '../src/recipes/times'`

- [ ] **Step 3: Skriv `src/recipes/times.js`**

```js
'use strict';

/**
 * Arbejdstid og tid i alt.
 *
 * To tal, fordi de betyder to ting: en lammeculotte kan tage et kvarters
 * arbejde og halvanden time i alt. Appen viser begge, og "højst en time"
 * (engine.DINNER_MAX_MINUTES) gælder tiden i alt.
 *
 * Valdemarsro mærker felterne omvendt: "Tid i alt" står i itemprop="cookTime"
 * og "Arbejdstid" i itemprop="totalTime" (målt på fire sider 2026-09-30).
 * De synlige etiketter læses derfor først — de er det, forfatteren selv har
 * skrevet — og schema.org-felterne bruges kun, hvor siden ikke har dem.
 */

// Timer før minutter i alternationen: "time" må ikke blive læst som "t".
const DURATION = '((?:\\d+(?:[.,]\\d+)?\\s*(?:timer|time|t\\b\\.?|minutter|min\\.?)\\s*(?:og\\s*)?){1,2})';
const LABEL_TOTAL = new RegExp(`tid i alt\\s*:?\\s*${DURATION}`, 'i');
const LABEL_ACTIVE = new RegExp(`arbejdstid\\s*:?\\s*${DURATION}`, 'i');

/** "1 t. 30 min." / "1 time og 30 min" / "2 timer" / "45 min." → minutter. */
function danishMinutes(text) {
  const s = String(text || '').toLowerCase();
  const h = s.match(/(\d+(?:[.,]\d+)?)\s*(?:timer|time|t\b|t\.)/);
  const m = s.match(/(\d+)\s*(?:minutter|min)/);
  if (!h && !m) return null;
  const hours = h ? parseFloat(h[1].replace(',', '.')) : 0;
  return Math.round(hours * 60) + (m ? parseInt(m[1], 10) : 0);
}

/** Tiderne, som siden selv skriver dem ("Tid i alt …", "Arbejdstid …"). */
function labelledTimes(text) {
  const t = String(text || '');
  const total = t.match(LABEL_TOTAL);
  const active = t.match(LABEL_ACTIVE);
  return {
    total: total ? danishMinutes(total[1]) : null,
    active: active ? danishMinutes(active[1]) : null,
  };
}

/**
 * Vælger de to tider. Etiketterne vinder; ellers er tid i alt `totalTime`
 * (eller forberedelse + tilberedning), og arbejdstiden er forberedelsen —
 * Arlas `prepTime` ER deres arbejdstid, og BBC's er den nærmeste, de har.
 */
function pickTimes({ labelled = {}, prep = null, cook = null, total = null } = {}) {
  let all = labelled.total ?? total ?? ((prep || 0) + (cook || 0) || null);
  let active = labelled.active ?? prep ?? null;
  if (all != null && active != null && active > all) [all, active] = [active, all];
  return { total_minutes: all || null, active_minutes: active || null };
}

module.exports = { danishMinutes, labelledTimes, pickTimes };
```

- [ ] **Step 4: Brug dem i `extractRecipe`**

I `src/recipes/extract.js`: tilføj øverst `const { labelledTimes, pickTimes } = require('./times');`. Erstat

```js
  const totalTime = parseDuration(raw.totalTime)
    || ((parseDuration(raw.prepTime) || 0) + (parseDuration(raw.cookTime) || 0)) || null;
```

med

```js
  // Se src/recipes/times.js: Valdemarsros schema.org-felter er byttet om,
  // så sidens egne etiketter læses først.
  const times = pickTimes({
    labelled: labelledTimes(stripTags(html)),
    prep: parseDuration(raw.prepTime),
    cook: parseDuration(raw.cookTime),
    total: parseDuration(raw.totalTime),
  });
```

og i det returnerede objekt erstat `total_minutes: totalTime,` med

```js
    total_minutes: times.total_minutes,
    active_minutes: times.active_minutes,
```

Opdatér også filens hovedkommentar: sætningen "Vi gemmer FAKTA … og henter ikke fremgangsmåden. Brugeren sendes til kilden for selve opskriften." erstattes af "Vi udtrækker fakta – titel, ingredienser, tider, næring. Fremgangsmåden hentes af instructions.js og bruges kun som råmateriale til appens egen danske udgave (se src/recipes/rewrite.js)."

- [ ] **Step 5: Kør tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 6: Commit**

```bash
git add src/recipes/times.js src/recipes/extract.js test/recipes.test.js
git commit -m "Arbejdstid og tid i alt hver for sig — Valdemarsros felter er byttet om"
```

### Task 3: Basen får plads til den danske udgave

**Files:**
- Modify: `src/db/index.js:31-57` (`migrate`, listen `added`)
- Modify: `src/db/schema.sql` (ny tabel `recipe_steps` efter `recipe_ingredients`)
- Modify: `src/recipes/crawl.js:95-150` (`storeRecipe`)
- Modify: `src/mealplan/generate.js:302-313` (`loadRecipes`)
- Test: `test/recipes.test.js`

- [ ] **Step 1: Skriv den fejlende test**

```js
const { getDb, setSetting } = require('../src/db');

test('basen har kolonnerne og tabellen til den danske udgave', () => {
  const db = getDb();
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['active_minutes', 'intro', 'edition', 'edition_hash', 'edited_at', 'changes']) {
    assert.ok(cols('recipes').includes(c), `recipes.${c}`);
  }
  for (const c of ['section', 'label']) assert.ok(cols('recipe_ingredients').includes(c), `recipe_ingredients.${c}`);
  assert.deepEqual(cols('recipe_steps'), ['recipe_id', 'position', 'section', 'text']);
});

test('uden dansk udgave er retten ude af madplanen, når indstillingen er sat', () => {
  const db = getDb();
  const plans = require('../src/mealplan/generate');
  const now = new Date().toISOString();
  // loadRecipes tager kun retter med mindst tre kendte varer — derfor tre linjer.
  const line = db.prepare(`INSERT INTO recipe_ingredients (recipe_id, raw, ingredient, position, item_key, amount, optional)
                           VALUES (?, ?, ?, ?, ?, ?, 0)`);
  const add = (url, edition) => {
    const id = Number(db.prepare(`
      INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at, edition)
      VALUES (?, 'test', 'Test', ?, 'da', 4, ?, ?)`).run(url, url, now, edition).lastInsertRowid);
    [['kyllingebryst', 0.5], ['kartofler', 0.6], ['loeg', 0.1]]
      .forEach(([key, amount], i) => line.run(id, `${amount} ${key}`, key, i, key, amount));
    return id;
  };
  const a = add('https://test.invalid/edition-ja', 1);
  const b = add('https://test.invalid/edition-nej', null);
  try {
    const ids = () => new Set(plans.loadRecipes({}).map((r) => r.id));
    assert.ok(ids().has(b), 'uden indstillingen er alle med');
    setSetting('recipes_edition_only', true);
    assert.ok(ids().has(a) && !ids().has(b), 'med indstillingen kun de danske');
  } finally {
    setSetting('recipes_edition_only', false);
    db.prepare('DELETE FROM recipes WHERE id IN (?, ?)').run(a, b);
  }
});
```

- [ ] **Step 2: Kør og se den fejle**

Run: `npm test 2>&1 | grep -A2 "basen har kolonnerne"`
Expected: FAIL — `recipes.active_minutes`

- [ ] **Step 3: Kolonnerne i `migrate()`**

Tilføj sidst i listen `added` i `src/db/index.js`:

```js
    // Den danske udgave (plan 2026-09-30). active_minutes er arbejdstiden —
    // total_minutes er tiden i alt. edition er udgavens nummer (NULL = kun
    // kildens rå data), edition_hash er hashen af filen i data/opskrifter/,
    // så import-da.js kan se, om den er rettet siden sidst.
    ['recipes', 'active_minutes', 'INTEGER'],
    ['recipes', 'intro', 'TEXT'],
    ['recipes', 'edition', 'INTEGER'],
    ['recipes', 'edition_hash', 'TEXT'],
    ['recipes', 'edited_at', 'TEXT'],
    ['recipes', 'changes', 'TEXT'],
    // Visningen: afsnittet ("Til dressingen") og varen med tilberedning
    // ("kyllingebryst, i strimler") uden mængde, så mængden kan ganges op.
    ['recipe_ingredients', 'section', 'TEXT'],
    ['recipe_ingredients', 'label', 'TEXT'],
```

- [ ] **Step 4: Tabellen i `schema.sql`**

Efter `CREATE INDEX IF NOT EXISTS idx_ri_recipe ...`:

```sql
-- Fremgangsmåden i appens danske udgave (data/opskrifter/, import-da.js).
-- Aldrig kildens tekst: den ligger kun i tmp/kilder/ og forlader ikke maskinen.
CREATE TABLE IF NOT EXISTS recipe_steps (
  recipe_id  INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  section    TEXT,
  text       TEXT NOT NULL,
  PRIMARY KEY (recipe_id, position)
);
```

- [ ] **Step 5: `loadRecipes` — kolonnerne og indstillingen**

I `src/mealplan/generate.js` (`getSetting` er allerede importeret) erstat SQL'en i `loadRecipes`:

```js
  // Når de danske udgaver er læst ind (opgave 14), skal en ret uden udgave
  // ikke med i madplanen: den har ingen fremgangsmåde at vise, og appen linker
  // ikke længere til kilden.
  const editionOnly = getSetting('recipes_edition_only', false) === true;
  const where = [column ? `${column} >= ?` : null, editionOnly ? 'edition IS NOT NULL' : null]
    .filter(Boolean);

  const rows = db.prepare(`
    SELECT id, title, url, image, source, source_name, lang, servings, total_minutes,
           active_minutes, kcal, protein_g, carbs_g, nutrition_src, keywords,
           score_healthy, score_classic, score_premium
      FROM recipes
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ${column ? `ORDER BY ${column} DESC` : ''}
  `).all(...params);
```

- [ ] **Step 6: Crawleren må ikke skrive hen over en dansk udgave**

Øverst i `storeRecipe(db, source, parsed)` i `src/recipes/crawl.js`:

```js
  // En ret med dansk udgave er vores nu (data/opskrifter/). Et nyt crawl må
  // hverken skrive kildens titel, tider eller ingredienslinjer hen over den.
  const kept = db.prepare('SELECT id, edition FROM recipes WHERE url = ?').get(parsed.url);
  if (kept && kept.edition != null) return { recipeId: kept.id, created: false, tier: null };
```

og læg `active_minutes` ind ved siden af `total_minutes` i INSERT'ens kolonneliste (`total_minutes, active_minutes,`), i VALUES (`@total_minutes, @active_minutes,`), i ON CONFLICT (`total_minutes = excluded.total_minutes, active_minutes = excluded.active_minutes,`) og i parametrene (`active_minutes: parsed.active_minutes,`).

Eksportér samtidig `fetchText` fra crawl.js (bruges i opgave 4):

```js
module.exports = { crawlAll, crawlSource, discoverUrls, storeRecipe, fetchText };
```

- [ ] **Step 7: Kør tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 8: Commit**

```bash
git add src/db/index.js src/db/schema.sql src/recipes/crawl.js src/mealplan/generate.js test/recipes.test.js
git commit -m "Basen får plads til den danske udgave: tider, afsnit, trin og udgavenummer"
```

### Task 4: Kildesiderne hentes igen — til tmp/kilder/

**Files:**
- Create: `src/recipes/instructions.js`
- Create: `src/recipes/edition.js` (kun stierne her; resten i opgave 5)
- Create: `src/recipes/fetch-sources.js`
- Modify: `package.json` (scripts)
- Test: `test/recipes.test.js`

- [ ] **Step 1: Skriv de fejlende tests**

```js
const { stepsFromJsonLd, stepsFromMicrodata } = require('../src/recipes/instructions');
const { slugOf } = require('../src/recipes/edition');

test('fremgangsmåden fra JSON-LD: trin, afsnit og Arlas "type" uden @', () => {
  const steps = stepsFromJsonLd([
    { type: 'HowToSection', name: 'First instruction', itemListElement: [
      { type: 'HowToStep', text: 'Varm olien.' },
      { '@type': 'HowToStep', text: 'Brun kyllingen.' }] },
    { '@type': 'HowToSection', name: 'Til saucen', itemListElement: [
      { '@type': 'HowToStep', text: 'Rør fløden i.' }] },
  ]);
  assert.deepEqual(steps, [
    { section: null, text: 'Varm olien.' },
    { section: null, text: 'Brun kyllingen.' },
    { section: 'Til saucen', text: 'Rør fløden i.' },
  ]);
  assert.deepEqual(stepsFromJsonLd('Heat the oil.\nAdd the onions.'),
    [{ section: null, text: 'Heat the oil.' }, { section: null, text: 'Add the onions.' }]);
});

test('fremgangsmåden fra microdata (Valdemarsro)', () => {
  const html = `<div itemscope itemtype="http://schema.org/Recipe">
    <p itemprop="recipeInstructions">Kom salt og <b>hvidløg</b> i en morter.</p>
    <p itemprop="recipeInstructions">Steg kødet.</p></div>`;
  assert.deepEqual(stepsFromMicrodata(html), [
    { section: null, text: 'Kom salt og hvidløg i en morter.' },
    { section: null, text: 'Steg kødet.' },
  ]);
});

test('filnavnet er stabilt og unikt pr. URL', () => {
  const a = 'https://www.valdemarsro.dk/lammeculotte/';
  assert.equal(slugOf(a), slugOf(a));
  assert.match(slugOf(a), /^lammeculotte-[0-9a-f]{6}$/);
  assert.notEqual(slugOf('https://x.test/a/lasagne'), slugOf('https://x.test/b/lasagne'));
});
```

- [ ] **Step 2: Kør og se dem fejle**

Run: `npm test 2>&1 | grep "Cannot find module"`
Expected: `Cannot find module '../src/recipes/instructions'`

- [ ] **Step 3: Skriv `src/recipes/instructions.js`**

```js
'use strict';

/**
 * Kildens fremgangsmåde som en liste af trin: [{ section, text }].
 *
 * Bruges KUN som råmateriale til appens egen danske udgave (rewrite.js).
 * Teksten er kildens og ophavsretligt beskyttet, så den gemmes aldrig i
 * data.db, i git eller i Supabase — kun i tmp/kilder/, som er gitignoret.
 */

const { stripTags, findJsonLdRecipes } = require('./extract');

const typeOf = (n) => String((n && (n['@type'] || n.type)) || '');
// Arla navngiver et afsnit uden overskrift "First instruction". Det er ikke
// en overskrift, nogen skal se.
const PLACEHOLDER = /^\w+ instructions?$/i;

function stepsFromJsonLd(value, section = null, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    for (const line of value.split(/\n+/)) {
      const text = stripTags(line);
      if (text) out.push({ section, text });
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) stepsFromJsonLd(v, section, out);
    return out;
  }
  if (typeof value === 'object') {
    if (/HowToSection/i.test(typeOf(value))) {
      const name = value.name && !PLACEHOLDER.test(value.name) ? stripTags(value.name) : section;
      return stepsFromJsonLd(value.itemListElement, name, out);
    }
    const text = value.text || value.name || value.description;
    if (text) out.push({ section, text: stripTags(text) });
  }
  return out;
}

/** Valdemarsro: ét itemprop="recipeInstructions" pr. trin. */
function stepsFromMicrodata(html) {
  const at = String(html).search(/itemtype\s*=\s*["']https?:\/\/schema\.org\/Recipe/i);
  if (at === -1) return [];
  const re = /<([a-z0-9]+)[^>]*\bitemprop\s*=\s*["']recipeInstructions["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const out = [];
  for (const m of String(html).slice(at).matchAll(re)) {
    const text = stripTags(m[2]);
    if (text) out.push({ section: null, text });
  }
  return out;
}

function instructionsFrom(html) {
  for (const r of findJsonLdRecipes(html)) {
    const steps = stepsFromJsonLd(r.recipeInstructions);
    if (steps.length) return steps;
  }
  return stepsFromMicrodata(html);
}

module.exports = { stepsFromJsonLd, stepsFromMicrodata, instructionsFrom };
```

- [ ] **Step 4: Skriv `src/recipes/edition.js` (stierne)**

```js
'use strict';

/**
 * Den danske udgave af en opskrift: stierne, formen og ingredienslinjen.
 *
 * Én fil pr. opskrift i data/opskrifter/<kilde>/<slug>.json. Filerne ligger i
 * git, så en rettet opskrift kan ses i en diff og rettes i hånden, og de
 * læses ind i data.db af import-da.js — også i den natlige kørsel, så
 * release-assettet aldrig står uden dem.
 *
 * Råmaterialet (kildens egen tekst) ligger i tmp/kilder/ med samme filnavn.
 */

const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EDITION_DIR = path.join(ROOT, 'data', 'opskrifter');
const SOURCE_DIR = path.join(ROOT, 'tmp', 'kilder');

/**
 * Sidste led i URL'en plus seks tegn af dens hash. recipes.id er et lokalt
 * løbenummer og duer ikke som navn; URL'en er den stabile nøgle, og hashen
 * holder to "lasagne"-sider hos samme kilde fra hinanden.
 */
function slugOf(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const last = (parts[parts.length - 1] || 'opskrift').toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 6);
  return `${last || 'opskrift'}-${hash}`;
}

const editionPath = (source, url) => path.join(EDITION_DIR, source, `${slugOf(url)}.json`);
const sourcePath = (source, url) => path.join(SOURCE_DIR, source, `${slugOf(url)}.json`);

module.exports = { EDITION_DIR, SOURCE_DIR, slugOf, editionPath, sourcePath };
```

- [ ] **Step 5: Kør tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 6: Skriv `src/recipes/fetch-sources.js`**

```js
'use strict';

/**
 * Henter kildesiderne igen og gemmer råmaterialet til den danske udgave i
 * tmp/kilder/<kilde>/<slug>.json: titel, portioner, tider, ingredienslinjer og
 * fremgangsmåde.
 *
 * tmp/ er gitignoret med vilje. Kildens fremgangsmåde er dens egen tekst; den
 * er input til omskrivningen og må hverken ende i git, i data.db (som ligger
 * som release-asset) eller i Supabase.
 *
 *   npm run recipes:fetch-sources                          # alle, der mangler
 *   npm run recipes:fetch-sources -- --source valdemarsro --limit 20
 *   npm run recipes:fetch-sources -- --ids 2178,2179 --force
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { BY_KEY } = require('./sources');
const { fetchText } = require('./crawl');
const { extractRecipe } = require('./extract');
const { instructionsFrom } = require('./instructions');
const { sourcePath } = require('./edition');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argValue = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

async function fetchOne(row) {
  const html = await fetchText(row.url);
  if (!html) return { ok: false, reason: 'kunne ikke hentes' };
  const parsed = extractRecipe(html, row.url);
  if (!parsed) return { ok: false, reason: 'ingen opskrift på siden' };
  const steps = instructionsFrom(html);
  if (!steps.length) return { ok: false, reason: 'ingen fremgangsmåde' };

  const record = {
    url: row.url, source: row.source, source_name: row.source_name, lang: row.lang,
    fetched_at: new Date().toISOString(),
    title: parsed.title,
    yield_count: parsed.servings,
    total_minutes: parsed.total_minutes,
    active_minutes: parsed.active_minutes,
    ingredients: parsed.ingredients.map((i) => i.raw),
    steps,
  };
  const file = sourcePath(row.source, row.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return { ok: true };
}

async function main(args) {
  const db = getDb();
  const ids = argValue(args, '--ids');
  const source = argValue(args, '--source');
  const limit = Number(argValue(args, '--limit')) || Infinity;
  const force = args.includes('--force');

  let rows = db.prepare('SELECT id, url, source, source_name, lang FROM recipes ORDER BY id').all();
  if (ids) { const want = new Set(ids.split(',').map(Number)); rows = rows.filter((r) => want.has(r.id)); }
  if (source) rows = rows.filter((r) => r.source === source);
  if (!force) rows = rows.filter((r) => !fs.existsSync(sourcePath(r.source, r.url)));
  rows = rows.slice(0, limit);

  // Én kø pr. kilde, kørt side om side: samme høflighed pr. site som
  // crawleren (sources.js' delayMs), men ikke fire gange så lang tid i alt.
  const queues = new Map();
  for (const r of rows) {
    if (!queues.has(r.source)) queues.set(r.source, []);
    queues.get(r.source).push(r);
  }
  const failed = [];
  let done = 0;
  await Promise.all([...queues].map(async ([key, list]) => {
    const delay = BY_KEY.get(key)?.delayMs ?? 1000;
    for (const r of list) {
      const res = await fetchOne(r);
      if (!res.ok) failed.push({ id: r.id, url: r.url, reason: res.reason });
      if (++done % 50 === 0) console.log(`  ${done}/${rows.length}`);
      await sleep(delay);
    }
  }));

  console.log(`${rows.length - failed.length} kilder gemt i tmp/kilder/ · ${failed.length} fejlede`);
  for (const f of failed.slice(0, 30)) console.log(`  ${f.id} ${f.url}: ${f.reason}`);
  return { saved: rows.length - failed.length, failed };
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('[FEJL]', e.message); process.exit(1); });
}

module.exports = { fetchOne, main };
```

Tilføj scriptet i `package.json`:

```json
"recipes:fetch-sources": "node src/recipes/fetch-sources.js",
```

- [ ] **Step 7: Røgtest mod én rigtig side**

Run: `npm run recipes:fetch-sources -- --ids 2178 --force && node -e "const f=require('fs');const d='tmp/kilder/valdemarsro/';const n=f.readdirSync(d).find(x=>x.startsWith('lammeculotte'));const r=JSON.parse(f.readFileSync(d+n));console.log(r.total_minutes, r.active_minutes, r.ingredients.length, r.steps.length)"`
Expected: `45 30 7 4` (eller det, siden siger på dagen: tid i alt > arbejdstid, 7 ingredienser, mindst 2 trin)

(Id 2178 er lammeculotten i den nuværende `data.db`. Findes den ikke under det id, så slå det op: `select id from recipes where url like '%lammeculotte%'`.)

- [ ] **Step 8: Commit**

```bash
git add src/recipes/instructions.js src/recipes/edition.js src/recipes/fetch-sources.js package.json test/recipes.test.js
git commit -m "Kildesiderne hentes igen til tmp/kilder/ — råmaterialet til den danske udgave"
```

---

## Fase 3 — den danske udgave

### Task 5: Udgavens form og ingredienslinjen

**Files:**
- Modify: `src/recipes/edition.js`
- Modify: `src/recipes/extract.js:243` (`OPTIONAL_RE`)
- Test: `test/recipes.test.js`

- [ ] **Step 1: Skriv de fejlende tests**

```js
const { lineOf, labelOf, UNITS, RECIPE_SCHEMA } = require('../src/recipes/edition');

test('den danske linje læses tilbage til samme vare og mængde', () => {
  const kb = parseIngredient(lineOf({ amount: 400, unit: 'g', name: 'kyllingebryst', note: 'i strimler', optional: false }));
  assert.equal(kb.item_key, 'kyllingebryst');
  near(kb.amount, 0.4);
  assert.equal(parseIngredient(lineOf({ amount: 1.5, unit: 'dl', name: 'piskefløde', note: null, optional: false })).qty, 1.5);
  // Valgfri står bagerst: "evt." forrest ville skygge for mængden.
  const opt = parseIngredient(lineOf({ amount: 100, unit: 'g', name: 'bacon', note: null, optional: true }));
  assert.equal(opt.optional, 1);
  near(opt.amount, 0.1);
  assert.equal(labelOf({ name: 'kyllingebryst', note: 'i strimler' }), 'kyllingebryst, i strimler');
});

test('skemaet kender kun enheder, parseIngredient kan læse', () => {
  for (const u of UNITS) {
    const p = parseIngredient(`2 ${u} løg`);
    assert.equal(p.unit, u, `enheden ${u} læses ikke`);
  }
  assert.equal(RECIPE_SCHEMA.additionalProperties, false);
});
```

- [ ] **Step 2: Kør og se dem fejle**

Run: `npm test 2>&1 | grep -E "lineOf|is not a function" | head -3`
Expected: `lineOf is not a function`

- [ ] **Step 3: Udvid `edition.js`**

Tilføj før `module.exports` i `src/recipes/edition.js`:

```js
// Enhederne, parseIngredient (extract.js) kender. Modellen må kun bruge dem —
// ellers kan linjen ikke regnes om til en mængde og prissættes.
const UNITS = ['g', 'kg', 'ml', 'dl', 'l', 'tsk', 'spsk', 'stk', 'fed', 'bundt',
               'dåse', 'pakke', 'skive', 'stilk', 'håndfuld', 'knivspids'];

// anyOf frem for type-arrays: det er den form, structured outputs tager imod
// uden forbehold. Røgtesten i opgave 6 bekræfter det mod CLI'en.
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'intro', 'servings', 'ingredients', 'steps', 'changes'],
  properties: {
    title: { type: 'string' },
    intro: { type: 'string' },
    servings: { type: 'integer' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'amount', 'unit', 'name', 'note', 'optional'],
        properties: {
          section: nullable({ type: 'string' }),
          amount: nullable({ type: 'number' }),
          unit: nullable({ type: 'string', enum: UNITS }),
          name: { type: 'string' },
          note: nullable({ type: 'string' }),
          optional: { type: 'boolean' },
        },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'text'],
        properties: { section: nullable({ type: 'string' }), text: { type: 'string' } },
      },
    },
    changes: { type: 'array', items: { type: 'string' } },
  },
};

/** 1.5 → "1,5". Listen er dansk; parseIngredient læser begge dele. */
const fmtAmount = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');

/** Varen med tilberedning, uden mængde: det, opskriftsarket skriver efter mængden. */
const labelOf = (ing) => `${ing.name}${ing.note ? `, ${ing.note}` : ''}`;

/**
 * Den danske linje, parseIngredient læser: "400 g kyllingebryst, i strimler".
 * Valgfri står bagerst som "(valgfri)" — et "evt." forrest ville stå, hvor
 * parseren leder efter mængden.
 */
function lineOf(ing) {
  const head = [ing.amount != null ? fmtAmount(ing.amount) : null, ing.unit, ing.name]
    .filter(Boolean).join(' ');
  return `${head}${ing.note ? `, ${ing.note}` : ''}${ing.optional ? ' (valgfri)' : ''}`;
}
```

og udvid eksporten:

```js
module.exports = {
  EDITION_DIR, SOURCE_DIR, slugOf, editionPath, sourcePath,
  UNITS, RECIPE_SCHEMA, fmtAmount, labelOf, lineOf,
};
```

- [ ] **Step 4: `(valgfri)` er valgfri**

I `src/recipes/extract.js`, udvid `OPTIONAL_RE`:

```js
const OPTIONAL_RE = /\(optional\)|\(valgfri\)|\boptional\b|\bif you like\b|^\s*evt\.?\s|^\s*eventuelt\b|^\s*valgfri/i;
```

- [ ] **Step 5: Kør tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`. Fejler "skemaet kender kun enheder" for én enhed (fx `skive` eller `stilk`), så står den ikke i `UNITS` i extract.js — fjern den fra `edition.js`' `UNITS`, frem for at ændre parseren.

- [ ] **Step 6: Commit**

```bash
git add src/recipes/edition.js src/recipes/extract.js test/recipes.test.js
git commit -m "Den danske udgaves form: skema, enheder og en linje parseren kan læse"
```

### Task 6: Omskrivningen med Claude Code — på abonnementet

**Files:**
- Create: `src/recipes/rewrite.js`
- Modify: `package.json` (script)
- Test: `test/recipes.test.js`

Omskrivningen kalder Claude Code-CLI'en i headless-tilstand (`claude -p`) som underproces. Det kører på brugerens Claude-abonnement — ingen API-nøgle, intet SDK, ingen ekstra udgift. Prøvet 2026-09-30 med CLI'en fra VS Code-udvidelsen (2.1.285): `--json-schema` giver et valideret objekt i svarets `structured_output`, og et kald tager få sekunder.

Det, der kan gå galt, er modellens svar, og det kontrolleres af import-da.js (opgave 7) og af piloten (opgave 13). De to rene hjælpere — at finde CLI'en og at kende abonnementets grænse — testes her.

- [ ] **Step 1: Skriv de fejlende tests**

```js
const { newestClaude, limitHit } = require('../src/recipes/rewrite');

test('den nyeste Claude Code i VS Code-udvidelserne vælges — efter versionsnummer', () => {
  assert.equal(newestClaude([
    'anthropic.claude-code-2.1.99-win32-x64',
    'anthropic.claude-code-2.1.285-win32-x64',
    'ms-python.python-2026.1.0',
  ]), 'anthropic.claude-code-2.1.285-win32-x64');
  assert.equal(newestClaude(['ms-python.python-2026.1.0']), null);
});

test('abonnementets grænse genkendes, andre fejl gør ikke', () => {
  assert.equal(limitHit({ is_error: true, api_error_status: 429, result: 'x' }), true);
  assert.equal(limitHit({ is_error: true, result: 'Claude usage limit reached|1759300000' }), true);
  assert.equal(limitHit({ is_error: true, result: 'Invalid JSON schema' }), false);
  assert.equal(limitHit({ is_error: false, result: 'usage limit' }), false);
});
```

- [ ] **Step 2: Kør og se dem fejle**

Run: `npm test 2>&1 | grep "Cannot find module"`
Expected: `Cannot find module '../src/recipes/rewrite'`

- [ ] **Step 3: Skriv `src/recipes/rewrite.js`**

```js
'use strict';

/**
 * Skriver appens danske udgave af opskrifterne med Claude Code i
 * headless-tilstand (`claude -p`) — på brugerens Claude-abonnement, ikke på
 * API'et, så der er ingen ekstra udgift. Abonnementets forbrugsgrænse gælder:
 * rammes den, stopper kørslen pænt, og næste kørsel fortsætter, hvor den slap
 * (en opskrift med en fil i data/opskrifter/ springes over).
 *
 *   npm run recipes:rewrite -- run [--limit N] [--source S] [--ids 1,2] [--force]
 *                                  [--parallel 2] [--model opus]
 *   npm run recipes:rewrite -- one <recipe_id> [--model opus]
 *
 * CLI'en: CLAUDE_BIN, ellers den nyeste i VS Code-udvidelserne, ellers
 * `claude` på PATH. Den kører fra en tom mappe uden værktøjer, indstillinger
 * og MCP: modellen skal kun læse opskriften og svare i skemaets form.
 *
 * Råmaterialet er tmp/kilder/ (fetch-sources.js); resultatet er
 * data/opskrifter/<kilde>/<slug>.json, som import-da.js læser ind i basen.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getDb } = require('../db');
const { SEED } = require('../lib/taxonomy');
const { UNITS, RECIPE_SCHEMA, sourcePath, editionPath } = require('./edition');

// Sonnet bruger mindst af abonnementets grænse og er rigeligt til at
// oversætte og runde mængder af. --model opus, hvis piloten siger andet.
const DEFAULT_MODEL = 'sonnet';
const EDITION = 1;
const STATE_DIR = path.join(__dirname, '..', '..', 'tmp', 'omskrivning');

const argValue = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

/** Den nyeste Claude Code-udvidelse blandt mappenavnene — efter versionsnummer, ikke alfabet. */
function newestClaude(dirs) {
  const ver = (d) => (d.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  const found = dirs.filter((d) => ver(d).length === 3);
  found.sort((a, b) => { const x = ver(a), y = ver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return found.length ? found[found.length - 1] : null;
}

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  const dir = fs.existsSync(ext) ? newestClaude(fs.readdirSync(ext)) : null;
  if (dir) {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const bin = path.join(ext, dir, 'resources', 'native-binary', exe);
    if (fs.existsSync(bin)) return bin;
  }
  return 'claude';
}

/** Har abonnementet sagt stop for nu? 429, eller "usage limit" i beskeden. */
function limitHit(res) {
  return Boolean(res && res.is_error && (res.api_error_status === 429
    || /usage limit|rate limit|limit reached/i.test(String(res.result || ''))));
}

// Brugerens valg 2026-09-30: så lidt om som muligt. Samme ret; mængderne
// rundet til danske pakninger og runde tal, så de ikke er kildens egne; og
// fremgangsmåden med egne ord — det er teksten, ophavsretten beskytter.
const INSTRUCTIONS = `Du er redaktør på en dansk madplan-app. Du får en opskrift fra en kilde – dansk eller engelsk – og skriver appens egen danske udgave af den.

Lav så lidt om som muligt: samme ret, samme råvarer, samme teknik, samme tider og temperaturer, samme portionsantal. Udgaven skal kunne laves i et dansk køkken med varer fra et dansk supermarked.

INGREDIENSER
- Skriv på dansk, én vare pr. linje. "Salt og peber" er to linjer.
- Brug kun disse enheder: ${UNITS.join(', ')} – eller null, når linjen ikke har en mængde. Omregn: cup → dl, oz → g, lb → g, tbsp → spsk, tsp → tsk, stick butter → g.
- Rund mængderne til det, man køber i Danmark, og til runde tal: hele pakker, hvor det giver mening (450 g hakket oksekød → 500 g; en dåse hakkede tomater er 400 g; et bæger fløde er 2,5 dl), ellers et rundt tal tæt på (180 g → 200 g). Ingen vare må ændres mere end 20 % op eller ned, og retten skal smage som før.
- name er varen alene, som den hedder i et dansk supermarked ("kyllingebryst", ikke "kyllingebryst uden skind i strimler"). Brug navnene fra varekataloget nedenfor, når de passer. Tilberedning ("finthakket", "i strimler") står i note.
- Er en vare svær at få i Netto, REMA 1000, Føtex, Bilka, Lidl eller Coop, så skift den til den nærmeste almindelige danske vare (double cream → piskefløde, courgette → squash, streaky bacon → bacon i skiver, self-raising flour → hvedemel og bagepulver). Skift aldrig rettens hovedråvare ud: lam forbliver lam, laks forbliver laks.
- optional er kun sand, hvis kilden selv kalder varen valgfri eller "evt.".
- section er en overskrift som "Til dressingen", eller null.
- Skriv hver erstatning af en vare som én kort sætning i changes. Afrundinger skal ikke med. Ingen erstatninger: en tom liste.

FREMGANGSMÅDE
- Skriv den på dansk med dine egne ord, i korte trin i bydeform ("Steg løget blødt i smørret."). Samme ret og samme teknik – men ikke en ordret oversættelse eller afskrift af kildens tekst.
- Temperaturer i °C for almindelig ovn; skriv varmluft, hvis kilden gør. Gasmærker og °F omregnes.
- Gentag ikke mængder fra ingredienslisten i trinene – de kan blive justeret i appen. Skriv "halvdelen af hvidløget", ikke "2 fed hvidløg".
- section som ved ingredienserne.

TITEL OG INTRO
- title: kort og dansk, som en dansk kogebog ville kalde retten.
- intro: én eller to sætninger med dine egne ord om retten.
- servings: kildens portionsantal, uændret.

VAREKATALOG (foretrukne varenavne)
`;

// Sorteret og uden noget, der skifter fra kald til kald: samme prompt hver
// gang, så den kan genbruges fra cachen og bruger mindre af grænsen.
function systemText() {
  const catalog = SEED
    .filter((e) => e.cat !== 'nonfood')
    .map((e) => `- ${e.name}${e.da && e.da.length ? ` (${e.da.slice(0, 6).join(', ')})` : ''}`)
    .sort((a, b) => a.localeCompare(b, 'da'))
    .join('\n');
  return INSTRUCTIONS + catalog;
}

function userMessage(src) {
  return [
    `Kilde: ${src.lang === 'en' ? 'engelsk' : 'dansk'}`,
    `Titel: ${src.title}`,
    `Portioner: ${src.yield_count ?? 'ikke oplyst'}`,
    '',
    'Ingredienser:',
    ...src.ingredients.map((l) => `- ${l}`),
    '',
    'Fremgangsmåde:',
    ...src.steps.map((s, i) => `${i + 1}. ${s.section ? `[${s.section}] ` : ''}${s.text}`),
  ].join('\n');
}

/** Ét kald til CLI'en. Svarer { output, model } eller { error, limit }. */
function ask(src, { model = DEFAULT_MODEL } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json',
      '--json-schema', JSON.stringify(RECIPE_SCHEMA),
      // ~13.000 tegn — et godt stykke under Windows' grænse på 32.767 for en
      // kommandolinje. Vokser kataloget meget, skal den i en fil.
      '--system-prompt', systemText(),
      '--tools', '', '--setting-sources', '', '--strict-mcp-config',
      '--no-session-persistence', '--model', model];
    // En tom mappe: ingen CLAUDE.md eller projektfiler må farve svaret.
    const child = spawn(claudeBin(), args, { cwd: os.tmpdir() });
    let out = '';
    let err = '';
    // setEncoding og ikke Buffer + '': et æ, der deles mellem to bidder,
    // ville ellers blive til to ødelagte tegn.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ error: `claude kunne ikke startes: ${e.message}` }));
    child.on('close', (code) => {
      let res;
      try { res = JSON.parse(out); } catch {
        return resolve({ error: `uventet svar (kode ${code}): ${(err || out).trim().slice(0, 300)}` });
      }
      if (limitHit(res)) return resolve({ error: String(res.result || 'grænsen er nået'), limit: true });
      if (res.is_error || res.subtype !== 'success' || !res.structured_output) {
        return resolve({ error: String(res.result || res.subtype || 'intet svar').slice(0, 300) });
      }
      resolve({ output: res.structured_output, model: Object.keys(res.modelUsage || {})[0] || model });
    });
    child.stdin.end(userMessage(src));
  });
}

function writeEdition(src, answer) {
  const ed = {
    url: src.url, source: src.source, source_name: src.source_name,
    edition: EDITION, model: answer.model, written_at: new Date().toISOString(),
    // Tiderne er kildens, læst af times.js — ikke modellens.
    total_minutes: src.total_minutes ?? null,
    active_minutes: src.active_minutes ?? null,
    yield_count: src.yield_count ?? null,
    ...answer.output,
  };
  const file = editionPath(src.source, src.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ed, null, 2)}\n`);
  return file;
}

/** De opskrifter, der har råmateriale, men endnu ingen dansk udgave. */
function pending(args) {
  let rows = getDb().prepare('SELECT id, url, source FROM recipes ORDER BY id').all();
  const ids = argValue(args, '--ids');
  const source = argValue(args, '--source');
  const limit = Number(argValue(args, '--limit')) || Infinity;
  const force = args.includes('--force');
  if (ids) { const want = new Set(ids.split(',').map(Number)); rows = rows.filter((r) => want.has(r.id)); }
  if (source) rows = rows.filter((r) => r.source === source);

  const out = [];
  for (const r of rows) {
    const file = sourcePath(r.source, r.url);
    if (!fs.existsSync(file)) continue;
    if (!force && fs.existsSync(editionPath(r.source, r.url))) continue;
    out.push({ ...JSON.parse(fs.readFileSync(file, 'utf8')), id: r.id });
    if (out.length >= limit) break;
  }
  return out;
}

async function run(args) {
  const todo = pending(args);
  if (!todo.length) { console.log('Intet at omskrive.'); return; }
  const model = argValue(args, '--model') || DEFAULT_MODEL;
  // Et par kald ad gangen går hurtigere, men når grænsen tilsvarende hurtigere.
  const parallel = Math.max(1, Number(argValue(args, '--parallel')) || 1);
  const started = Date.now();
  const failed = [];
  let ok = 0;
  let next = 0;
  let stopped = null;

  async function worker() {
    while (!stopped && next < todo.length) {
      const src = todo[next++];
      const answer = await ask(src, { model });
      if (answer.limit) { stopped = answer.error; break; }
      if (answer.error) { failed.push({ id: src.id, why: answer.error }); continue; }
      writeEdition(src, answer);
      if (++ok % 10 === 0) {
        const sec = (Date.now() - started) / 1000 / ok;
        console.log(`  ${ok}/${todo.length} · ${sec.toFixed(0)} s pr. opskrift`);
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));

  const perRecipe = ok ? ((Date.now() - started) / 1000 / ok).toFixed(0) : '–';
  console.log(`${ok} danske udgaver skrevet · ${failed.length} fejlede · ${perRecipe} s pr. opskrift`);
  for (const f of failed.slice(0, 30)) console.log(`  ${f.id}: ${f.why}`);
  if (failed.length) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'fejl.json'), JSON.stringify(failed, null, 2));
    console.log(`Kør dem igen: npm run recipes:rewrite -- run --force --ids ${failed.map((f) => f.id).join(',')}`);
  }
  if (stopped) {
    console.log(`\nAbonnementets grænse er nået: ${stopped}`);
    console.log('Start samme kommando igen, når grænsen er nulstillet — den fortsætter, hvor den slap.');
  }
}

async function one(id, args) {
  const r = getDb().prepare('SELECT id, url, source FROM recipes WHERE id = ?').get(Number(id));
  if (!r) throw new Error(`Ukendt opskrift ${id}`);
  const src = { ...JSON.parse(fs.readFileSync(sourcePath(r.source, r.url), 'utf8')), id: r.id };
  const answer = await ask(src, { model: argValue(args, '--model') || DEFAULT_MODEL });
  if (answer.error) throw new Error(`${id}: ${answer.error}`);
  console.log(`Skrevet: ${path.relative(process.cwd(), writeEdition(src, answer))} (${answer.model})`);
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'run') return run(args);
  if (cmd === 'one') return one(args[0], args.slice(1));
  console.log('Brug: run [--limit N] [--source S] [--ids 1,2] [--force] [--parallel N] [--model M] | one <id>');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('[FEJL]', e.message); process.exit(1); });
}

module.exports = { newestClaude, limitHit, systemText, userMessage };
```

Tilføj i `package.json`:

```json
"recipes:rewrite": "node src/recipes/rewrite.js",
```

- [ ] **Step 4: Kør tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 5: Røgtest — lammeculotten (et enkelt kald på abonnementet)**

Run: `npm run recipes:rewrite -- one 2178`
Expected: `Skrevet: data/opskrifter/valdemarsro/lammeculotte-xxxxxx.json (claude-sonnet-…)`. Åbn filen: dansk titel, `lammeculotte` i `name`, enheder fra listen, runde mængder, mindst to trin uden gramtal, `total_minutes`/`active_minutes` fra kilden.

Svarer CLI'en med en fejl om skemaet, så læs teksten: den nævner den konstruktion, den ikke tager imod (fx `anyOf` med `enum`). Ret `RECIPE_SCHEMA` i `edition.js` til den form, fejlen peger på, og kør igen. Findes CLI'en ikke, så sæt `CLAUDE_BIN` til stien til `claude.exe`.

- [ ] **Step 6: Commit**

```bash
git add src/recipes/rewrite.js package.json test/recipes.test.js
git commit -m "Omskrivningen med Claude Code på abonnementet — ingen API, ingen udgift"
```

(Lammeculotte-filen committes først i opgave 14 sammen med resten.)

### Task 7: Indlæsningen — kontrol og data.db

**Files:**
- Create: `src/recipes/import-da.js`
- Modify: `package.json` (script)
- Test: `test/recipes.test.js`

- [ ] **Step 1: Skriv de fejlende tests**

```js
const os = require('os');
const fs = require('fs');
const path = require('path');
const { importAll } = require('../src/recipes/import-da');

const EDITION_FIXTURE = {
  url: 'https://test.invalid/da-import-1', source: 'test', source_name: 'Test',
  edition: 1, model: 'test', written_at: '2026-09-30T12:00:00.000Z',
  total_minutes: 90, active_minutes: 15, yield_count: 4,
  title: 'Lammeculotte med krydderurter', intro: 'Mør lam med salvie.', servings: 4,
  ingredients: [
    { section: null, amount: 600, unit: 'g', name: 'lammeculotte', note: null, optional: false },
    { section: null, amount: 3, unit: 'fed', name: 'hvidløg', note: 'hakket', optional: false },
    { section: null, amount: null, unit: null, name: 'salt', note: null, optional: false },
  ],
  steps: [
    { section: null, text: 'Gnid kødet med hvidløg og salt.' },
    { section: null, text: 'Steg det i ovnen ved 180 °C.' },
  ],
  changes: [],
};

function withEdition(edition, fn) {
  const db = getDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opskrifter-'));
  fs.writeFileSync(path.join(dir, 'ret.json'), JSON.stringify(edition));
  const id = Number(db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, yield_count, fetched_at)
    VALUES (?, 'test', 'Test', 'Lamb rump', 'en', 4, 4, ?)`).run(edition.url, new Date().toISOString()).lastInsertRowid);
  const p = parseIngredient('600 g lamb rump', 0);
  db.prepare(`INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient, item_key, amount, optional, position)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(id, p.raw, p.qty, p.unit, p.ingredient, p.item_key, p.amount, p.optional);
  try { return fn({ db, dir, id }); } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('en dansk udgave læses ind: titel, tider, linjer og trin', () => {
  withEdition(EDITION_FIXTURE, ({ db, dir, id }) => {
    const first = importAll({ dir, log: () => {} });
    assert.equal(first.applied, 1);
    const r = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
    assert.equal(r.title, 'Lammeculotte med krydderurter');
    assert.equal(r.lang, 'da');
    assert.equal(r.edition, 1);
    assert.equal(r.total_minutes, 90);
    assert.equal(r.active_minutes, 15);
    const lines = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY position').all(id);
    assert.deepEqual(lines.map((l) => l.item_key), ['lam', 'hvidloeg', 'salt']);
    assert.equal(lines[1].label, 'hvidløg, hakket');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_steps WHERE recipe_id = ?').get(id).n, 2);
    // Anden gang er filen uændret og røres ikke.
    assert.equal(importAll({ dir, log: () => {} }).unchanged, 1);
  });
});

test('en udgave, der har flyttet hovedråvaren mere end 25 %, læses ikke ind', () => {
  const more = {
    ...EDITION_FIXTURE,
    url: 'https://test.invalid/da-import-3',
    ingredients: [{ section: null, amount: 900, unit: 'g', name: 'lammeculotte', note: null, optional: false },
                  ...EDITION_FIXTURE.ingredients.slice(1)],
  };
  withEdition(more, ({ dir }) => {
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.flagged, 1);
    assert.match(res.flaggedList[0].issues.join(), /lam: 600 → 900/);
  });
});

test('en udgave, der har skiftet hovedråvaren ud, læses ikke ind', () => {
  const swapped = {
    ...EDITION_FIXTURE,
    url: 'https://test.invalid/da-import-2',
    ingredients: [{ section: null, amount: 600, unit: 'g', name: 'svinemørbrad', note: null, optional: false },
                  ...EDITION_FIXTURE.ingredients.slice(1)],
  };
  withEdition(swapped, ({ db, dir, id }) => {
    const res = importAll({ dir, log: () => {} });
    assert.equal(res.applied, 0);
    assert.equal(res.flagged, 1);
    assert.equal(db.prepare('SELECT title FROM recipes WHERE id = ?').get(id).title, 'Lamb rump');
  });
  // Godkendt i hånden: så læses den ind alligevel.
  withEdition({ ...swapped, accepted: true }, ({ dir }) => {
    assert.equal(importAll({ dir, log: () => {} }).applied, 1);
  });
});
```

- [ ] **Step 2: Kør og se dem fejle**

Run: `npm test 2>&1 | grep "Cannot find module"`
Expected: `Cannot find module '../src/recipes/import-da'`

- [ ] **Step 3: Skriv `src/recipes/import-da.js`**

```js
'use strict';

/**
 * Læser de danske udgaver (data/opskrifter/**.json) ind i data.db.
 *
 * Idempotent: filens hash står på retten, og en uændret fil røres ikke. Den
 * køres også i den natlige kørsel, så release-assettet aldrig står uden de
 * danske opskrifter.
 *
 * En udgave, der ikke består kontrollen, springes over og nævnes; den gamle
 * udgave i basen bliver stående. Er den set efter og i orden, sættes
 * "accepted": true i filen, og så læses den ind.
 *
 *   npm run recipes:import
 *   npm run recipes:import -- --report tmp/omskrivning/kontrol.md
 *
 * Bagefter: npm run backfill:amounts && npm run reclassify && npm run costs:recompute
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const taxonomy = require('../lib/taxonomy');
const { parseIngredient } = require('./extract');
const { UNITS, EDITION_DIR, lineOf, labelOf } = require('./edition');

const MAIN_CATS = new Set(['meat', 'poultry', 'fish']);
const catOf = (key) => { const m = key && taxonomy.get(key); return m ? (m.category || m.cat) : null; };

// Et dyr forrest i et sammensat kødord skal genfindes i varen. Ellers er
// "lammeculotte" blevet til bøf igen (opgave 1).
const ANIMAL_PREFIX = [
  ['lamme', (k) => k === 'lam'],
  ['kalve', (k) => k === 'kalvekoed'],
  ['okse', (k) => /okse|boef/.test(k)],
  ['svine', (k) => /svin|flaesk/.test(k)],
  ['kylling', (k) => /kylling/.test(k)],
];

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name))
      : d.name.endsWith('.json') ? [path.join(dir, d.name)] : []))
    .sort();
}

/** Hvad der er galt med udgaven. Tom liste: den kan læses ind. */
function problems(ed, lines, before) {
  const out = [];
  if (!ed.title || ed.title.length < 3) out.push('ingen titel');
  if (!Array.isArray(ed.steps) || ed.steps.length < 2) out.push('færre end to trin');
  if (!Array.isArray(ed.ingredients) || ed.ingredients.length < 2) out.push('færre end to ingredienser');
  for (const ing of ed.ingredients || []) {
    if (ing.unit != null && !UNITS.includes(ing.unit)) out.push(`ukendt enhed "${ing.unit}"`);
    if (ing.amount != null && !(ing.amount > 0)) out.push(`mængden ${ing.amount} for ${ing.name}`);
  }
  if (ed.yield_count && ed.servings !== ed.yield_count) {
    out.push(`${ed.servings} portioner, kilden siger ${ed.yield_count}`);
  }

  // Hovedråvaren må ikke være skiftet ud.
  const after = new Set(lines.map((l) => l.item_key).filter(Boolean));
  for (const k of new Set(before.filter((l) => MAIN_CATS.has(catOf(l.item_key))).map((l) => l.item_key))) {
    if (!after.has(k)) { out.push(`hovedråvaren ${k} er væk`); continue; }
    // Afrundingen må højst flytte en vare 20 % (prompten); 25 % giver plads
    // til hele pakker. Mere end det er en anden ret.
    const sum = (ls) => ls.filter((l) => l.item_key === k).reduce((a, l) => a + (l.amount || 0), 0);
    const was = sum(before), now = sum(lines);
    if (was > 0 && now > 0 && Math.abs(now / was - 1) > 0.25) {
      out.push(`${k}: ${Math.round(was * 1000)} → ${Math.round(now * 1000)} (mere end 25 %)`);
    }
  }
  for (const l of lines) {
    if (!MAIN_CATS.has(catOf(l.item_key))) continue;
    for (const [prefix, ok] of ANIMAL_PREFIX) {
      if (l.ingredient.startsWith(prefix) && !ok(l.item_key)) out.push(`"${l.raw}" er koblet til ${l.item_key}`);
    }
  }

  // Flere ukendte linjer end før: udgaven er sværere at prissætte end kilden.
  const unknown = (ls) => ls.filter((l) => !l.item_key && !l.optional).length;
  if (unknown(lines) > unknown(before)) out.push(`${unknown(lines)} ukendte linjer (før ${unknown(before)})`);
  return out;
}

function importAll({ dir = EDITION_DIR, log = console.log, reportPath = null } = {}) {
  const db = getDb();
  const byUrl = new Map(db.prepare('SELECT id, url, edition_hash FROM recipes').all().map((r) => [r.url, r]));
  const before = db.prepare('SELECT raw, ingredient, item_key, amount, optional FROM recipe_ingredients WHERE recipe_id = ?');

  const apply = db.transaction((id, ed, lines, hash) => {
    db.prepare(`
      UPDATE recipes SET title = @title, intro = @intro, lang = 'da',
             total_minutes = COALESCE(@total, total_minutes),
             active_minutes = COALESCE(@active, active_minutes),
             edition = @edition, edition_hash = @hash, edited_at = @at, changes = @changes
       WHERE id = @id`).run({
      id, title: ed.title, intro: ed.intro || null,
      total: ed.total_minutes ?? null, active: ed.active_minutes ?? null,
      edition: ed.edition, hash, at: ed.written_at || new Date().toISOString(),
      changes: JSON.stringify(ed.changes || []),
    });
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
    const ins = db.prepare(`
      INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient, item_key, amount,
                                      optional, position, section, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((l, i) => ins.run(id, l.raw, l.qty, l.unit, l.ingredient, l.item_key, l.amount,
      l.optional, i, l.section, l.label));
    db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(id);
    const step = db.prepare('INSERT INTO recipe_steps (recipe_id, position, section, text) VALUES (?, ?, ?, ?)');
    ed.steps.forEach((s, i) => step.run(id, i, s.section || null, s.text));
  });

  const stats = { applied: 0, unchanged: 0, flagged: 0, orphan: 0 };
  const flagged = [];
  for (const file of listFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const ed = JSON.parse(text);
    const row = byUrl.get(ed.url);
    if (!row) { stats.orphan++; continue; }
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    if (row.edition_hash === hash) { stats.unchanged++; continue; }

    const lines = (ed.ingredients || []).map((ing, i) => {
      const raw = lineOf(ing);
      return { ...parseIngredient(raw, i), raw, section: ing.section || null, label: labelOf(ing) };
    });
    const issues = problems(ed, lines, before.all(row.id));
    if (issues.length && !ed.accepted) {
      stats.flagged++;
      flagged.push({ file: path.relative(process.cwd(), file), id: row.id, title: ed.title, issues });
      continue;
    }
    apply(row.id, ed, lines, hash);
    stats.applied++;
  }

  log(`${stats.applied} læst ind · ${stats.unchanged} uændrede · ${stats.flagged} til eftersyn · ${stats.orphan} uden ret i basen`);
  for (const f of flagged.slice(0, 20)) log(`  ${f.id} ${f.title}: ${f.issues.join('; ')}`);
  if (reportPath) {
    const md = ['# Danske udgaver til eftersyn', '',
      ...flagged.map((f) => `- **${f.title}** (${f.id}) \`${f.file}\`\n  - ${f.issues.join('\n  - ')}`)];
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${md.join('\n')}\n`);
    log(`Eftersynslisten: ${reportPath}`);
  }
  return { ...stats, flaggedList: flagged };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--report');
  importAll({ reportPath: i === -1 ? null : args[i + 1] });
}

module.exports = { importAll, problems };
```

Tilføj i `package.json`:

```json
"recipes:import": "node src/recipes/import-da.js",
```

- [ ] **Step 4: Kør tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/recipes/import-da.js package.json test/recipes.test.js
git commit -m "Indlæsningen af de danske udgaver — med kontrol af hovedråvare og dyr"
```

---

## Fase 4 — opskriften i appen

### Task 8: Opskrifterne til browseren

**Files:**
- Modify: `src/sync/build.js` (ny `collectRecipeDetails`, `recipeIndex`-mappingen ca. linje 314–345, `build`, `push`, `DERIVED`, eksporten)
- Modify: `supabase/schema.sql`
- Modify: `src/server.js` (ny rute ved `/api/recipe-index`)
- Modify: `public/data.js` (to mappinger af `recipes`, ny `Data.recipe`)
- Modify: `public/engine.js:1155` (kopien af retten i `buildPlan`)
- Modify: `public/sw.js` (`CACHEABLE_TABLES`, `VERSION`)
- Test: `test/sync.test.js`

- [ ] **Step 1: Skriv de fejlende tests**

I `test/sync.test.js`, i testen `collectPlanIndex leverer base_qty ...`, efter keywords-assertionen:

```js
    // Femte felt: arbejdstiden. Uden den viser browseren kun tiden i alt.
    assert.ok('active_minutes' in recipe, 'active_minutes mangler i payloaden');
```

Og en ny test sidst i filen:

```js
test('collectRecipeDetails leverer ingredienser med mængde og fremgangsmåde', () => {
  const db = getDb();
  const { collectRecipeDetails } = require('../src/sync/build');
  const id = Number(db.prepare(`
    INSERT INTO recipes (url, source, source_name, title, lang, servings, fetched_at,
                         edition, intro, total_minutes, active_minutes)
    VALUES ('https://test.invalid/details', 'test', 'Test', 'Lam i ovn', 'da', 4, ?, 1, 'Mørt.', 90, 15)`)
    .run(new Date().toISOString()).lastInsertRowid);
  db.prepare(`INSERT INTO recipe_ingredients (recipe_id, raw, qty, unit, ingredient, item_key, amount,
                                              optional, position, section, label)
              VALUES (?, '600 g lammeculotte', 600, 'g', 'lammeculotte', 'lam', 0.6, 0, 0, NULL, 'lammeculotte')`).run(id);
  db.prepare("INSERT INTO recipe_steps (recipe_id, position, section, text) VALUES (?, 0, NULL, 'Steg kødet.')").run(id);
  try {
    const [row] = collectRecipeDetails(db, id);
    assert.deepEqual(row, {
      recipe_id: id, title: 'Lam i ovn', intro: 'Mørt.', image: null, source_name: 'Test',
      servings: 4, total_minutes: 90, active_minutes: 15,
      ingredients: [{ qty: 600, unit: 'g', label: 'lammeculotte', key: 'lam', optional: false, section: null }],
      steps: [{ section: null, text: 'Steg kødet.' }],
    });
  } finally {
    db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  }
});
```

- [ ] **Step 2: Kør og se dem fejle**

Run: `npm test 2>&1 | grep -E "active_minutes mangler|collectRecipeDetails is not a function"`
Expected: begge linjer

- [ ] **Step 3: `build.js`**

I `recipeIndex`-mappingen (efter `total_minutes: r.total_minutes,`):

```js
      active_minutes: r.active_minutes ?? null,
```

Ny funktion før `// ── Hovedkørsel`:

```js
/**
 * Opskrifterne, som appen viser dem: ingredienserne med mængde og enhed, og
 * fremgangsmåden. Kun de danske udgaver — en ret uden udgave har ingen
 * fremgangsmåde, vi må vise. Appen henter én ad gangen (Data.recipe): 2.200
 * fremgangsmåder i recipe_index ville gøre hver sidevisning megabyte tungere.
 */
function collectRecipeDetails(db, onlyId = null) {
  const recipes = db.prepare(`
    SELECT id, title, intro, image, source_name, servings, total_minutes, active_minutes
      FROM recipes
     WHERE edition IS NOT NULL ${onlyId != null ? 'AND id = ?' : ''}
     ORDER BY id`).all(...(onlyId != null ? [onlyId] : []));
  const lines = db.prepare(`
    SELECT qty, unit, label, ingredient, item_key, optional, section
      FROM recipe_ingredients WHERE recipe_id = ? ORDER BY position`);
  const steps = db.prepare('SELECT section, text FROM recipe_steps WHERE recipe_id = ? ORDER BY position');
  return recipes.map((r) => ({
    recipe_id: r.id, title: r.title, intro: r.intro, image: r.image,
    source_name: r.source_name, servings: r.servings,
    total_minutes: r.total_minutes, active_minutes: r.active_minutes,
    ingredients: lines.all(r.id).map((l) => ({
      qty: l.qty, unit: l.unit, label: l.label || l.ingredient,
      key: l.item_key, optional: Boolean(l.optional), section: l.section,
    })),
    steps: steps.all(r.id),
  }));
}
```

I `build()`: efter `const weekPlans = collectPlans(log);` tilføj `const recipeDetails = collectRecipeDetails(db);`, i `model` tilføj `recipeDetails,`, i `summary` tilføj `recipe_details: recipeDetails.length,` og i dry-run-listen `recipe_details: recipeDetails,`.

I `push()`, efter `recipe_index`-linjen:

```js
  await t('recipe_details', model.recipeDetails, { onConflict: 'recipe_id', chunk: 100 });
```

Øverst i `DERIVED` (før `items` — samme grund som dens kommentar: den nyeste tabel er den, en installation mest sandsynligt mangler, og al sletning sker før indsættelse):

```js
  // Nyeste tabel (plan 2026-09-30) — derfor først. Se kommentaren ved items.
  ['recipe_details', 'recipe_id=not.is.null'],
```

Eksportér `collectRecipeDetails` i `module.exports`.

- [ ] **Step 4: `supabase/schema.sql`**

Efter `recipe_index`-blokken og dens `alter table`-linjer:

```sql
alter table recipe_index add column if not exists active_minutes int;

-- Opskrifterne, som appen viser dem: den danske udgave med ingredienser og
-- fremgangsmåde (src/sync/build.js: collectRecipeDetails). Hentes én ad
-- gangen, når en ret åbnes — derfor ikke en del af recipe_index.
create table if not exists recipe_details (
  recipe_id      bigint primary key,
  title          text not null,
  intro          text,
  image          text,
  source_name    text,             -- krediteres ved fotoet, ikke ved opskriften
  servings       int,
  total_minutes  int,
  active_minutes int,
  ingredients    jsonb not null,   -- [{qty, unit, label, key, optional, section}]
  steps          jsonb not null    -- [{section, text}]
);
```

og i `create table if not exists recipe_index (...)` tilføj `active_minutes int,` efter `total_minutes int,`. Tilføj `alter table recipe_details enable row level security;` ved de andre, og `'recipe_details'` i `read_all`-arrayet.

- [ ] **Step 5: `src/server.js`**

Efter `/api/recipe-index`-ruten:

```js
  // Én opskrift, som appen viser den (Supabase: recipe_details).
  const recipeMatch = p.match(/^\/api\/recipes\/(\d+)$/);
  if (recipeMatch) {
    const [row] = syncBuild().collectRecipeDetails(db, Number(recipeMatch[1]));
    return row ? json(res, row) : json(res, { error: 'Opskriften findes ikke på dansk endnu.' }, 404);
  }
```

- [ ] **Step 6: `public/data.js`**

I begge `recipes`-mappinger (ved `servings: r.servings, total_minutes: r.total_minutes,`) tilføj `active_minutes: r.active_minutes ?? null,`.

Over `const Data = {`:

```js
// Opskrifterne ændrer sig kun ved den natlige kørsel.
const recipeCache = new Map();
```

I `Data`, efter `recipeIndex()`:

```js
  /**
   * Én opskrift med ingredienser og fremgangsmåde (recipe_details). Hentes
   * først, når den åbnes, og huskes resten af sidevisningen.
   */
  async recipe(id) {
    const key = Number(id);
    if (recipeCache.has(key)) return recipeCache.get(key);
    const row = USE_SUPABASE
      ? (await sb(`recipe_details?recipe_id=eq.${key}&select=*`))[0]
      : await local(`/api/recipes/${key}`);
    if (!row || row.error) return { error: (row && row.error) || 'Opskriften findes ikke på dansk endnu.' };
    recipeCache.set(key, row);
    return row;
  },
```

- [ ] **Step 7: `engine.js` og `sw.js`**

I `public/engine.js` (ca. linje 1155, kopien af retten i planens `days`), efter `total_minutes: c.recipe.total_minutes,`:

```js
          active_minutes: c.recipe.active_minutes,
```

I `public/sw.js`: tilføj `recipe_details` i `CACHEABLE_TABLES` (en åbnet opskrift kan så ses i en kælderbutik uden dækning), og sæt `VERSION` op med en linje i kommentaren:

```js
// v6: opskriftsarket (recipe_details) og ny markup i app.js.
const VERSION = 'v6';
```

- [ ] **Step 8: Kør tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 9: Commit**

```bash
git add src/sync/build.js supabase/schema.sql src/server.js public/data.js public/engine.js public/sw.js test/sync.test.js
git commit -m "Opskrifterne til browseren: recipe_details og arbejdstiden i recipe_index"
```

### Task 9: Opskriftsarket — ingen links ud

**Files:**
- Modify: `public/app.js` (`pickMeta`, `renderChoose`, `proposalCard`, `renderList`, `showProduct`, `storePicker`, nye hjælpere)
- Modify: `public/styles.css`

Ingen enhedstest (DOM); kontrolleres i browseren i Step 5.

- [ ] **Step 1: Hjælperne**

I `public/app.js`, efter `qty()`:

```js
/** 45 → "45 min", 90 → "1 t 30 min". */
function dur(m) {
  if (!(m > 0)) return '';
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h} t${mm ? ` ${mm} min` : ''}` : `${mm} min`;
}

/** Til kortet: arbejdstiden, og tiden i alt kun når den er en anden. */
function timeShort(r) {
  const a = r.active_minutes, t = r.total_minutes;
  if (a && t && t > a) return `${dur(a)} arbejde · ${dur(t)} i alt`;
  return dur(t || a);
}

const FRACTIONS = [[0.25, '¼'], [0.5, '½'], [0.75, '¾']];

/**
 * Mængden på en ingredienslinje, ganget op til husstanden. Gram rundes til
 * 5 g, skeer og stykker til nærmeste kvarte — ingen skriver "1,33 spsk".
 */
function lineAmount(q, unit, factor) {
  if (q == null) return '';
  const n = q * factor;
  if (unit === 'g' || unit === 'ml') return `${n >= 20 ? Math.round(n / 5) * 5 : Math.round(n)} ${unit}`;
  if (unit === 'kg' || unit === 'l' || unit === 'dl') {
    return `${n.toLocaleString('da-DK', { maximumFractionDigits: 2 })} ${unit}`;
  }
  const quarter = Math.max(0.25, Math.round(n * 4) / 4);
  const whole = Math.floor(quarter);
  const frac = FRACTIONS.find(([f]) => Math.abs(quarter - whole - f) < 1e-9);
  const text = `${whole || ''}${frac ? frac[1] : ''}`;
  return unit ? `${text} ${unit}` : text;
}

/** Knapper med data-recipe åbner opskriftsarket. */
function bindRecipeLinks(root) {
  root.querySelectorAll('[data-recipe]').forEach((b) => b.addEventListener('click', (e) => {
    // Knappen kan stå i en <label> (retterne i trin 4). Uden dette kunne et
    // klik i nogle browsere også sætte fluebenet.
    e.preventDefault();
    showRecipe(Number(b.dataset.recipe));
  }));
}
```

- [ ] **Step 2: `showRecipe`**

Efter `showProduct`:

```js
/**
 * Opskriften i appen: ingredienserne ganget op til husstanden, og
 * fremgangsmåden. Er en rest af en pakke lagt i netop denne ret (engine:
 * shoppingList.topups), står det ved varen.
 */
async function showRecipe(id) {
  const modal = $('#modal');
  modal.classList.add('recipe');
  $('#modal-title').textContent = 'Opskrift';
  $('#modal-body').innerHTML = '<div class="loading">Henter opskriften…</div>';
  if (!modal.open) modal.showModal();

  let r;
  try { r = await Data.recipe(id); } catch (err) { r = { error: err.message }; }
  if (r.error) {
    $('#modal-body').innerHTML = `<div class="empty"><h3>Opskriften kan ikke vises</h3><p>${esc(r.error)}</p></div>`;
    return;
  }

  const household = FLOW.settings ? FLOW.settings.servings : (r.servings || 4);
  const factor = household / (r.servings > 0 ? r.servings : 4);
  const extra = { ...((FLOW.list && FLOW.list.topups && FLOW.list.topups[id]) || {}) };
  const unitOf = (key) => FLOW.ctx && FLOW.ctx.items && FLOW.ctx.items.get(key)?.base_unit;

  const grouped = (rows) => rows.reduce((acc, row) => {
    const last = acc[acc.length - 1];
    if (!last || last.section !== (row.section || null)) acc.push({ section: row.section || null, rows: [] });
    acc[acc.length - 1].rows.push(row);
    return acc;
  }, []);

  const ingredients = grouped(r.ingredients).map((g) => `
    ${g.section ? `<h3 class="recipe-sub">${esc(g.section)}</h3>` : ''}
    <ul class="ingr">${g.rows.map((ing) => {
      // Resten står kun ved den første linje med varen.
      const more = ing.key && extra[ing.key] ? extra[ing.key] : 0;
      if (more) delete extra[ing.key];
      return `<li><span class="ingr-amt">${esc(lineAmount(ing.qty, ing.unit, factor))}</span>
        <span>${esc(ing.label)}${ing.optional ? ' <span class="note">(valgfri)</span>' : ''}
        ${more ? `<small class="topup">+ ${esc(qty(more, unitOf(ing.key)))} — så pakken bliver brugt op</small>` : ''}</span></li>`;
    }).join('')}</ul>`).join('');

  const steps = grouped(r.steps).map((g) => `
    ${g.section ? `<h3 class="recipe-sub">${esc(g.section)}</h3>` : ''}
    <ol class="steps">${g.rows.map((s) => `<li>${esc(s.text)}</li>`).join('')}</ol>`).join('');

  const meta = [
    r.active_minutes ? `Arbejdstid ${dur(r.active_minutes)}` : '',
    r.total_minutes ? `I alt ${dur(r.total_minutes)}` : '',
    `${household} ${household === 1 ? 'person' : 'personer'}`,
  ].filter(Boolean).join(' · ');

  $('#modal-title').textContent = r.title;
  $('#modal-body').innerHTML = `
    ${r.image ? `<figure class="recipe-fig">
      <img class="recipe-img" src="${esc(thumb(r.image, 1200))}" alt="">
      ${r.source_name ? `<figcaption>Foto: ${esc(r.source_name)}</figcaption>` : ''}
    </figure>` : ''}
    ${r.intro ? `<p class="recipe-intro">${esc(r.intro)}</p>` : ''}
    <p class="recipe-meta">${esc(meta)}</p>
    <div class="recipe-cols">
      <section><h2>Ingredienser</h2>${ingredients}</section>
      <section><h2>Sådan gør du</h2>${steps}</section>
    </div>`;
}
```

Brugerens valg 2026-09-30: opskriften krediteres ikke — fotoet gør. Fotoet hentes fra kildens server, så "Foto: <kilde>" står lige under det.

Samme dialog bruges af vare-arket og butiksvælgeren. Tilføj `$('#modal').classList.remove('recipe');` som første linje i `showProduct` og `storePicker`.

- [ ] **Step 3: Linkene bliver knapper**

I `pickMeta` erstat tidslinjen og linket:

```js
  const t = timeShort(r);
  if (t) parts.push(t);
  // Opskriften åbnes i appen. Knappen står i kortets <label>; et klik på
  // interaktivt indhold i en label sætter ikke fluebenet, så man kan læse
  // opskriften uden at vælge retten.
  parts.push(`<button type="button" class="pick-link" data-recipe="${r.id}">Se opskrift</button>`);
  // Kildens navn står kun som kreditering af fotoet (brugerens valg
  // 2026-09-30): billedet er deres, opskriften er vores udgave.
  if (r.image && r.source_name) parts.push(`<span class="pick-credit">Foto: ${esc(r.source_name)}</span>`);
```

(slet de gamle linjer `if (r.total_minutes) parts.push(...)`, `if (r.source_name) ...` og `if (r.url) parts.push(... target="_blank" ...)`.)

I `proposalCard`: `<li>${esc(r.title)}</li>` → `<li><button type="button" class="link" data-recipe="${r.id}">${esc(r.title)}</button></li>`.

I `renderChoose`, efter `bindGotoStores(el);`: `bindRecipeLinks(el);`.

I `renderList`, erstat "Ugens retter"-listen:

```js
    <ol class="week-dishes">${picks.map((r) => `<li><button type="button" class="link" data-recipe="${r.id}">${esc(r.title)}</button></li>`).join('')}</ol>
```

og tilføj `bindRecipeLinks(el);` efter `innerHTML` er sat.

Kontrollér til sidst: `grep -n "target=\"_blank\"" public/app.js` må kun give links i vare-arket, ikke til opskrifter.

- [ ] **Step 4: CSS**

I `public/styles.css`, ny sektion før `/* ── Ark og dialoger`:

```css
/* ── Opskriften ───────────────────────────────────────────────────────────── */
/* Et link, der er en knap: samme blå som resten af appens links. */
button.link, .pick-link {
  padding: 0; min-height: 0; border-radius: 0;
  background: none; box-shadow: none;
  color: var(--link); font: inherit; letter-spacing: inherit; text-align: left;
}
button.link:hover, .pick-link:hover { box-shadow: none; text-decoration: underline; text-underline-offset: 2px; }
button.link:active, .pick-link:active { scale: 1; }

dialog.recipe { max-width: 920px; }
.recipe-fig { margin: 0 0 18px; }
.recipe-img {
  display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
  border-radius: var(--r-lg); background: var(--ground);
}
.recipe-fig figcaption, .pick-credit { font-size: 11.5px; color: var(--ink-3); }
.recipe-fig figcaption { margin-top: 6px; text-align: right; }
.recipe-intro { margin: 0 0 6px; font-size: 17px; line-height: 1.45; color: var(--ink-2); }
.recipe-meta { margin: 0 0 20px; font-size: 13px; font-weight: 500; color: var(--ink-3); }
.recipe-cols { display: grid; gap: 8px 36px; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
.recipe-cols h2 { margin: 6px 0 12px; }
.recipe-sub { margin: 16px 0 6px; font-size: 14px; color: var(--ink-3); }
.ingr { list-style: none; margin: 0; padding: 0; }
.ingr li {
  display: grid; grid-template-columns: 5.5em 1fr; gap: 12px;
  padding: 8px 0; border-top: 1px solid var(--rule-faint); font-size: 14.5px;
}
.ingr-amt { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.topup { display: block; margin-top: 2px; font-size: 12px; color: var(--link); }
.steps { margin: 0; padding-left: 22px; }
.steps li { padding: 0 0 12px 4px; font-size: 15px; line-height: 1.55; }
.steps li::marker { font-weight: 600; color: var(--ink-3); }
```

og i `@media (max-width: 720px)`-blokken:

```css
  .recipe-cols { grid-template-columns: 1fr; }
```

- [ ] **Step 5: Kontrollér i browseren**

```bash
npm start
```
Åbn `http://localhost:3000/#/plan`, vælg en butik og et forslag. Tryk "Se opskrift" på en ret med dansk udgave: arket viser titel, arbejdstid/i alt, ingredienser ganget op til husstanden og trin — og fluebenet på retten er IKKE sat af klikket. Fotoet står med "Foto: <kilde>" i arket og på kortet, og ingen steder står der, hvor opskriften kommer fra. Tryk på en ret uden udgave: "Opskriften findes ikke på dansk endnu." Tryk på en ret under "Ugens retter": samme ark. Mobilbredde (390 px): én kolonne, arket som bundark.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "Opskriften i appen: ingredienser og fremgangsmåde, ingen links ud"
```

---

## Fase 5 — resten bruges

### Task 10: En lille rest lægges i retten — i motoren

**Files:**
- Modify: `public/engine.js` (`choosePack` ca. linje 741, dens tre kaldere ca. 1923/2098/2319, `shoppingList` ca. 2405–2530, eksporten)
- Test: `test/waste.test.js`

Prototypen (kørt og rullet tilbage under planlægningen) flyttede præcis fire tests; tallene nedenfor er dem, den målte.

- [ ] **Step 1: Skriv de nye tests**

Sidst i `test/waste.test.js`:

```js
test('en lille rest af en frisk vare lægges i den største ret', () => {
  // 0,4 + 0,5 kg kyllingebryst = 0,9 kg; bakken er 1 kg. De 0,1 kg ville være
  // spild. Den største ret må få op til en fjerdedel af sine 0,5 kg, altså
  // 0,125 kg — nok til hele resten. Intet går til spilde.
  const plan = { days: [
    { recipe: recipe(70, 0.8, [line('kyllingebryst', 0.4)]) },
    { recipe: recipe(71, 0.8, [line('kyllingebryst', 0.5)]) },
  ] };
  const list = engine.shoppingList(plan, CTX);
  const kb = list.buy.find((b) => b.key === 'kyllingebryst');
  near(kb.leftover, 0);
  assert.deepEqual(kb.topup, [{ recipe_id: 71, title: 'Ret 71', qty: 0.1 }]);
  assert.deepEqual(list.topups, { 71: { kyllingebryst: 0.1 } });
  near(list.waste_kr, 0);
});

test('en rest, der er større end én rets fjerdedel, deles', () => {
  // 0,4 + 0,4 kg: 0,2 kg til overs, og hver ret kan tage 0,1 kg.
  const plan = { days: [
    { recipe: recipe(74, 0.8, [line('kyllingebryst', 0.4)]) },
    { recipe: recipe(75, 0.8, [line('kyllingebryst', 0.4)]) },
  ] };
  const kb = engine.shoppingList(plan, CTX).buy.find((b) => b.key === 'kyllingebryst');
  assert.deepEqual(kb.topup.map((t) => [t.recipe_id, t.qty]), [[74, 0.1], [75, 0.1]]);
  near(kb.leftover, 0);
});

test('mere end en fjerdedel bliver en rest, ikke en større portion', () => {
  // 0,4 kg laks af en 1 kg-pakke: højst 0,1 kg kan lægges i, 0,5 kg er spild.
  const plan = { days: [{ recipe: recipe(72, 0.8, [line('laks', 0.4)]) }] };
  const list = engine.shoppingList(plan, CTX);
  const laks = list.buy.find((b) => b.key === 'laks');
  near(laks.leftover, 0.5);
  assert.deepEqual(laks.topup, [{ recipe_id: 72, title: 'Ret 72', qty: 0.1 }]);
  near(list.waste_kr, 60);
});

test('kun friske varer, der vejes eller måles, fyldes op', () => {
  // Kartofler holder (keeps), æg tælles i stykker. Ingen af dem bliver
  // "lidt mere" i retten.
  const plan = { days: [{ recipe: recipe(73, 0.8, [line('kartofler', 0.6), line('aeg', 2)]) }] };
  const list = engine.shoppingList(plan, CTX);
  for (const b of list.buy) assert.deepEqual(b.topup, [], `${b.key} skal ikke fyldes op`);
  assert.deepEqual(list.topups, {});
});
```

- [ ] **Step 2: Kør og se dem fejle**

Run: `node -r ./test/helpers/set-test-db.js --test test/waste.test.js 2>&1 | grep -E "^✖|ℹ fail"`
Expected: de fire nye tests fejler (`topup` er `undefined`)

- [ ] **Step 3: Reglen og `choosePack`**

I `public/engine.js`, lige før `function choosePack`:

```js
  // Højst så meget mere af en vare kan lægges i en ret, for at en pakke bliver
  // brugt op: en fjerdedel af det, retten selv skal bruge. 25 g kyllingebryst
  // i en ret med 400 g mærkes ikke; en halv pakke fløde gør. Kun friske varer
  // (keeps: perishable) og kun det, der vejes eller måles — et ekstra æg eller
  // en halv citron er ikke "lidt mere".
  const TOPUP_MAX_SHARE = 0.25;

  /** Hvor meget af resten der kan lægges i retterne i stedet for at gå til spilde. */
  function absorbable(need, leftover, keeps, baseUnit) {
    if (keeps !== 'perishable' || (baseUnit !== 'kg' && baseUnit !== 'l')) return 0;
    return Math.min(leftover, need * TOPUP_MAX_SHARE);
  }
```

Ret `choosePack`:

```js
  function choosePack(need, packs, { keeps = 'keeps', base_unit = null } = {}) {
```

og i løkken erstat

```js
      const leftover = Math.max(0, bought - need);
      const waste = leftover * w;
```

med

```js
      const leftover = Math.max(0, bought - need);
      // Den del af resten, retterne kan tage, er ikke spild. Reglen står HER,
      // så pakkevalget, ugens spildscore og listens waste_kr regner ens —
      // test/waste.test.js holder ugen og listen op mod hinanden.
      const absorbed = absorbable(need, leftover, keeps, base_unit);
      const waste = (leftover - absorbed) * w;
```

og `bought, leftover, waste, cost };` → `bought, leftover, absorbed, waste, cost };`.

I de tre kaldere, send enheden med:

```js
choosePack(n, price.packs || [price], { keeps: meta.keeps, base_unit: meta.base_unit })
choosePack(own, pick.price.packs || [pick.price], { keeps: meta.keeps, base_unit: meta.base_unit })
choosePack(need, price.packs || [price], { keeps: meta ? meta.keeps : 'keeps', base_unit: meta ? meta.base_unit : null })
```

- [ ] **Step 4: Fordelingen i `shoppingList`**

Ved `const usedIn = new Map();`:

```js
    // Hvor meget hver ret selv bruger af hver vare. Resten af en pakke
    // fordeles efter det (se topup nedenfor).
    const perRecipe = new Map();
```

Efter `basket.set(it.key, (basket.get(it.key) || 0) + need);`:

```js
        if (!perRecipe.has(it.key)) perRecipe.set(it.key, new Map());
        const mine = perRecipe.get(it.key);
        const own = mine.get(rec.id) || { id: rec.id, title: rec.title, need: 0 };
        own.need += need;
        mine.set(rec.id, own);
```

Før `const buy = [];`: `const topups = {};`. I løkken over `basket`, før `buy.push(...)`:

```js
      // choosePack har regnet, hvor meget af resten retterne kan tage. Her
      // fordeles det: største ret først, og ingen ret mere end sin egen
      // fjerdedel. Ved samme mængde afgør titlen, så to kørsler er ens.
      const topup = [];
      let rest = pick ? pick.absorbed : 0;
      if (rest > 0) {
        const eaters = [...(perRecipe.get(key) || new Map()).values()]
          .sort((a, b) => b.need - a.need || String(a.title).localeCompare(String(b.title), 'da'));
        for (const e of eaters) {
          if (!(rest > 1e-9)) break;
          const give = Math.min(rest, e.need * TOPUP_MAX_SHARE);
          if (!(give > 0)) continue;
          topup.push({ recipe_id: e.id, title: e.title, qty: roundQty(give) });
          if (!topups[e.id]) topups[e.id] = {};
          topups[e.id][key] = roundQty(give);
          rest -= give;
        }
      }
```

I `buy.push({...})`: `leftover: pick ? roundQty(pick.leftover) : null,` → `leftover: pick ? roundQty(pick.leftover - pick.absorbed) : null,` og tilføj `topup,` efter `used_in`. I det returnerede objekt tilføj:

```js
      // `recipe_id → vare → mængde i varens enhed`: det, opskriftsarket
      // lægger oven i retten.
      topups,
```

Tilføj `TOPUP_MAX_SHARE` i eksporten (ved `WASTE_WEIGHT, WASTE_AVERSION`).

- [ ] **Step 5: Ret de fire forventninger, der flytter sig**

I `test/waste.test.js`:

1. `score er et internt tal og slipper ikke ud`: tilføj `'absorbed'` i listen (alfabetisk: `['absorbed', 'bought', 'cost', 'leftover', 'pack_price', 'pack_qty', 'packs', 'waste']`).
2. `opskrifterne skaleres til husstanden`: `near(uge(2).waste, 20);` → `near(uge(2).waste, 15);` med kommentaren: `// … og den halve pose tæller som spild — minus den fjerdedel af 0,5 kg, retten selv kan tage: 0,375 kg × 80 kr × 0,5`.
3. `spildet står i kroner og er vægtet efter holdbarhed`: `72` → `60`, og i kommentarens regnestykke: `// 60 kr: 0,6 kg laks til overs, hvoraf 0,1 kg (en fjerdedel af 0,4) lægges i retten — 0,5 × 120.`
4. `ugens spildscore er halvdelen af listens spild`: `near(list.waste_kr, 65.6);` → `near(list.waste_kr, 50.6);` med kommentaren `// 0,375 kg laks à 120 kr (0,5 til overs minus 0,125 i retten) + 0,7 kg kartofler à 8 kr (keeps, halv vægt).`

- [ ] **Step 6: Kør hele suiten**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`. `test/sync.test.js` (browseren og serveren giver samme lister) skal bestå uændret — begge kører samme motor.

- [ ] **Step 7: Commit**

```bash
git add public/engine.js test/waste.test.js
git commit -m "En lille rest af en frisk vare lægges i en ret i stedet for at gå til spilde"
```

### Task 11: Resten i appen

**Files:**
- Modify: `public/app.js` (`buyLine`, listens fodnote)

`showRecipe` (opgave 9) viser allerede `+ 25 g — så pakken bliver brugt op` ud fra `FLOW.list.topups`.

- [ ] **Step 1: Indkøbslinjen siger, hvor resten går hen**

I `buyLine`:

```js
  const left = b.leftover > 0 ? ` · ${qty(b.leftover, b.unit)} til overs` : '';
  // Resten, motoren har lagt i en ret (engine: topup). Det er grunden til, at
  // "til overs" er mindre, end pakken og behovet ellers ville sige.
  const into = b.topup && b.topup.length
    ? ` · resten i ${esc(listNames(b.topup.map((t) => t.title)))}` : '';
```

og brug `${left}${into}` i `<small>`.

- [ ] **Step 2: Fodnoten**

I `renderList`, i `.list-foot`, efter sætningen om spild:

```js
      Er der en lille rest af en frisk vare, lægges den i en af retterne — højst en fjerdedel
      mere, end retten selv bruger — så den ikke går til spilde. Det står i opskriften.
```

- [ ] **Step 3: Kontrollér i browseren**

`npm start` → vælg et forslag. Find en indkøbslinje med "resten i …", åbn den ret: ingredienslinjen har `+ … — så pakken bliver brugt op`. Spildtallet i bonen er det samme som i forslagskortet.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Listen og opskriften siger, hvor resten af pakken bliver brugt"
```

---

## Fase 6 — drift og kørsel

### Task 12: Den natlige kørsel og dokumentationen

**Files:**
- Modify: `.github/workflows/update.yml` (trinnet "Sørg for varetaksonomi og materialiserede mængder")
- Modify: `DEPLOY.md`

- [ ] **Step 1: Importen i den natlige kørsel**

```yaml
      - name: Sørg for varetaksonomi og materialiserede mængder
        run: |
          npm run seed:items
          npm run recompute
          npm run recipes:import
          npm run backfill:amounts
          npm run reclassify
```

Og en kommentarlinje over trinnet: `# recipes:import læser de danske udgaver fra data/opskrifter/ (i git) ind i basen. Den skal før backfill:amounts og reclassify, som regner på de danske linjer.`

- [ ] **Step 2: DEPLOY.md**

Ny sektion:

```markdown
## Opskrifterne på dansk

Appens opskrifter er vores egne danske udgaver i `data/opskrifter/<kilde>/<slug>.json`
(i git — ret dem i hånden, og næste kørsel læser dem ind). De skrives lokalt:

1. `npm run recipes:fetch-sources` — henter kildesiderne til `tmp/kilder/` (gitignoret;
   kildens tekst forlader aldrig maskinen).
2. `npm run recipes:rewrite -- run` — Claude Code skriver udgaverne på Claude-abonnementet
   (ingen API-nøgle; kører aldrig i CI). Stopper ved abonnementets grænse og fortsætter,
   hvor den slap, når kommandoen startes igen.
3. `npm run recipes:import -- --report tmp/omskrivning/kontrol.md` — læser dem ind og lister
   dem, der skal ses efter. En udgave godkendes i hånden med `"accepted": true` i filen.

`recipes_edition_only` (indstilling i `data.db`) holder retter uden dansk udgave ude af
madplanen. Før første synk med `recipe_details`: kør `supabase/schema.sql` i SQL-editoren.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/update.yml DEPLOY.md
git commit -m "Den natlige kørsel læser de danske opskrifter ind"
```

### Task 13: Piloten — 21 opskrifter (checkpoint med brugeren)

Kører på abonnementet; koster ingen penge, men bruger af grænsen.

- [ ] **Step 1: Den nyeste base og en kopi**

Mellem to natlige kørsler (de starter 05:10 UTC):

```bash
gh release download db --pattern data.db --clobber
cp data.db data.db.pre-dansk
npm run coverage > tmp/dækning-før.txt
```

- [ ] **Step 2: Råmaterialet til alle (ca. 30–45 min, ingen Claude)**

Run: `npm run recipes:fetch-sources`
Expected: `~2.2xx kilder gemt i tmp/kilder/ · N fejlede`. Fejl-listen gemmes; retter uden fremgangsmåde kan ikke få en dansk udgave og falder ud ved opgave 14.

- [ ] **Step 3: Vælg og kør piloten**

```bash
node -e "const db=require('better-sqlite3')('data.db',{readonly:true});const ids=['valdemarsro','arla','bbcgoodfood','greatbritishchefs'].flatMap(s=>db.prepare('select id from recipes where source=? order by random() limit 5').all(s).map(r=>r.id));console.log([...new Set([2178,...ids])].slice(0,21).join(','))"
npm run recipes:rewrite -- run --ids <listen ovenfor>
```
Expected: `20 danske udgaver skrevet · 0 fejlede · N s pr. opskrift`. Lammeculotten (2178) har allerede en udgave (`data/opskrifter/valdemarsro/lammeculotte-55da61.json`), og `run` springer en skrevet udgave over. Skal den skrives om med den samme prompt som de andre, så kør den for sig med `npm run recipes:rewrite -- run --force --ids 2178` — så er der 21.

- [ ] **Step 4: Læs dem ind og se efter**

```bash
npm run recipes:import -- --report tmp/omskrivning/kontrol.md
npm run backfill:amounts && npm run reclassify && npm run costs:recompute
npm start
```

Tjekliste — for hver af mindst ti af udgaverne (filen og arket i appen):
- Alt er på dansk; enhederne er metriske; varenavnene findes i et dansk supermarked.
- Mængderne er runde og tæt på kildens (højst ±20 %), og retten er den samme.
- Erstatningerne i `changes` er fornuftige, og hovedråvaren er den samme.
- For to af dem: læg kildens tekst (`tmp/kilder/…`) ved siden af og bekræft, at fremgangsmåden ikke er en ordret oversættelse.
- Lammeculotten: `lam` på linjen, arbejdstid og tid i alt som på Valdemarsros side.
- Ingen gramtal i trinene. Fotoet står med "Foto: Valdemarsro"; opskriften krediteres ikke.

- [ ] **Step 5: Hvor lang tid resten tager**

`s pr. opskrift` × 2.224 er kørselstiden uden afbrydelser; grænsen på abonnementet deler den op. **Stop her og vis brugeren:** tjeklisten, eftersynslisten fra `kontrol.md`, tiden pr. opskrift og hvor mange piloten nåede, før grænsen evt. slog til. Fortsæt først til opgave 14 på brugerens ja. Skal prompten rettes, så ret `INSTRUCTIONS` i `rewrite.js` og kør piloten igen med `run --force --ids …`. Er Sonnets udgaver for svage, så prøv fem med `--model opus`.

### Task 14: Hele kørslen

- [ ] **Step 1: Resten skrives**

```bash
npm run recipes:rewrite -- run --parallel 2
```
Rammes grænsen, står der "Abonnementets grænse er nået". Start samme kommando igen, når den er nulstillet — den springer over, hvad der allerede er skrevet. Gentag, til den siger `Intet at omskrive.` Kør de fejlede igen med `run --force --ids …`-linjen, den skriver.

Undervejs kan de færdige udgaver læses ind og ses efter i klumper (Step 2) — det kræver ikke, at alle er skrevet.

- [ ] **Step 2: Læs ind og se efter**

```bash
gh release download db --pattern data.db --clobber   # nattens base — ikke den fra i går
cp data.db data.db.pre-dansk
npm run seed:items
npm run recipes:import -- --report tmp/omskrivning/kontrol.md
npm run backfill:amounts && npm run reclassify && npm run costs:recompute
```
Gå `kontrol.md` igennem: ret filen i hånden, sæt `"accepted": true`, eller kør retten igen med `one`. Gentag `recipes:import`, til listen kun indeholder det, der bevidst skal holdes ude.

- [ ] **Step 3: Mål, hvad det har gjort**

```bash
npm run coverage > tmp/dækning-efter.txt
diff tmp/dækning-før.txt tmp/dækning-efter.txt
node -e "const db=require('better-sqlite3')('data.db',{readonly:true});console.log(db.prepare('select count(*) n, sum(edition is not null) dansk, sum(total_minutes>60) over_en_time from recipes').get())"
```
Skriv tallene i commit-beskeden: hvor mange retter har dansk udgave, hvor mange er nu over en time (og dermed ude af madplanen), og hvordan dækningen pr. kæde har ændret sig. Falder et spor under `3 × 7` retter i en kæde, så sig det til brugeren, før indstillingen sættes.

- [ ] **Step 4: Kun danske udgaver i madplanen**

```bash
node -e "require('./src/db').setSetting('recipes_edition_only', true)"
npm test
```
Expected: `ℹ fail 0`

- [ ] **Step 5: Supabase og release**

Rækkefølgen er ikke valgfri — se også DEPLOY.md, "Rækkefølgen, når grenen skal i drift".

1. Kør `supabase/schema.sql` i Supabase' SQL-editor (ny tabel, ny kolonne, politikken) — **før grenen når `main`**. Den natlige kørsel sletter fra `recipe_details` som det første og får 404 uden tabellen; den gamle `main` er ligeglad med den nye tabel, så det er sikkert at gøre det først.
2. Hent nattens base igen og læs udgaverne ind på den **lige før** upload. Basen fra trin 2 er mindst en nat gammel nu, og `gh release upload --clobber` ville overskrive det, en natlig kørsel har lagt i release-assetet i mellemtiden. Kør det i ét stræk og ikke omkring 05:10 UTC:

```bash
gh release download db --pattern data.db --clobber
npm run seed:items
npm run recipes:import -- --report tmp/omskrivning/kontrol.md   # samme liste som i trin 2
npm run backfill:amounts && npm run reclassify && npm run costs:recompute
node -e "require('./src/db').setSetting('recipes_edition_only', true)"
npm run sync:dry        # recipe_details ≈ antal danske udgaver
npm run sync
gh release upload db data.db --clobber
```

- [ ] **Step 6: Commit udgaverne**

```bash
git add data/opskrifter
git commit -m "2.2xx opskrifter på dansk — appens egne udgaver (se tallene i beskeden)"
```

- [ ] **Step 7: Flet og start kørslen — lige efter trin 5 og 6**

Flet grenen til `main` nu, hverken før eller senere. Før: en frontend uden links, men med en tom `recipe_details`, viser "findes ikke på dansk endnu" ved hver ret. Senere: nattens kørsel på den gamle `main` kender ikke `recipes_edition_only` og lægger retter uden dansk udgave tilbage i madplanen. Start så workflowet i hånden, før næste kørsel kl. 05:10 UTC:

```bash
gh workflow run update.yml
```

Åbn den udrullede app, når kørslen er færdig: vælg et forslag, åbn tre opskrifter (én fra hver sprogkilde), og bekræft, at ingen ret linker ud, og at fotoerne står med "Foto: …".

---

## Selvtjek mod opgaven

| Brugerens ønske | Opgave |
|---|---|
| Database med opskrifter i stedet for links | 3 (basen), 5–7 (udgaverne i `data/opskrifter/` + import), 8 (`recipe_details`), 9 (ingen links) |
| Justere mængder, så en rest på 25 g kyllingebryst bruges | 10 (motoren), 11 (listen), 9 (arket viser `+ 25 g`) |
| Danskervenlige råvarer, så lidt om som muligt, ikke kildens mængder | 6 (prompten: erstatninger, varekataloget, runde mængder ±20 %), 7 (kontrol af hovedråvaren og dens mængde) |
| Ingen kreditering af opskriften, men af billederne | 9 ("Foto: …" på kort og ark; ingen kildeangivelse ved retten) |
| Ingen udgift — abonnementet | 6 (`claude -p`), 13–14 |
| Alt oversat til dansk | 6, 14 (`recipes_edition_only` holder resten ude) |
| Lammeculotte ≠ bøf/steak | 1 (taksonomien), 7 (dyr-kontrollen fanger det næste tilfælde) |
| Arbejdstid og tid i alt hver for sig | 2 (udtrækket), 3/8 (basen og payloaden), 9 (kortet og arket) |
