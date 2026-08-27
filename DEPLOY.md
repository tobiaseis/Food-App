# Deploy: Vercel + Supabase + GitHub Actions

Alle tre er gratis i den nødvendige størrelse. Samlet tid: ~20 minutter.

## Sådan hænger det sammen

```
GitHub Actions  (dagligt 05:10 UTC)
  1. henter data.db fra release-asset
  2. npm run update            ← ingest mod lokal SQLite, uændret kode
  3. node src/sync/build.js    ← madplaner + prisstatistik regnes HER
  4. push read-model           →  Supabase
  5. gemmer data.db tilbage

Vercel  (statisk frontend)  →  læser Supabase direkte med anon-nøglen
```

**Hvorfor ikke bare køre alt i Supabase?** Én madplan kræver ~3.200 enkeltopslag.
Lokalt mod SQLite tager det 183 ms; mod en fjern Postgres ville det tage op mod
et minut og aldrig kunne køre i en serverless funktion. Derfor bliver den tunge
del i GitHub Actions, og Supabase får kun færdige resultater. Det er også
grunden til, at de ~140 synkrone SQLite-kald i `src/` ikke skal skrives om.

Prishistorikken bor i `data.db`, som gemmes som **release-asset** frem for i
git – et 12 MB binært commit om dagen ville sprænge repoet i løbet af et år.

---

## 1. Supabase (5 min)

