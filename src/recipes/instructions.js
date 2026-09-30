'use strict';

/**
 * Kildens fremgangsmåde som en liste af trin: [{ section, text }].
 *
 * Bruges KUN som råmateriale til appens egen danske udgave (rewrite.js).
 * Teksten er kildens og ophavsretligt beskyttet, så den gemmes aldrig i
 * data.db, i git eller i Supabase — kun i tmp/kilder/, som er gitignoret.
 */

const { stripTags, findJsonLdRecipes } = require('./extract');

const typeOf = (n) => String((n && (n['@type'] || n.type)) || '');
// Arla navngiver et afsnit uden overskrift "First instruction". Det er ikke
// en overskrift, nogen skal se.
const PLACEHOLDER = /^\w+ instructions?$/i;

function stepsFromJsonLd(value, section = null, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    for (const line of value.split(/\n+/)) {
      const text = stripTags(line);
      if (text) out.push({ section, text });
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) stepsFromJsonLd(v, section, out);
    return out;
  }
  if (typeof value === 'object') {
    if (/HowToSection/i.test(typeOf(value))) {
      const name = value.name && !PLACEHOLDER.test(value.name) ? stripTags(value.name) : section;
      return stepsFromJsonLd(value.itemListElement, name, out);
    }
    const text = value.text || value.name || value.description;
    if (text) out.push({ section, text: stripTags(text) });
  }
  return out;
}

/** Valdemarsro: ét itemprop="recipeInstructions" pr. trin. */
function stepsFromMicrodata(html) {
  const at = String(html).search(/itemtype\s*=\s*["']https?:\/\/schema\.org\/Recipe/i);
  if (at === -1) return [];
  const re = /<([a-z0-9]+)[^>]*\bitemprop\s*=\s*["']recipeInstructions["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const out = [];
  for (const m of String(html).slice(at).matchAll(re)) {
    const text = stripTags(m[2]);
    if (text) out.push({ section: null, text });
  }
  return out;
}

function instructionsFrom(html) {
  for (const r of findJsonLdRecipes(html)) {
    const steps = stepsFromJsonLd(r.recipeInstructions);
    if (steps.length) return steps;
  }
  return stepsFromMicrodata(html);
}

module.exports = { stepsFromJsonLd, stepsFromMicrodata, instructionsFrom };
