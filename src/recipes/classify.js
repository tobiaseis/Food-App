'use strict';

/**
 * Estimerer næringsindhold og placerer opskrifter i de tre spor:
 * sund & proteinrig · klassisk · gourmet.
 *
 * Kilderne oplyser ikke altid næringsindhold (Valdemarsro gør fx ikke), så vi
 * estimerer ud fra ingrediensmængder og taksonomiens makroer pr. 100 g. Det
 * er groft, men godt nok til at rangere retter mod hinanden – og opskrifter
 * med rigtige tal fra kilden vinder altid over et estimat.
 */

const taxonomy = require('../lib/taxonomy');
const { gramsOf, UNIT_G, PIECE_G } = require('../lib/units');

/** Estimerer kcal/protein/kulhydrat pr. portion ud fra ingredienserne. */
function estimateNutrition(ingredients, servings) {
  const n = servings && servings > 0 ? servings : 4;
  let kcal = 0, protein = 0, carbs = 0, known = 0, total = 0;

  for (const ing of ingredients) {
    total++;
    const entry = ing.taxonomy_key ? taxonomy.get(ing.taxonomy_key) : null;
    // entry er en baserække siden opgave 3: feltet hedder protein_per_100g,
    // ikke seedets korte p.
    if (!entry || entry.protein_per_100g == null) continue;
    const g = gramsOf(ing, entry);
    if (!g || g > 5000) continue;
    known++;
    kcal    += (g / 100) * (entry.kcal_per_100g || 0);
    protein += (g / 100) * entry.protein_per_100g;
    carbs   += (g / 100) * (entry.carbs_per_100g || 0);
  }

  if (!known || known / Math.max(total, 1) < 0.4) return null;  // for tyndt grundlag

  return {
    kcal: Math.round(kcal / n),
    protein_g: Math.round((protein / n) * 10) / 10,
    carbs_g: Math.round((carbs / n) * 10) / 10,
    coverage: known / total,
  };
}

// Nogle udgivere ER gourmetkilder. Det er et reelt signal om rettens niveau,
// på linje med råvarer og tilberedningstid, så det tælles med i scoren.
const SOURCE_PREMIUM_BIAS = {
  greatbritishchefs: 0.25,
};

/**
 * Scorer en opskrift mod hvert af de tre spor. Score 0–1.
 */
function scoreTiers(recipe, ingredients) {
  const keys = ingredients.map((i) => i.taxonomy_key).filter(Boolean);
  const uniq = new Set(keys);
  // entry.category, ikke entry.cat — se kommentaren i estimateNutrition().
  const cat = (k) => taxonomy.get(k)?.category;

  const protein = recipe.protein_g;
  const kcal    = recipe.kcal;
  const minutes = recipe.total_minutes || 0;
  const nIng    = ingredients.filter((i) => !i.is_staple).length;

  const vegCount = [...uniq].filter((k) => ['veg', 'fruit', 'legume'].includes(cat(k))).length;
  const proteinFoods = [...uniq].filter((k) => ['meat', 'poultry', 'fish', 'eggs', 'legume'].includes(cat(k))).length;
  const premiumIng = [...uniq].filter((k) => taxonomy.isPremium(k)).length;
  const heavy = ['floede', 'smoer', 'sukker', 'flodeost', 'bacon'].filter((k) => uniq.has(k)).length;
  const isSweet = /kage|dessert|cake|dessert|cookie|småkage|is |icing|frosting|muffin|brownie/i
    .test(`${recipe.title} ${recipe.keywords || ''}`);

  // ── Sund & proteinrig, lavt kulhydrat ─────────────────────────────────────
  // Sporet handler om to ting på én gang: meget protein OG få kulhydrater.
  // Protein alene ville lukke pasta bolognese ind.
  const carbs = recipe.carbs_g;

  let healthy = 0;
  if (protein != null) {
    if (protein >= 35) healthy += 0.38;
    else if (protein >= 25) healthy += 0.28;
    else if (protein >= 18) healthy += 0.15;
    else healthy += 0.02;
  } else if (proteinFoods > 0) healthy += 0.12;

  if (carbs != null) {
    if (carbs <= 15) healthy += 0.3;
    else if (carbs <= 30) healthy += 0.2;
    else if (carbs <= 45) healthy += 0.08;
    else if (carbs >= 70) healthy -= 0.22;
    else if (carbs >= 55) healthy -= 0.1;
  } else {
    // Uden kulhydrattal straffes de tunge stivelseskilder på ingrediensniveau,
    // så en pastaret ikke slipper igennem, bare fordi tallet mangler.
    const starchy = ['pasta', 'ris', 'kartofler', 'brod', 'bulgur', 'tortilla', 'pizza', 'mel']
      .filter((k) => uniq.has(k)).length;
    healthy -= starchy * 0.12;
  }

  if (kcal != null) {
    if (kcal <= 450) healthy += 0.18;
    else if (kcal <= 650) healthy += 0.1;
    else if (kcal >= 900) healthy -= 0.15;
  }
  if (protein != null && kcal) {
    const ratio = protein / (kcal / 100);          // g protein pr. 100 kcal
    if (ratio >= 8) healthy += 0.16;
    else if (ratio >= 5) healthy += 0.08;
  }
  healthy += Math.min(vegCount, 5) * 0.035;
  healthy -= heavy * 0.05;
  if (isSweet) healthy -= 0.5;

  // ── Gourmet ───────────────────────────────────────────────────────────────
  let premium = 0;
  premium += Math.min(premiumIng, 3) * 0.22;
  if (minutes >= 120) premium += 0.2;
  else if (minutes >= 75) premium += 0.12;
  if (nIng >= 14) premium += 0.15;
  else if (nIng >= 10) premium += 0.08;
  if (uniq.has('vin')) premium += 0.1;
  if (uniq.has('floede') && premiumIng > 0) premium += 0.05;
  if (/confit|sous vide|braiseret|braised|reduktion|terrine|risotto|bouillabaisse|wellington|ragout|velouté|beurre|purée|jus|ballotine|carpaccio|tartare|soufflé/i
      .test(`${recipe.title} ${recipe.description || ''}`)) premium += 0.2;
  premium += SOURCE_PREMIUM_BIAS[recipe.source] || 0;
  // Hverdagsretter skal ikke kunne snige sig ind i gourmetsporet på
  // ingredienstælling alene.
  if (/cottage pie|shepherd|traybake|jacket|fish finger|sandwich|toastie|nuggets|pizza|burger|hotdog/i
      .test(recipe.title)) premium -= 0.3;

  // ── Klassisk hverdagsmad ──────────────────────────────────────────────────
  let classic = 0.3;
  if (minutes && minutes <= 45) classic += 0.25;
  else if (minutes && minutes <= 70) classic += 0.1;
  if (nIng <= 10) classic += 0.2;
  if (premiumIng === 0) classic += 0.12;
  if (uniq.has('hakket_oksekoed') || uniq.has('hakket_svinekoed') || uniq.has('kartofler')
      || uniq.has('pasta') || uniq.has('ris') || uniq.has('frikadeller')) classic += 0.15;
  classic -= (SOURCE_PREMIUM_BIAS[recipe.source] || 0);
  if (isSweet) classic -= 0.35;

  const clamp = (x) => Math.max(0, Math.min(1, Math.round(x * 100) / 100));
  return { healthy: clamp(healthy), classic: clamp(classic), premium: clamp(premium) };
}

function primaryTier(scores) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return { tier: entries[0][0], tier_score: entries[0][1] };
}

module.exports = { estimateNutrition, scoreTiers, primaryTier, gramsOf, UNIT_G, PIECE_G };
