# Android

Appen er den samme kode som websiden. Capacitor pakker `public/` ind i en
APK og lægger en native bro ved siden af, så den kan sende push, spørge om
placering og svare på tilbage-knappen.

```bash
npm run android:sync     # byg config.js og kopiér public/ ind i projektet
npm run android:open     # åbn i Android Studio
npm run android:apk      # debug-APK i android/app/build/outputs/apk/debug/
npm run android:aab      # release-bundle til Play (kræver keystore.properties)
```

Kun `public/` er kilden. Rediger aldrig `android/app/src/main/assets/public/` —
den mappe overskrives ved hver sync.

---

## Første gang

**JDK.** Gradle skal bruge 17 eller nyere. Java 8 i PATH er ikke nok. Android
Studio har en med, og den er nemmest at pege på:

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"    # Git Bash
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"    # PowerShell
```

**SDK-sti.** `android/local.properties` skal findes og pege på SDK'et. Den er
ikke i git, fordi stien er personlig:

```properties
sdk.dir=C:/Users/DIT-NAVN/AppData/Local/Android/Sdk
```

Skråstreger fremad. En `.properties`-fil bruger `\` som undvigetegn, så
`C:\Users\...` bliver læst forkert og giver en ubrugelig fejl om
"syntaksen i filnavnet".

**Nøgler.** Inde i APK'en findes der ingen `/api/*`-server at falde tilbage
på. Uden Supabase-nøgler installerer appen fint, starter fint og viser en
fejlskærm, der forklarer præcis dette. Læg dem i `.env` ved siden af
`package.json`:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
```

`npm run android:sync` stopper med en forklaring, hvis de mangler.

---

## Push

Detektionen fandtes i forvejen: den natlige kørsel evaluerer hver overvågning
og lægger rækker i `notifications`. Det, der manglede, var leveringen.

```
GitHub Actions ──> Supabase ──> src/push/send.js ──> FCM ──> telefon
   (nattens kørsel)  notifications        (nyt)
```

**Sådan sættes det op:**

1. Opret et Firebase-projekt på <https://console.firebase.google.com>.
2. Tilføj en Android-app med pakkenavnet `dk.madplan.app`.
3. Hent `google-services.json` og læg den i `android/app/`.
   Filen er i `.gitignore` — den er ikke hemmelig, men den binder repoet til
   ét bestemt Firebase-projekt.
4. Lav en tjenestekonto (Projektindstillinger → Tjenestekonti → Generér ny
   privat nøgle). Hele JSON-filen bliver til GitHub-hemmeligheden
   `FCM_SERVICE_ACCOUNT`.
5. Kør `supabase/schema.sql` igen — den tilføjer `device_tokens` og
   `notifications.pushed_at`.

Prøv den af uden at sende noget:

```bash
node src/push/send.js --dry-run
```

Uden legitimation springer scriptet over og går pænt ud, så den natlige
kørsel ikke vælter af, at Firebase ikke er sat op endnu.

**Tilladelsen** bliver der først spurgt om, når brugeren opretter sin første
overvågning — ikke ved opstart. Et nej ved opstart er svært at komme tilbage
fra på Android 13+.

---

## Før appen deles med andre

`supabase/auth.sql` er en gate, ikke en nice-to-have.

I dag adskilles overvågninger kun af et `device_id` fra localStorage, og
policyen er `for all to anon using (true)`. Det er fint for én husstand — men
anon-nøglen ligger i enhver APK, så i det øjeblik fremmede kan hente appen,
kan enhver med nøglen læse og slette alles overvågninger og hjemmeadresser.

1. Supabase → Authentication → Sign In / Providers → slå **Anonymous sign-ins** til.
2. Kør `supabase/auth.sql` i SQL-editoren.
3. Kør **ikke** `schema.sql` igen bagefter — dens åbne policyer ville træde i
   stedet for de stramme.

Appen logger selv anonymt ind ved opstart og overtager de rækker, den allerede
ejede, via `claim_device()`. Brugeren ser ingen loginskærm. Er anonymt login
ikke slået til endnu, falder appen stille tilbage på anon-nøglen — de to trin
kan altså rulles ud hver for sig.

---

## App Links

Et delt link skal åbne appen, ikke browseren.

1. Sæt `appLinkHost` i `android/variables.gradle` til dit domæne.
2. `node scripts/assetlinks.js <SHA-256-fingeraftryk>` — fingeraftrykket
   findes i Play Console under **Appsignering**. Bruger du Play App Signing,
   signerer Google appen om efter upload, så det er deres fingeraftryk, der
   tæller. Angiv gerne både upload- og appsigneringsnøglen.
3. Deploy, så filen kan hentes på `/.well-known/assetlinks.json`.
4. Geninstallér appen — Android verificerer ved installation.

---

## Play Store

```bash
npm run icons     # ikoner til web og launcher
npm run store     # feature graphic + skærmbilleder (appen skal køre)
```

**Signering.** Lav en upload-nøgle og en `android/keystore.properties`:

```properties
storeFile=../upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

Begge filer er i `.gitignore`. Mister du nøglen, kan appen ikke opdateres.
Lad Play App Signing holde den rigtige nøgle, og hav en sikkerhedskopi af
uploadnøglen et andet sted end den maskine, der byggede den.

**Version** kommer fra `package.json`. `1.0.0` bliver til `versionCode 10000`
(major × 10000 + minor × 100 + patch). Hæv versionen dér, ikke i Gradle.

**Materiale til butikssiden** ligger i `store/` efter `npm run store`:
ikon 512×512, feature graphic 1024×500 og fire telefonskærmbilleder.

**Privatlivspolitik.** Appen tager grov placering og en notifikationsnøgle, så
en politik-URL er et krav. Den ligger på `/privatliv`.

**Datasikkerhed** i Play Console skal stemme med den. Erklær:
placering (grov, valgfri, ikke delt), app-aktivitet (de varer, brugeren
følger) og enheds-id (notifikationsnøglen). Ingen deling med tredjepart,
ingen sporing på tværs af apps.

**Ny personlig udviklerkonto?** Google kræver 12 testere i en lukket test i
14 sammenhængende dage, før du kan udgive. Opret kontoen og find testerne,
mens du bygger — det er ventetiden, ikke arbejdet, der er den lange pol.

---

## Fejlfinding

| Symptom | Årsag |
|---|---|
| `Syntaksen i filnavnet ... er forkert` | `local.properties` med `\` i stien. Brug `/`. |
| Blank app, "Kunne ikke hente data" | Bygget uden Supabase-nøgler. Kør `npm run android:sync`. |
| Splash-skærmen bliver hængende | Skulle ikke kunne ske — der er et loft på 3 s i `capacitor.config.json`. |
| Ingen push | `google-services.json` mangler i `android/app/`, eller `FCM_SERVICE_ACCOUNT` er ikke sat. |
| Push kommer to gange | `notifications.pushed_at` mangler. Kør `supabase/schema.sql` igen. |
| Links åbner i browseren | `appLinkHost` eller `assetlinks.json` passer ikke. Geninstallér efter rettelsen. |
| Ændringer slår ikke igennem | Glemt `npx cap sync android` — APK'en har sin egen kopi af `public/`. |
