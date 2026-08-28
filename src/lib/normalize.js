'use strict';

const taxonomy = require('./taxonomy');

// ── Tekst-hjælpere ───────────────────────────────────────────────────────────

/** æ/ø/å → ae/oe/aa, så slugs bliver ASCII og stabile. */
function foldDanish(s) {
  return String(s)
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/é/g, 'e').replace(/ü/g, 'u').replace(/ö/g, 'oe').replace(/ä/g, 'ae');
}

function slugify(s) {
  return foldDanish(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80) || 'ukendt';
}

function titleCase(s) {
  const t = String(s).trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// Markedsføringsstøj der aldrig hjælper med at identificere varen.
const NOISE = [
  'frit valg', 'friit valg', 'tilbud', 'spar', 'ex. pant', 'ex pant', 'excl. pant',
  'inkl. pant', 'pr. stk', 'pr stk', 'pr. kg', 'pr kg', 'pr. liter', 'ca.', 'ca ',
  'flere varianter', 'flere slags', 'forskellige varianter', 'div. varianter',
  'vælg mellem', 'kun', 'nyhed', 'dansk', 'danske', 'friske', 'frisk',
  'kølet', 'frost', 'dybfrost', 'dybfrossen', 'max 4 stk', 'begrænset parti',
];

const BRANDS = [
  'arla', 'lurpak', 'kærgården', 'castello', 'buko', 'philadelphia', 'cheasy',
  'karolines køkken', 'thise', 'naturmælk', 'jerseymælk',
  'coca-cola', 'coca cola', 'pepsi', 'faxe kondi', 'fanta', 'sprite', 'schweppes',
  'carlsberg', 'tuborg', 'royal', 'heineken', 'grøn tuborg',
  'kims', 'taffel', 'estrella', 'pringles', 'doritos',
  'toms', 'anthon berg', 'marabou', 'milka', 'ritter sport', 'freia',
  'kellogg', 'nestlé', 'nestle', 'quaker', 'havregryn',
  'knorr', 'blå band', 'beauvais', 'heinz', 'hellmann', 'k-salat',
  'ama', 'øgo', 'levevis', 'budget', 'först', 'x-tra', 'änglamark', 'anglamark',
  'harboe', 'cocio', 'matilde', 'tuborg squash',
  'den grønne slagter', 'hanegal', 'tulip', 'steff houlberg', 'gøl', 'stryhns',
  'lambi', 'plenty', 'neutral', 'ajax', 'ariel', 'omo', 'zalo', 'nivea', 'colgate',
  'santa maria', 'uncle ben', 'barilla', 'de cecco', 'zeta', 'urtekram',
  // Mærker hvis navn indeholder en råvare. Uden dem bliver "Selaks" til laks,
  // "Lambi" til lam og "Lavazza helbønner" til bønner.
  'selaks', 'lambi', 'lavazza', 'copenhagen roaster', 'merrild', 'beefeater',
  'seagate', 'mr beef', 'bistronne', 'pålækker', 'pålægsslagteren', 'skagenfood',
  'glyngøre', 'madværket', 'velsmag', 'gestus', 'freygaard', 'butcher\'s',
];

// ── Rensning af overskrift ───────────────────────────────────────────────────

/**
 * Støj- og brandord fjernes som HELE ord, aldrig som orddele.
 *
 * Ren tekstudskiftning gør skade, man ikke opdager: "spar" åd sig ind i
 * "spareribs", "frisk" i "friskost", "dansk" i "danskvand" – og "kun" i
 * "kalkun", så en kalkunbrystfilet blev læst som en kyllingebrystfilet.
 *
 * \b duer ikke: JS regner æ/ø/å som ikke-ordtegn, så ordgrænserne skrives ud.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordPatterns(terms) {
  return terms.map((t) => new RegExp(
    `(^|[^a-zæøå0-9])${escapeRe(t.trim())}(?![a-zæøå0-9])`, 'gi'));
}

const NOISE_RE = wordPatterns(NOISE);
const BRAND_RE = wordPatterns(BRANDS);

function stripAll(text, patterns) {
  let s = String(text);
  for (const re of patterns) s = s.replace(re, '$1 ');
  return s;
}

/**
 * Fjerner størrelser, procenter, pant, markedsføringsord og alternativ-varianter,
 * så der kun står selve varetypen tilbage.
 */
function cleanHeading(raw) {
  if (!raw) return '';
  let s = ' ' + String(raw).toLowerCase() + ' ';

  s = s.replace(/\([^)]*\)/g, ' ');                       // (parenteser)
  s = s.replace(/\d+([.,]\d+)?\s*-\s*\d+([.,]\d+)?\s*%/g, ' '); // 8-12 %
  s = s.replace(/\d+([.,]\d+)?\s*%/g, ' ');               // 18 %
  s = s.replace(/\d+\s*x\s*\d+([.,]\d+)?\s*\w*/g, ' ');   // 24 x 33 cl
  // størrelsesangivelser, evt. som interval: "200-500 g", "1,5 l"
  s = s.replace(/\d+([.,]\d+)?\s*(-\s*\d+([.,]\d+)?\s*)?(kg|g|gr|gram|ml|cl|dl|l|ltr|liter|stk|pk|pakke|rl|ruller)\b/g, ' ');
  s = s.replace(/\bca\.?\s*\d+/g, ' ');

  s = stripAll(s, NOISE_RE);

  // "Pepsi Max eller Faxe Kondi" → primær variant.
  //
  // Undtagen når den første variant ender på bindestreg: "Lakse- eller
  // torskefars" er ikke laks, den er fars. Bindestregen betyder, at ordet
  // deler efterled med den næste variant, og efterleddet er dét, varen er.
  // Så beholder vi hele strengen og lader opslaget finde det hele ord.
  const variants = s.split(/\s+eller\s+|\s*\/\s*|\s+samt\s+|\s*,\s*/);
  if (!/-\s*$/.test(variants[0])) s = variants[0];

  s = s.replace(/[^\wæøåÆØÅ\s&%-]/g, ' ')
       .replace(/\s+/g, ' ')
       .trim();

  return s;
}

