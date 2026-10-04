'use strict';

/**
 * Den danske udgave af en opskrift: stierne, formen og ingredienslinjen.
 *
 * Én fil pr. opskrift i data/opskrifter/<kilde>/<slug>.json. Filerne ligger i
 * git, så en rettet opskrift kan ses i en diff og rettes i hånden, og de
 * læses ind i data.db af import-da.js — også i den natlige kørsel, så
 * release-assettet aldrig står uden dem.
 *
 * Råmaterialet (kildens egen tekst) ligger i tmp/kilder/ med samme filnavn.
 */

const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EDITION_DIR = path.join(ROOT, 'data', 'opskrifter');
const SOURCE_DIR = path.join(ROOT, 'tmp', 'kilder');

/**
 * Sidste led i URL'en plus seks tegn af dens hash. recipes.id er et lokalt
 * løbenummer og duer ikke som navn; URL'en er den stabile nøgle, og hashen
 * holder to "lasagne"-sider hos samme kilde fra hinanden.
 */
function slugOf(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const last = (parts[parts.length - 1] || 'opskrift').toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 6);
  return `${last || 'opskrift'}-${hash}`;
}

const editionPath = (source, url) => path.join(EDITION_DIR, source, `${slugOf(url)}.json`);
const sourcePath = (source, url) => path.join(SOURCE_DIR, source, `${slugOf(url)}.json`);

// Enhederne, parseIngredient (extract.js) kender. Modellen må kun bruge dem —
// ellers kan linjen ikke regnes om til en mængde og prissættes.
const UNITS = ['g', 'kg', 'ml', 'dl', 'l', 'tsk', 'spsk', 'stk', 'fed', 'bundt',
               'dåse', 'pakke', 'skive', 'stilk', 'håndfuld', 'knivspids'];

// anyOf frem for type-arrays: det er den form, structured outputs tager imod
// uden forbehold. Røgtesten i opgave 6 bekræfter det mod CLI'en.
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'intro', 'servings', 'ingredients', 'steps', 'changes'],
  properties: {
    title: { type: 'string' },
    intro: { type: 'string' },
    servings: { type: 'integer' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'amount', 'unit', 'name', 'note', 'optional'],
        properties: {
          section: nullable({ type: 'string' }),
          amount: nullable({ type: 'number' }),
          unit: nullable({ type: 'string', enum: UNITS }),
          name: { type: 'string' },
          note: nullable({ type: 'string' }),
          optional: { type: 'boolean' },
        },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'text'],
        properties: { section: nullable({ type: 'string' }), text: { type: 'string' } },
      },
    },
    changes: { type: 'array', items: { type: 'string' } },
  },
};

/** 1.5 → "1,5". Listen er dansk; parseIngredient læser begge dele. */
const fmtAmount = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');

/** Varen med tilberedning, uden mængde: det, opskriftsarket skriver efter mængden. */
const labelOf = (ing) => `${ing.name}${ing.note ? `, ${ing.note}` : ''}`;

/**
 * Den danske linje, parseIngredient læser: "400 g kyllingebryst, i strimler".
 * Valgfri står bagerst som "(valgfri)" — et "evt." forrest ville stå, hvor
 * parseren leder efter mængden.
 */
function lineOf(ing) {
  const head = [ing.amount != null ? fmtAmount(ing.amount) : null, ing.unit, ing.name]
    .filter(Boolean).join(' ');
  return `${head}${ing.note ? `, ${ing.note}` : ''}${ing.optional ? ' (valgfri)' : ''}`;
}

module.exports = {
  EDITION_DIR, SOURCE_DIR, slugOf, editionPath, sourcePath,
  UNITS, RECIPE_SCHEMA, fmtAmount, labelOf, lineOf,
};
