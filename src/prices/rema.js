'use strict';

/**
 * REMA 1000s eget shop-API.
 *
 * Den eneste af de 14 kæder, der kan hentes automatisk — se
 * docs/superpowers/specs/2026-09-06-api-undersoegelse.md for hvorfor Salling
 * og Coop ikke kan. Endpointet er udokumenteret og kan forsvinde uden varsel;
 * derfor står kilden i item_prices.source, så en række herfra kan skelnes
 * fra en indtastet og erstattes, hvis dagen kommer.
 *
 * Pakkestørrelsen står ikke som et tal. Den udledes af pris ÷ kilopris, og
 * krydstjekkes mod `underline`, som ofte siger den i klartekst ("2 KG.").
 */

const BASE = 'https://api.digital.rema1000.dk/api';

// REMAs compare_unit mod vores base_unit. Andet end disse tre kan vi ikke
// sammenligne med en opskriftsmængde.
const UNITS = { kg: 'kg', l: 'l', ltr: 'l', stk: 'stk', pcs: 'stk' };

/** "2 KG." / "500 G." / "10 STK." -> mængde i base_unit, eller null. */
function packFromUnderline(underline, baseUnit) {
  if (!underline) return null;
  const m = String(underline).match(/(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ltr|l|dl|cl|ml|stk)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  const toBase = { kg: 1, gr: 0.001, g: 0.001, ltr: 1, l: 1, dl: 0.1, cl: 0.01, ml: 0.001, stk: 1 };
  const unitBase = (u === 'g' || u === 'gr' || u === 'kg') ? 'kg' : u === 'stk' ? 'stk' : 'l';
  if (unitBase !== baseUnit) return null;
  return n * toBase[u];
}

/**
 * Hvilken af produktets priser er HYLDEPRISEN?
 *
 * `prices` er ikke én pris. Er varen på tilbud, står kampagneprisen FØRST og
 * normalprisen bagefter — "HK. OKSEKØD, 35% GRØNT" stod med 29 kr (is_campaign)
 * og 29,95 kr samme dag. item_prices er normalprisen, og den effektive pris
 * regnes som coalesce(aktivt tilbud, normalpris): tog vi kampagneprisen, ville
 * ugens tilbud blive skrevet ind som varens normale niveau, og rabatten
 * forsvinde ud af regnestykket for evigt efter.
 */
function shelfPrice(prices) {
  if (!Array.isArray(prices) || !prices.length) return null;
  return prices.find((p) => p && !p.is_campaign) || null;
}

/** Ét produkt fra søgesvaret til en prisrække, eller null hvis det ikke kan bruges. */
function parseRemaProduct(raw) {
  const price = shelfPrice(raw && raw.prices);
  if (!price || !(price.price > 0)) return null;
  if (!(price.compare_unit_price > 0)) return null;

  const baseUnit = UNITS[String(price.compare_unit || '').toLowerCase()];
  if (!baseUnit) return null;

  // Klartekst slår regnestykket, når den er der: den er ikke afrundet.
  const stated = packFromUnderline(raw.underline, baseUnit);
  const derived = price.price / price.compare_unit_price;
  const packQty = stated != null && Math.abs(stated - derived) / derived < 0.05
    ? stated
    : Math.round(derived * 1000) / 1000;

  if (!(packQty > 0)) return null;

  return {
    name: raw.name,
    pack_qty: packQty,
    pack_unit: baseUnit,
    pack_price: price.price,
    unit_price: price.compare_unit_price,
  };
}

/**
 * Ord, der gør en råvare til et andet produkt.
 *
 * Taksonomien slår produktnavnet op og finder varens ord i det — og det er
 * netop fælden: KATTEMAD, FISK & REJER slår op til `rejer`, TORSKEROGN til
 * `torsk`, SKINKESALAT til `skinke`. Navnet indeholder varen, men produktet
 * er noget helt andet, og prisen på det ville blive stående som varens
 * normalpris, uden at noget gjorde opmærksom på den. Samme familie som
 * "Apple iPad" på æble — bare fra en ny kilde.
 *
 * Det kunne ikke løses i `taxonomy.preparedForm()`. Den findes allerede, men
 * fanger ingen af dem, og den bruges også til at klassificere OPSKRIFTER: et
 * nyt ord som `salat` dér ville gøre et hoved salat til en færdigvare.
 * Stramningen hører hjemme her og kun her.
 *
 * Listen er kurateret, ikke udledt. Hvert ord står her, fordi et ægte
 * søgesvar fra REMA blev til et forkert match — præcis som `essential`-listen
 * i plan 1 er varer, nogen har set på, ikke en regel, der kan regnes ud. Den
 * vokser, når et nyt fejlmatch dukker op, og ikke før.
 *
 * To ting at vide, før der rettes i den:
 *
 *  - Mønstrene slutter i et negativt lookahead, så ordet skal slutte et dansk
 *    ord: `horn` fanger SUPPEHORN, men ikke HORNFISK, og `dej` ikke "dejlig".
 *  - De prøves mod navn OG `underline`, for det er dér, mærket står, og mærket
 *    er tit det eneste, der afslører produktet: "SELECTION LAKS" er kattemad
 *    fra SHEBA, "PASSION & BANAN" er skyr fra CHEASY, "PÆRE/BANAN" er yoghurt
 *    fra ARLA. Prisen er til at tro på i alle tre tilfælde — det er varen, der
 *    er en anden.
 */
const DERAILING_WORDS = [
  // ── Pålægssalat er ikke råvaren ──────────────────────────────────────────
  // SKINKESALAT på skinke, MAKRELSALAT på makrel, KALKUNSALAT på kalkun.
  { label: 'salat',      re: /salat(er|en)?(?![a-zæøå])/ },
  // Varen `salat` er selv en salat og slipper derfor uden om ordet ovenfor.
  // Men mayonnaisesalaterne hedder også salat, og de koster en fjerdedel af,
  // hvad et hoved salat gør (36,50 mod 133 kr/kg) — så de skal nævnes ved
  // navn. `mayo` og mærket K-SALAT tager resten af dem.
  { label: 'mayosalat',  re: /mayo|k-salat|italiensk salat|karry ?salat|salatskålen|proteinsalat/ },
  // SALAT ROSINER er rosiner, man drysser på en salat. Ikke salat.
  { label: 'salatdrys',  re: /salat rosiner/ },
  // ── Færdigretter og tilbehør ─────────────────────────────────────────────
  // KARTOFFEL-PORRE SUPPE på porre, ASPARGESSUPPE på asparges.
  { label: 'suppe',      re: /supper?(?![a-zæøå])/ },
  // YMERDRYS er drysset, ikke ymeren.
  { label: 'drys',       re: /drys(set)?(?![a-zæøå])/ },
  // TORSKEROGN og RØGET TORSKELEVER er ikke torskefilet.
  { label: 'rogn',       re: /rogn(en)?(?![a-zæøå])/ },
  { label: 'lever',      re: /lever(en|postej)?(?![a-zæøå])/ },
  // TRØFFELKUGLER er romkaramel.
  { label: 'kugler',     re: /kugler?(ne)?(?![a-zæøå])/ },
  // SUPPEHORN er pasta.
  { label: 'horn',       re: /horn(et|ene)?(?![a-zæøå])/ },
  // PIZZADEJ er ikke pizza, og slet ikke mel.
  { label: 'dej',        re: /dej(en|e)?(?![a-zæøå])/ },
  // FARSEREDE PORRER er hakket svinekød i en porre; INDBAGT LAKS er butterdej.
  // `lasagne(?!plader)` er ikke en finurlighed: LASAGNEPLADER ER pasta, mens
  // en LASAGNE er en færdigret. Samme undtagelse som i taxonomy.js.
  { label: 'færdigret',  re: /farsere(t|de)|indbagt(e)?|fyldte?(?![a-zæøå])|risotto|bolognese|carbonara|lasagne(?!plader)|tarteletfyld/ },
  // SKY M/CHAMPIGNON er sovs. MANGO KARRY DRESSING og APPELSINMARMELADE
  // er heller ikke frugten, selv om de smager af den.
  { label: 'tilbehør',   re: /sauce|sovs|dressing|dress\.|chutney|marmelade|relish|bearnaise|(^|[^a-zæøå])sky(?![a-zæøå])/ },
  // PATATE MASCARPONE er en pizza fra MODENA PIZZA.
  { label: 'pizza',      re: /pizza(er)?(?![a-zæøå])/ },
  // ── Mejeridesserten med frugtens navn ────────────────────────────────────
  // APPELSIN YOGHURT, PÆRE/BANAN (ARLA, YOGHURT), PASSION & BANAN (CHEASY
  // SKYR), CITRON (CHEASY, YOGHURT). Alle fire var BILLIGSTE match på deres
  // frugt, og alle fire ville have gjort frugten til en mejerivare.
  { label: 'mejeri',     re: /yoghurt|yoggi|skyr(?![a-zæøå])/ },
  // ── Morgenmad, kage, slik og snacks ──────────────────────────────────────
  // GRANOLA CHOKOLADE og GRANOLA NØDDER er morgenmad.
  { label: 'granola',    re: /granola|m(ü|u)sli|cornflakes/ },
  // MINT CHEWS er slik med mynte i, ikke mynte.
  { label: 'slik',       re: /slik(?![a-zæøå])|chews|bolsje|vingummi|lakrids|karamel|skumfidus/ },
  { label: 'kage',       re: /kage(r|n)?(?![a-zæøå])|muffins?|brownie/ },
  // HVIDLØGSBAGUETTES og NAANBRØD, HVIDLØG er brød med hvidløg i.
  { label: 'bagværk',    re: /baguette(s|r)?(?![a-zæøå])|naan|croutoner|grissini|flûte/ },
  // BANAN CHIPS er ikke banan.
  { label: 'chips',      re: /chips(?![a-zæøå])/ },
  // "CUPNUDLER OKSEKØD" er 65 g nudler med oksesmag. Den stod gemt bag et
  // endnu billigere fejlmatch og kom først frem, da det blev afvist — hvilket
  // er selve pointen med at printe listerne og læse dem igen efter hver
  // stramning: rettes ét match, rykker det næste op på pladsen.
  { label: 'nudler',     re: /nudler(?![a-zæøå])/ },
  // ── Det, der kun smager af varen ─────────────────────────────────────────
  // "PROTEIN BANAN / ARLA, BANAN SMAG" og "NUDLER M/KYLLINGSMAG": et produkt,
  // der sælges på at smage af noget, er ikke det noget.
  { label: 'smag',       re: /smag(en)?(?![a-zæøå])/ },
  // ── Varen er en anden råvare ─────────────────────────────────────────────
  // ASPARGES KARTOFLER er en kartoffelsort, ikke asparges.
  { label: 'kartoffel',  re: /kartof(fel|ler|len|felmel)(?![a-zæøå])/ },
  // SKINKEOST er smøreost fra BUKO, ikke skinke.
  { label: 'smøreost',   re: /skinkeost|rejeost/ },
  // VEGANSK STEAK er ikke en bøf, og SMØRBAR fra NATURLI' er ikke smør.
  { label: 'vegansk',    re: /vegansk(e)?|veganer|veggie|plantebaseret|naturli/ },
  // ── Dyrefoder ────────────────────────────────────────────────────────────
  // KATTEMAD, FISK & REJER siger det selv. De andre gør ikke: "SELECTION
  // LAKS" (SHEBA) og "POÉSIE KALKUN" (VITAKRAFT) er kattemad, og de stod som
  // billigste match på laks og kalkun. Derfor står mærkerne her.
  { label: 'dyrefoder',  re: /kattemad|hundemad|kattefoder|hundefoder|kattemynte|godbidder|(^|[^a-zæøå])foder(?![a-zæøå])|sheba|whiskas|vitakraft|pedigree|friskies|royal canin|purina|matzinger|meaty cat/ },
];

/**
 * Ord, der siger, at tallet ikke er varens kilopris.
 *
 * Dette er en ANDEN slags afvisning end listen ovenfor, og derfor en anden
 * liste. `DERAILING_WORDS` svarer på "er det overhovedet den vare?" —
 * TORSKEROGN er ikke torsk. Denne svarer på "er tallet varens kilopris?":
 * produktet ER den rigtige vare, men kiloprisen er regnet på en vægt, der
 * ikke kun er varen.
 *
 *   BLOMKÅLSBLANDING 18,50 kr/kg — vægten er blomkål OG broccoli OG gulerod
 *   LAKS I OLIVENOLIE 163,64    — olien vejer med
 *   HK. OKSEKØD, 35% GRØNT      — 35 % af vægten er grøntsager
 *
 * Det er samme invariant, som fik opgave 1 til at droppe stk→kg-omregningen:
 * `unit_price` skal betyde kroner pr. kilo AF VAREN, ellers kan rækken ikke
 * sammenlignes med de andre kæders rækker, og hele kædevalget regner på
 * tal, der ikke måler det samme.
 *
 * `madspild` står her af en beslægtet, men egen grund: en madspildskasse er
 * en ryddepris, ikke en normalpris. Vægten ER varens, men prisen er ikke den,
 * der står på hylden i næste uge.
 *
 * GRÆNSEN, der er trukket med vilje: `i lage` og `i vand` står IKKE på listen,
 * selv om lagen også vejer. Dåsen er den normale form for tun, muslinger,
 * oliven, kapers, cornichoner, bønner, ærter, asparges og ansjoser — ti varer,
 * hvis eneste pris ville forsvinde — og de andre kæders rækker på de varer er
 * den samme slags dåse. Sammenligneligheden, som er hele formålet, er i behold.
 * Glasset med hvidløg i olie er derimod ikke den normale form for hvidløg.
 */
const PRICE_BASIS_WORDS = [
  // "-blanding" som sammensat ord: BLOMKÅLSBLANDING, BROCCOLIBLANDING er poser
  // med flere grøntsager. Det foranstillede bogstav er ikke pynt — det skiller
  // dem fra "MIN EGEN BLANDING TE", hvor blandingen er te og kun te, og hvor
  // hele vægten altså ER varen.
  //
  // `mix` står bevidst IKKE her: det bruges begge veje (SALATMIX er varens
  // egen form, BACONMIX og SLIK MIX er varen selv), og sammensætningstricket
  // skiller dem ikke ad. Det kommer først på, når data tvinger det.
  { label: 'blanding', re: /[a-zæøå]blanding(en|er)?(?![a-zæøå])/ },
  // Olien vejer med: LAKS I OLIVENOLIE, HVIDLØG KRYDDEROLIE, TUN I OLIE.
  // "HVIDLØG I CHILI" er samme 290 g glas som HVIDLØG KRYDDEROLIE — fed på
  // glasset, hvidløg i bunden — og skal med, ellers rykker afvisningen bare
  // matchet én linje ned. Varer, hvis egen nøgle er en olie (kokosolie),
  // slipper forbi på selv-undtagelsen.
  { label: 'i olie',   re: /olie(n)?(?![a-zæøå])|(^|[^a-zæøå])i chili(?![a-zæøå])/ },
  // "HK. OKSEKØD, 35% GRØNT": hver tredje kilo er grøntsager. `grønt` uden
  // efterfølgende bogstav rammer ikke "grøntsager" i en underline og ikke
  // "grønne" i DEN GRØNNE SLAGTER.
  { label: 'strækket', re: /grønt(?![a-zæøå])/ },
  // "PÆRER I BK. MADSPILD" og "MINI GULERØDDER / KL. 2 STOP MADSPILD": en
  // ryddepris på varer, der er ved at være for gamle. Begge var BILLIGSTE
  // match på deres vare, og begge ville have sat normalprisen ~40 % for lavt.
  { label: 'madspild', re: /madspild/ },
];

/** Første ord i `list`, der rammer produktet uden også at ramme varen selv. */
function firstMatch(list, product, selfText) {
  const name = typeof product === 'string' ? product : (product && product.name) || '';
  const underline = typeof product === 'string' ? '' : (product && product.underline) || '';
  const hay = `${name} / ${underline}`.toLowerCase();
  const self = String(selfText || '').toLowerCase();
  for (const w of list) {
    if (!w.re.test(hay)) continue;
    if (w.re.test(self)) continue;
    return w;
  }
  return null;
}

/**
 * Er kiloprisen regnet på en vægt, der ikke kun er varen — eller på en
 * ryddepris? Returnerer ordet, der forkastede matchet, eller `null`.
 */
function wrongPriceBasis(product, selfText) {
  return firstMatch(PRICE_BASIS_WORDS, product, selfText);
}

/**
 * Bærer produktet et ord, der gør det til noget andet end varen?
 *
 * `selfText` er varens egne ord (nøgle + navn). Er varen SELV den ting,
 * springes ordet over: `suppe` må gerne matche en suppe og `salat` en salat —
 * ellers ville stramningen tage de eneste rigtige match fra netop de varer.
 * Det er også derfor `stenbiderrogn` stadig må matche rogn.
 *
 * Returnerer det ord, der forkastede matchet, eller `null`.
 */
function derailingWord(product, selfText) {
  return firstMatch(DERAILING_WORDS, product, selfText);
}

/** Søger og returnerer de rå produkter. Kaster ved HTTP-fejl. */
async function searchRema(query, { perPage = 20, fetchImpl = fetch } = {}) {
  const url = `${BASE}/search/products?query=${encodeURIComponent(query)}`
            + `&page=1&per_page=${perPage}`;
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'accept-language': 'da-DK,da;q=0.9' },
  });
  if (!res.ok) throw new Error(`REMA svarede HTTP ${res.status} på "${query}"`);
  const body = await res.json();
  return body.data || body.results || [];
}

module.exports = {
  parseRemaProduct, packFromUnderline, shelfPrice, searchRema,
  derailingWord, DERAILING_WORDS,
  wrongPriceBasis, PRICE_BASIS_WORDS,
  BASE,
};