function detectBrand(text) {
  if (!text) return null;
  const hay = ' ' + String(text).toLowerCase() + ' ';
  let best = null;
  for (let i = 0; i < BRANDS.length; i++) {
    BRAND_RE[i].lastIndex = 0;
    if (!BRAND_RE[i].test(hay)) continue;
    if (!best || BRANDS[i].length > best.length) best = BRANDS[i];
  }
  return best ? titleCase(best) : null;
}

/** Fjerner brandnavnet fra en renset streng, så varetypen står tilbage. */
function stripBrand(cleaned) {
  return stripAll(' ' + cleaned + ' ', BRAND_RE).replace(/\s+/g, ' ').trim();
}

// ── Varianter der flytter prisen ─────────────────────────────────────────────

/**
 * Fedtprocent i hakket kød.
 *
 * 8-12 % og 15-20 % er ikke samme vare – de har systematisk forskellig pris,
 * og at slå dem sammen ville sammenligne magert kød med fedt og kalde
 * forskellen et tilbud. Derfor er fedtprocenten en del af vareidentiteten.
 *
 * Intervallerne samles i de fire grader, danske slagtere faktisk sælger efter,
 * så "14-18 %" og "15-20 %" havner samme sted i stedet for at blive to varer.
 */
const FAT_BUCKETS = [
  { max: 7.5, key: '3-7', label: '3-7 %' },
  { max: 13.5, key: '8-12', label: '8-12 %' },
  { max: 21, key: '15-20', label: '15-20 %' },
  { max: Infinity, key: '22-26', label: '22-26 %' },
];

function parseFatGrade(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();

  // Alle procentangivelser, både intervaller ("8-12 %") og enkelttal ("5 %")
  const re = /(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*%/g;
  for (const m of s.matchAll(re)) {
    const lo = parseInt(m[1], 10);
    const hi = m[2] != null ? parseInt(m[2], 10) : lo;
    const mid = (lo + hi) / 2;

    // Ikke alle procenter er fedt: "med 35 % grøntsager", "spar 20 %".
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 16);
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    if (/grønt|grðnt|salat|rabat|mere|ekstra/.test(after)) continue;
    if (/spar|op til|rabat/.test(before)) continue;
    if (mid <= 0 || mid > 30) continue;              // uden for fedtspændet

    const bucket = FAT_BUCKETS.find((b) => mid < b.max);
    return { key: bucket.key, label: bucket.label, low: lo, high: hi };
  }
  return null;
}