1. Opret et gratis projekt på [supabase.com](https://supabase.com).
2. Åbn **SQL Editor** → indsæt hele `supabase/schema.sql` → **Run**.
3. Under **Project Settings → API** finder du:
   - `Project URL` → bruges som `SUPABASE_URL`
   - `anon public` → `SUPABASE_ANON_KEY` (må gerne ligge i frontenden)
   - `service_role` → `SUPABASE_SERVICE_KEY` (**kun** i GitHub Actions)

> Free tier sætter projektet på pause efter 7 dages inaktivitet. Den daglige
> Actions-kørsel tæller som aktivitet, så det sker ikke i praksis.

## 2. GitHub (5 min)

```bash
git add -A && git commit -m "Deploy-opsætning"
git push
```

**Settings → Secrets and variables → Actions → New repository secret:**

| Navn | Værdi |
|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service_role-nøglen |

### Første kørsel: send din lokale database med

Du har allerede ~2.200 opskrifter og flere ugers tilbud i `data.db`. Upload den,
så slipper workflowet for at crawle opskrifter forfra (~30 min):

```bash
npm run sync:dry                      # sanity-check at basen er hel
gh release create db --title "Database" --notes "SQLite-snapshot"
gh release upload db data.db --clobber
```

Kør derefter workflowet: **Actions → "Hent tilbud og opdatér Supabase" → Run workflow**.

Springer du uploadet over, henter workflowet selv opskrifter, første gang det
opdager at basen er tom. Det tager bare længere tid.

## 3. Vercel (5 min)

1. **Add New → Project** → importér repoet. Framework Preset: **Other**.
2. Vercel læser `vercel.json`, så build-kommando og output-mappe er sat:
   - Install Command: *(tom – springes over med vilje, se nedenfor)*
   - Build Command: `node scripts/build-web.js`
   - Output Directory: `public`
3. **Environment Variables** – tilføj dem **før** første deploy:

| Navn | Værdi | Miljøer |
|---|---|---|
| `SUPABASE_URL` | samme som ovenfor | Production + Preview + Development |
| `SUPABASE_ANON_KEY` | **anon**-nøglen – aldrig service_role | Production + Preview + Development |

> **Sæt flueben ved alle tre miljøer.** Vercel holder variabler adskilt pr.
> miljø, og alt andet end din produktionsgren bygger som **Preview**. Sidder
> nøglerne kun på Production, fejler et branch-deploy med
> `SUPABASE_URL MANGLER`, selv om variablen tydeligvis står i listen.

4. Deploy.

`scripts/build-web.js` skriver `public/config.js` ud fra de to variabler. Er de
tomme, falder frontenden tilbage til den lokale server på `/api/*`, så
`npm start` bliver ved med at virke uændret under udvikling. **På Vercel findes
den server ikke**, så buildet fejler med vilje hvis variablerne mangler – ellers
ville deployet lykkes og siden være helt tom.

### Hvorfor `installCommand` er tom

Frontend-buildet er én fil, `scripts/build-web.js`, og den bruger kun `node:fs`
og `node:path`. Kørte Vercel `npm install`, ville den kompilere `better-sqlite3`
– et native-modul der hverken bruges eller er nødvendigt her, og som kan fejle
på Vercels build-image. Tom install-kommando springer trinnet helt over.

### Sikkerhedsheaders

`vercel.json` sætter en Content-Security-Policy. Den er tilpasset appen:

| Direktiv | Hvorfor |
|---|---|
| `script-src 'self'` | ingen inline-scripts – derfor ligger `modal-close`- og billed-fallback-lytterne i `app.js` |
| `style-src 'self' 'unsafe-inline'` | app.js genererer HTML med `style="…"`-attributter |
| `img-src 'self' data: https:` | tilbuds- og opskriftsfotos hentes fra eksterne domæner |
| `connect-src 'self' https://*.supabase.co` | frontenden taler kun med Supabase |

Tilføjer du en ny ekstern kilde (fx et CDN eller en font), skal den med i det
relevante direktiv – ellers blokerer browseren den tavst.

---

## Hvad der virker hvor

| Funktion | Lokalt (`npm start`) | Vercel + Supabase |
|---|---|---|
| Madplaner, 3 spor | genereres live (183 ms) | 4 forudberegnede varianter pr. spor; "Ny plan" skifter mellem dem |
| Ugens fund, prishistorik | live | færdigregnet, opdateres dagligt |
| Søg i tilbud | live | direkte mod Supabase |
| Følg varer | træf findes med det samme | oprettes straks, træf findes ved næste natlige kørsel |
| "Hent tilbudsaviser"-knap | kører ingest | deaktiveret – det er Actions' opgave |

## Gratis-grænser at kende

- **Supabase:** 500 MB database. Tilbud vokser ~20 MB/år, så der er plads i
  mange år. Pauser ved 7 dages inaktivitet (undgås af den daglige kørsel).
- **GitHub Actions:** gratis uden loft på offentlige repos; 2.000 min/md på
  private. Kørslen tager ~2 min, altså ~60 min/md – rigeligt indenfor.
  **Planlagte workflows deaktiveres efter 60 dages inaktivitet i repoet** –
  et commit én gang i kvartalet holder det i live.
  Cron kan blive forsinket 15-30 min i spidsbelastning; det betyder intet her.
- **Vercel Hobby:** gratis til ikke-kommerciel brug.

## Fejlfinding

```bash
npm run sync:dry     # byg read-modellen uden at sende noget
npm run sync         # byg og push (kræver SUPABASE_URL + SUPABASE_SERVICE_KEY)
```

- **Tom frontend, ingen fejl:** read-modellen er ikke bygget endnu. Kør
  workflowet manuelt.
- **`permission denied for table ...`:** RLS-policyerne fra `schema.sql` er ikke
  kørt. Kør filen igen – den er idempotent.
- **Madplan siger "Ingen madplan er bygget endnu":** `meal_plans` er tom.
  Sker hvis `build.js` fejlede efter tilbud, men før planerne. Se Actions-loggen.
- **Actions fejler på `better-sqlite3`:** tjek at Node-versionen i workflowet
  stadig har prebuilds (22 har).
- **`409 · duplicate key value violates unique constraint "products_slug_key"`:**
  skulle ikke kunne ske mere. `push()` udskifter hele det afledte lag ved hver
  kørsel, netop fordi `products.id`, `offers.id` og `recipes.id` er
  AUTOINCREMENT og altså får nye værdier, hvis basen bygges forfra. Ser du den
  igen, er der kommet en upsert på `id` ind et sted – `test/sync.test.js`
  fanger det.
- **Vercel: `FEJL: byg på Vercel uden Supabase-nøgler`:** buildet stopper med
  vilje. Se miljø-noten under punkt 3 – ni ud af ti gange mangler fluebenet ved
  Preview.

## Databasen skal overleve

`data.db` er sandheden: prishistorikken findes kun der. Workflowet gemmer den
som release-asset **også når et senere trin fejler** (`if: always()`), fordi
ingest og opskrifts-crawl tager op mod en halv time. Uden det ville en fejlet
Supabase-synkronisering smide hele kørslen væk, og næste kørsel ville starte
forfra på en tom base.

Har du en god base lokalt, så send den med, før du lader Actions køre – ellers
crawler den sine egne (færre) opskrifter:

```bash
npm run db:checkpoint
gh release upload db data.db --clobber
```
