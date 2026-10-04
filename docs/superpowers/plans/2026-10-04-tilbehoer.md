# Hele måltider: tilbehør til retter, der mangler det — implementeringsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Madplanen foreslår kun hele måltider. En aftensret, der kun er en hovedret (stegt tunsteak, ovnbagt laks, frikadeller uden kartofler), får et klassisk tilbehør med mængder, der står i opskriften, kommer på indkøbslisten og er med i prisen.

**Architecture:** Et nyt CLI `src/recipes/sides.js` spørger Claude Code (headless, brugerens abonnement — samme vej som `rewrite.js`) om hver aftensret med dansk udgave: er den et helt måltid, og hvis ikke, hvilket tilbehør. Svaret gemmes i udgavens JSON-fil som `meal` (`{ complete, side }`). `import-da.js` lægger tilbehørets linjer og trin ind som et afsnit `Tilbehør: <titel>`. Motoren og brugerfladen ændres ikke: de prissætter og viser allerede afsnit.

**Tech Stack:** Node ≥ 20 (CommonJS), better-sqlite3, Claude Code-CLI'en (`claude -p --json-schema`).

## Brugerens beslutning (2026-10-04)

Retter, der kun er en del af et måltid, skal have tilbehør — ikke fjernes. Målt: af 996 aftensretter har ca. 150–180 hverken mættende tilbehør eller en reel mængde grønt; en ren tælleregel rammer forkert (tærter, ravioli, speltotto, pirogger tælles ikke som tilbehør), så vurderingen gøres af Claude.

## Global Constraints

- Node ≥ 20, CommonJS, `'use strict';`. Kommentarer på dansk, der forklarer **hvorfor**. Ingen nye npm-afhængigheder.
- Claude-kald kun lokalt via CLI'en på abonnementet — aldrig i CI, ingen API-nøgle. Lange kørsler startes som selvstændig proces (`Start-Process` på en .cmd i et synligt vindue), ikke som værktøjets baggrundskommando.
- Tests mod `test.db`, aldrig `data.db`. Kopi før kørsler mod `data.db`.
- `data/opskrifter/` er appens egne data (i git); kildernes tekst (`tmp/kilder/`) forlader aldrig maskinen og bruges ikke her.
- Tilbehøret følger de samme regler som udgaven: kun enhederne i `edition.js`' `UNITS`, varenavne som i et dansk supermarked, mængder til rettens eget portionsantal.
- Commit efter hver opgave.

---

### Task 1: Ét kald-modul og vurderingen af måltidet

**Files:**
- Modify: `src/recipes/rewrite.js` (træk det generiske CLI-kald og køen ud, så de kan genbruges)
- Create: `src/recipes/sides.js`
- Modify: `src/recipes/edition.js` (skemaet for svaret)
- Modify: `package.json` (script `recipes:sides`)
- Test: `test/recipes.test.js`