/**
 * Økologi er den anden variant, der systematisk flytter prisen: samme
 * fedtprocent koster ~40 % mere økologisk (87-122 kr/kg mod 137-147 kr/kg).
 */
function isOrganic(text) {
  const s = String(text || '').toLowerCase();
  // \b duer ikke foran "ø": JS regner æ/ø/å som ikke-ordtegn, så /\bøkolog/
  // matcher aldrig " økologisk". Ordgrænser skrives eksplicit i stedet.
  return /økolog|organic/.test(s)
      || /(^|[^a-zæøå0-9])øko([^a-zæøå0-9]|$)/.test(s);
}

// Kategorier hvor økologi er en reel prisforskel og ikke bare et mærkat.
const ORGANIC_SPLIT_CATS = new Set(['meat', 'poultry', 'fish', 'dairy', 'cheese', 'eggs', 'veg', 'fruit']);

// ── Vare-identitet ───────────────────────────────────────────────────────────

/**
 * Den del af beskrivelsen der er varespecifikation og ikke salgstale.
 *
 * Korte beskrivelser er specifikationer – "SPOT Dansk hakket kyllingekød
 * 3-7% 450 g. Pr. kg 62,50" – og de er værd at slå op, når overskriften
 * intet gav. Lange er markedsføringsprosa, og ét madord et tilfældigt sted
 * i dem betyder ingenting: "HP trådløs mus" blev til AND, fordi ordet stod
 * inde i en produkttekst om bluetooth.
 */
const DESC_SPEC_MAX = 120;

function specText(description) {
  const s = String(description || '').trim();
  return s.length && s.length <= DESC_SPEC_MAX ? s : '';
}

/**
 * Afgør hvilken kanonisk vare et tilbud handler om.
 *
 * Taksonomi-match vinder altid: det er dét, der får "Kyllingebryst 1 kg" og
 * "Kyllingebrystfilet ca. 900 g" til at blive samme produkt uge efter uge.
 */
