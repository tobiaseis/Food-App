'use strict';

/**
 * Portioner ud fra kildens "antal".
 *
 * Kilden siger recipeYield, og for frikadeller, deller, kødboller og falafel
 * er det STYKANTALLET: "Linsefrikadeller" står til 18 for 175 g røde linser,
 * "Pink tundeller" til 8 for én dåse tun. Læst som portioner blev retterne
 * regnet om til husstanden med en faktor op til 4,5 for lille, og prisen pr.
 * portion blev tilsvarende for lav. Brugerens tommelfingerregel 2026-09-28:
 * én portion er 3-4 frikadeller.
 *
 * Grænsen på 8: under den er tallet personer. Ingen opskrift med en af
 * titlerne står mellem 6 og 8 i basen; "Frikadeller" (500 g kød) står til 4,
 * "Classic homemade meatballs" (knap 1 kg kød) til 6.
 *
 * Kildens rå tal gemmes i recipes.yield_count og portionerne regnes altid
 * derfra. Så kan reglen køres igen og igen uden at dele et tal, der allerede
 * er delt — og ændres, uden at nogen skal hente opskrifterne forfra.
 */

// Flertal, i ordets slutning: "Linsefrikadeller", "Pink tundeller", "Kødboller
// - til baby". IKKE "Bagt frikadellepita" — dér er de 8 pitaer, og 400 g kød
// delt på 2 portioner gav 3.707 kcal pr. portion.
const PIECE_TITLE = /(?:deller|kødboller|meatballs|falafels?)(?![a-zæøå])/i;
const PIECES_PER_SERVING = 3.5;
const MIN_PIECES = 8;

function servingsFromYield(title, yieldCount) {
  if (!(yieldCount > 0)) return yieldCount ?? null;
  if (yieldCount >= MIN_PIECES && PIECE_TITLE.test(title || '')) {
    return Math.max(1, Math.round(yieldCount / PIECES_PER_SERVING));
  }
  return yieldCount;
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

module.exports = { servingsFromYield, scaleNutrition, PIECES_PER_SERVING, MIN_PIECES };
