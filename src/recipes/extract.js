'use strict';

/**
 * Udtrækker opskriftsdata fra en HTML-side.
 *
 * De tre kilder markerer deres opskrifter forskelligt, så alle tre veje skal
 * understøttes:
 *   · BBC Good Food  – almindelig JSON-LD i <script type="application/ld+json">
 *   · Arla           – JSON-LD, men med HTML-entity i type-attributten
 *                      (type="application/ld&#x2B;json")
 *   · Valdemarsro    – microdata (itemprop="recipeIngredient")
 *
 * Vi gemmer FAKTA – titel, ingrediensliste, næringsindhold, link – og henter
 * ikke fremgangsmåden. Brugeren sendes til kilden for selve opskriften.
 */

const taxonomy = require('../lib/taxonomy');

// ── HTML-hjælpere ────────────────────────────────────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aelig: 'æ', oslash: 'ø', aring: 'å', AElig: 'Æ', Oslash: 'Ø', Aring: 'Å',
  eacute: 'é', frac12: '½', frac14: '¼', frac34: '¾', deg: '°',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(\w+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

// Matcher både "application/ld+json" og entity-varianten "application/ld&#x2B;json"
const LD_SCRIPT = /<script[^>]*type\s*=\s*["']application\/ld(?:\+|&#x2B;|&#43;)json["'][^>]*>([\s\S]*?)<\/script>/gi;

function typesOf(node) {
  const t = node && node['@type'];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map(String);
}

/** Går rekursivt gennem alle JSON-LD-blokke og finder Recipe-objekter. */
function findJsonLdRecipes(html) {
  const found = [];
  for (const m of html.matchAll(LD_SCRIPT)) {
    let parsed;
    try {
      parsed = JSON.parse(decodeEntities(m[1].trim()));
    } catch {
      try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    }
    const stack = [parsed];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (typesOf(node).includes('Recipe')) found.push(node);
      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasPart']) {
        if (node[key]) stack.push(node[key]);
      }
    }
  }
  return found;
}

// ── Microdata ────────────────────────────────────────────────────────────────