function productIdentity(heading, description = '') {
  const cleaned  = cleanHeading(heading);
  const noBrand  = stripBrand(cleaned);
  const brand    = detectBrand(heading) || detectBrand(description);

  // Prøv i faldende specificitet: renset uden brand → renset → rå overskrift
  // → en kort beskrivelse. Se `specText` for hvorfor den skal være kort.
  // Beskrivelsen kan UDELUKKE en vare, men ikke udpege den som råvare.
  //
  // Den er markedsføringstekst, og et madord i den er som regel en
  // smagsvariant: "Ribena – Blandet Bær & Frugt" er ikke bær, "Rynkeby
  // Nektar – Æble, Appelsin" er ikke æbler, og "Pringles – Sour cream &
  // onion" er ikke creme fraiche. Ingen af dem kan laves mad af.
  //
  // Den anden vej holder derimod: står der opvaskemiddel eller tandpasta i
  // beskrivelsen, ER varen det – "Vel eller Duck" er toiletrens, ikke and.
  // Derfor tæller beskrivelsen kun, når den peger væk fra madplanen.
  const specHit = taxonomy.lookup(specText(description));
  const specVeto = specHit && !taxonomy.isMealCapable(specHit.entry.key) ? specHit : null;

  let hit = taxonomy.lookup(noBrand)
         || taxonomy.lookup(cleaned)
         || taxonomy.lookup(heading)
         || specVeto;

  if (hit && specVeto && taxonomy.isMealCapable(hit.entry.key)) hit = specVeto;

  if (hit) {
    const e = hit.entry;
    const haystack = `${heading} ${description || ''}`;

    let slug = e.key.replace(/_/g, '-');
    let name = e.name;

    // Forarbejdet vare: den indeholder råvaren, men er den ikke. "Indbagte
    // rejer" er butterdej og rejesauce, "kyllingenuggets" er ikke kyllingelår.
    // Den beholder sin varetype – prishistorikken skal stadig kunne følge
    // nuggets som nuggets – men får sin egen identitet, så madplanen kan
    // holde den ude af opskrifterne.
    const form = taxonomy.preparedForm(heading);
    if (form) {
      slug += `-${form.key}`;
      name += `, ${form.label}`;
    }

    // Fedtprocent: kun på varer hvor den er en reel prisfaktor (hakket kød).
    const fat = e.fatGrades ? parseFatGrade(haystack) : null;
    if (fat) {
      slug += `-${fat.key}`;
      name += ` ${fat.label}`;
    }

    const organic = ORGANIC_SPLIT_CATS.has(e.cat) && isOrganic(haystack);
    if (organic) {
      slug += '-oeko';
      name += ', økologisk';
    }

    return {
      slug,
      name,
      category: e.cat,
      taxonomy_key: e.key,
      fat_grade: fat ? fat.key : null,
      organic: organic ? 1 : 0,
      prepared: form ? 1 : 0,
      protein_per_100g: e.p ?? null,
      kcal_per_100g: e.kcal ?? null,
      brand,
    };
  }

  // Uden varetype er teksten selv identiteten. Formen skal stadig med i
  // slug'en, ellers deler "Santa Maria Tex Mex" og "... eller Nissin
  // kopnudler" nøgle, og varen skifter mellem råvare og færdigret.
  const fallback = noBrand || cleaned || String(heading).toLowerCase();
  const form = taxonomy.preparedForm(heading);
  return {
    slug: slugify(fallback) + (form ? `-${form.key}` : ''),
    name: titleCase(fallback),
    category: null,
    taxonomy_key: null,
    fat_grade: null,
    organic: 0,
    prepared: taxonomy.preparedForm(heading) ? 1 : 0,
    protein_per_100g: null,
    kcal_per_100g: null,
    brand,
  };
}

// ── Enhedspris ───────────────────────────────────────────────────────────────

/**
 * Læser butikkens egen "pr. kg"/"pr. liter"-angivelse ud af beskrivelsen.
 * Bruges som kontrol og som fallback når mængden mangler.
 */
/**
 * Læser et tal skrevet på dansk talformat.
 *
 * Punktum er tusindseparator og komma er decimaltegn: "1.268,57" er
 * ét tusind to hundrede otteogtres komma syvoghalvtreds – ikke 1,268.
 * Aviserne blander dog formaterne, så "9.97" skal stadig blive til 9,97.
 */
function parseDanishNumber(raw) {
  const s = String(raw).trim();
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  // Kun punktummer: præcis 3 cifre efter hvert punktum ⇒ tusindseparator
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, ''));
  return parseFloat(s);
}

function parseStatedUnitPrice(description) {
  if (!description) return null;
  const text = String(description).toLowerCase();

  // Danske aviser skriver det begge veje: "9.09 pr. liter" og "Pr. liter 9.97".
  //
  // Tal-mønsteret må IKKE sluge et afsluttende punktum. Ellers læses
  // "Klasse 1. Pr. kg 24,00" som "1 pr. kg", og varekvaliteten bliver
  // til en kilopris.
  const after  = text.match(/(\d+(?:[.,]\d+)*)\s*(?:kr\.?\s*)?(?:\/|pr\.?\s+)\s*(kg|kilo|liter|ltr|l)(?![a-zæøå])/);
  const before = text.match(/pr\.?\s*(kg|kilo|liter|ltr|l)(?![a-zæøå])[^\d]{0,12}(\d+(?:[.,]\d+)*)/);

  // "pr. kg 24,00" er entydig; tal-før-enhed er lettere at forveksle med
  // omkringstående tal, så den form bruges kun som fallback.
  const m = before ? { num: before[2], unit: before[1] }
          : after ? { num: after[1], unit: after[2] }
          : null;
  if (!m) return null;

  const value = parseDanishNumber(m.num.replace(/[.,]$/, ''));
  if (!isFinite(value) || value <= 0) return null;
  return { value, unit: /k/.test(m.unit) ? 'kg' : 'l' };
}