Krav:
1. Refaktorér `rewrite.js`, så det generiske ligger i eksporterede funktioner, der genbruges af `sides.js` uden kopier: et kald `askClaude({ system, schema, input, model })` → `{ output, model }` eller `{ error, limit }` (det nuværende `ask` bliver en tynd indpakning), og køen med `--parallel`, stop ved abonnementets grænse og stop efter fem fejl i træk (det nuværende `run`/`drain`). `rewrite.js`' adfærd og eksisterende tests må ikke ændre sig.
2. `edition.js`: `MEAL_SCHEMA` = `{ complete: boolean, reason: string, side: null | { title: string, ingredients: [samme ingrediens-skema som RECIPE_SCHEMA's], steps: [string] } }` (anyOf-null som resten af skemaet, `additionalProperties: false`).
3. `sides.js` CLI: `npm run recipes:sides -- run [--limit N] [--ids 1,2] [--force] [--parallel N] [--model M]` og `one <id>`.
   - Hvilke retter: dem `loadRecipes({})` returnerer, som har en dansk udgave, og som `engine.isDinner(r, items)` kalder aftensmad (items fra `items`-tabellen). Fra opskriftens `url`/`source` findes udgavens fil via `editionPath`. En udgave, der allerede har `meal`, springes over (medmindre `--force`).
   - Prompt (dansk, fast, så den kan genbruges fra cachen): Er retten et helt aftensmåltid for en dansk husstand? Et helt måltid har en hovedråvare og noget mættende (kartofler, ris, pasta, brød, korn, dej, bønner) eller rigeligt grønt; supper, gryderetter, pastaretter, tærter, pizza, wraps, salater med protein og stivelse eller rigeligt grønt er hele måltider. Hvis ikke: foreslå ÉT enkelt, klassisk tilbehør, der passer til retten og køkkenet (fx kogte kartofler, ris, brød, grøn salat — eller to af dem, når det er det naturlige, fx kartofler og salat), til rettens eget antal portioner; højst 4 ingredienser og højst 3 korte trin i bydeform; kun de tilladte enheder; ingen salt/peber/olie-linjer, medmindre tilbehøret kræver dem; ingen mængder i trinene. `reason` er én kort sætning.
   - Input: titel, portioner, ingredienslinjer (mængde, enhed, navn) og trinene fra udgavens fil — ikke kildens tekst.
   - Standardmodel `haiku` (en enkel vurdering; sparer abonnementets grænse) — `--model sonnet` kan vælges.
   - Svaret skrives i udgavens fil som `meal: { complete, reason, side, model, checked_at }` med samme formatering som `rewrite.js` (`JSON.stringify(..., null, 2) + '\n'`); intet andet i filen ændres.
4. Tests (rene funktioner, ingen CLI-kald): udvælgelsen af retter (en udgave med `meal` springes over uden `--force`), skrivningen af `meal` ind i en udgave (de øvrige felter uændrede), og at `MEAL_SCHEMA` kun tillader `UNITS`.

### Task 2: Importen lægger tilbehøret ind

**Files:**
- Modify: `src/recipes/import-da.js`
- Test: `test/recipes.test.js`

Krav:
1. Når `ed.meal && ed.meal.side` findes: tilbehørets ingredienser bliver ekstra linjer efter rettens egne, med `section` = `Tilbehør: <side.title>` (bygget med samme `lineOf`/`labelOf`/`parseIngredient` som rettens linjer), og tilbehørets trin bliver ekstra trin med `section` = `Tilbehør`. `meal.complete === true` eller `side === null` lægger intet til.
2. `problems()` vurderer rettens egne linjer som i dag (linjetal mod `source_lines`, hovedråvare, ukendte linjer osv.) — tilbehørets linjer tæller ikke med dér. Tilbehøret får sin egen lille kontrol: enheder i `UNITS`, mængder > 0, 1–4 linjer, mindst ét trin; fejler den, holdes hele udgaven tilbage med en tydelig besked (`tilbehør: …`).
3. Idempotens som i dag (filens hash) — en udgave, der får `meal` tilføjet, læses ind igen.
4. Tests: en udgave med tilbehør får linjer med afsnittet `Tilbehør: Kogte kartofler` og et `Tilbehør`-trin i basen; en udgave med `complete: true` får ingen ekstra linjer; tilbehørets linjer udløser ikke "ingredienslinjer"-kontrollen; et tilbehør med en ukendt enhed holdes tilbage.

### Task 3: Kørslen (drift, med stop hos brugeren)

- [ ] `npm run recipes:sides -- run --ids <5 retter, bl.a. 752 Stegt tunsteak, 690 Ovnbagt laks, 280 Frikadeller, 1094 og en tærte>` og læs svarene: er vurderingen rigtig, og er tilbehøret fornuftigt?
- [ ] Hele kørslen som selvstændig proces (`tmp/omskrivning/tilbehoer.cmd`, synligt vindue, `--parallel 2`).
- [ ] `cp data.db data.db.pre-tilbehoer`, `npm run recipes:import -- --report tmp/omskrivning/kontrol.md`, `npm run backfill:amounts && npm run reclassify && npm run costs:recompute`. Mål: hvor mange retter fik tilbehør, eksempler, og om noget blev holdt tilbage pga. tilbehøret.
- [ ] Commit `data/opskrifter/` med tallene. Push kun efter brugerens ja.
