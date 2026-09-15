# Undersøgelse: kan vi hente normalpriser fra kædernes egne API'er?

**Dato:** 2026-09-15
**Status:** afsluttet — tidsafgrænset undersøgelse, ikke produktionskode
**Opgave:** Task 10 (`.superpowers/sdd/2026-09-06-varetyper-og-maengder/task-10-brief.md`)

## Spørgsmålet

Databasedesignet (`2026-09-06-database-design.md`, beslutning 1) siger: hybrid
kilde til `item_prices` — API hvor det findes, manuelt ellers, med `source` pr.
række. Denne undersøgelse svarer, pr. kæde, ja eller nej på: **kan vi hente pris
og pakkestørrelse for en kendt vare, uden login?**

Metode: scriptet `scripts/spike-chain-apis.js` kalder en URL og udskriver
svarets nøglestier, så pris- og mængdefelter kan ses uden at læse hele
JSON-svaret. Testvarer: `kartofler` (poser i varierende størrelse) og
`hakket oksekød` (pakker i ikke-runde gram-tal — 250/350/400/500/750/800 g).

## Resultat

| kæde | endpoint | login? | pris? | pakkestørrelse? | vurdering |
|---|---|---|---|---|---|
| **REMA 1000** | `GET https://api.digital.rema1000.dk/api/search/products?query=<ord>&page=1&per_page=<n>` | Nej | **Ja** — `data[].prices[].price` | **Ja** — afledt: `price ÷ data[].prices[].compare_unit_price` (kg-pris), bekræftet af fritekstfeltet `data[].underline` (fx "400 GR. / REMA 1000") | **Kan automatiseres.** Stabilt, ustyret adgang, pænt struktureret svar. |
| **Salling Group** (Bilka/føtex/Netto) | `GET https://api.sallinggroup.com/v1/food-waste`, `/v1/stores` (officielt API, `developer.sallinggroup.com`) | Ja — kræver oprettelse + API-nøgle | **Nej** — kun madspild-tilbud tæt på udløb, ikke normalsortiment | Nej | **Kan ikke bruges til normalpriser**, uanset at API'et er officielt. Dækningen er forkert, ikke adgangen. |
| **Coop** (Kvickly/SuperBrugsen/Brugsen/365discount) | Officiel portal `developer.cl.coop.dk` **utilgængelig** (se nedenfor). Gateway `api.cl.coop.dk` findes, men ingen fundet produkt/pris-rute. | Ja for API-nøgle (der hvor porten overhovedet virker) | **Nej** — ingen produkt/pris-endpoint fundet | Nej | **Manuelt/CSV.** Coop.dk MAD (webshoppen) lukkede i 2023 — der er intet sted at spørge. |

## Beviser pr. kæde

### REMA 1000 — JA

Endpointet blev fundet ved at hente `shop.rema1000.dk`s JS-bundle
(`/js/app.js`) og gribe efter API-basen og kaldene i klartekst:

```
baseURL: "https://api.digital.rema1000.dk/api"
GN.get("search/products", { params: { query, page, per_page, filter[...] } })
```

Testet direkte, uden nogen login-cookie eller session:

```
$ curl "https://api.digital.rema1000.dk/api/search/products?query=kartofler&page=1&per_page=5"
HTTP 200 application/json
```

Uddrag af ét produkt (kartofler):

```json
{
  "name": "SKRÆLLE KARTOFLER",
  "underline": "2 KG. / DANMARK KL. 1",
  "prices": [{ "price": 18, "compare_unit": "kg", "compare_unit_price": 9 }]
}
```

18 kr ÷ 9 kr/kg = 2 kg — stemmer med `underline`. For hakket oksekød (8 varianter
hentet i én søgning) matchede samme regnestykke alle otte ikke-runde
pakkestørrelser eksakt:

| navn | underline | pris | compare_unit_price | udregnet pakke |
|---|---|---|---|---|
| HK. OKSEKØD 8-12% | 400 GR. | 39,95 | 99,88 kr/kg | 400 g |
| HK. OKSEKØD 8-12% | 800 GR. | 76,95 | 96,19 kr/kg | 800 g |
| HK. OKSEKØD 15-18% | 400 GR. | 37,95 | 94,88 kr/kg | 400 g |
| HK. OKSEKØD, 35% GRØNT | 400 GR. | 29,00 | 72,50 kr/kg | 400 g |
| HAKKET KØDKVÆG 8-12% | 250 GR. | 32,95 | 131,80 kr/kg | 250 g |
| HK. OKSEKØD 4-7%, FRILAND | 350 GR. | 64,95 | 185,57 kr/kg | 350 g |
| HK. GRIS & KALV 8-12% | 500 GR. | 29,95 | 59,90 kr/kg | 500 g |

Ingen af kaldene brugte cookies, session-token eller `X-Device`/`X-Locale`-
headers ud over dem, spike-scriptet selv sætter (`accept`, `accept-language`,
`user-agent`) — de er ikke krævet, kun venlige at sende. Ingen 403/429 er set
under undersøgelsen (et par håndfulde kald, ikke belastningstestet).