/**
 * Beregner normaliseret mængde og pris pr. kg / liter / stk.
 *
 * Tjek leverer `quantity.unit.si.factor`, hvilket gør det til ren regning
 * i stedet for gætværk: 33 cl × 0.01 = 0.33 l  →  3 kr / 0.33 = 9.09 kr/l
 * (præcis dét tal avisen selv trykker).
 */
function computeUnitPrice(offer) {
  const price = offer?.pricing?.price;
  const q     = offer?.quantity || {};
  const size  = q.size || {};
  const unit  = q.unit || {};
  const si    = unit.si || {};
  const pcs   = q.pieces || {};

  const out = {
    size_from: size.from ?? null,
    size_to: size.to ?? null,
    unit_symbol: unit.symbol ?? null,
    si_symbol: si.symbol ?? null,
    si_factor: si.factor ?? null,
    pieces_from: pcs.from ?? null,
    pieces_to: pcs.to ?? null,
    base_qty: null,
    base_unit: 'stk',
    unit_price: null,
    size_is_range: 0,
  };

  if (typeof price !== 'number' || !isFinite(price)) return out;

  const piecesFrom = typeof pcs.from === 'number' ? pcs.from : 1;
  const piecesTo   = typeof pcs.to === 'number' ? pcs.to : piecesFrom;
  const pieces     = Math.max(1, (piecesFrom + piecesTo) / 2);

  const hasSize = typeof size.from === 'number' && isFinite(size.from) && size.from > 0;

  if (hasSize && typeof si.factor === 'number' && si.factor > 0 && si.symbol) {
    const sizeTo = typeof size.to === 'number' ? size.to : size.from;
    const mid    = (size.from + sizeTo) / 2;
    out.size_is_range = sizeTo !== size.from ? 1 : 0;

    const sym = si.symbol.toLowerCase();
    const baseUnit = sym === 'l' ? 'l'
                   : sym === 'kg' ? 'kg'
                   : (sym === 'pcs' || sym === 'pc' || sym === 'stk') ? 'stk'
                   : sym;

    const qty = mid * si.factor * pieces;
    if (qty > 0) {
      out.base_qty   = round(qty, 4);
      out.base_unit  = baseUnit;
      out.unit_price = round(price / qty, 2);
    }
  }

  // En dagligvare vejer typisk mellem 5 g og 25 kg. Ligger den beregnede
  // mængde i det spænd, er metadataene troværdige, og de bruges.
  const plausible = out.base_qty != null && out.base_qty >= 0.005 && out.base_qty <= 25;

  // Avisens egen "pr. kg"-linje bruges kun når beregningen svigter. Begge
  // kilder kan tage fejl – Tjek angiver fx en 24×33 cl ramme cola som
  // "33 l pr. dåse" (= 792 liter), mens avisteksten kan indeholde tal, der
  // ikke er priser. Beregningen vinder, når den giver et realistisk svar.
  const stated = parseStatedUnitPrice(offer.description);
  if (!plausible) {
    if (stated) {
      out.base_unit  = stated.unit;
      out.unit_price = round(stated.value, 2);
      out.base_qty   = round(price / stated.value, 4);
    } else if (out.base_qty != null) {
      // Urealistisk mængde og intet at rette efter: et forkert kr/kg er
      // værre end ingen kr/kg – det ville toppe listen over bedste tilbud.
      out.base_qty = null;
      out.unit_price = null;
      out.base_unit = 'stk';
    }
  }

  if (out.unit_price == null) {
    out.base_unit  = 'stk';
    out.base_qty   = pieces;
    out.unit_price = round(price / pieces, 2);
  }

  return out;
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ── ISO-uge ──────────────────────────────────────────────────────────────────

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

module.exports = {
  foldDanish, slugify, titleCase,
  cleanHeading, detectBrand, stripBrand,
  productIdentity, computeUnitPrice, parseStatedUnitPrice,
  parseFatGrade, isOrganic, FAT_BUCKETS,
  isoWeek, round,
};
