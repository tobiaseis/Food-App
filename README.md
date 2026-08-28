# Madplan

Ugentlige madplaner bygget ud fra de varer, der faktisk er på tilbud i danske
supermarkeder – med prishistorik, så man kan se om et "tilbud" er et tilbud,
og notifikationer på de varer, man selv køber tit.

```bash
npm install
npm run ingest        # henter denne uges tilbudsaviser  (~1 min)
npm run recipes       # henter opskrifter                (~20 min, kun første gang)
npm start             # http://localhost:3000
```

### Kør automatisk hver uge

```powershell
npm run schedule            # opretter en daglig Windows-opgave kl. 07:00
npm run schedule:status     # se sidste/næste kørsel og seneste loglinjer
npm run schedule:remove     # fjern den igen
```

Kæderne udgiver ikke deres aviser på samme ugedag, så opgaven kører **dagligt**
frem for ugentligt. Kørslen er idempotent – kun tilbud, databasen ikke har set
før, indsættes – så en ekstra kørsel koster ingenting. Den henter tilbud,
opdaterer butiksregisteret én gang om ugen, kører dine overvågninger og
skriver et resumé til `logs/update.log`.

Uden planlagt opgave er `npm run update` den samme rutine kørt i hånden.

### Eller som app på telefonen

```bash
npm run android:sync     # byg config.js og kopiér public/ ind i projektet
npm run android:apk      # debug-APK
```

Capacitor pakker `public/` ind i en APK – samme kode som websiden, ingen
bundler, ingen omskrivning. Det, der kommer med, er dét, en fane ikke kan:
**rigtige notifikationer**. Overvågningerne er hele tiden blevet evalueret
hver nat; det, der manglede, var at levere dem, så man opdager tilbuddet
mens det gælder og ikke ugen efter.

Se **[ANDROID.md](ANDROID.md)** for opsætning, push og Play Store.

### Eller kør det i skyen – gratis

Vercel (frontend) + Supabase (data) + GitHub Actions (den daglige kørsel).
Se **[DEPLOY.md](DEPLOY.md)** for opsætningen.

Kort fortalt: den tunge beregning bliver i GitHub Actions mod en lokal
SQLite-fil, fordi opslagene mod en fjern database ville tage op mod et minut.
Supabase modtager færdige resultater, så frontenden laver rene SELECTs.

Madplanen er den ene undtagelse, og med vilje. Den afhænger af brugerens
favoritbutikker, og dem findes der 32.767 kombinationer af – de kan ikke
forudberegnes. Actions bygger derfor de to små opslagstabeller, planen består
af (`offer_index`: ~550 rækker, `recipe_index`: ~2.100), og `public/engine.js`
sætter planen sammen i browseren. Samme fil kører begge steder, så en plan
bygget lokalt og en bygget i skyen er den samme plan – det er der en test på.

---

## Hvad appen gør

**Madplan** i tre spor – *sund & proteinrig (lavt kulhydrat)*, *klassisk*,
*gourmet*. Syv retter, hvor rettens **hovedråvare er på tilbud i de butikker,
du selv handler i**. Hver ret linker til opskriften hos kilden, og der følger
en indkøbsliste med, grupperet efter butik.

**Mine butikker.** Man vælger de kæder, der ligger i nærheden – har man Rema og
Netto, bygges planen kun af deres tilbud. Uden det valg er en madplan ikke en
indkøbsliste, men en køretur: femten kæder på tværs af landet er ikke et sted,
man handler. Valget gælder også "Ugens fund" og "Alle tilbud".

Planen varierer fra uge til uge: retter fra de seneste fire ugers planer
trykkes ned i rangeringen, og "Ny plan" omroker feltet, så man ikke får de
samme syv retter igen. Sund-sporet vægter både højt protein **og** få
kulhydrater – protein alene ville lukke pasta bolognese ind.

**Prishistorik** pr. varetype målt i kr/kg – ikke i stykpris. Det er dét, der
gør det muligt at svare på, om 35 kr for hakket oksekød er billigt. Hver ret
vare får en vurdering: *rigtig god pris*, *god pris*, *normal pris* eller
*dyrere end normalt*.