**Risiko:** endpointet er ikke dokumenteret af REMA — det er fundet ved at
læse deres frontend-bundle. Det kan ændre sig uden varsel. Til gengæld er det
den samme slags "stabil, uofficiel" API, tredjeparts-scrapere (Apify m.fl.)
allerede bygger på, så det er ikke en engangs-tilfældighed.

### Salling Group — NEJ (dækning, ikke adgang)

Det officielle udviklerprogram (`developer.sallinggroup.com`, gateway
`api.sallinggroup.com`) blev afprøvet direkte uden nøgle:

```
$ curl https://api.sallinggroup.com/v1/food-waste?zip=8000
HTTP 401 {"error":"This API resource requires authentication...
$ curl https://api.sallinggroup.com/v1/stores
HTTP 401 {"error":"This API resource requires authentication...
$ curl https://api.sallinggroup.com/v1/product-suggestions
HTTP 404 {"error":"Unknown Operation: GET /v1/product-suggestions"...
$ curl https://api.sallinggroup.com/v1/prices
HTTP 404 {"error":"Unknown Operation: GET /v1/prices"...
```

De to reelle ressourcer (`food-waste`, `stores`) kræver en API-nøgle (kræver
oprettelse på udviklerportalen — en "login"-lignende barriere). Men det
afgørende svar kommer FØR man overhovedet rammer login-spørgsmålet: det
officielle API-katalog er, ifølge portalens egen dokumentation og flere
tredjeparts-integrationer, begrænset til:

- **Anti Food Waste** — kun varer på vej mod udløbsdato, med rabat. Ikke
  normalsortimentet, og kun opdateret de sidste ~2 døgn.
- **Product Suggestions** — anbefalinger, ikke priser (og findes slet ikke som
  gættet endpoint-navn, se 404 ovenfor).
- **Stores** — butiksmetadata (adresse, åbningstider), ingen priser.
- **Holidays**, **Jobs** — irrelevant for denne opgave.

Der findes ingen `/v1/products` eller `/v1/prices`-ressource. Konklusionen
holder derfor uafhængigt af login-spørgsmålet: selv med en gratis nøgle kan
Bilka/føtex/Netto ikke prissættes via dette API.

### Coop — NEJ (portalen er nede, ingen produkt-API fundet)

`coop.dk/mad` (den tidligere online-dagligvarebutik) svarer selv, at den er
lukket:

```
$ curl -sL https://mad.coop.dk → redirect til coop.dk/mad
<title>Coop.dk MAD lukkede i 2023</title>
```

`kvickly.coop.dk`, `superbrugsen.coop.dk`, `brugsen.coop.dk`,
`365discount.coop.dk` er markedsførings-/tilbudssider uden produktsøgning
eller synlig pris-API i deres HTML/JS (afsøgt for API-URL'er, ingen fundet).

Den officielle udviklerportal er utilgængelig:

```
$ curl -v https://developer.cl.coop.dk/
* schannel: SNI or certificate check failed: SEC_E_WRONG_PRINCIPAL
$ curl -sk https://developer.cl.coop.dk/   # certifikat-tjek slået fra
HTTP 503 Service Unavailable
```

Certifikatet, serveren på `developer.cl.coop.dk` præsenterer, hører til
`api.cl.coop.dk`/`api.coop.dk` — en fejlkonfigureret eller nedlagt reverse
proxy — og selv uden om certifikatfejlen svarer den 503. Selve API-gatewayen
(`api.cl.coop.dk`) lever og kræver et abonnementsnøgle (Azure API
Management-stil):

```
$ curl https://api.cl.coop.dk/storeapi/v1/stores/markers
HTTP 401 {"message":"Access denied due to missing subscription key..."}
```

men søgning fandt kun én dokumenteret ressource under den gateway
(`storeapi` — butikslokationer), ingen produkt- eller prisressource. De
uofficielle "Coop-API'er", tredjeparts-scrapere bruger, viste sig at være
Tjek/eTilbudsavis' tilbudsavis-API — samme slags tilbudsdata, appen allerede
henter i dag, ikke normalpriser.

**Konklusion:** ingen vej ind, hverken officiel eller uofficiel, uden et
større reverse-engineering-arbejde end denne dags budget tillader. Behandles
som manuel/CSV, ligesom Lidl og franchisekæderne.

## Anbefaling

Kun **REMA 1000** kan automatiseres i dag — resten af de undersøgte kæder
(Bilka, føtex, Netto, Kvickly, SuperBrugsen, Brugsen, 365discount) går i
CSV'en, sammen med Lidl og franchisekæderne, som brief'en allerede
forudsatte. Ved den realistiske brugssituation — tre yndlingskæder,
~240 varer prissat pr. kæde — betyder det: vælger brugeren REMA som én af de
tre, spares ~240 rækker manuelt arbejde ud af op til ~720 (3 × 240); vælger
brugeren tre kæder uden REMA, er alle ~720 rækker manuelle. `item_prices`
skal derfor bære et `source`-felt, der som minimum skelner
`rema_api`/`manual`, og importøren (plan 2) skal kunne tage imod begge —
scriptet herfra bliver ikke productionskode, men beviser at ruten findes.

## Deliverables

- `scripts/spike-chain-apis.js` — undersøgelsesværktøjet, brugt til alle ovenstående kald
- Denne fil
