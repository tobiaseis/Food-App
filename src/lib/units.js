'use strict';

/**
 * Enhedskonvertering fra opskriftstekst til varens egen enhed.
 *
 * Opskrifter måler i alt muligt — gram, dl, spsk, "2 løg" — og varen måles i
 * kg, l eller stk. Det er her de to mødes.
 *
 * Masse og rumfang holdes adskilt med vilje. Regner man rumfang om til gram
 * og tilbage til rumfang, ganger og dividerer man med massefylden, og små
 * fejl bliver til en ekstra karton fløde på indkøbslisten.
 */

// Rene massemål.
const UNIT_G = {
  g: 1, gram: 1, gr: 1, kg: 1000, oz: 28.35,
  lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6,
};

// Rene rumfangsmål, i ml.
const UNIT_ML = {
  ml: 1, cl: 10, dl: 100, l: 1000, liter: 1000, ltr: 1000,
  spsk: 15, tsk: 5, tbsp: 15, tablespoon: 15, tablespoons: 15,
  tsp: 5, teaspoon: 5, teaspoons: 5, cup: 240, cups: 240,
};

// Upræcise mål, som vi kun kan give en vægt. De optræder næsten kun på
// krydderier og friske urter, hvor præcisionen alligevel er ligegyldig.
const UNIT_APPROX_G = {
  knivspids: 1, pinch: 1, nip: 1,
  fed: 3, clove: 3, cloves: 3,
  håndfuld: 30, handful: 30, bundt: 30, bunch: 30, sprig: 2, sprigs: 4,
  dåse: 400, dåser: 400, can: 400, cans: 400, tin: 400, tins: 400,
  skive: 25, skiver: 25, slice: 25, slices: 25, rasher: 25, rashers: 25,
  pakke: 250, pakker: 250, pack: 250, packs: 250, pose: 250, poser: 250,
};

// Typisk stykvægt når opskriften bare siger "1 løg".
const PIECE_G = {
  aeg: 58, loeg: 110, hvidloeg: 4, gulerod: 70, tomat: 90, kartofler: 120,
  citron: 90, appelsin: 140, banan: 120, aeble: 150, peberfrugt: 150,
  agurk: 300, squash: 200, aubergine: 250, porre: 150, avocado: 150,
  selleri: 40, broccoli: 350, blomkaal: 500, kyllingebryst: 150,
  brod: 500, tortilla: 60, sodkartoffel: 150, ingefaer: 15,
  // Målt på den ene linje i korpus, der siger både antal og vægt:
  // "20 plader rispapir (ca. 200 g)".
  rispapir: 10,
};
const DEFAULT_PIECE_G = 100;
const COUNT_UNITS = new Set(['stk', 'stykker', 'styk', 'piece', 'pieces']);

// Et enhedsløst tal over dette er en vægt, ikke et antal. Kilder taber deres
// "g": "400 hakket svinekød" bliver ellers til 400 stykker á 100 g = 40 kg.
const UNITLESS_IS_GRAMS = 100;

const norm = (u) => (u ? String(u).toLowerCase() : null);

/** Rumfang i ml, hvis enheden er et rumfangsmål. Ellers null. */
function mlOf(ing) {
  if (!ing || !ing.qty || ing.qty <= 0) return null;
  const f = UNIT_ML[norm(ing.unit)];
  return f ? ing.qty * f : null;
}

/**
 * Vægt i gram. `item` bruges kun til stykvægt og massefylde og må gerne
 * mangle — så falder den tilbage til 100 g pr. stk, som hidtil.
 */
function gramsOf(ing, item = null) {
  if (!ing || !ing.qty || ing.qty <= 0) return null;
  const u = norm(ing.unit);

  if (u && UNIT_G[u])        return ing.qty * UNIT_G[u];
  if (u && UNIT_APPROX_G[u]) return ing.qty * UNIT_APPROX_G[u];
  if (u && UNIT_ML[u])       return ing.qty * UNIT_ML[u] * (item?.density_g_ml ?? 1);

  // Ingen enhed: opskriften tæller stykker — medmindre tallet er så stort,
  // at det kun kan være gram. Stykvarer (æg, tortillas) tælles altid.
  if (ing.qty >= UNITLESS_IS_GRAMS && (item?.base_unit ?? 'kg') !== 'stk') {
    return ing.qty;
  }

  // Falder tilbage til stykvægts-tabellen på ingrediensens egen nøgle, når
  // varen ikke er sendt med. Den gamle gramsOf() slog selv op i PIECE_G, så
  // uden det ville et glemt andet argument stille og roligt gøre hvert løg
  // til 100 g i stedet for 110 — en fejl uden fejlmeddelelse.
  const per = item?.piece_g
    ?? PIECE_G[ing.item_key ?? ing.taxonomy_key]
    ?? DEFAULT_PIECE_G;
  return ing.qty * per;
}

/**
 * Mængden i varens egen enhed: kg, l eller stk.
 * Det er dette tal, indkøbslisten lægger sammen og runder op til hele pakker.
 */
