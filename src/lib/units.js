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
};
const DEFAULT_PIECE_G = 100;
const COUNT_UNITS = new Set(['stk', 'stykker', 'styk', 'piece', 'pieces']);

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

  // Ingen enhed: opskriften tæller stykker.
  //
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

module.exports = {
  UNIT_G, UNIT_ML, UNIT_APPROX_G, PIECE_G, DEFAULT_PIECE_G,
  gramsOf, amountOf, mlOf,
};
