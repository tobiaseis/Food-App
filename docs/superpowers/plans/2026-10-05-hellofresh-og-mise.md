# HelloFresh-retter, lækkert tilbehør og tre Mise-inspirerede funktioner — implementeringsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Flere og bedre hele måltider (500 HelloFresh-retter som første hold), rigtigt tilbehør i stedet for "kogte kartofler og hovedsalat", og tre funktioner inspireret af Mise: "brug det, jeg har", swipe i trin 4 og madlavningstilstand.

**Architecture:** HelloFresh bliver en femte kilde i den eksisterende pipeline (crawl → fetch-sources → rewrite → sides → import). Udgaverne gøres selvbærende (billede m.m. i JSON'en), og importen opretter selv en ret, der mangler i basen — ellers kan den natlige kørsel ikke læse nye kilders udgaver ind i release-basen. Tilbehøret skrives om med en skarpere prompt. De tre funktioner bygges i motoren (`public/engine.js`) og brugerfladen (`public/app.js`, `public/styles.css`).

**Tech Stack:** Node ≥ 20 (CommonJS), better-sqlite3, Claude Code-CLI'en på abonnementet, vanilla JS.

## Brugerens beslutninger (2026-10-05)

- **Mise:** inspiration til funktioner, men deres opskrifter hentes ikke (de ligger i appen, ikke på offentlige sider, og er en konkurrents produkt).
- **HelloFresh:** 4.919 forskellige retter på hellofresh.dk; robots.txt tillader `/recipes/`, vilkårene forbyder ikke automatisk hentning. **Første hold: de 500 nyeste forskellige retter.** Samme behandling som de øvrige kilder: fakta, fremgangsmåde med egne ord, mængder rundet, "Foto: HelloFresh", ingen kreditering af opskriften.
- **Tilbehør:** "Kogte kartofler og hovedsalat er ikke tilbehør. Det skal være ordentlige og lækre måltider." Tilbehøret skal passe til retten og være lækkert.
- **Funktioner:** "Brug det, jeg har", swipe retter, madlavningstilstand. (Kostfiltre er fravalgt.)

## Global Constraints

- Node ≥ 20, CommonJS, `'use strict';`. Kommentarer på dansk, der forklarer **hvorfor**. Ingen nye npm-afhængigheder.
- `public/engine.js` rører aldrig databasen og kører i både Node og browser; browser og server skal give samme pulje, forslag og lister (`test/sync.test.js`).
- Nye felter i browserens payload huskes alle steder (loadRecipes, build.js, supabase/schema.sql, public/data.js) med en test på kanten.
- Claude-kald kun lokalt via CLI'en på abonnementet, aldrig i CI. Lange kørsler som selvstændig proces (`Start-Process` på en .cmd i et synligt vindue). Under ventetid: korte statuslinjer.
- Crawleren er høflig: ≈1 kald/sek pr. kilde, kun stier robots.txt tillader. Kildens tekst forlader aldrig maskinen (`tmp/kilder/`).
- Tests mod `test.db`, aldrig `data.db`; kopi før kørsler mod `data.db`. Alle tekster i brugerfladen på dansk. Designsystemet: lyst, Apple-agtigt, tokens i `public/styles.css`.
- Commit efter hver opgave; intet pushes uden brugerens ja.

---

### Task 1: Lækkert tilbehør (prompt v2 + omkørsel)

**Files:** `src/recipes/sides.js`, `src/recipes/import-da.js` (kontrol), `test/recipes.test.js`.

1. Ny prompt for tilbehøret: det skal være et rigtigt tilbehør, der passer til rettens køkken og smag — det, en god kogebog eller et måltidskassefirma ville servere til retten (fx sprøde ovnkartofler med rosmarin, agurkesalat med dild, sesamnudler, ristet brød med hvidløgssmør, couscoussalat med citron, coleslaw, ovnbagte rodfrugter, kartoffelmos med brunet smør). FORBUDT: ren kogte kartofler, ren kogt ris uden noget, og en bar salat af ét blad ("hovedsalat", "grøn salat" alene). Op til 6 ingredienser og 4 trin; stadig ingen bælgfrugter eller æg (motoren kan gøre dem til hovedråvare). Behold eksemplet i prompten, men skift det til et lækkert (fx "Sprøde rosmarinkartofler og agurkesalat").
2. Standardmodel for tilbehøret: `sonnet` (kvalitet; `--model haiku` kan stadig vælges).
3. `cleanSide` må ikke længere fjerne olie/smør, når tilbehøret ikke er "kogte kartofler" — tilbehør som sprøde ovnkartofler kræver olie. Ret reglen, så kun salt og peber fjernes, og olie/smør beholdes (de er essentials og havner alligevel på "tjek at du har"). Opdatér testen.
4. `sideProblems`: hold et tilbehør tilbage, hvis det kun består af kartofler/ris/salat-varer uden andet (fx titel matcher /^(kogte? (kartofler|ris)|grøn salat|hovedsalat)$/i eller alle linjer er kartofler/ris/salat uden krydderi/dressing) — besked "tilbehør: for kedeligt". Test det.
5. Kør (drift): `npm run recipes:sides -- run --force --ids <alle med side i dag>` som selvstændig proces; læs et udvalg (10) efter; `cp data.db data.db.pre-tilbehoer2`; import + backfill + reclassify + costs; commit udgaverne med tal.

### Task 2: Selvbærende udgaver — importen opretter manglende retter

**Files:** `src/recipes/rewrite.js` (`editionRecord`), `src/recipes/import-da.js`, `scripts/backfill-edition-meta.js` (ny), `test/recipes.test.js`.

Problem: den natlige kørsel importerer udgaverne i release-basen, og en ny kildes retter (HelloFresh) findes ikke dér — importen tæller dem som "uden ret i basen" og springer dem over.
1. Udgaven får de felter, der skal til for at oprette retten: `image`, `lang` ('da'), `keywords` (kildens, hvis nogen), `fetched_at`. `rewrite.js` skriver dem fremover (fra kilde-recorden i `tmp/kilder/` — udvid `fetch-sources.js`' record med `image` og `keywords` fra `extractRecipe`). Et engangsscript `scripts/backfill-edition-meta.js` lægger dem ind i alle eksisterende udgaver fra `data.db` (samme formatering, kun manglende felter).
2. `importAll`: når udgavens `url` ikke findes i basen, opret retten (`INSERT INTO recipes (url, source, source_name, title, lang, servings, yield_count, total_minutes, active_minutes, image, keywords, fetched_at) …`) og læs udgaven ind som ellers. "Før"-linjerne er da tomme: kontrollerne, der sammenligner med "før" (hovedråvare, ukendte linjer), sammenligner i stedet med intet — en ny ret uden kendt hovedråvare skal holdes tilbage ("ingen kendt hovedråvare"), og linjetallet måles mod `source_lines`. Nye kategorier i stats: `created`. Tests: en udgave med ukendt url oprettes og læses ind; en uden kendt hovedråvare holdes tilbage.
3. `reclassify` kører efter importen i CI og regner servings/tier/næring for de nye retter — bekræft med en test eller en lokal kørsel, at en oprettet ret får tier og scorer.

### Task 3: HelloFresh som kilde (500 nyeste)

**Files:** `src/recipes/sources.js`, evt. `src/recipes/extract.js`, `test/recipes.test.js`.

1. Ny kilde `hellofresh` (navn "HelloFresh", lang 'da', delayMs 1000): opdagelse via `https://www.hellofresh.dk/sitemap_recipe_pages.xml`; URL'er `/recipes/<slug>-<24 hex id>`. Dedup på slug uden id (samme ret i flere uger) og vælg den nyeste udgave (de første 8 hex i id'et er et Unix-tidsstempel); sortér nyeste først, så `--limit 500` giver de 500 nyeste forskellige retter. Respektér robots.txt (`/recipes/search/?q*` og `?page=`-varianter må ikke hentes).
2. Udtrækket virker allerede på siderne (JSON-LD: titel, portioner, tider, ingredienser, trin, billede — prøvet på "Kyllingewok med jasminris, kokosmælk & broccoli"). Tjek mængdeformater som "efter behov Sukker", "3.5 dl Vand", "1 pose Koriander" og ingredienser med stort begyndelsesbogstav — tilføj en test for `parseIngredient` på 5 typiske HelloFresh-linjer (item_key og mængde).
3. Drift: `npm run recipes -- hellofresh --limit 500` (crawl, ~10 min), `npm run recipes:fetch-sources -- --source hellofresh`, `npm run recipes:rewrite -- run --source hellofresh --parallel 2` (selvstændig proces), `npm run recipes:sides -- run` for de nye aftensretter, import + backfill + reclassify + costs. Mål: hvor mange læst ind, holdt tilbage (pr. type), hvor mange er aftensmad, tilbehør, og puljerne pr. spor. Commit udgaverne.

### Task 4: "Brug det, jeg har"

**Files:** `public/engine.js`, `public/data.js`, `public/app.js`, `public/styles.css`, `test/waste.test.js` / `test/sync.test.js`.

1. Brugerflade i trin 3 (under aftener og personer): "Har du noget, der skal bruges?" — et søgefelt over varekataloget (`ctx.items`: navne; søg også på synonymer, hvis de findes i payloaden, ellers kun navn) med forslag som chips; valgte varer vises som chips med ×; huskes pr. browser (localStorage, som FLOW). Kun varer, der købes (ikke essentials).
2. Motor: (a) rangering — `candidatePool`/`twoProposals` får `have: Set(keys)`; en ret, der bruger en "har"-vare, får et tillæg i rangeringen (fx +0,15 pr. vare, højst +0,3) — som en eksporteret, testet funktion, data.js bruger; (b) `sharedWeek`/`shoppingList`: "har"-varer købes ikke — de står på "Tjek at du har" med markeringen "har du", og de indgår ikke i ugens pris. Paritet browser/server bevares (test).
3. Listen viser "Du har: kylling, ris" øverst i trin 5.

### Task 5: Swipe retter (trin 4, telefon)

**Files:** `public/app.js`, `public/styles.css`.

1. På skærme ≤ 720 px får trin 4 en vælger "Swipe | Liste" (standard: Swipe). Swipe viser én ret ad gangen som et stort kort (foto, titel, tider, pris pr. portion hvis budget) med to knapper (× og ✓) og swipe med finger/pointer: højre = vælg (samme logik som fluebenet, inkl. loftet på antal aftener og beskeden), venstre = næste. En tæller "3 af 4 valgt"; når ugen er fuld, vises "Se indkøbslisten". Retter, der blev sprunget over, kommer igen sidst. Tastatur: ← og →. Respektér `prefers-reduced-motion`.
2. Liste-visningen er den nuværende. Forslag A/B står uændret over vælgeren.
3. Tjek i browser (Playwright, 390 px): swipe højre vælger, venstre springer over, loftet holder.

### Task 6: Madlavningstilstand

**Files:** `public/app.js`, `public/styles.css`.

1. Knappen "Begynd at lave mad" i opskriftsarket åbner en fuldskærmsvisning: ét trin ad gangen i stor skrift (afsnit "Tilbehør" med), trinnummer "3 af 9", frem/tilbage-knapper og swipe, de ingredienser og mængder (ganget op til husstanden), der nævnes i trinnet, er ikke nødvendige — i stedet en knap "Ingredienser" der viser listen. Luk med ×.
2. Skærmen holdes tændt med Screen Wake Lock API (`navigator.wakeLock.request('screen')`), genopret ved `visibilitychange`, slip ved luk. Mangler API'et, sker intet (ingen fejl).
3. Tjek i browser (390 px og 1280 px).

### Task 7: Afslutning

Afsluttende review af hele grenen, én rettelsesbølge, mål puljerne, spørg brugeren før fletning og push.