**Følg varer** – skriv fx `skyr`, og appen holder øje med den i alle kæder.
Notifikationer kan begrænses til en mindste rabat og en maksimal afstand til
nærmeste butik.

---

## Datakilder

### Tilbud: Tjek/eTilbudsavis' offentlige API

`squid-api.tjek.com` leverer struktureret tilbudsdata for **15 dagligvarekæder**:
Netto, føtex, REMA 1000, Bilka, Lidl, SuperBrugsen, Kvickly, MENY, SPAR,
365discount, Brugsen, Min Købmand, ABC Lavpris, LET-KØB og Salling.

Vigtigt er `quantity.unit.si.factor` sammen med `size`: 33 cl × 0,01 = 0,33 l,
og 3 kr / 0,33 l = **9,09 kr/l** – præcis det tal, avisen selv trykker.
Enhedsprisen er altså regnestykke, ikke gætværk.

API'et giver også førpris, gyldighedsperiode, sidetal, produktbillede og
butikssøgning på koordinater (2.700 butikker med position).

### Opskrifter: fire etablerede madsider

| Kilde | Sprog | Format | Rolle |
|---|---|---|---|
| [Valdemarsro](https://www.valdemarsro.dk) | da | microdata | dansk hverdagsmad |
| [Arla](https://www.arla.dk) | da | JSON-LD | dansk, med næringsdeklaration |
| [BBC Good Food](https://www.bbcgoodfood.com) | en | JSON-LD | bredt udvalg + fulde makroer |
| [Great British Chefs](https://www.greatbritishchefs.com) | en | JSON-LD | restaurantkokke → gourmet-sporet |

Alle fire udstiller struktureret opskriftsdata (schema.org) og tillader crawl
af opskriftsstier i deres `robots.txt`. Crawleren kører ~1 kald/sekund.

**Vi gemmer fakta – titel, ingrediensliste, næringsindhold, billede og link –
og henter ikke fremgangsmåden.** Brugeren sendes til kilden for selve
opskriften. Ingrediensmængder er dét, matchningen har brug for; metodeteksten
tilhører udgiveren.

---

## Hvordan det hænger sammen

```
Tjek API ──► normalisering ──► varetype ──► prishistorik ──┐
                (kr/kg)        (taksonomi)                 ├──► madplan
                                    ▲                      │
opskriftssider ──► ingredienser ────┘                 indkøbsliste
                   (da + en)                          notifikationer
```

### Taksonomien er omdrejningspunktet

`src/lib/taxonomy.js` er en dansk fødevare-taksonomi med danske og engelske
synonymer. Den løser tre problemer på én gang:

1. **Stabil vare-identitet.** "REMA 1000 Hakket dansk oksekød, 500 g" og
   "Dansk hakket oksekød" bliver til samme varetype, uge efter uge. Uden det
   findes der ingen prishistorik – hver uges ordlyd ville blive sin egen vare.
   Egenskaber der reelt ændrer prisen, holdes dog adskilt; se
   [Varianter der flytter prisen](#varianter-der-flytter-prisen).
2. **Opskrift-match.** "500 g hakket oksekød" i en opskrift kobles til et
   tilbud på hakket oksekød.
3. **Sprogbro.** `beef mince` → `hakket_oksekoed`, så engelske opskrifter kan
   matche danske tilbud.

Dansk er et sammensætningssprog, så opslaget accepterer delmatch inde i ord
("jomfruolivenolie" → olie), men kun for synonymer på 4+ tegn – ellers ville
"is" ramme "ris". Rangeringen tager hovedordet forrest, fordi danske varenavne
gør det samme: *Skinke*culotte er skinke.

### Hovedråvare, støtte og basisvare

Alle ingredienser skal ikke være på tilbud – det ville aldrig kunne lade sig
gøre. Men de rigtige skal. Ingredienserne deles derfor i tre:

| Rolle | Eksempel i en fajita | Betydning |
|---|---|---|
| **Hovedråvare** | kyllingen | *skal* være på tilbud |
| **Støtteråvare** | peberfrugt, tortillas, flåede tomater | tæller positivt, er ikke et krav |
| **Basisvare** | olie, spidskommen, hvidløg, salt | tælles slet ikke |

Hovedråvaren findes ud fra kategori og mængde: kød, fisk, æg og bælgfrugter kan
bære en ret, og den tungeste af dem er rettens hovedråvare. Er der to i samme
størrelsesorden – laks *og* torsk i en fiskelasagne – er begge et krav, mens de
25 g bacon til pynt ikke er. Vegetarretter falder tilbage på den tungeste
bærende råvare, så en linsegryde stadig har noget at planlægges omkring.

Basisvarerne er ikke en principiel afgrænsning, men en praktisk: står varen i
skabet i forvejen, køber man den sjældent på tilbud, og den bruges i så små
mængder, at prisen alligevel ikke flytter noget. En madplan, der ventede på
tilbud på hvidløg og paprika, ville aldrig blive til noget.

**Kravet lemper sig selv – og siger det.** Har man kun to butikker, er der
færre tilbud at bygge på. Motoren vælger derfor det strengeste af fire krav,
der stadig giver nok retter at vælge imellem, og skriver hvilket det blev:

1. alle hovedråvarer på tilbud *og* mindst en fjerdedel af resten
2. alle hovedråvarer på tilbud
3. rettens vigtigste hovedråvare på tilbud
4. mindst én råvare på tilbud

Uden den besked kunne man ikke se forskel på "alt er på tilbud" og "vi gav op
og tog, hvad vi kunne finde".

**Ukendte råvarer udelader retten.** Løftet kan kun holdes for råvarer, vi kan
genkende. En opskrift med "750 g lammebov" – som taksonomien ikke kender – ville
ellers se ud som en vegetarret og blive planlagt op om kartoflerne ved siden af.
Ingredienslinjer, der ligner kød eller fisk uden at kunne slås op, markerer
retten som ikke-planlægbar i stedet.

### Varianter der flytter prisen

Nogle egenskaber gør en vare til en *anden* vare, fordi de systematisk ændrer
kiloprisen. De indgår derfor i vareidentiteten:

| Variant | Gælder | Hvorfor |
|---|---|---|
| **Fedtprocent** | hakket okse-, gris-, kyllinge- og kalkunkød | 8-12 % og 15-20 % er ikke samme vare og har ikke samme pris |
| **Økologi** | kød, fisk, mejeri, æg, frugt og grønt | samme fedtprocent koster ~40 % mere økologisk |

Målt på ugens data for hakket oksekød:

| Vare | Median |
|---|---|
| 15-20 % | 92,11 kr/kg |
| 8-12 % | 96,19 kr/kg |
| 8-12 %, økologisk | 142,50 kr/kg |

Uden opdelingen ville de 142,50 kr/kg indgå i samme median som de 87,50, og et
helt almindeligt tilbud på magert hakkekød ville se ud som en god handel.
Nærliggende intervaller samles i de fire grader, slagteren faktisk sælger efter,
så "14-18 %" og "15-20 %" ikke bliver to varer.

### "Er det egentlig et tilbud?"

Tre uafhængige mål, fordi de dækker hinandens huller:

| Mål | Dækning | Styrke |
|---|---|---|
| Førpris fra avisen | ~9 % af tilbud | præcis, men sjælden |
| På tværs af kæder | virker fra dag ét | afslører "tilbud" til normalpris |
| Over tid | vokser med hver uges ingest | fanger sæson og reelle prisfald |

Alt regnes på `unit_price` (kr/kg eller kr/l) – aldrig på stykprisen, ellers
sammenligner man 400 g med 1 kg. Referenceprisen er **medianen**, og der tælles
**én pris pr. kæde pr. uge**: nogle kæder udgiver den samme vare i 16 aviser
samtidig, og uden den regel trækker én kæde medianen ned mod sig selv.

---

## Kommandoer

| Kommando | Gør |
|---|---|
| `npm run ingest` | Henter alle aktive tilbudsaviser. Idempotent – kør den gerne dagligt. |
| `npm run ingest:stores` | Som ovenfor, men opdaterer også butiksregisteret. |
| `npm run recipes` | Henter opskrifter fra alle fire kilder. |
| `npm run reclassify` | Genberegner næring og spor-scorer uden at hente sider igen. |
| `npm run recompute` | Genberegner enhedspriser og vare-identitet på eksisterende data. |
| `npm run watch` | Kører overvågninger og danner notifikationer. |
| `npm run update` | Hele rutinen: tilbud → normalisering → butikker → overvågninger. Skriver til `logs/update.log`. |
| `npm run schedule` | Opretter den daglige Windows-opgave (`-Status` / `-Remove` / `-RunNow`). |
| `npm test` | Regressionstests for normaliseringen. |

Prishistorikken bygges op ved at køre `update` løbende. Databasen er
`data.db` (SQLite).

---

## Projektstruktur

```
src/
  db/          skema + migreringer
  lib/         taksonomi og normalisering  ← kernen
  ingest/      Tjek-klient, ingest, genberegning
  price/       prishistorik og tilbudsvurdering
  recipes/     udtræk, kilder, crawler, klassifikation
  mealplan/    henter data til madplansmotoren
  watch/       følg varer + notifikationer
  server.js    JSON-API + statisk frontend
public/        frontend (vanilla JS, ingen byggetrin)
  engine.js    madplansmotoren – kører BÅDE i Node og i browseren
  data.js      datalag: lokal server eller Supabase
supabase/      Postgres-skema til read-modellen
scripts/       Windows-opgave + web-build
test/          regressionstests
.github/       daglig GitHub Actions-kørsel
```

---

## Forbehold

- **Prishistorik kræver tid.** Krydssammenligningen mellem kæder virker med det
  samme, men tidsserien bliver først for alvor brugbar efter nogle ugers ingest.
- **Næringsindhold er delvist estimeret.** Arla og BBC Good Food oplyser fulde
  makroer inkl. kulhydrat. Valdemarsro og Great British Chefs oplyser intet
  eller kun delvist, så protein, kalorier og kulhydrat estimeres ud fra
  ingrediensmængder og taksonomiens tal pr. 100 g. Estimater er mærket `est.`
  i visningen. Sund-sporet rangerer på tallene, så et dårligt estimat kan
  placere en ret forkert – tjek makroerne på retten, hvis det er afgørende.
- **Fedtprocent kendes kun når avisen skriver den.** Står der bare "Hakket
  oksekød", grupperes varen for sig, adskilt fra dem med oplyst fedtprocent.
  Det er ærligt – vi ved det ikke – men det giver en ekstra gruppe med færre
  observationer.
- **Prisoverslag på en madplan er et overslag.** Det regnes som opskriftens
  mængder gange tilbudsprisen pr. kg/l – og for de råvarer, der *ikke* er på
  tilbud, gange varetypens normalpris. Basisvarer (salt, olie, krydderier)
  tælles ikke med, og varer uden kendt normalpris indgår ikke i beløbet.
- **Færre butikker giver færre retter at vælge imellem.** Med to kæder er der
  typisk 50-60 varetyper på tilbud mod ~90 for alle femten. Planen kan stadig
  bygges, men kravet lempes oftere, og prisoverslaget bliver højere, fordi
  flere råvarer skal købes til normalpris.
- **Enhedsprisen kan mangle.** Hvis mængdedata er urealistiske og avisen ikke
  selv oplyser en kilopris, sættes `unit_price` til stykpris i stedet for at
  gætte. Et forkert kr/kg ville ellers toppe listen over bedste tilbud.
- **Taksonomien dækker ~54 %** af alle tilbud (og langt mere af dagligvarerne –
  resten er non-food fra fx byggemarkeder i samme aviser). Varer uden match får
  stadig en stabil identitet og en enhedspris, men indgår ikke i madplaner.

## Den gamle PDF-pipeline

`pipeline.js` (PDF-download + AI-vision) ligger stadig i repoet som
`npm run legacy:pdf`. Den er ikke længere i brug: Tjek-API'et giver de samme
varer struktureret, gratis og deterministisk – inklusive de felter,
vision-udtrækket aldrig fik fat i (førpris, mængde, gyldighedsperiode).
Til sammenligning gav PDF-vejen 161 varer fra én kæde; API-vejen giver
~7.600 fra fjorten.
