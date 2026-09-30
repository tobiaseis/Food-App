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

module.exports = { EDITION_DIR, SOURCE_DIR, slugOf, editionPath, sourcePath };
