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
 * Går frem fra et elements åbne-tag (ved openEnd) og tæller åbne/luk-tags af
 * SAMME navn (dybde), til det rigtige luk-tag er fundet. Returnerer både den
 * indre HTML og positionen lige efter luk-taget.
 *
 * En ikke-grådig backreference-regex ("<TAG ...>([\s\S]*?)</TAG>") stopper
 * ved det FØRSTE luk-tag med det navn — også når det hører til et indlejret
 * element med samme tagnavn (en billed-/tipboks i en <div>, eller en
 * under-liste i en <li>) — og afkorter fremgangsmåden midt i. Det er den
 * fejlklasse, denne funktion retter — delt af innerHtmlOf (boksens fulde
 * indhold) og stepsFromBlock (ét trins fulde udstrækning), så der kun er én
 * udgave af dybdelogikken.
 */
function scanToClose(html, tagName, openEnd) {
  const re = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}\\s*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) return { inner: html.slice(openEnd, m.index), end: m.index + m[0].length };
    } else {
      depth++;
    }
  }
  return { inner: html.slice(openEnd), end: html.length }; // ubalanceret: tag resten med frem for at tabe trin
}

function innerHtmlOf(html, tagName, openEnd) {
  return scanToClose(html, tagName, openEnd).inner;
}

/**
 * Dagens Valdemarsro-markup pakker somme tider flere trin ind i én
 * recipeInstructions-boks (<p> pr. trin, evt. en <ul><li> midt i en
 * intervalmetode, eller en <li> med sin egen under-liste). Er der <p>/<li>
 * til stede, bliver hver af dem sit eget trin — hver blok tages med sin
 * FULDE udstrækning via scanToClose (samme dybdelogik som innerHtmlOf), så
 * en under-liste inde i én <li> ikke selv bliver opdelt i flere trin og
 * mister teksten efter den; det er præcis den fejl, en ikke-dybdesporet
 * blok-regex ville reintroducere ét niveau nede.
 *
 * Tekst MELLEM to blokke bliver også sit eget trin — både løs tekst (en
 * sætning, siden glemte at pakke i <p>) og tekst i et andet tag (en <span>,
 * en tipboks i en <div>, en mellemoverskrift). Her blev tagget tekst før
 * kasseret som dekoration, men det kan lige så vel være et trin, siden har
 * pakket anderledes, og fetch-sources kører én gang over alle 2.224 sider:
 * hvad der tabes her, ser omskrivningen aldrig. Et "Se video her" for meget
 * skriver modellen selv ud; et manglende trin kan den ikke gætte. Er der
 * slet ingen <p>/<li>, er hele elementets tekst ét trin, som før.
 */
function stepsFromBlock(inner, out) {
  const blockOpen = /<(p|li)\b[^>]*>/gi;
  let pos = 0;
  let any = false;
  let m;
  while ((m = blockOpen.exec(inner))) {
    any = true;
    const gap = stripTags(inner.slice(pos, m.index));
    if (gap) out.push({ section: null, text: gap });

    const tagName = m[1];
    const { inner: content, end } = scanToClose(inner, tagName, m.index + m[0].length);
    const text = stripTags(content);
    if (text) out.push({ section: null, text });

    pos = end;
    blockOpen.lastIndex = end; // spring over evt. indlejrede <p>/<li> — de er allerede talt med
  }
  if (!any) {
    const text = stripTags(inner);
    if (text) out.push({ section: null, text });
    return;
  }
  // Samme regel for teksten efter den sidste blok.
  const tail = stripTags(inner.slice(pos));
  if (tail) out.push({ section: null, text: tail });
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