function amountOf(ing, item) {
  if (!item || !ing || !ing.qty || ing.qty <= 0) return null;
  const u = norm(ing.unit);

  if (item.base_unit === 'stk') {
    if (!u || COUNT_UNITS.has(u)) return ing.qty;
    const g = gramsOf(ing, item);
    const per = item.piece_g ?? DEFAULT_PIECE_G;
    return g == null ? null : g / per;
  }

  if (item.base_unit === 'l') {
    // Rumfang til rumfang: massefylden skal ikke ind over.
    const ml = mlOf(ing);
    if (ml != null) return ml / 1000;
    const g = gramsOf(ing, item);
    return g == null ? null : g / (1000 * (item.density_g_ml ?? 1));
  }

  const g = gramsOf(ing, item);
  return g == null ? null : g / 1000;
}

/**
 * Vægten, forfatteren selv har skrevet i en parentes — eller null.
 *
 * "1 kylling (ca. 1200 g)" blev til 0,1 kg: parentesen blev skåret væk, før
 * mængden blev læst, og så var "1 kylling" ét stykke à DEFAULT_PIECE_G. Målt:
 * 331 linjer har et bart antal og en vægt i parentes, og fejlen går fra
 * ubetydelig (løg, hvor stykvægten er god) til tolv gange for lidt (en hel
 * kylling). Budget-sporet viste derfor "ca. 1 kr pr. portion" for en helstegt
 * kylling. Forfatterens tal er ikke et gæt; vores stykvægt er.
 *
 * Tre fælder, alle set i basen:
 *   "(à 125 g)", "(about 200g each)", "(60-80g per prawn)"  → pr. STYKKE
 *   "(or 800-900g trimmed lean leg)"                         → et alternativ,
 *                                                              ikke denne vare
 *   "(about 300-400g)"                                       → et interval
 */
const PAREN_W = /(\d+(?:[.,]\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?\s*(kg|gram|g|cl|dl|ml|l)\b/i;
const PER_PIECE = /(^|\s)(à|á|a)\s*\d|\b(each|hver|apiece|stykket)\b|\bper\s+\w+|\bpr\.?\s*stk/i;

// Et kommasegment tæller kun, når det SELV starter med en omtrentlig vægt:
// "1 ribbensteg, cirka 1,5 kg." er stegens vægt; "2 løg, hakket" er ikke.
const APPROX_START = /^\s*(ca\.?|cirka|omkring|about|approx\.?|approximately|around)\s/i;

function readWeight(text) {
  const w = text.match(PAREN_W);
  if (!w) return null;
  const a = parseFloat(w[1].replace(',', '.'));
  const b = w[2] ? parseFloat(w[2].replace(',', '.')) : a;
  const unit = w[3].toLowerCase() === 'gram' ? 'g' : w[3].toLowerCase();
  return { qty: (a + b) / 2, unit, perPiece: PER_PIECE.test(text) };
}

function parenWeight(raw) {
  const s = String(raw || '');
  for (const m of s.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1];
    if (/^\s*(or|eller)\b/i.test(inner)) continue;
    const w = readWeight(inner);
    if (w) return w;
  }
  // Samme vægt, skrevet efter et komma i stedet for i en parentes. Sjældnere
  // (14 linjer mod 331), men det er den form, ribbestegen har: "1 ribbensteg,
  // cirka 1,5 kg." blev gemt som 0,1 kg og lagde sig øverst i budget-sporet.
  // Parenteser skæres væk først, så et komma INDE i en parentes ikke tæller.
  //
  // Og der deles IKKE ved et komma, der står direkte foran et ciffer: det er
  // et dansk decimalkomma. Et almindeligt split(',') skar "cirka 1,5 kg" over
  // til "cirka 1" uden enhed, og ribbestegen blev ved med at være 0,1 kg —
  // samme fælde som "15,95" i CSV-importøren i plan 2.
  const segments = s.replace(/\([^)]*\)/g, ' ').split(/,(?!\d)/).slice(1);
  for (const seg of segments) {
    if (!APPROX_START.test(seg)) continue;
    const w = readWeight(seg);
    if (w) return w;
  }
  return null;
}

/**
 * Mængden i varens egen enhed for en hel ingredienslinje.
 *
 * Det samme som amountOf, bortset fra at en vægt i parentes vinder over et
 * bart antal. Findes med vilje ét sted: opskriftslæseren (parseIngredient) og
 * genberegningen (scripts/backfill-amounts.js) kalder begge denne, for
 * genberegningen læser den GEMTE mængde og enhed og ville ellers aldrig se
 * parentesen.
 *
 * Kun når linjens egen mængde er et antal (ingen enhed, eller 'stk'), og kun
 * for varer, der ikke selv tælles i stk: "4 æg (ca. 250 g)" er fire æg.
 */
function amountOfLine(ing, item) {
  const pw = parenWeight(ing && ing.raw);
  const u = ing && ing.unit ? String(ing.unit).toLowerCase() : null;
  const countish = !u || COUNT_UNITS.has(u);
  if (pw && item && item.base_unit !== 'stk' && countish) {
    const qty = pw.perPiece && ing.qty ? pw.qty * ing.qty : pw.qty;
    return amountOf({ qty, unit: pw.unit, item_key: ing.item_key }, item);
  }
  return amountOf(ing, item);
}

module.exports = {
  UNIT_G, UNIT_ML, UNIT_APPROX_G, PIECE_G, DEFAULT_PIECE_G,
  gramsOf, amountOf, mlOf, parenWeight, amountOfLine,
};
