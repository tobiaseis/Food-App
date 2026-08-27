'use strict';

/**
 * Genberegner næringsestimat og spor-scorer for alle gemte opskrifter.
 *
 * Køres efter ændringer i taksonomien eller klassifikationsreglerne – så
 * slipper man for at hente alle sider igen, fordi ingredienslinjerne allerede
 * ligger i basen.
 *
 *   node src/recipes/reclassify.js
 */

const { getDb } = require('../db');
const taxonomy = require('../lib/taxonomy');
const { parseIngredient } = require('./extract');
const { estimateNutrition, scoreTiers, primaryTier } = require('./classify');

function reclassify({ relinkIngredients = true, log = console.log } = {}) {
  const db = getDb();
  const recipes = db.prepare('SELECT * FROM recipes').all();
  const getIngredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY position');

  const updateRecipe = db.prepare(`
    UPDATE recipes SET
      kcal = @kcal, protein_g = @protein_g, carbs_g = @carbs_g, nutrition_src = @nutrition_src,
      tier = @tier, tier_score = @tier_score,
      score_healthy = @score_healthy, score_classic = @score_classic, score_premium = @score_premium
    WHERE id = @id
  `);
  const updateIngredient = db.prepare(
    'UPDATE recipe_ingredients SET taxonomy_key = ?, is_staple = ?, ingredient = ?, qty = ?, unit = ? WHERE id = ?'
  );

  let relinked = 0;
  const tiers = {};

  const run = db.transaction(() => {
    for (const r of recipes) {
      let ingredients = getIngredients.all(r.id);

      // Kør ingredienslinjerne gennem parseren igen, så nye taksonomi-poster
      // slår igennem på allerede hentede opskrifter.
      if (relinkIngredients) {
        for (const ing of ingredients) {
          const p = parseIngredient(ing.raw, ing.position);
          if (p.taxonomy_key !== ing.taxonomy_key || p.ingredient !== ing.ingredient) relinked++;
          updateIngredient.run(p.taxonomy_key, p.is_staple, p.ingredient, p.qty, p.unit, ing.id);
          ing.taxonomy_key = p.taxonomy_key;
          ing.is_staple = p.is_staple;
          ing.qty = p.qty;
          ing.unit = p.unit;
        }
      }

      let kcal = r.kcal, protein = r.protein_g, carbs = r.carbs_g, src = r.nutrition_src;
      if (src !== 'site') {
        const est = estimateNutrition(ingredients, r.servings);
        if (est) { kcal = est.kcal; protein = est.protein_g; carbs = est.carbs_g; src = 'estimated'; }
      } else if (carbs == null) {
        // Kilden oplyser protein/kcal, men ikke kulhydrat – estimér det ene tal
        const est = estimateNutrition(ingredients, r.servings);
        if (est) carbs = est.carbs_g;
      }

      const scores = scoreTiers({ ...r, kcal, protein_g: protein, carbs_g: carbs }, ingredients);
      const { tier, tier_score } = primaryTier(scores);
      tiers[tier] = (tiers[tier] || 0) + 1;

      updateRecipe.run({
        id: r.id, kcal, protein_g: protein, carbs_g: carbs, nutrition_src: src,
        tier, tier_score,
        score_healthy: scores.healthy,
        score_classic: scores.classic,
        score_premium: scores.premium,
      });
    }
  });
  run();

  log(`${recipes.length} opskrifter genberegnet · ${relinked} ingredienslinjer fik ny kobling`);
  for (const [t, n] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) {
    log(`  ${t.padEnd(10)} ${n}`);
  }
  return { recipes: recipes.length, relinked, tiers };
}

if (require.main === module) reclassify();

module.exports = { reclassify };
