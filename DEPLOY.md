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

1. **Add New → Project** → importér repoet.
2. Vercel læser `vercel.json`, så build-kommando og output-mappe er sat.
   Bekræft at der står:
   - Build Command: `node scripts/build-web.js`
   - Output Directory: `public`
3. **Environment Variables:**

| Navn | Værdi |
|---|---|
| `SUPABASE_URL` | samme som ovenfor |
| `SUPABASE_ANON_KEY` | **anon**-nøglen – aldrig service_role |

4. Deploy.

`scripts/build-web.js` skriver `public/config.js` ud fra de to variabler. Er de
tomme, falder frontenden tilbage til den lokale server på `/api/*`, så
`npm start` bliver ved med at virke uændret under udvikling.

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