/** Alle værdier for en given itemprop – enten content-attribut eller elementtekst. */
function microdataValues(html, prop) {
  const out = [];
  const re = new RegExp(
    `<([a-z0-9]+)([^>]*\\bitemprop\\s*=\\s*["']${prop}["'][^>]*)>([\\s\\S]{0,3000}?)<\\/\\1>`, 'gi'
  );
  for (const m of html.matchAll(re)) {
    const attrs = m[2];
    const content = attrs.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    const src     = attrs.match(/\b(?:src|href)\s*=\s*["']([^"']*)["']/i);
    const value = content ? content[1] : (stripTags(m[3]) || (src ? src[1] : ''));
    if (value) out.push(decodeEntities(value).trim());
  }
  // Selvlukkende <meta itemprop="x" content="y">
  const metaRe = new RegExp(`<meta[^>]*\\bitemprop\\s*=\\s*["']${prop}["'][^>]*>`, 'gi');
  for (const m of html.matchAll(metaRe)) {
    const c = m[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (c && c[1]) out.push(decodeEntities(c[1]).trim());
  }
  return [...new Set(out)];
}

function findMicrodataRecipe(fullHtml) {
  const scopeAt = fullHtml.search(/itemtype\s*=\s*["']https?:\/\/schema\.org\/Recipe/i);
  if (scopeAt === -1) return null;

  // Søg kun fra Recipe-elementet og frem. Ellers rammer itemprop="name" typisk
  // sidens eller udgiverens navn, der står i markup'en længere oppe.
  const html = fullHtml.slice(scopeAt);

  const ingredients = [
    ...microdataValues(html, 'recipeIngredient'),
    ...microdataValues(html, 'ingredients'),
  ];
  if (!ingredients.length) return null;

  const first = (arr) => (arr.length ? arr[0] : undefined);

  // itemprop="name" duer ikke til titlen her: Recipe-scopet omslutter også
  // nested publisher/author-scopes, så det første "name" er udgiverens navn.
  // Sidens egen overskrift er langt mere pålidelig.
  const h1 = fullHtml.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
  const og = fullHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const heading = stripTags(h1?.[1] || '')
    || stripTags(og?.[1] || '').replace(/\s*[|–—-]\s*[^|–—-]{2,30}$/, '')
    || first(microdataValues(html, 'name'));

  // Billedet tages fra og:image. microdata-billeder sidder ofte på et
  // <img> (et void-element uden lukketag), så tekstsøgningen ville ellers
  // returnere den omkringliggende brødtekst i stedet for en URL.
  const ogImage = fullHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const imgTag  = html.match(/<img[^>]*\bitemprop\s*=\s*["']image["'][^>]*\bsrc\s*=\s*["']([^"']+)["']/i);

  return {
    '@type': 'Recipe',
    name: heading,
    _image: ogImage?.[1] || imgTag?.[1] || null,
    description: first(microdataValues(html, 'description')),
    image: first(microdataValues(html, 'image')),
    recipeYield: first(microdataValues(html, 'recipeYield')),
    totalTime: first(microdataValues(html, 'totalTime')),
    cookTime: first(microdataValues(html, 'cookTime')),
    prepTime: first(microdataValues(html, 'prepTime')),
    recipeIngredient: ingredients,
    recipeCategory: first(microdataValues(html, 'recipeCategory')),
    recipeCuisine: first(microdataValues(html, 'recipeCuisine')),
    keywords: first(microdataValues(html, 'keywords')),
    _microdata: true,
  };
}

// ── Feltparsere ──────────────────────────────────────────────────────────────

/** ISO 8601-varighed (PT1H15M) → minutter. */
function parseDuration(v) {
  if (!v) return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const iso = s.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return (+(iso[1] || 0)) * 1440 + (+(iso[2] || 0)) * 60 + (+(iso[3] || 0));
  }
  const plain = s.match(/(\d+)\s*(min|minut|hour|time)/i);
  if (plain) return /h|time/i.test(plain[2]) ? +plain[1] * 60 : +plain[1];
  return null;
}

function parseYield(v) {
  if (v == null) return null;
  const first = Array.isArray(v) ? v[0] : v;
  const m = String(first).match(/\d+/);
  const n = m ? parseInt(m[0], 10) : null;
  return n && n > 0 && n <= 40 ? n : null;
}

function parseNutritionNumber(v) {
  if (v == null) return null;
  const m = String(v).replace(',', '.').match(/[\d.]+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return isFinite(n) ? n : null;
}

function firstString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (typeof v === 'object') return firstString(v.url || v.contentUrl || v['@id'] || v.name);
  return String(v);
}

// ── Ingrediensparsing ────────────────────────────────────────────────────────

const VULGAR = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

const UNITS = [
  // dansk
  'kg', 'gram', 'gr', 'g', 'liter', 'ltr', 'dl', 'cl', 'ml', 'l',
  'spsk', 'tsk', 'knivspids', 'nip', 'fed', 'bundt', 'stilk', 'håndfuld',
  'dåse', 'dåser', 'pakke', 'pakker', 'pose', 'poser', 'stk', 'skiver', 'skive',
  // engelsk
  'tbsp', 'tablespoon', 'tablespoons', 'tsp', 'teaspoon', 'teaspoons',
  'cup', 'cups', 'oz', 'lb', 'lbs', 'pound', 'pounds', 'clove', 'cloves',
  'handful', 'pinch', 'sprig', 'sprigs', 'rasher', 'rashers', 'slice', 'slices',
  'can', 'cans', 'tin', 'tins', 'pack', 'packs', 'bunch',
];
// Sorteret længst-først, så 'liter' ikke skygges af 'l'.
// Bemærk: \b duer IKKE her – JS regner æ/ø/å som ikke-ordtegn, så /^l\b/
// ville matche "l" i "løg" og efterlade "øg" tilbage som ingrediens.
const UNIT_RE = new RegExp(
  `^(${[...UNITS].sort((a, b) => b.length - a.length).join('|')})(?![a-zæøåA-ZÆØÅ])\\.?`, 'i'
);

// Tilberedningsord der ikke er en del af varenavnet
const PREP_WORDS = /\b(finthakket|hakket fint|groft hakket|i tern|i skiver|i både|revet|smuttede|pillede|friske?|frosne?|økologiske?|optøet|udbenet|marineret|chopped|finely chopped|diced|sliced|minced|grated|fresh|frozen|organic|peeled|trimmed|to serve|to taste|for the [a-z ]+|plus extra[a-z ,]*)\b/gi;

/**
 * "500 g hakket oksekød, finthakket" → { qty: 500, unit: 'g',
 *                                        ingredient: 'hakket oksekød', ... }
 */
function parseIngredient(raw, position = 0) {
  const original = stripTags(raw);
  let s = original.toLowerCase().trim();

  // Fjern parenteser: "1 dåse (400 g) hakkede tomater"
  s = s.replace(/\([^)]*\)/g, ' ');

  let qty = null;
  let unit = null;

  // Mængde: "500", "1,5", "1 1/2", "½", "2-3"
  const qtyMatch = s.match(/^\s*(\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+\s*\/\s*\d+|\d+[.,]\d+|\d+\s*-\s*\d+|\d+)/);
  if (qtyMatch) {
    const tok = qtyMatch[1].trim();
    if (/^[½¼¾⅓⅔⅛]$/.test(tok)) qty = VULGAR[tok];
    else if (/[½¼¾⅓⅔⅛]/.test(tok)) {
      const whole = parseInt(tok, 10) || 0;
      const frac = VULGAR[tok.slice(-1)] || 0;
      qty = whole + frac;
    } else if (tok.includes('/')) {
      const [a, b] = tok.split('/').map((x) => parseFloat(x.trim()));
      qty = b ? a / b : null;
    } else if (tok.includes('-')) {
      const [a, b] = tok.split('-').map((x) => parseFloat(x.trim().replace(',', '.')));
      qty = (a + b) / 2;                       // interval → midtpunkt
    } else {
      qty = parseFloat(tok.replace(',', '.'));
    }
    s = s.slice(qtyMatch[0].length).trim();
  }

  const unitMatch = s.match(UNIT_RE);
  if (unitMatch) {
    unit = unitMatch[1].toLowerCase();
    s = s.slice(unitMatch[0].length).trim();
  }

  // Alt efter komma er som regel tilberedning, ikke varen
  s = s.split(',')[0];
  s = s.replace(PREP_WORDS, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(af|of|à|a)\s+/i, '').replace(/[.;:]+$/, '').trim();

  const hit = taxonomy.lookup(s) || taxonomy.lookup(original);
  const key = hit ? hit.entry.key : null;

  return {
    raw: original,
    qty,
    unit,
    ingredient: s || original.toLowerCase(),
    taxonomy_key: key,
    is_staple: key ? (taxonomy.isStaple(key) ? 1 : 0) : 0,
    position,
  };
}

// ── Samlet udtræk ────────────────────────────────────────────────────────────

/** Finder den bedste opskrift på en side og normaliserer den. */
function extractRecipe(html, url) {
  const candidates = findJsonLdRecipes(html);
  const raw = candidates.find((c) => c.recipeIngredient || c.ingredients)
           || candidates[0]
           || findMicrodataRecipe(html);
  if (!raw) return null;

  const ingredientLines = []
    .concat(raw.recipeIngredient || raw.ingredients || [])
    .map((x) => (typeof x === 'string' ? x : firstString(x)))
    .filter((x) => x && String(x).trim().length > 1);

  if (!ingredientLines.length) return null;

  const n = raw.nutrition || {};
  const servings = parseYield(raw.recipeYield);

  const totalTime = parseDuration(raw.totalTime)
    || ((parseDuration(raw.prepTime) || 0) + (parseDuration(raw.cookTime) || 0)) || null;

  let title = stripTags(firstString(raw.name) || '');
  if (!title || title.length < 3) {
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const h1 = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
    title = stripTags(og?.[1] || h1?.[1] || '') || title;
  }
  if (!title) return null;

  // Et billedfelt der ikke er en URL, er ikke et billede. Nogle sider lægger
  // brødtekst i itemprop="image"; så falder vi tilbage på og:image.
  const asUrl = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null);
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const image = asUrl(firstString(raw.image)) || asUrl(raw._image) || asUrl(ogImage?.[1]);

  return {
    url,
    title,
    description: raw.description ? stripTags(firstString(raw.description)).substring(0, 500) : null,
    image,
    servings,
    total_minutes: totalTime,
    kcal:      parseNutritionNumber(n.calories),
    protein_g: parseNutritionNumber(n.proteinContent),
    carbs_g:   parseNutritionNumber(n.carbohydrateContent),
    fat_g:     parseNutritionNumber(n.fatContent),
    keywords: [raw.recipeCategory, raw.recipeCuisine, raw.keywords]
      .map(firstString).filter(Boolean).join(', ').substring(0, 300) || null,
    ingredients: ingredientLines.map((line, i) => parseIngredient(line, i)),
    via: raw._microdata ? 'microdata' : 'jsonld',
  };
}

module.exports = {
  extractRecipe, parseIngredient, findJsonLdRecipes, findMicrodataRecipe,
  parseDuration, parseYield, stripTags, decodeEntities,
};
