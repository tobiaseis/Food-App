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

/**
 * Den indre HTML af elementet, der starter lige efter dets åbne-tag (ved
 * openEnd), fundet ved at tælle åbne/luk-tags af SAMME navn (dybde).
 *
 * En ikke-grådig backreference-regex ("<TAG ...>([\s\S]*?)</TAG>") stopper
 * ved det FØRSTE luk-tag med det navn — også når det hører til et indlejret
 * element med samme tagnavn (fx en billed- eller tipboks i en <div>) — og
 * afkorter fremgangsmåden midt i. Det er den fejl, denne funktion retter.
 */
function innerHtmlOf(html, tagName, openEnd) {
  const re = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}\\s*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) return html.slice(openEnd, m.index);
    } else {
      depth++;
    }
  }
  return html.slice(openEnd); // ubalanceret markup: tag resten med frem for at tabe trin
}

/**
 * Dagens Valdemarsro-markup pakker somme tider flere trin ind i én
 * recipeInstructions-boks (<p> pr. trin, evt. en <ul><li> midt i en
 * intervalmetode). Er der <p>/<li> til stede, bliver hver af dem sit eget
 * trin; ellers er hele elementets tekst ét trin, som før.
 */
function stepsFromBlock(inner, out) {
  const blocks = [...inner.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  if (blocks.length) {
    for (const b of blocks) {
      const text = stripTags(b[2]);
      if (text) out.push({ section: null, text });
    }
    return;
  }
  const text = stripTags(inner);
  if (text) out.push({ section: null, text });
}

/** Valdemarsro: recipeInstructions som ét element pr. trin, eller ét element
 *  der pakker flere <p>/<li> ind. */
function stepsFromMicrodata(html) {
  const at = String(html).search(/itemtype\s*=\s*["']https?:\/\/schema\.org\/Recipe/i);
  if (at === -1) return [];
  const scoped = String(html).slice(at);
  const openTag = /<([a-z0-9]+)[^>]*\bitemprop\s*=\s*["']recipeInstructions["'][^>]*>/gi;
  const out = [];
  for (const m of scoped.matchAll(openTag)) {
    const inner = innerHtmlOf(scoped, m[1], m.index + m[0].length);
    stepsFromBlock(inner, out);
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
