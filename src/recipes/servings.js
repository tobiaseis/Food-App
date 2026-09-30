'use strict';

/**
 * Portioner ud fra kildens "antal".
 *
 * Kilden siger recipeYield, og for stykretter er det STYKANTALLET:
 * "Linsefrikadeller" står til 18 for 175 g røde linser, "Sprøde forårsruller"
 * til 30, "Grillspyd med kylling" til 12. Læst som portioner blev retterne
 * regnet om til husstanden med en faktor op til 7 for lille, og prisen pr.
 * portion blev tilsvarende for lav. Brugerens tommelfingerregel 2026-09-28:
 * én portion er 3-4 frikadeller. Resten af tabellen er bygget i samme ånd.
 *
 * Og den modsatte vej: valdemarsros tærter står til 1 — én hel tærte.
 *
 * Kildens rå tal gemmes i recipes.yield_count og portionerne regnes altid
 * derfra. Så kan reglen køres igen og igen uden at dele et tal, der allerede
 * er delt — og ændres, uden at nogen skal hente opskrifterne forfra.
 */

// Stk. pr. portion, efter titlen. Første match vinder. Flertal i ordets
// slutning, så "Bagt frikadellepita" (8 pitaer) ikke er 8 frikadeller.
//
// Hvert engelsk ord har sit danske ved siden af: reclassify regner portionerne
// igen ud fra titlen, og efter recipes:import er titlen den danske udgaves.
// "Easy healthy falafels" (16 stk) må ikke blive til 16 portioner, fordi den
// nu hedder "Nemme falafler". Ord, der er de samme på dansk (dumplings,
// wontons, gyoza, tacos, kebab, sliders), står der kun én gang.
const PIECE_RULES = [
  [/(?:deller|kødboller|meatballs|falafels?|falafler|fish ?cakes?)(?![a-zæøå])/i, 3.5],
  [/spyd(?![a-zæøå])|skewers?\b|kebabs?\b/i, 3],
  [/forårsrull?er|spring rolls?\b|summer rolls?\b|sommerrull?er/i, 4],
  [/dumplings?\b|wontons?\b|gyoza\b|potstickers?\b/i, 6],
  [/sliders\b|miniburgere?(?![a-zæøå])/i, 3],
  [/pandekager|pancakes\b|vafler(?![a-zæøå])|waffles\b/i, 3],
  [/tacos\b|taquitos\b/i, 3],
];
// Under 8 er tallet personer. Ingen af titlerne står mellem 6 og 8 i basen
// som stykantal; "Frikadeller" (500 g kød) står til 4.
const MIN_PIECES = 8;
// Og er der over 250 g mad pr. "stykke", er tallet også personer: "Herbed
// chicken skewers" er 2,5 kg til 8, ikke 8 spyd til knap 3.
const PIECE_MAX_G = 250;

// "1" på en tærte er én hel tærte. 19 aftensretter, alle over 1 kg.
const WHOLE_DISH = /tærte|quiche|\btarts?\b|\bpie\b/i;
const WHOLE_DISH_SERVINGS = 4;

function servingsFromYield(title, yieldCount, totalGrams = null) {
  if (!(yieldCount > 0)) return yieldCount ?? null;
  const t = title || '';
  if (yieldCount === 1 && WHOLE_DISH.test(t)) return WHOLE_DISH_SERVINGS;
  if (yieldCount >= MIN_PIECES && !(totalGrams / yieldCount >= PIECE_MAX_G)) {
    const rule = PIECE_RULES.find(([re]) => re.test(t));
    if (rule) return Math.max(1, Math.round(yieldCount / rule[1]));
  }
  return yieldCount;
}

/**
 * Opskriftens samlede vægt i gram ud fra linjernes mængder (kg/l/stk).
 * `getItem(key)` giver varen med base_unit, piece_g og density_g_ml.
 */
function totalGrams(lines, getItem) {
  let g = 0;
  for (const l of lines || []) {
    const key = l.item_key ?? l.key;
    const it = key ? getItem(key) : null;
    if (!it || !(l.amount > 0)) continue;
    if (it.base_unit === 'stk') g += l.amount * (it.piece_g || 100);
    else if (it.base_unit === 'l') g += l.amount * 1000 * (it.density_g_ml || 1);
    else g += l.amount * 1000;
  }
  return g;
}

/**
 * Kildens næring er pr. SIN portion — for en stykopskrift pr. stykke. Den
 * skaleres med, når portionen bliver større.
 */
function scaleNutrition(n, fromServings, toServings) {
  if (!(fromServings > 0) || !(toServings > 0) || fromServings === toServings) return n;
  const f = fromServings / toServings;
  const s = (v, dp) => (v == null ? v : Math.round(v * f * 10 ** dp) / 10 ** dp);
  return { kcal: s(n.kcal, 0), protein_g: s(n.protein_g, 1), carbs_g: s(n.carbs_g, 1), fat_g: s(n.fat_g, 1) };
}

module.exports = {
  servingsFromYield, totalGrams, scaleNutrition,
  PIECE_RULES, MIN_PIECES, PIECE_MAX_G, WHOLE_DISH_SERVINGS,
};
