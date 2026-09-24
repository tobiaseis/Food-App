'use strict';

/**
 * Madplans-motoren – ren logik, ingen database.
 *
 * Filen ligger i `public/`, fordi den køres BEGGE steder:
 *
 *   · Node   – `src/mealplan/generate.js` henter data fra SQLite og kalder her.
 *   · Browser – `public/data.js` henter færdige indeks fra Supabase og kalder her.
 *
 * Én kopi af reglerne, to datakilder. Alternativet – en kopi hvert sted – ville
 * betyde, at madplanen lokalt og madplanen i skyen langsomt blev to
 * forskellige apps.
 *
 * ── Hvad motoren afgør ──────────────────────────────────────────────────────
 *
 * En ret kommer med i planen, hvis dens HOVEDRÅVARER er på tilbud i de
 * butikker, brugeren rent faktisk handler i. Ikke alle ingredienser skal være
 * på tilbud – det ville aldrig kunne lade sig gøre – og basisvarer (salt,
 * olie, krydderier, mel) tæller slet ikke med, fordi de står i skabet i
 * forvejen.
 *
 * Ingredienserne deles derfor i tre:
 *
 *   HOVEDRÅVARE   kødet, fisken, bønnerne – det retten hedder noget efter, og
 *                 det der fylder mest på bonen. I en fajita: kyllingen.
 *   STØTTERÅVARE  peberfrugt, tortillas, flåede tomater. Tæller positivt, når
 *                 de er på tilbud, men er ikke et krav.
 *   BASISVARE     salt, peber, olie, mel, krydderier. Tælles slet ikke.
 *
 * Kravet strammes eller lempes automatisk efter, hvor mange retter der rent
 * faktisk kan bygges af ugens tilbud i brugerens butikker – se LEVELS. Har man
 * kun to butikker i nærheden, er der færre tilbud at bygge på, og så er det
 * bedre at lempe kravet end at svare "ingen madplan".
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ── Rollefordeling ─────────────────────────────────────────────────────────

  // Kategorier der kan bære en ret. Det er dem, retten planlægges omkring,
  // og det er dem, der gør en ret til aftensmad.
  //
  // 'cheese' var her kortvarigt og er rullet tilbage. Historikken bliver
  // stående, så ingen genopfinder idéen:
  //
  // Formålet var at få ostepastaretterne med — Macaroni and Cheese, cacio e
  // pepe, boursinpasta, gnocchi traybake og otte andre, tolv ægte
  // hverdagsmiddage, mod to retter der ikke er middage. Målt bagefter kom
  // gevinsten aldrig: **Macaroni and Cheese lå nr. 94 af 128 kandidater**,
  // og der vises tolv. Retterne blev MULIGE, ikke sandsynlige — de er dyre
  // pr. portion, og optagelse er ikke det samme som at komme på bordet.
  //
  // Prisen var derimod høj og umålt. MAIN_CATS afgør ikke kun optagelsen,
  // men også tilbudsmatchet, variationsspærren og vægtningen i scoreRecipe,
  // og **344 af 2.208 opskrifter (15,6 %) skiftede hovedråvare**: en
  // kartoffelgratin blev planlagt op om osten i stedet for om kartoflen.
  // Kun optagelsen var målt; de tre andre virkninger var ikke.
  //
  // Og der findes ingen billig udgave. Det blev forsøgt at lade osten tælle
  // ved optagelsen alene, i et separat sæt, så assignRoles stod urørt — men
  // reserve-reglen tager kun den TUNGESTE bærende råvare, og i en ostepasta
  // vejer pastaen mere end osten. Macaroni and Cheese blev planlagt op om
  // pastaen og faldt ud alligevel; det eneste, der kom ind, var
  // Stracciatella ost. Enten er osten en hovedkategori med alt hvad det
  // koster, eller også er den ikke med.
  const MAIN_CATS = new Set(['meat', 'poultry', 'fish', 'eggs', 'legume']);

  // Bærende, men ikke hovedrolle. Bruges som reserve-hovedråvare i
  // vegetarretter, hvor der ikke er noget kød at pege på.
  const CARRIER_CATS = new Set(['veg', 'grain', 'bakery', 'cheese', 'dairy', 'fruit']);

  // Må aldrig indgå i en madplans-vurdering. En rødvin til en gryderet er
  // ikke et argument for at lave retten, og et tilbud på chips er slet ikke.
  const IGNORED_CATS = new Set(['drink', 'snack', 'nonfood']);

  // Tilbehøret, en ret bygges op om. Bruges kun til at holde ugen varieret:
  // syv retter med hver sin protein er stadig en kedelig uge, hvis alle syv
  // serveres med pasta.
  const STARCH_KEYS = new Set(['pasta', 'ris', 'kartofler', 'brod', 'tortilla',
                               'bulgur', 'pizza', 'sodkartoffel', 'havregryn']);

  // ── Variationsspærren ──────────────────────────────────────────────────────
  //
  // To spærrer, ikke én. Hovedråvaren alene rækker ikke: syv retter med hver
  // sin protein kan sagtens ende som syv gange pasta, fordi det er pastaen,
  // der er på tilbud. Tilbehøret skal derfor også variere.
  //
  // Anden runde er [99, 99] og slipper alt igennem: en uge skal kunne fyldes,
  // også når feltet er så smalt, at spærren ikke kan holdes. Færre retter end
  // dage er ikke et bedre svar end en ensformig uge.
  //
  // Reglen bor HER, fordi to steder skal bruge den — buildPlan og sharedWeek —
  // og fordi den slags lige blev en critical: `bestPriceFor` og `basketCost`
  // var to funktioner, der skulle være enige, og de holdt op med at være det.
  // Iterationen er forskellig (buildPlan går én sorteret liste igennem,
  // sharedWeek vælger om for hver dag), men tællingen og grænserne er de samme.
  const VARIETY_PASSES = [[2, 3], [99, 99]];

  /** Hvad spærren tæller på: rettens hovedråvare og dens tilbehør. */
  function varietyKeys(roles) {
    const starch = [...roles.mains, ...roles.support].find((i) => STARCH_KEYS.has(i.key));
    return {
      main: roles.mains.length ? roles.mains[0].key : null,
      starch: starch ? starch.key : null,
    };
  }

  /** Tællerne plus reglen om, hvad der må komme ind. Én pr. uge. */
  function varietyTally() {
    const mains = new Map();
    const starches = new Map();
    return {
      allows(keys, [maxMain, maxStarch]) {
        if (keys.main && (mains.get(keys.main) || 0) >= maxMain) return false;
        if (keys.starch && (starches.get(keys.starch) || 0) >= maxStarch) return false;
        return true;
      },
      add(keys) {
        if (keys.main) mains.set(keys.main, (mains.get(keys.main) || 0) + 1);
        if (keys.starch) starches.set(keys.starch, (starches.get(keys.starch) || 0) + 1);
      },
    };
  }

  // Ingredienser uden oplyst mængde vægtes som en middelstor portion, så et
  // "bacon til pynt" ikke pludselig bliver rettens hovedråvare.
  //
  // Disse to var oprindeligt grammtal (100 og 40) sammenlignet mod item.grams.
  // Siden opgave 9 er mængden i varens EGEN enhed (kg/l/stk), så begge er
  // divideret med 1000 for at blive sammenlignelige igen — de er stadig
  // kg/l-tal, ikke gram. (MAX_SANE_AMOUNT nedenfor i qtyInBase er samme historie.)
  const ROLE_FALLBACK_AMOUNT = 0.1;

  const MAIN_MIN_AMOUNT = 0.04;  // under det er man pynt, ikke hovedråvare
  const MAIN_SHARE  = 0.35;    // … og mindst en tredjedel af den største
  const MAX_MAINS   = 3;       // flere end det er et krav, ingen uge kan opfylde

  // Rollevægten skal sammenligne æbler med æbler: 2 æg er ikke mere end
  // 0,4 kg kylling, men det er præcis hvad amount siger, når den ene vare
  // tælles i stk og den anden vejes. weight er amount omregnet til et
  // kg-sammenligneligt tal (se generate.js/build.js, som udregner det) –
  // findes den ikke (ældre payload, eller en test der ikke sætter den),
  // falder vi tilbage til amount, som hidtil.
  const roleWeight = (item) => {
    const w = item.weight ?? item.amount;
    return w != null && w > 0 ? w : ROLE_FALLBACK_AMOUNT;
  };

  /**
   * Deler en opskrifts ingredienser i hovedråvarer, støtteråvarer og basisvarer.
   *
   * `items` er `{ key, cat, essential, amount, weight, ingredient }` –
   * taksonomien er allerede slået op af den, der kalder, så motoren selv er
   * fri for opslag. `amount` er i varens egen enhed (kg, l eller stk), ikke
   * gram — det er den, indkøbslisten og prisberegningen bruger. `weight` er
   * KUN til at afgøre roller (se roleWeight ovenfor): en stk-vare og en
   * kg/l-vare kan ellers ikke sammenlignes.
   *
   * `unknownMain` sættes, når opskriften indeholder en ingrediens, der ligner
   * kød eller fisk, men ikke kunne slås op. Så må reserve-reglen for
   * vegetarretter IKKE træde til: retten ville ellers blive planlagt op om
   * kartoflerne ved siden af og love et tilbud på et lam, vi aldrig har
   * kigget efter. Uden hovedråvare falder retten ud af planen i stedet.
   */
  function assignRoles(items, { unknownMain = false } = {}) {
    const staples = [];
    const usable = [];

    for (const raw of items || []) {
      if (!raw || !raw.key) continue;
      const item = {
        key: raw.key,
        cat: raw.cat || null,
        ingredient: raw.ingredient || raw.name || raw.key,
        name: raw.name || null,
        amount: raw.amount != null && raw.amount > 0 ? raw.amount : null,
        weight: raw.weight != null && raw.weight > 0 ? raw.weight : null,
      };
      if (raw.essential || IGNORED_CATS.has(item.cat)) { staples.push(item); continue; }
      usable.push(item);
    }

    // Samme varetype kan optræde flere gange i en ingrediensliste ("2 løg" +
    // "1 løg til dressingen"). Den skal kun stilles som ét krav – vi beholder
    // den største mængde, fordi det er den, prisen skal regnes på.
    const byKey = new Map();
    for (const it of usable) {
      const prev = byKey.get(it.key);
      if (!prev || roleWeight(it) > roleWeight(prev)) byKey.set(it.key, it);
    }
    const list = [...byKey.values()];

    let mains = list
      .filter((i) => MAIN_CATS.has(i.cat))
      .sort((a, b) => roleWeight(b) - roleWeight(a));

    if (mains.length) {
      const top = roleWeight(mains[0]);
      mains = mains
        .filter((i) => roleWeight(i) >= Math.max(MAIN_MIN_AMOUNT, top * MAIN_SHARE))
        .slice(0, MAX_MAINS);
    } else if (!unknownMain) {
      // Vegetarret: den tungeste bærende råvare træder i stedet for kødet,
      // så en linsegryde stadig har noget, planen kan stilles op omkring.
      mains = list
        .filter((i) => CARRIER_CATS.has(i.cat))
        .sort((a, b) => roleWeight(b) - roleWeight(a))
        .slice(0, 1);
    }

    const mainKeys = new Set(mains.map((m) => m.key));
    const support = list.filter((i) => !mainKeys.has(i.key));

    return { mains, support, staples };
  }

  // ── Krav-trin ──────────────────────────────────────────────────────────────

  /**
   * Fra strengest til mildest. Motoren vælger det STRENGESTE trin, der stadig
   * giver nok retter at vælge imellem, og fortæller hvilket det blev – ellers
   * ville brugeren ikke kunne se forskel på "alt er på tilbud" og "vi gav op".
   */
  const LEVELS = [
    { id: 'strict', mains: 'all', support: 0.25,
      label: 'Alle hovedråvarer på tilbud – og mindst en fjerdedel af resten' },
    { id: 'mains', mains: 'all', support: 0,
      label: 'Alle hovedråvarer på tilbud' },
    { id: 'main', mains: 'top', support: 0,
      label: 'Rettens vigtigste hovedråvare på tilbud' },
    { id: 'loose', mains: 'none', support: 0,
      label: 'Mindst én råvare på tilbud' },
  ];

  function qualifies(s, level) {
    if (level.mains === 'all' && !s.mains_all_on_offer) return false;
    if (level.mains === 'top' && !s.main_on_offer) return false;
    if (level.mains === 'none' && s.match_count === 0) return false;
    if (level.support > 0 && s.support_coverage < level.support) return false;
    return true;
  }

  // ── Normalpriser ───────────────────────────────────────────────────────────

  // Hvor længe en normalpris må stå, før den skal ses efter. Tallene er
  // spec afsnit 3.5: fresh svinger med sæson og leverandør, baseline gør
  // ikke. Essentials får aldrig en pris, så de har heller ingen frist.
  const PRICE_TTL_DAYS = { fresh: 90, baseline: 180, essential: null };

  function validUntilFor(itemClass, observedAt = new Date()) {
    const days = PRICE_TTL_DAYS[itemClass];
    if (days == null) return null;
    return new Date(observedAt.getTime() + days * 86400000).toISOString();
  }

  // Hvad mad kan koste pr. kg/l/stk i en dansk butik. Intervallerne er vide med
  // vilje: de skal fange en tastefejl og en fejlkobling, ikke en dyr økovare.
  // Kilden til en pris uden for båndet er næsten altid, at tilbuddet hører til
  // noget andet end varen — "Apple iPad" på æble, ansigtscreme på fløde.
  //
  // Båndet findes, fordi outlier-filtret i bootstrappen ikke kan se den slags:
  // det måler en vare mod dens EGEN median, og er alle varens observationer
  // forkerte, ER medianen fejlen. appelsins eneste stk-tilbud er "Orange
  // ilddæmon" til 1999,20 kr — legetøj — og med én observation havde der stået
  // 14.280 kr/kg. Båndet er den eneste viden her, der kommer udefra.
  //
  // Det er et værn mod STØRRELSESORDENER, ikke en priskontrol. En fejl på
  // 2-3x slipper igennem og skal slippe igennem: porre står målt til 80 kr/kg
  // mod 25-40 i virkeligheden, og 80 ligger inden for veg-båndet — som det
  // skal, for asparges og friske krydderurter koster virkelig det.
  const PRICE_BAND = {
    veg:    [2, 150],   fruit:  [2, 200],   meat:  [20, 600],
    poultry:[20, 300],  fish:   [20, 700],  dairy: [5, 200],
    // eggs og bakery rummer BÅDE stk- og kg-varer (æggeblomme og æggehvide
    // sælges pr. kg), så kg-båndet her skal være rummeligt nok til dem. Loftet
    // pr. stk er en helt anden størrelsesorden og står i PRICE_BAND_STK.
    cheese: [30, 500],  eggs:   [5, 200],   legume: [5, 200],
    // grain-gulvet var 5, og den billigste ÆGTE korn-observation i basen er
    // præcis 5,00 kr/kg (MADVÆRKET havregryn) — gulvet sad oven på en rigtig
    // pris, hvor en øre den anden vej havde kasseret den. 2 giver luft.
    grain:  [2, 150],   bakery: [5, 200],
    // pantry- og snack-loftet var 400 og kasserede ægte hyldepriser: målt hos
    // REMA koster PINJEKERNER 455-480 kr/kg, PISTACIEKERNER 480, STØDT
    // KARDEMOMME 590 og HUSBLAS 512. Tørvarer, nødder og krydderier sælges i
    // små pakker, og en høj kilopris er reglen dér, ikke fejlen — loftet på
    // 400 skar tværs gennem én rigtig fordeling (pinjekerner blev accepteret
    // til 400 og forkastet til 455, samme vare i samme butik). 900 fanger
    // stadig en tierfejl; et fejlmatch under 900 er taksonomiens og
    // produktnavnelistens arbejde, ikke båndets.
    pantry: [3, 900],   snack:  [10, 900],
    // 'drink' blander to slags varer: sodavand og juice solgt pr. liter, og
    // kaffe og te solgt som TØRVÆGT. Målt i basen: te op til 450 kr/kg og
    // kaffe til 421 er ægte hyldepriser, så loftet følger dem og ikke
    // sodavanden. Den rene løsning er at flytte kaffe/te til 'pantry', men
    // kategorien styrer også madplanen (IGNORED_CATS), så det er dataarbejde.
    //
    // Loftet bliver på 600, selv om tebreve målt når 835 kr/kg: en Melitta
    // kaffemaskine til 799 ligger i samme interval, og en kaffemaskine gemt
    // som tepris er værre end en manglende tepris. Derfor følger 'drink' IKKE
    // pantry op på 900.
    drink:  [2, 600],
  };

  // Et stk-loft er en helt anden størrelsesorden end et kiloloft, og de to kan
  // ikke dele tal. Kun tre varer sælges pr. stk — brod, tortilla, aeg — mens
  // deres kategorier også rummer kg-varer (æggeblomme, æggehvide), som kg-
  // båndet ovenfor skal blive ved med at dække. Målt i basen: ægte brød topper
  // ved 35 kr/stk, æg ligger på 2,90-3,60. Uden det her slipper "Bodum
  // brødkasse" (99), "Holm brødform" (79) og "Køkkenchef brødrister" (79)
  // igennem som brødpriser, og et æg til 32 kr regnes for en rimelig hyldepris.
  const PRICE_BAND_STK = { bakery: 60, eggs: 10 };

  /**
   * Kan denne kr/base_unit være en rigtig hyldepris?
   *
   * `true` ja · `false` nej · `null` vi har intet bånd for kategorien.
   * De tre svar skal holdes adskilt: en kalder, der læser "ved det ikke" som
   * et nej, ville kassere hver eneste vare i en kategori, ingen har sat
   * grænser for endnu.
   */
  function isPlausiblePrice(category, unitPrice, baseUnit) {
    const band = PRICE_BAND[category];
    if (!band) return null;
    // Infinity og NaN slipper ellers igennem hver eneste sammenligning og
    // videre ned i en REAL-kolonne, der kun kræver > 0.
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return false;
    if (baseUnit === 'stk') {
      // Ingen undergrænse pr. stk: ét æble og én kasse æbler er begge "1 stk".
      return unitPrice <= (PRICE_BAND_STK[category] ?? band[1]);
    }
    return unitPrice >= band[0] && unitPrice <= band[1];
  }

  /** Det loft/gulv, isPlausiblePrice faktisk brugte — til fejlbeskeder. */
  function priceBandFor(category, baseUnit) {
    const band = PRICE_BAND[category];
    if (!band) return null;
    if (baseUnit === 'stk') return [0, PRICE_BAND_STK[category] ?? band[1]];
    return band;
  }

  // Rangorden mellem priskilder. Tallet er ikke en kvalitetsscore, kun en
  // rækkefølge — se effectivePrice for hvorfor den skal gå forud for prisen.
  //
  //   manual   et menneske har set hylden
  //   api:rema kædens egen hyldepris, hentet direkte
  //   derived  et gæt ud fra hvad varen har kostet PÅ TILBUD
  //
  // En kilde, der ikke står her, hører bagest: den dag Salling åbner et API,
  // skal 'api:salling' ikke umærkeligt komme forrest, bare fordi ingen nåede
  // at tage stilling til den.
  // Frosset, fordi den eksporteres: uden dette kunne en tilfældig side
  // skrive `engine.SOURCE_RANK.derived = -1` og vende rangordenen om for
  // alle opslag i processen.
  const SOURCE_RANK = Object.freeze({ manual: 0, 'api:rema': 1, derived: 2 });
  const SOURCE_RANK_UNKNOWN = 3;

  // Opslag i et kort, der må være et Map ELLER et almindeligt objekt.
  // Browseren bygger sine kort af JSON, serveren af Map's, og ingen af
  // opslagsfunktionerne her skal kende forskel.
  const lookup = (m, k) => (m instanceof Map ? m.get(k) : m && m[k]) || null;

  // Leksikografisk sammenligning af to taltupler. Bruges til at rangere
  // normalpriser på (kilde, udløbet, pris) i netop den rækkefølge.
  function cmp(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  }

  /**
   * Hvad koster varen i den kæde i dag?
   *
   * Tilbudsprisen overskriver aldrig normalprisen i basen — de to lever i
   * hver sin tabel, og valget træffes her, ved opslaget. Så falder prisen
   * tilbage af sig selv, når tilbuddet udløber, historikken er intakt, og
   * der er ingen særregel for baseline kontra fresh.
   *
   *   offers   `vare|kæde` → aktivt tilbud. Rækken skal bære `base_qty`,
   *            ellers er den ikke en brugbar pris (se herunder) — både
   *            activeOfferMap og `offer_index` leverer den kolonne.
   *   normals  `vare|kæde` → ALLE normalpris-rækker for det par
   *   now      sammenligningstidspunktet, så udløb kan testes
   *   baseUnit varens egen enhed (`items.base_unit`). Angivet: enhver
   *            kandidat i en ANDEN enhed kasseres, før noget sammenlignes.
   *
   * Svaret er `null`, når vi ikke kender nogen pris i den kæde. Ikke nul:
   * en vare til 0 kr ser ud som en gratis vare i et budget, mens `null`
   * siger det, der faktisk er tilfældet — at vi ikke ved det.
   */
  function effectivePrice(itemKey, chainId, { offers, normals, now = new Date(), baseUnit = null } = {}) {
    const k = `${itemKey}|${chainId}`;
    const nowIso = now.toISOString();

    // Enheden tjekkes FØR kandidaterne findes, ikke kun når to skal måles mod
    // hinanden. Sammenligningen længere nede kasserer et tilbud i den forkerte
    // enhed — men kun hvis der er en normalpris at holde det op mod. Er der
    // ingen, blev tilbuddet returneret i den enhed, AVISEN nævnte, og den
    // kalder, der ganger `behov × unit_price`, gangede på tværs af to enheder.
    //
    // Målt i data.db: 257 (vare, kæde)-par har et tilbud i en anden enhed end
    // varens og ingen normalpris overhovedet. `brod` er et af dem — avisen
    // siger 9,90 kr/KG, varen måles i STK — og læst som kr/stk kostede et
    // brød en tredjedel af, hvad det gør.
    //
    // `baseUnit` er valgfri, fordi ikke enhver kalder kender varens enhed
    // (browserens tilbudsliste slår op uden at have `items` ved hånden). Er
    // den ikke givet, gælder den gamle regel alene: bedre end ingen vagt.
    const wrongUnit = (unit) => baseUnit != null && unit !== baseUnit;

    // Tilbuddet skal bære sin egen pakke. `base_qty` er den mængde, prisen
    // gælder, og uden den kan hverken pakkeafrundingen eller kurveprisen
    // regne på rækken — så er tilbuddet ikke en brugbar pris, og
    // normalprisen står tilbage.
    const offer = lookup(offers, k);
    const fromOffer = offer && offer.unit_price > 0 && offer.base_qty > 0
      && !wrongUnit(offer.base_unit)
      ? { pack_qty: offer.base_qty, pack_unit: offer.base_unit,
          pack_price: offer.price, unit_price: offer.unit_price,
          on_offer: true, source: 'offer', stale: false }
      : null;

    // Kilden går FORUD for prisen. De afledte priser er bygget af
    // TILBUDSpriser og ligger systematisk under den rigtige normalpris, så
    // "billigste vinder" ville lade et gæt slå en hyldepris: målt på basen
    // vinder gættet i 10 af de 30 vare/kæde-par, der har flere kilder —
    // boef 199,90 mod 219,44, flaeskesteg 65,83 mod 83,33. Så var hele
    // REMA-hentningen spildt.
    //
    // Først inden for det bedste niveau, der findes, afgør prisen: flere
    // pakkestørrelser er tilladt, og den billigste pr. enhed er
    // udgangspunktet. Selve pakkevalget sker senere, når behovet er kendt.
    let best = null;
    let bestScore = null;
    for (const r of lookup(normals, k) || []) {
      if (!(r.unit_price > 0)) continue;
      // Samme vagt på normalsiden. `item_prices` holder invarianten med en
      // TRIGGER, så basen kan ikke levere en forkert enhed i dag — men
      // browseren bygger sit kort af JSON fra src/sync/build.js, og reglen
      // her må ikke hvile på, at den anden ende er i orden.
      if (wrongUnit(r.pack_unit)) continue;
      // En udløben pris taber til en gyldig på samme niveau, men slår
      // stadig et dårligere niveau: gammelt og rigtigt slår nyt og gættet.
      const stale = r.valid_until != null && r.valid_until < nowIso;
      // hasOwn, ikke `[]`: et opslag gennem Object.prototype ville give
      // source: 'constructor' en Function som rang, `??` ville aldrig
      // fyre, og rækken ville slå `derived`. Basens CHECK holder det ude
      // i dag, men rangordenen skal ikke afhænge af den.
      const rank = Object.hasOwn(SOURCE_RANK, r.source) ? SOURCE_RANK[r.source] : SOURCE_RANK_UNKNOWN;
      const score = [rank, stale ? 1 : 0, r.unit_price];
      if (best && cmp(score, bestScore) >= 0) continue;
      bestScore = score;
      best = { pack_qty: r.pack_qty, pack_unit: r.pack_unit,
               pack_price: r.pack_price, unit_price: r.unit_price,
               on_offer: false, source: r.source, stale };
    }

    // Og her holder rangordenen op. Et tilbud er ikke et gæt på, hvad varen
    // koster — det er en pris, man faktisk kan betale i denne uge — så det
    // konkurrerer på prisen alene mod den vinder, rangordenen fandt.
    if (!fromOffer) return best;
    if (!best) return fromOffer;

    // Men kr/stk og kr/kg er ikke det samme tal. Tilbuddets `base_unit` er
    // AVISENS enhed, ikke varens: den er forskellig fra varens egen i 973 af
    // 2.376 tilbudsrækker, og 130 vare|kæde-par har et tilbud i en anden
    // enhed end deres normalpris. Uden denne linje slår "blomkål 12 kr/STK"
    // en indtastet pris på 18 kr/KG — den højeste tillidskilde i hele
    // rangordenen, kastet væk for et tal, der ikke måler det samme (målt:
    // blomkaal|11deC den ene vej, brod|0b1e8 den anden).
    //
    // `item_prices` holder den samme invariant med en TRIGGER (se
    // src/db/schema.sql); her er der ingen base at spørge, så reglen skal
    // stå i koden.
    //
    // Tilbuddet FORKASTES, det omregnes ikke: `piece_g` er den BRUGBARE
    // vægt, ikke købsvægten, og den vej er prøvet og rullet tilbage i
    // opgave 1, trin 9.
    if (fromOffer.pack_unit !== best.pack_unit) return best;

    return fromOffer.unit_price <= best.unit_price ? fromOffer : best;
  }

  // ── Pakker og spild ────────────────────────────────────────────────────────

  // Hvor tungt en rest tæller som spild. Kartofler til overs er ikke spild;
  // fløde til overs er. Det er forskellen på at optimere mod madspild og at
  // optimere mod et regneark.
  //
  // Frosset af samme grund som SOURCE_RANK: tabellen eksporteres, og en
  // kalder, der satte `engine.WASTE_WEIGHT.perishable = 0`, ville slå
  // spildvægtningen fra for hver eneste madplan i processen.
  const WASTE_WEIGHT = Object.freeze({ perishable: 1, keeps: 0.5, pantry: 0 });

  // Hvor meget det er værd at betale for at undgå en rest, målt som en andel
  // af hvad resten SELV er værd. 0,5 betyder: jeg betaler gerne 50 øre ekstra
  // for at slippe for at smide mad ud for en krone.
  //
  // Det var først et fast kronebeløb pr. enhed, og det var dimensionelt
  // forkert: én 'stk'-enhed er ét æg til 3 kr, mens én 'kg'-enhed kan være
  // oksekød til 200. Målt gav 15 kr/enhed en straf på 22,50 kr for 3 æg til
  // overs fra en 6-pakke, der kostede 20 — mere end pakken selv. Ganget på
  // varens egen enhedspris skalerer reglen af sig selv og kræver ingen nye
  // data: `unit_price` står på hver eneste prisrække.
  //
  // Andelen er stadig et SKØN og ikke et resultat — den er aldrig efterprøvet
  // mod en rigtig kurv og skal ses efter, når de første lister er set.
  //
  // Ingen Object.freeze her, selv om tabellen ovenfor har en: et tal kan ikke
  // muteres, så kaldet ville være en no-op. choosePack læser konstanten, ikke
  // eksporten, og kan derfor ikke flyttes udefra.
  const WASTE_AVERSION = 0.5;

  /**
   * Hvilken pakke, og hvor mange af den, dækker behovet billigst?
   *
   * Man kan ikke købe en halv pose. Skal man bruge 1,3 kg kartofler, koster
   * det to 1 kg-poser eller én 1,5 kg-pose — ikke 1,3 × kiloprisen. Valget
   * mellem to pakkestørrelser afgøres af pris PLUS vægtet spild, hvor resten
   * er sat til det, den selv er værd; på prisen alene ville storposen altid
   * vinde, fordi den er billigst pr. kilo, og madplanen ville systematisk
   * købe mere, end der bliver spist.
   *
   *   need   mængden i varens egen base_unit (kg, l eller stk)
   *   packs  pakkerne, `{ pack_qty, pack_price, unit_price }`. `unit_price` må
   *          mangle — den kan regnes. Se nedenfor: de skal komme fra ÉN kilde.
   *   keeps  `items.keeps`: hvor længe en rest holder. Ukendt værdi vægtes som
   *          'keeps', midt imellem.
   *
   * **`packs` må kun rumme rækker fra det BEDSTE kildeniveau, der findes for
   * (vare, kæde)** — samme rangorden som effectivePrice: manual > api:rema >
   * derived. En pakkestørrelse på en 'derived'-række er ikke en pakke, nogen
   * har set i en butik; den er udledt af, hvad varen tilfældigvis har været på
   * tilbud i. Blandes niveauerne, kan indkøbslisten komme til at bede om en
   * pose, der ikke findes. Funktionen kan ikke selv se forskel — rækkerne
   * bærer ikke deres kilde hertil — så filtreringen hører hos kalderen.
   *
   * Sådan ser basen ud i dag: alle 620 (vare, kæde)-par har præcis ÉN
   * pakkestørrelse i deres bedste kildeniveau. Funktionen *vælger* derfor
   * ikke endnu — den runder op, og det er den halvdel, der betyder mest
   * (0,5 kg kartofler koster en hel 2 kg-pose til 15,95, ikke 3,99).
   * Spildvægtningen får først noget at vælge imellem, når
   * `data/item_prices.csv` bærer flere pakker pr. par. Det er en datamangel
   * og ikke en fejl i reglen her.
   *
   * Og det, der IKKE er med: opskriftsmængder er i BRUGBARE gram, mens man
   * køber hele grøntsager (400 g broccolibuketter kræver et hoved på ~570 g).
   * Udbytte-faktoren hører hjemme lige her — `need` ganges med 1/yield, før
   * der rundes op — men tallene for de ~30 grøntsager findes ikke, og gættede
   * udbytter ville bytte en kendt lille fejl ud med en ukendt (opgave 1,
   * trin 9 og opgave 5).
   *
   * `null`, når der ikke er noget at købe: intet behov, eller ingen brugbar
   * pakke. Ikke en tom pose til 0 kr — se effectivePrice for samme skelnen.
   */
  function choosePack(need, packs, { keeps = 'keeps' } = {}) {
    if (!(need > 0) || !packs || !packs.length) return null;

    // hasOwn, ikke `[]`: et opslag gennem Object.prototype ville give
    // keeps: 'constructor' en Function som vægt, `??` ville aldrig fyre, og
    // spildet blive NaN. Basens CHECK holder de tre lovlige værdier, men
    // kortet kommer også fra browserens JSON.
    const w = Object.hasOwn(WASTE_WEIGHT, keeps) ? WASTE_WEIGHT[keeps] : WASTE_WEIGHT.keeps;

    let best = null;
    let bestScore = null;
    for (const p of packs) {
      if (!(p.pack_qty > 0) || !(p.pack_price > 0)) continue;

      // Flydende tal går ikke rent op. Tre retter à 400 g lægges sammen til
      // 1.2000000000000002, og delt med en 0,4 kg-bakke bliver det
      // 3.0000000000000004 — et rent Math.ceil køber en fjerde bakke og
      // kalder de 400 g for spild. Tolerancen er relativ og ligger mange
      // størrelsesordener under et gram; den kan ikke skjule et rigtigt behov.
      const ratio = need / p.pack_qty;
      const n = Math.ceil(ratio - ratio * 1e-9);
      const bought = n * p.pack_qty;
      // Efter tolerancen kan `bought` lande en flimmer under `need`. En
      // negativ rest er ikke en rest, og den ville tælle som en gevinst.
      const leftover = Math.max(0, bought - need);
      const waste = leftover * w;
      const cost = n * p.pack_price;

      // Resten prissættes til det, den er værd — ikke til et fast beløb pr.
      // enhed. Enhedsprisen kan mangle på en håndskrevet række; den kan
      // altid regnes, og pack_qty er allerede sikret større end nul ovenfor.
      const unit = p.unit_price > 0 ? p.unit_price : p.pack_price / p.pack_qty;

      // Scoren blander kroner og spild og er ikke en pris, nogen kan betale.
      // Den bliver derfor i funktionen: effectivePrice lækkede præcis sådan
      // et sorteringstal, og et tal i en indkøbsliste bliver læst som penge.
      // `cost` går med ud — opskriftsprisen i opgave 6 er bygget af den.
      const score = cost + waste * unit * WASTE_AVERSION;

      // Strengt `<`: ved uafgjort vinder den først i listen, så to kørsler på
      // uændrede data vælger den samme pose (samme argument som cheapestPerItem).
      if (best && score >= bestScore) continue;
      bestScore = score;
      best = { pack_qty: p.pack_qty, pack_price: p.pack_price, packs: n,
               bought, leftover, waste, cost };
    }
    return best;
  }

  // ── Scoring af én opskrift ─────────────────────────────────────────────────

  const round2 = (n) => Math.round(n * 100) / 100;

  // Over dette er mængden næsten altid en fejllæsning ("1 pakke" tolket som
  // kilo). Et enkelt sådant tal ville alene bestemme hele planens prisoverslag.
  //
  // Var 5000 (gram) før opgave 9; amount er nu i kg/l, så grænsen er delt med
  // 1000. Gælder kun kg/l — se qtyInBase: et stykantal styres ikke af denne
  // grænse, for et højt antal (fx "12 æg") er ikke en fejllæsning på samme
  // måde som 90 kg mel er.
  const MAX_SANE_AMOUNT = 5;

  /**
   * Opskriftens mængde omregnet til tilbuddets egen enhed.
   *
   * `amount` er i INGREDIENSENS egen enhed (kg, l eller stk) – amountOf() i
   * src/lib/units.js har regnet den om. `baseUnit` er TILBUDDETS enhed, og de
   * to er IKKE samme tal, når varen selv er stk, men mødes af et kg/l-prissat
   * tilbud (fire tortillas mod et kg-prissat tortilla-tilbud: amount er 4,
   * ikke 4 kg). Derfor tager funktionen `weight` som separat parameter — det
   * er `amount` konverteret til et kg-sammenligneligt tal, allerede udregnet
   * af weightFor() (src/mealplan/generate.js) til nøjagtig denne slags
   * sammenligning (se roleWeight/assignRoles), og sendt med i payloaden af
   * build.js. Bruges `amount` direkte for en stk-vare mod et kg/l-tilbud,
   * prissættes et stykantal som var det en vægt/rumfang — for tortilla er
   * fejlfaktoren 1000/piece_g, 16,7× for høj (verificeret: 4 stk × 90,91
   * kr/kg = 363,64 kr for en ret, der reelt koster ~21,82 kr for 240 g).
   *
   * Styk er stadig en fast 1: vi ved ikke, om tilbuddets "1 stk" er samme
   * pakningsstørrelse som opskriftens "1 stk", så et regnet antal ville give
   * falsk præcision. Sanity-grænsen herunder tjekkes derfor EFTER stk-grenen
   * (koden returnerer på stk, FØR grænsen nås) — ellers ville et højt, men
   * helt normalt stykantal (en bakke æg, 91 linjer i korpus over
   * MAX_SANE_AMOUNT på 5) blive afvist som en fejllæsning. Byt IKKE om på
   * rækkefølgen: det er testet i test/mealplan.test.js.
   *
   * Men nul er et forkert svar. Man kan ikke købe en brøkdel af en avocado, og
   * 38 % af tilbuddene sælges pr. styk – med nul stod hele kæder i
   * indkøbslisten til "0 kr", selvom der lå varer under dem, og planens
   * prisoverslag var systematisk for lavt. Ét stykke er det, man som minimum
   * lægger i kurven, og derfor det konservative gæt.
   */
  function qtyInBase(amount, weight, baseUnit) {
    if (!amount) return null;
    if (baseUnit === 'stk') return 1;
    const measured = weight ?? amount;
    if (isMeasured(baseUnit) && measured <= MAX_SANE_AMOUNT) return measured;
    return null;
  }

  /**
   * Kan enheden sammenlignes på tværs af pakninger?
   *
   * Kilo og liter kan: 60 kr/kg er 60 kr/kg, uanset hvor stor pakken er. Styk
   * kan ikke. "1 stk" er ét æble i ét tilbud og en 2-kilos pose i det næste,
   * så medianprisen pr. styk er ikke en normalpris, men et gennemsnit af to
   * forskellige varer. Derfor prissættes styk-varer kun ud fra det tilbud, vi
   * faktisk har set – aldrig ud fra en median, og der beregnes ingen
   * besparelse på dem.
   */
  function isMeasured(baseUnit) {
    return baseUnit === 'kg' || baseUnit === 'l';
  }

  /**
   * Tilbudskortet reduceret til ÉT billigste tilbud pr. vare.
   *
   * `activeOfferMap()` og Supabase-indekset nøgler på `vare|kæde`, fordi
   * prisreglerne skal kunne spørge, hvad varen koster i den enkelte butik.
   * Scoringen af en opskrift stiller et andet og grovere spørgsmål — "er
   * varen på tilbud et sted i mine butikker, og hvad koster den så billigst?"
   * — og det er dét, denne reduktion svarer på. Den ligger her og ikke i
   * `generate.js`, fordi browseren bygger sit kort af de samme rækker: to
   * kopier af reglen ville før eller siden vælge hver sit tilbud.
   *
   * Nøglen læses som alt FØR det første '|'. Et kort, der stadig nøgler på
   * varen alene, falder derfor uændret igennem — varenøgler er
   * taksonomiens `[a-z0-9_]`-nøgler og indeholder aldrig '|'.
   *
   * `<=` og ikke `<`: ved samme kilopris vinder den først indsatte, og
   * rækkerne kommer sorteret billigst først fra begge kilder. Så er valget
   * det samme hver gang — en plan, der skifter tilbud mellem to kørsler på
   * uændrede data, er ikke til at fejlsøge.
   */
  function cheapestPerItem(offers) {
    const entries = offers instanceof Map
      ? offers.entries() : Object.entries(offers || {});
    // En manglende kilopris må ikke vinde over en rigtig. Kilderne filtrerer
    // dem fra i SQL'en, men kortet kommer også fra browseren.
    const price = (o) => (Number.isFinite(o.unit_price) ? o.unit_price : Infinity);

    const byItem = new Map();
    for (const [key, offer] of entries) {
      if (!offer) continue;
      const itemKey = String(key).split('|')[0];
      const prev = byItem.get(itemKey);
      if (prev && price(prev) <= price(offer)) continue;
      byItem.set(itemKey, offer);
    }
    return byItem;
  }

  /**
   * Hvor stor en del af retten er på tilbud – og hvad koster den cirka?
   *
   * `offers` slår varetype op i det billigste aktive tilbud i brugerens egne
   * butikker. `normalPrices` er varetypens normalpris (median kr/kg) og bruges
   * både som reference for besparelsen og til at prissætte de ingredienser,
   * der ikke er på tilbud.
   */
  function scoreRecipe(recipe, roles, offers, normalPrices) {
    const matched = [];
    const missing = [];
    let estCost = 0, estSavings = 0, pricedCount = 0;

    const consider = (item, role) => {
      const offer = lookup(offers, item.key);
      const normal = lookup(normalPrices, item.key);

      if (offer) {
        const qty = qtyInBase(item.amount, item.weight, offer.base_unit);
        const normalUnit = offer.normal_unit_price != null ? offer.normal_unit_price
          : (normal && normal.base_unit === offer.base_unit ? normal.unit_price : null);

        let cost = null, saving = null;
        if (qty != null) {
          cost = qty * offer.unit_price;
          if (isMeasured(offer.base_unit) && normalUnit != null && normalUnit > offer.unit_price) {
            saving = qty * (normalUnit - offer.unit_price);
          }
        }
        if (cost != null) { estCost += cost; pricedCount++; }
        if (saving != null) estSavings += saving;

        matched.push({
          taxonomy_key: item.key,
          role,
          name: offer.product_name || item.ingredient,
          ingredient: item.ingredient,
          offer_id: offer.offer_id,
          chain: offer.chain,
          chain_id: offer.chain_id,
          heading: offer.heading,
          price: offer.price,
          unit_price: offer.unit_price,
          base_unit: offer.base_unit,
          normal_unit_price: normalUnit,
          amount: item.amount ? round2(item.amount) : null,
          est_cost: cost != null ? round2(cost) : null,
          est_saving: saving != null ? round2(saving) : null,
          image: offer.image,
        });
        return true;
      }

      // Ikke på tilbud – den skal stadig købes, og den skal med i prisen,
      // hvis vi kender varens normalpris.
      // Uden et tilbud er der kun medianen at prissætte efter, og den duer
      // ikke til styk – se isMeasured. Så tælles varen ikke med i prisen
      // frem for at blive sat til et tal, der lige så godt kan være ti gange
      // for højt.
      const qty = normal && isMeasured(normal.base_unit)
        ? qtyInBase(item.amount, item.weight, normal.base_unit) : null;
      if (qty != null && normal.unit_price != null) {
        estCost += qty * normal.unit_price;
        pricedCount++;
      }
      missing.push({
        taxonomy_key: item.key,
        role,
        ingredient: item.ingredient,
        name: normal && normal.name ? normal.name : item.ingredient,
        amount: item.amount ? round2(item.amount) : null,
        est_cost: qty != null && normal.unit_price != null ? round2(qty * normal.unit_price) : null,
      });
      return false;
    };

    const mainHits = roles.mains.map((m) => consider(m, 'main'));
    const supportHits = roles.support.map((s) => consider(s, 'support'));

    const mainCount = mainHits.filter(Boolean).length;
    const supportCount = supportHits.filter(Boolean).length;
    const mainTotal = roles.mains.length;
    const supportTotal = roles.support.length;

    // Hovedråvarer vejer dobbelt: det er dem, planen står og falder med.
    const weighted = (2 * mainCount + supportCount) / Math.max(2 * mainTotal + supportTotal, 1);
    const servings = recipe.servings && recipe.servings > 0 ? recipe.servings : 4;

    return {
      matched,
      unmatched: missing,
      mains: roles.mains.map((m, i) => ({
        taxonomy_key: m.key, ingredient: m.ingredient, on_offer: mainHits[i],
      })),
      match_count: matched.length,
      considered: mainTotal + supportTotal,
      main_count: mainCount,
      main_total: mainTotal,
      support_count: supportCount,
      support_total: supportTotal,
      main_on_offer: mainTotal > 0 ? mainHits[0] === true : false,
      mains_all_on_offer: mainTotal > 0 && mainCount === mainTotal,
      main_coverage: mainTotal ? mainCount / mainTotal : 0,
      support_coverage: supportTotal ? supportCount / supportTotal : 1,
      coverage: round2(weighted),
      est_cost: round2(estCost),
      est_cost_per_serving: round2(estCost / servings),
      est_savings: round2(estSavings),
      priced_ingredients: pricedCount,
    };
  }

  // ── Udvælgelse ─────────────────────────────────────────────────────────────

  const DAYS = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];

  // Nøk til danske opskrifter i rangeringen. Sat lavt med vilje: en dansk ret
  // skal vinde over en engelsk, der ligger tæt på – ikke over en, der dækker
  // ugens tilbud mærkbart bedre. Til sammenligning vejer tilbudsdækningen 0,40.
  const LANG_BONUS = 0.07;

  /** Lille deterministisk PRNG, så et givet seed altid giver samme plan. */
  function seededNoise(seed, id) {
    let h = (seed ^ (id * 2654435761)) >>> 0;
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;  h >>>= 0;
    return (h % 1000) / 1000;                        // 0…1
  }

  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return { week, year: d.getUTCFullYear() };
  }

  /**
   * Bygger ugens plan.
   *
   *   recipes       [{ id, title, …, tier_score, items: [{key,cat,essential,amount,ingredient}] }]
   *   offers        `vare|kæde` → billigste aktive tilbud i den kæde. Et kort
   *                 nøglet på varen alene virker også — se cheapestPerItem.
   *   normalPrices  varetype → { unit_price, base_unit, name }
   *   recentIds     opskrifter fra de seneste ugers planer; de trykkes ned
   */
  function buildPlan({
    tier = 'classic',
    tierLabel = '',
    recipes = [],
    offers = new Map(),
    normalPrices = new Map(),
    days = 7,
    seed = 0,
    variety = 0.18,
    recentIds = null,
    chainIds = null,
    chainNames = null,
    at = new Date(),
  } = {}) {
    const recent = recentIds instanceof Set ? recentIds
      : new Set(Array.isArray(recentIds) ? recentIds : []);

    // Kortet kommer nøglet på `vare|kæde`. Scoringen skal have ét tilbud pr.
    // vare, og tallet i `offers_available` betyder "varer på tilbud" i
    // brugerfladen — ikke vare/kæde-par. Begge dele kommer af den samme
    // reduktion, regnet én gang for hele planen.
    const offerByItem = cheapestPerItem(offers);
    const offerCount = offerByItem.size;

    // 1) Scor alt én gang. Scoren afhænger ikke af kravniveauet – kun af
    //    hvilke varer der er på tilbud – så den skal ikke regnes forfra,
    //    når kravet lempes.
    const scored = [];
    for (const r of recipes) {
      const roles = assignRoles(r.items, { unknownMain: r.unknown_main });
      if (!roles.mains.length) continue;                  // ingen bærende råvare
      if (roles.mains.length + roles.support.length < 2) continue;
      const s = scoreRecipe(r, roles, offerByItem, normalPrices);
      // main/starch kommer fra den fælles varietyKeys, så spærren tæller på
      // det samme i buildPlan og i sharedWeek.
      scored.push({ recipe: r, roles, score: s, ...varietyKeys(roles) });
    }

    // 2) Vælg det strengeste krav, der stadig giver nok at vælge imellem.
    //    Feltet skal være større end ugen selv – ellers er der ingen variation
    //    at hente, og "Ny plan" ville give samme syv retter igen.
    const target = Math.max(days * 2, days);
    let level = LEVELS[LEVELS.length - 1];
    let pool = [];
    for (const lv of LEVELS) {
      const p = scored.filter((c) => qualifies(c.score, lv));
      if (p.length > pool.length) { level = lv; pool = p; }
      if (p.length >= target) { level = lv; pool = p; break; }
    }

    // 3) Ranger. Tilbudsdækning vejer tungest, men sporet skal stadig kunne
    //    skubbe en ret ud, hvis den ikke passer.
    for (const cand of pool) {
      const tierScore = cand.recipe.tier_score ?? 0;
      let total = 0.40 * cand.score.coverage
                + 0.20 * cand.score.main_coverage
                + 0.30 * tierScore
                + 0.10 * Math.min(cand.score.est_savings / 40, 1)
                // Appen er dansk, og en madplan man skal lave i aften, læses
                // lettere på sit eget sprog. Bevidst et lille nøk og ikke et
                // filter: Gourmet-sporet henter det meste fra engelske kilder,
                // og en uge uden gourmetretter ville være en dårligere plan
                // end en uge med engelske titler.
                + (cand.recipe.lang === 'da' ? LANG_BONUS : 0);
      cand.repeat = recent.has(cand.recipe.id);
      if (cand.repeat) total -= 0.22;         // var med i en af de sidste ugers planer
      total += seededNoise(seed, cand.recipe.id) * variety;
      cand.tierScore = tierScore;
      cand.total = total;
    }
    pool.sort((a, b) => b.total - a.total);

    // 4) Grådigt valg med variation. Spærren er den fælles — se VARIETY_PASSES.
    const chosen = [];
    const tally = varietyTally();
    for (const pass of VARIETY_PASSES) {
      for (const cand of pool) {
        if (chosen.length >= days) break;
        if (chosen.some((c) => c.recipe.id === cand.recipe.id)) continue;
        if (!tally.allows(cand, pass)) continue;
        chosen.push(cand);
        tally.add(cand);
      }
      if (chosen.length >= days) break;
    }

    const plan = {
      tier,
      tier_label: tierLabel,
      generated_at: new Date().toISOString(),
      ...isoWeek(at),
      chain_ids: chainIds,
      chain_names: chainNames,
      seed,
      offers_available: offerCount,
      candidates_scored: scored.length,
      candidates_qualified: pool.length,
      rule: {
        level: level.id,
        label: level.label,
        relaxed: level.id !== LEVELS[0].id,
      },
      est_cost: round2(chosen.reduce((a, c) => a + c.score.est_cost, 0)),
      est_savings: round2(chosen.reduce((a, c) => a + c.score.est_savings, 0)),
      days: chosen.map((c, i) => ({
        day: i,
        day_name: DAYS[i % 7],
        recipe: {
          id: c.recipe.id,
          title: c.recipe.title,
          url: c.recipe.url,
          image: c.recipe.image,
          source: c.recipe.source,
          source_name: c.recipe.source_name,
          servings: c.recipe.servings,
          total_minutes: c.recipe.total_minutes,
          kcal: c.recipe.kcal,
          protein_g: c.recipe.protein_g,
          carbs_g: c.recipe.carbs_g,
          nutrition_src: c.recipe.nutrition_src,
        },
        tier_score: c.tierScore,
        ...c.score,
      })),
    };

    if (!plan.days.length) {
      plan.error = offerCount === 0
        ? 'Der er ingen aktive tilbud i de valgte butikker. Vælg flere butikker, eller hent ugens tilbudsaviser.'
        : 'Ingen retter kunne bygges af tilbuddene i de valgte butikker. Prøv at vælge en butik mere.';
    }
    return plan;
  }

  // ── Indkøbsliste ───────────────────────────────────────────────────────────

  /**
   * Samlet indkøbsliste: det, der er på tilbud, grupperet efter butik – og
   * resten som én liste, for den skal jo også købes.
   */
  function shoppingList(plan) {
    const byChain = new Map();
    const rest = new Map();

    for (const day of plan.days || []) {
      for (const m of day.matched || []) {
        if (!byChain.has(m.chain)) byChain.set(m.chain, new Map());
        const items = byChain.get(m.chain);
        const prev = items.get(m.taxonomy_key);
        if (prev) {
          prev.amount = round2(prev.amount + (m.amount || 0));
          prev.est_cost = round2(prev.est_cost + (m.est_cost || 0));
          prev.est_saving = round2(prev.est_saving + (m.est_saving || 0));
          prev.used_in.push(day.recipe.title);
        } else {
          items.set(m.taxonomy_key, {
            name: m.name, heading: m.heading, chain: m.chain, role: m.role,
            price: m.price, unit_price: m.unit_price, base_unit: m.base_unit,
            amount: m.amount || 0, est_cost: m.est_cost || 0, est_saving: m.est_saving || 0,
            image: m.image, used_in: [day.recipe.title],
          });
        }
      }

      for (const u of day.unmatched || []) {
        const prev = rest.get(u.taxonomy_key);
        if (prev) {
          prev.amount = round2(prev.amount + (u.amount || 0));
          prev.est_cost = round2(prev.est_cost + (u.est_cost || 0));
          prev.used_in.push(day.recipe.title);
        } else {
          rest.set(u.taxonomy_key, {
            name: u.name || u.ingredient, role: u.role,
            amount: u.amount || 0, est_cost: u.est_cost || 0,
            used_in: [day.recipe.title],
          });
        }
      }
    }

    return {
      on_offer: [...byChain.entries()].map(([chain, items]) => ({
        chain,
        items: [...items.values()].sort((a, b) => b.est_saving - a.est_saving),
        total: round2([...items.values()].reduce((a, i) => a + i.est_cost, 0)),
        savings: round2([...items.values()].reduce((a, i) => a + i.est_saving, 0)),
      })).sort((a, b) => b.savings - a.savings),

      rest: [...rest.values()].sort((a, b) => b.used_in.length - a.used_in.length),
    };
  }

  // ── Ugen, sat sammen så pakkerne bliver brugt op ───────────────────────────

  // Kategorier, hvor et 'optional'-flag ikke skal tros. En ret med valgfri
  // kylling er ikke en ret.
  //
  // OPTIONAL_RE i src/recipes/extract.js matcher `optional` og `if you like`
  // HVOR SOM HELST i linjen, mens de danske mønstre er forankret til
  // linjestart. "4 chicken breasts (skinless, if you like)" blev derfor
  // flaget, og flaget fjerner linjen fra både prisen og nævneren: et fejlflag
  // bliver til "fuldt prissat og næsten gratis". Grænsen trækkes, hvor den
  // kan siges enkelt: en hovedprotein er aldrig valgfri.
  //
  // Reglen stod først i scripts/recompute-recipe-costs.js alene. Den hører
  // her, fordi ugens kurv og opskriftens pris SKAL svare til hinanden —
  // købte ugen den valgfri persille, mens recipe_costs lod være, ville de to
  // tal, brugeren ser side om side, være regnet på hver sin ret.
  const MAIN_PROTEIN = new Set(['meat', 'poultry', 'fish']);

  /**
   * Skal denne ingredienslinje overhovedet købes?
   *
   *   line  `{ key, amount, optional }` fra loadRecipes
   *   meta  varens række i `items` (class, category)
   *
   * Basisvarer står allerede i skabet, og "evt. et skvæt fløde" købes ikke.
   * Begge dele skal være samme regel hos alle kaldere — se MAIN_PROTEIN.
   */
  function isBoughtLine(line, meta) {
    if (!line || !meta || meta.class === 'essential') return false;
    if (line.optional && !MAIN_PROTEIN.has(meta.category)) return false;
    return true;
  }

  /**
   * Har retten en hovedråvare — er den overhovedet aftensmad?
   *
   * `assignRoles` svarer allerede på det og bruges af buildPlan til netop
   * dette, men den har en reserve-regel: uden kød peger den på den tungeste
   * BÆRENDE råvare, så en vegetarret stadig har noget at planlægge om. Den
   * regel er for mild her. Målt mod de prissatte REMA-opskrifter foreslog
   * ugen hasselnøddesirup, hot honey, mørdej og en roux som fire dages
   * aftensmad — mel og smør er `grain` og `dairy`, og reserve-reglen lod dem
   * passere som "hovedråvare". Derfor kræves en rigtig hovedrolle:
   * kød, fjerkræ, fisk, æg eller bælgfrugt.
   *
   * Tærsklerne kommer gratis med fra assignRoles: 20 g ansjoser i en gryde er
   * pynt (MAIN_MIN_AMOUNT) og bliver ikke til en fiskeret.
   *
   * **Reglen er: en middag har et protein eller en bælgfrugt. Den grænse er
   * VALGT, ikke fundet.** Prisen for den er de rene grøntsagsretter, de
   * mælkebaserede retter og ostepastaretterne: porre-kartoffelsuppe,
   * risengrød, grønlangkål, Macaroni and Cheese og cacio e pepe er alle ude.
   * Det er ikke en glemt kategori, og det er ikke et hul, der bare skal
   * lukkes — begge de oplagte måder at lukke det på er målt og forkastet:
   *
   *   'cheese' i MAIN_CATS: gevinsten kom aldrig (Macaroni and Cheese lå
   *   nr. 94 af 128 og ville ikke blive vist), og prisen var 15,6 % af
   *   korpusset, der skiftede hovedråvare. Se kommentaren ved MAIN_CATS.
   *
   *   Et gulv på købt vægt pr. portion: fordelingerne for de beholdte og de
   *   udelukkede overlapper næsten helt (median 0,311 mod 0,215 kg). Et gulv
   *   på 0,10 kg lukker **Mørdej** ind — den ret, hele filteret findes for —
   *   og ingen værdi henter Macaroni and Cheese uden også at hente smoothies
   *   og pærecrumble. De to tungeste udelukkede er risengrød og en grøn
   *   smoothie. Vægt måler ikke, om noget er aftensmad.
   *
   * To ting, filteret ikke kan, og som ikke skal løses her:
   *
   * 1. **Det skelner ikke en middag fra et tilbehør.** Pea purée har ærter
   *    og er dermed "aftensmad"; målt lå den nr. 4 af 128 og stod i et
   *    forslag. Den ligger højt af præcis den grund, den ikke burde være
   *    der: den er billig pr. portion, FORDI den er tilbehør. Ingen vægtning
   *    retter det — hverken SCORE_KR eller spildleddet — for de måler
   *    kroner, og det her er viden om, hvad en ret ER. Den viden hører i
   *    `score_classic`, plan 1's klassifikator.
   *
   * 2. **Filteret kan kun være så godt som koblingen mellem ingrediens og
   *    vare.** Målt: "100ml strong espresso" er koblet til varen `bonner`
   *    (bælgfrugt) med mængden 0,1 kg, og derfor har en café con leche en
   *    "hovedråvare" — den lå nr. 3 af 128. Den hører til i den voksende
   *    liste over fejlkoblinger fra plan 1: "Apple iPad" på æble,
   *    Cerave-creme på fløde, "1 tsk dijonsennep" på ketchup. Rettes i
   *    taksonomien, ikke her.
   *
   * De to står sammen, fordi de ser ens ud udefra — en billig ret, der ikke
   * er aftensmad, øverst på listen — men kun den ene er en fejl i data.
   */
  /**
   * Opskriftens linjer i den form, assignRoles vil have dem.
   *
   * Rollerne læses af VARETABELLEN og ikke af linjens eget `cat`-felt: den,
   * der har `items` ved hånden, skal have kategorien ét sted fra. buildPlan
   * bruger linjens felt, fordi den ikke har tabellen — ikke fordi de to må nå
   * frem til hver sit svar.
   */
  function roleLines(recipe, items) {
    return ((recipe && recipe.items) || []).map((it) => {
      const meta = items.get(it.key);
      return {
        key: it.key,
        cat: meta ? meta.category : it.cat || null,
        essential: meta ? meta.class === 'essential' : Boolean(it.essential),
        amount: it.amount,
        weight: it.weight,
      };
    });
  }

  function hasMainCourse(recipe, items) {
    const { mains } = assignRoles(roleLines(recipe, items),
      { unknownMain: Boolean(recipe.unknown_main) });
    return mains.some((m) => MAIN_CATS.has(m.cat));
  }

  // Portionsantal, når opskriften ikke siger det. 4 er både det hyppigste tal
  // i basen (80 af de prissatte) og det, resten af appen regner i.
  const DEFAULT_SERVINGS = 4;

  // Hvad ugens spor-score er værd i kroner PR. PORTION. En ret med score 1,0
  // må koste SCORE_KR mere pr. portion end en med score 0,0, før den taber.
  // Det er det eneste sted, "god mad" og "billig mad" gøres sammenlignelige,
  // og derfor skal tallet måles og ikke gættes.
  //
  // Målt over de 117 kandidater, der er tilbage efter hovedråvare-kravet
  // (REMA 1000, hyldepriser, ingen aktive tilbud i ugen), med opskrifterne
  // skaleret til husstanden:
  //
  //   marginal pr. portion   p10 15,75   median 31,43   p90 56,15   spænd 40,40 kr
  //   score_classic          p10  0,52   median  0,87   p90  1,00   spænd  0,48
  //
  // 40,40 / 0,48 = 84,2, og **SCORE_KR = 84**: kvalitetsleddet spænder lige
  // så meget som prisleddet over de midterste 80 % af kandidaterne, og
  // hverken pris eller score kan afgøre ugen alene.
  //
  // Tallet er målt hver gang puljen har ændret sig, og historien er værd at
  // kende: 40 (gættet) → 167 (målt før skaleringen) → 84 (målt efter) → 80
  // (målt mens 'cheese' var en hovedkategori) → 84 igen, da osten blev
  // rullet tilbage. At det lander på sit gamle tal, efter en ændring er
  // trukket tilbage, er den kontrol man kan håbe på.
  //
  // Springet fra 167 var derimod reelt: skaleringen halverede prisleddets
  // spænd, og 167 gav scoren dobbelt vægt — forslag B blev fire
  // kyllingeretter i træk til 278 kr. Yderpunkterne står fast som kontrol:
  // ved 40 afgør prisen alene (ugen fyldes med 10-portions-deller), ved 250
  // afgør scoren alene.
  //
  // Bemærk hvad der IKKE er et argument: den monotone kyllingeuge delte
  // 1,3 kg kyllingebryst over tre retter og sparede 122,90 kr — det bedste
  // delingstal i hele målingen. Deling er et bindeled, ikke et mål.
  //
  // Det er stadig ikke et resultat: ÉN kæde, hyldepriser uden aktive tilbud,
  // og score_classic er tæt pakket (mere end hver tiende ret har 1,00). Skal
  // ses efter igen, når rigtige madplaner har været i hænderne på nogen.
  const SCORE_KR = 84;

  // Hvad det koster en ret at stå i det ANDET forslag allerede. Stor nok til
  // at slå enhver kurveforskel, så forslag B bygges af andre retter — men
  // endelig, så ugen stadig kan fyldes, når der ikke er andre tilbage: er
  // kun fravalgte retter i spil, bærer de den alle sammen, og rækkefølgen
  // mellem dem er uændret.
  const AVOID_PENALTY = 1e4;

  // Mængden, som den skal SES. round2 er rigtig for en pris, men 3 g hvidløg
  // bliver til 0 med to decimaler, og "deler 0 kg Hvidløg over 4 retter" er
  // ikke en forklaring — det er en fejl, der ser ud som en oplysning. Små
  // mængder beholder derfor betydende cifre i stedet for faste decimaler.
  // Fundet, da skaleringen til husstanden gjorde mængderne mindre.
  const roundQty = (n) => {
    if (!(n > 0)) return 0;
    const digits = Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(n))));
    const f = 10 ** digits;
    return Math.round(n * f) / f;
  };

  /**
   * Byg en uge ved grådigt at tilføje den ret, der giver mest for pengene.
   *
   * Målet er ikke laveste pris alene: en uge, hvor hver ret trækker sin egen
   * pose op af fryseren, er dyrere i spild end i kroner. Derfor scorer vi
   * marginalt — hvad koster retten OVEN I det, vi allerede køber — så en ret,
   * der bruger resten af noget, vi har, vinder over en lige så god ret, der
   * kræver en ny vare. Det var præcis det, der blev bedt om: køber man 1 kg
   * kartofler til én ret, skal en anden ret bruge resten.
   *
   *   candidates  opskrifter fra loadRecipes, med `score` (sporets score)
   *   days        hvor mange retter ugen skal have
   *   items       `items`-tabellen som Map: class, category, keeps, base_unit
   *   offers      `vare|kæde` → aktivt tilbud   (som effectivePrice vil have dem)
   *   normals     `vare|kæde` → normalpris-rækker
   *   chainIds    de kæder, der må handles i
   *   servings    hvor mange der spiser med. Opskrifterne skaleres til det.
   *   avoid       Set af opskrift-id'er, der skal vige (se twoProposals)
   */
  function sharedWeek(candidates, {
    days = 5, seed = 0, servings = DEFAULT_SERVINGS,
    items = new Map(), offers = new Map(), normals = new Map(),
    chainIds = [], avoid = null, now = new Date(),
  } = {}) {
    // Husstanden, ikke opskriftens eget portionsantal. 0 eller negativ er
    // ikke en husstand og ville gøre hele kurven til nul eller negativ.
    const household = servings > 0 ? servings : DEFAULT_SERVINGS;
    const picks = [];
    const basket = new Map();   // vare → samlet behov i varens base_unit

    // Uden butikker er der ingen priser, og uden priser koster hver eneste
    // ret nul. En uge med retter i og 0 kr på er en løgn; en tom uge er
    // sandheden og kan ses med det samme. Derfor bygges der ikke videre.
    if (!chainIds || !chainIds.length) {
      return { picks: [], cost: 0, waste: 0, shared: [] };
    }

    // Den grådige løkke prissætter HELE kurven om for hver kandidat på hver
    // dag. Uden et memo slås den samme (vare, kæde) op titusindvis af gange
    // for én uge, og svaret er det samme hver gang — priserne kan ikke ændre
    // sig midt i en kørsel.
    const priceMemo = new Map();
    const priceIn = (key, chainId, meta) => {
      const mk = `${key}|${chainId}`;
      if (priceMemo.has(mk)) return priceMemo.get(mk);
      const p = effectivePrice(key, chainId,
        // `baseUnit` er ikke pynt: uden den kan effectivePrice returnere et
        // tilbud i AVISENS enhed, når varen ingen normalpris har, og så
        // regnes et behov i stk mod en kilopris (opgave 6).
        { offers, normals, now, baseUnit: meta.base_unit });
      priceMemo.set(mk, p);
      return p;
    };

    /** Rettens behov pr. VARE — ikke pr. linje: samme vare står ofte flere gange. */
    const needsOf = (rec) => {
      const out = new Map();
      // Opskriften skaleres til husstanden. Uden det købes retten, som den er
      // skrevet: målt lå to retter til TI personer i den samme uge som to til
      // fire, og man køber ikke ti portioner majsdeller til én aftensmad.
      // Skaleringen ændrer ikke, hvilke retter der vælges — marginalen blev
      // allerede målt pr. portion — men den ændrer kurven, prisen og hvad der
      // reelt kan deles, og det er den halvdel, brugeren mærker.
      const factor = household / (rec && rec.servings > 0 ? rec.servings : DEFAULT_SERVINGS);
      for (const it of (rec && rec.items) || []) {
        const meta = items.get(it.key);
        if (!isBoughtLine(it, meta)) continue;
        // `amount`, ikke `weight`. `weight` er en ROLLEVÆGT — stykantal
        // omregnet til kilo, så assignRoles kan sammenligne 6 æg med 0,4 kg
        // kylling — mens `amount` er mængden i varens EGEN enhed, og det er
        // den, prisen er målt i.
        const need = it.amount * factor;
        if (need > 0) out.set(it.key, (out.get(it.key) || 0) + need);
      }
      return out;
    };

    /**
     * Et stykke kan ikke deles: 0,8 æg er ét æg.
     *
     * Oprundingen sker HER og ikke i needsOf, og forskellen er målbar. Ligger
     * den i needsOf, rundes hver ret op for sig, og fire retter à 0,4 æg
     * køber fire æg, hvor to slår til. Behovet skal lægges sammen først og
     * rundes op bagefter — præcis samme regel som pakkeafrundingen, og af
     * samme grund.
     */
    const wholeUnits = (meta, need) => (meta.base_unit === 'stk' ? Math.ceil(need) : need);

    /**
     * Hvor køber vi varen, hvilken pakke, og hvad koster det?
     *
     * ÉN funktion, fordi kurven og forklaringen SKAL være enige. Her stod
     * først to: kurven valgte kæde på pris plus værdien af spildet, mens
     * forklaringen valgte på enhedspris alene — med en kommentar om, at de
     * delte regnestykke. De var uenige for 49 af de 76 varer, der har priser
     * i mere end én kæde, typisk kød, hvor den laveste kilopris kommer i en
     * større pakke.
     *
     * Følgen var ikke kosmetisk. Målt på en uge til 149,15 kr påstod
     * payloaden 119,56 kr sparet, hvor kurven sparede 76,95 — kyllingelinjen
     * alene lå 47 % for højt. Og da valget af kæde også vælger PAKKEN, løj
     * den om antallet af poser, ikke bare om kronerne. Det er sætningen,
     * brugeren læser, så to regnestykker må der ikke være.
     *
     * Spildet vægtes i kroner, ikke i enheder: en kurv rummer både kilo
     * kartofler og stykker æg, og lagde man dem sammen først, adderede man to
     * ting uden fælles enhed. `choosePack` giver ikke sin interne score fra
     * sig — med vilje — så sammenligningen mellem kæder regnes her, af de
     * felter, den DA giver.
     */
    const bestPackFor = (key, meta, need) => {
      const n = wholeUnits(meta, need);
      let best = null;
      for (const chainId of chainIds) {
        const price = priceIn(key, chainId, meta);
        if (!price) continue;
        const pack = choosePack(n, [price], { keeps: meta.keeps });
        if (!pack) continue;
        const unit = price.unit_price > 0
          ? price.unit_price
          : price.pack_price / price.pack_qty;
        const kr = pack.waste * unit * WASTE_AVERSION;
        const score = pack.cost + kr;
        if (best && score >= best.score) continue;
        best = { price, pack, kr, score };
      }
      return best;
    };

    /**
     * Kan HELE retten prissættes? Tre ting kan ellers gøre den gratis, og
     * alle tre er målt i basen:
     *
     *  1. en vare uden pris i nogen af de valgte kæder;
     *  2. en ingrediens, taksonomien slet ikke kender. Den når aldrig ind i
     *     `recipe.items`, så motoren kan ikke selv se den — kun den, der læste
     *     opskriften, kan tælle den, og det er `unknown_count` fra
     *     loadRecipes. 678 af 2.208 opskrifter har mindst én;
     *  3. en KENDT vare uden mængde ("et stykke ingefær"). needsOf springer
     *     den over, og så er den gratis. Målt: "Pork noodle stir-fry" stod
     *     som fuldt prissat uden at købe ingefæren.
     *
     * Det er samme regel som `recipe_costs.priceable`, regnet uden basen — så
     * en ret er prissætbar begge steder eller ingen af dem.
     */
    const canPrice = (rec) => {
      if (rec.unknown_count > 0) return false;
      for (const it of (rec && rec.items) || []) {
        const meta = items.get(it.key);
        if (!isBoughtLine(it, meta)) continue;
        if (!(it.amount > 0)) return false;
        if (!chainIds.some((chainId) => priceIn(it.key, chainId, meta))) return false;
      }
      return true;
    };

    const basketCost = (b) => {
      let cost = 0; let wasteKr = 0;
      for (const [key, need] of b) {
        const meta = items.get(key);
        if (!meta) continue;
        const best = bestPackFor(key, meta, need);
        if (best) { cost += best.pack.cost; wasteKr += best.kr; }
      }
      return { cost, wasteKr };
    };

    // ── Hvilke retter må komme i betragtning? ────────────────────────────────
    //
    // To krav, begge bløde: kan intet opfylde dem, er en dårlig uge bedre end
    // ingen uge, og kalderen kan ikke se forskel på "ingen retter" og
    // "motoren sagde nej".
    //
    // 1. En ret uden hovedråvare er ikke aftensmad. Uden det greb den
    //    grådige regel det billigste i basen, og det billigste er sirup,
    //    hot honey og en roux — se hasMainCourse.
    //
    // 2. En ret, vi ikke kan prissætte, ser GRATIS ud. basketCost springer en
    //    vare uden pris over — den koster nul og spilder nul — så reglen
    //    griber efter de opskrifter, basen ved mindst om. Målt: får
    //    twoProposals alle 2.208 opskrifter, har alle otte valgte retter
    //    priceable = 0, og en havbars-middag står til 6 kr, fordi tre
    //    fjerdedele af dens ingredienser er usynlige.
    //
    //    Det er samme fejl som sirup-ugen, et lag længere nede: dengang
    //    manglede KVALITETEN modvægt, her er selve prisen fiktion. Og her
    //    står det forkerte tal på skærmen.
    const withMain = (candidates || []).filter((c) => hasMainCourse(c, items));
    const priced = withMain.filter(canPrice);
    const pool = priced.length ? priced : (withMain.length ? withMain : (candidates || []));

    let current = basketCost(basket);

    // Variationsspærren, den samme som buildPlan bruger. Den står INDE i den
    // grådige løkke og ikke som et forfilter, fordi hvilken ret der må være
    // den tredje afhænger af, hvad de to første blev.
    //
    // Uden den bliver ugen ensformig, netop FORDI delingen belønner det: tre
    // ærteretter deles om én pose ærter, og det er den billigste uge, der
    // findes. Målt gav det Ærtesuppe, Pea purée og Pasta med ærter og citron
    // i samme forslag, og før det fire kyllingeretter i træk. Brugeren sagde
    // det selv i designfasen: en uge behøver ikke være kylling hele vejen.
    const tally = varietyTally();
    const varietyMemo = new Map();
    const keysOf = (cand) => {
      if (!varietyMemo.has(cand.id)) {
        varietyMemo.set(cand.id, varietyKeys(assignRoles(roleLines(cand, items),
          { unknownMain: Boolean(cand.unknown_main) })));
      }
      return varietyMemo.get(cand.id);
    };

    while (picks.length < days) {
      let bestPick = null;

      // Første runde med spærren; er der ingen ret, der må komme ind, gælder
      // [99, 99], og ugen bliver fyldt. En uge med for få retter er ikke et
      // bedre svar end en ensformig uge.
      for (const pass of VARIETY_PASSES) {
        for (const cand of pool) {
          if (picks.some((p) => p.id === cand.id)) continue;
          if (!tally.allows(keysOf(cand), pass)) continue;

          const merged = new Map(basket);
          for (const [k, v] of needsOf(cand)) merged.set(k, (merged.get(k) || 0) + v);
          const after = basketCost(merged);

          // Marginal pris + marginalt spild, modregnet sporets score. Begge led
          // er kroner, så der er intet at gange med. Støjen gør, at "Ny plan"
          // ikke giver præcis samme uge hver gang.
          const marginal = (after.cost - current.cost)
                         + (after.wasteKr - current.wasteKr);

          // …og marginalen måles PR. PORTION. Portionsantallet går fra 1 til 12
          // blandt de prissatte opskrifter (19 af dem siger 1, 8 siger intet),
          // og uden normaliseringen sammenlignes en ret til én person med en
          // ret til tolv. Retten til én vinder hver gang, fordi den køber
          // mindst — ikke fordi den er billigere at spise.
          //
          // Der divideres med HUSSTANDEN og ikke med opskriftens eget tal:
          // needsOf har allerede skaleret retten til husstanden, så alle
          // kandidater måles på lige mange portioner. Divisoren er dermed den
          // samme for dem alle og kan ikke flytte rangordenen — den holder kun
          // leddet i samme størrelsesorden som SCORE_KR, der blev målt på
          // netop kroner pr. portion.
          const perServing = marginal / household;

          const score = (cand.score || 0) * SCORE_KR - perServing
                      + seededNoise(seed, cand.id)
                      - (avoid && avoid.has(cand.id) ? AVOID_PENALTY : 0);

          if (!bestPick || score > bestPick.score) bestPick = { cand, merged, after, score };
        }
        if (bestPick) break;            // den strenge spærre rakte
      }

      if (!bestPick) break;
      picks.push(bestPick.cand);
      tally.add(keysOf(bestPick.cand));
      basket.clear();
      for (const [k, v] of bestPick.merged) basket.set(k, v);
      current = bestPick.after;
    }

    // Hvad deles der FAKTISK? Det er forklaringen, brugeren får at se, og
    // den skal kunne holde.
    //
    // "Bruges af to retter" er ikke det samme som "deles". To retter, der
    // hver bruger en hel 1 kg-pose, deler ingenting — der købes to poser.
    // Deling er, at ugen slipper med FÆRRE PAKKER, end retterne ville koste
    // hver for sig. Det er den forskel, brugeren bad om, og den kan måles:
    // choosePack(hele behovet).packs mod summen af choosePack(hver rets
    // behov).packs. Kun når forskellen er positiv, er der sparet noget.
    const shared = [];
    for (const [key, need] of basket) {
      const users = picks.filter((p) => needsOf(p).has(key));
      if (users.length < 2) continue;

      const meta = items.get(key);
      if (!meta) continue;
      // Samme funktion som kurven bruger — så besparelsen er regnet i den
      // butik og på den pakke, ugen faktisk køber i. Se bestPackFor.
      const best = bestPackFor(key, meta, need);
      if (!best) continue;

      const together = best.pack;
      let apart = 0;
      for (const u of users) {
        // Hver for sig købes der i den SAMME butik: spørgsmålet er, hvad
        // sammenlægningen sparer, ikke hvad en anden butik ville have kostet.
        const own = wholeUnits(meta, needsOf(u).get(key) || 0);
        const pack = choosePack(own, [best.price], { keeps: meta.keeps });
        if (pack) apart += pack.packs;
      }
      const saved = apart - together.packs;
      if (saved > 0) {
        shared.push({
          key,
          name: meta.name || key,
          unit: meta.base_unit,
          used: users.length,
          need: roundQty(wholeUnits(meta, need)),
          saved,
          // Besparelsen i kroner, så opgave 8 kan vise den uden at regne
          // pakkeprisen ud igen — og uden at kunne komme til at bruge en
          // anden butiks pris end den, tallet blev målt i.
          saved_kr: round2(saved * together.pack_price),
        });
      }
    }
    shared.sort((a, b) => b.saved_kr - a.saved_kr || b.saved - a.saved || b.used - a.used);

    // `current.wasteKr`, ikke `current.waste`: kurven regner spild i kroner,
    // og feltet hedder derfor det. Et opslag på det gamle navn giver
    // undefined, og round2(undefined) er NaN — et tal, der ser ud som et tal.
    return { picks, cost: round2(current.cost), waste: round2(current.wasteKr), shared };
  }

  /**
   * To uger, der er tilstrækkeligt forskellige til at være et valg.
   *
   * Samme algoritme, forskelligt udgangspunkt. Vi prøver flere frø og tager
   * det første par, der deler højst én ret — to forslag med fire fælles
   * retter er ikke to forslag.
   *
   * Frøet alene rækker ikke. Støjen er under én krone, mens to retter typisk
   * er hundrede kroner fra hinanden i marginal pris, så den grådige løkke
   * vælger det samme hver gang; frøet kan kun vende et uafgjort. Derfor er
   * sidste udvej at bygge B med A's retter FRAVALGT — det er stadig den
   * samme algoritme, den må bare ikke gribe efter de samme retter først.
   *
   * Og er der færre kandidater end dage, er de to uger nødt til at ligne
   * hinanden: så beholdes den MINDST ens, ikke bare den første, der blev
   * prøvet. Brugeren skal i det mindste have den bedste af de dårlige valg.
   */
  function twoProposals(candidates, opts) {
    const MAX_SHARED = 1;
    const a = sharedWeek(candidates, { ...opts, seed: 1 });

    let b = null;
    const consider = (week) => {
      week.overlap = week.picks.filter((p) => a.picks.some((q) => q.id === p.id)).length;
      if (!b || week.overlap < b.overlap) b = week;
      return b.overlap <= MAX_SHARED;
    };

    let ok = false;
    for (let seed = 2; seed <= 12 && !ok; seed++) {
      ok = consider(sharedWeek(candidates, { ...opts, seed }));
    }
    if (!ok) {
      consider(sharedWeek(candidates,
        { ...opts, seed: 2, avoid: new Set(a.picks.map((p) => p.id)) }));
    }

    // Overlappet er en egenskab ved PARRET og står derfor på dem begge.
    // Stod det kun på B, ville opgave 8 læse undefined på A.
    const overlap = b ? b.overlap : 0;
    return [a, b].map((w) => ({ ...w, overlap, explanation: explainWeek(w) }));
  }

  // Hvor lidt en besparelse må være værd og stadig komme i overskriften,
  // målt som andel af ugens pris. "Sparer 7,96 kr på smør" er småpenge i en
  // uge til 234 kr, og en overskrift, der fyldes op med småpenge, får hele
  // delingen til at lyde som ingenting.
  const EXPLAIN_MIN_SHARE = 0.05;

  /** "deler 1 kg Hakket oksekød over 2 retter og 1.2 kg Kartofler over 2 retter" */
  function explainWeek(week) {
    if (!week || !week.shared || !week.shared.length) {
      return 'ingen råvarer deles på tværs af retterne';
    }
    // Kun hvis der ER en besparelse, der bærer sin plads. Findes der ingen,
    // nævnes de små alligevel: at fortie en ægte deling er værre end at
    // nævne en lille.
    const worth = week.shared.filter((s) => s.saved_kr >= week.cost * EXPLAIN_MIN_SHARE);
    // Kronerne skal MED. Pladsen i overskriften gives efter besparelsen, og
    // står der kun en mængde, læses "0.021 kg Hvidløg" som ingenting, selv om
    // det er de 12 kr, der gav linjen dens plads.
    const parts = (worth.length ? worth : week.shared).slice(0, 2)
      .map((s) => `${s.need} ${s.unit} ${s.name} over ${s.used} retter (${s.saved_kr} kr)`);
    return `deler ${parts.join(' og ')}`;
  }

  return {
    assignRoles, scoreRecipe, buildPlan, shoppingList, qualifies, cheapestPerItem,
    seededNoise, isoWeek, validUntilFor, isPlausiblePrice, priceBandFor, effectivePrice,
    choosePack, isBoughtLine, hasMainCourse, sharedWeek, twoProposals, explainWeek,
    MAIN_PROTEIN, SCORE_KR, DEFAULT_SERVINGS,
    LEVELS, DAYS, MAIN_CATS, CARRIER_CATS, IGNORED_CATS, STARCH_KEYS,
    PRICE_TTL_DAYS, PRICE_BAND, PRICE_BAND_STK, SOURCE_RANK,
    WASTE_WEIGHT, WASTE_AVERSION,
  };
}));
