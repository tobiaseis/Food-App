'use strict';

/**
 * REMA's hyldepriser som fil i repoet — og den ENE vej ind i basen.
 *
 * Version 1 bruger REMA's normalpriser som skøn for alle kæder. De blev hentet
 * lokalt, og den natlige kørsel henter sin database fra en release og har
 * aldrig kaldt REMA. Målt: uden de 102 REMA-rækker faldt de fuldt prissatte
 * opskrift-kæde-par fra 7.302 til 273, og REMA selv fra 311 aftensmadsretter
 * til 2. Version 1 fandtes kun på én maskine.
 *
 * Brugerens valg: priserne ligger i `data/rema-prices.csv`, som
 * `data/item_prices.csv` gør det for de indtastede. De kan ses i git, en
 * prisændring kan læses i en diff, og der er ingen automatiske kald til et
 * API, vi ikke er inviteret til. Filen fornyes ved at køre `prices:rema`
 * lokalt og committe.
 *
 * To indgange, ét lager: `prices:rema` (henter, skriver filen, lagrer) og
 * `prices:import-rema` (læser filen, lagrer). Begge kalder `storeRemaRows`,
 * så en række ser ens ud, uanset hvilken vej den kom ind. To skrivere, der
 * hver havde deres egen idé om en api:rema-række, er præcis den slags, der
 * har drevet fra hinanden i denne kodebase før.
 */

const fs = require('node:fs');
const path = require('node:path');

const REMA_CSV = path.join(__dirname, '..', '..', 'data', 'rema-prices.csv');

// Brugerens valg 2026-09-28: "De priser jeg selv har indtastet må gerne
// overskrives for nu." De indtastede REMA-priser var pladsholdere fra januar;
// som indtastede vandt de over REMA's egne, friske hyldepriser, også efter de
// var udløbet (blomkål: 18 kr/kg i stedet for 39,86). Så længe dette står på
// true, sletter en indlæsning de indtastede REMA-priser på hver vare, REMA
// selv har en pris på. Varer, REMA ikke har (selleri, vin), og andre kæders
// indtastede priser røres ikke. Sæt den til false, når indtastede REMA-priser
// igen skal vinde.
const REMA_BEATS_MANUAL = true;

// Produktnavnet står SIDST, og kun de første seks kommaer deler felterne. Så
// kan et REMA-navn indeholde et komma uden citationstegn — og uden en
// CSV-afhængighed.
const COLUMNS = ['item_key', 'pack_qty', 'pack_unit', 'pack_price', 'unit_price',
                 'observed_at', 'product'];

const HEADER = `# REMA 1000's hyldepriser, hentet fra deres API af \`npm run prices:rema\`.
#
# Version 1 bruger dem som SKØN for alle 14 kæder, indtil en kædes egen pris
# er tastet ind i data/item_prices.csv. Filen er git-versioneret med vilje:
# en prisændring kan læses i en diff, og den natlige kørsel indlæser den med
# \`npm run prices:import-rema\` uden at kontakte REMA.
#
# Forny den ved at køre \`npm run prices:rema\` og committe resultatet —
# friske varer udløber efter 90 dage. Ret den ikke i hånden: næste hentning
# skriver den forfra. En pris, der skal tilsidesættes, hører i item_prices.csv.
#
# 'product' er det REMA-produkt, prisen kommer fra. Det står der, så et
# forkert match kan ses: "SKINKESALAT" som pris på skinke er en fejl.
`;

function writeRemaCsv(rows, file = REMA_CSV) {
  // Sorteret, så en ny hentning giver en diff, der viser ÆNDRINGER — ikke en
  // ny rækkefølge.
  const sorted = [...rows].sort((a, b) =>
    a.item_key.localeCompare(b.item_key) || a.pack_qty - b.pack_qty);
  const body = sorted.map((r) => [
    r.item_key, r.pack_qty, r.pack_unit, r.pack_price, r.unit_price,
    r.observed_at, String(r.product || '').replace(/[\r\n]+/g, ' ').trim(),
  ].join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, HEADER + COLUMNS.join(',') + '\n' + body.join('\n') + '\n', 'utf8');
}

function readRemaCsv(file = REMA_CSV) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rows = [];
  let headerSeen = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!headerSeen) { headerSeen = true; continue; }
    const parts = line.split(',');
    if (parts.length < COLUMNS.length) {
      throw new Error(`rema-prices.csv linje ${i + 1}: ${parts.length} felter, forventede mindst ${COLUMNS.length}`);
    }
    const [item_key, pack_qty, pack_unit, pack_price, unit_price, observed_at] = parts;
    rows.push({
      item_key, pack_unit, observed_at,
      pack_qty: Number(pack_qty), pack_price: Number(pack_price), unit_price: Number(unit_price),
      product: parts.slice(6).join(','),
    });
  }
  return rows;
}

/**
 * Læg REMA-rækkerne i basen som 'api:rema'.
 *
 * `clean` rydder først alle kædens gamle api:rema-rækker, så en pakke, REMA
 * er holdt op med at sælge, ikke bliver liggende og vinde på pris for evigt
 * (samme grund som i bootstrap-prices.js). Kun for en HEL runde: en halv, der
 * rydder op, ville slette varer, den aldrig spurgte om.
 *
 * `valid_until` regnes her, fra varens klasse og `observed_at` — ikke fra
 * filen. Så slår en ændret udløbsregel igennem ved næste indlæsning.
 */
function storeRemaRows(db, chainId, rows, { clean, validUntilFor }) {
  if (!rows.length) {
    // En genopbygning uden noget at bygge med er bare en sletning. En tom
    // eller manglende fil må aldrig tømme REMA's priser.
    throw new Error('ingen REMA-priser at lagre — afbryder uden at røre basen');
  }
  const cls = new Map(db.prepare('SELECT key, class FROM items').all().map((i) => [i.key, i.class]));
  const del = db.prepare("DELETE FROM item_prices WHERE chain_id = ? AND source = 'api:rema'");
  const manualOf = db.prepare(
    "SELECT item_key, pack_qty, pack_unit FROM item_prices WHERE chain_id = ? AND source = 'manual' AND item_key = ?");
  const dropManual = db.prepare(
    "DELETE FROM item_prices WHERE chain_id = ? AND source = 'manual' AND item_key = ?");
  const ins = db.prepare(`
    INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit,
                             pack_price, unit_price, source, observed_at, valid_until)
    VALUES (@item_key, @chain_id, @pack_qty, @pack_unit,
            @pack_price, @unit_price, 'api:rema', @observed_at, @valid_until)
    ON CONFLICT(item_key, chain_id, pack_qty, pack_unit) DO UPDATE SET
      pack_price = excluded.pack_price, unit_price = excluded.unit_price,
      source = excluded.source, observed_at = excluded.observed_at,
      valid_until = excluded.valid_until,
      -- En hentet pris er ikke gættet frem; et 'derived'-gæts n_obs må ikke
      -- blive hængende på den.
      n_obs = 0
     -- En indtastet pris er set af et menneske. Den vinder over et API —
     -- medmindre REMA_BEATS_MANUAL har ryddet den af vejen først.
     WHERE item_prices.source <> 'manual'
  `);

  let unknown = 0;
  const overwritten = [];
  const run = db.transaction(() => {
    const dropped = clean ? del.run(chainId).changes : 0;
    let ok = 0;
    const seen = new Set();
    for (const r of rows) {
      const c = cls.get(r.item_key);
      // En vare, der er forsvundet fra kataloget eller blevet essential siden
      // hentningen, springes over frem for at vælte hele indlæsningen.
      if (!c || c === 'essential') { unknown++; continue; }
      if (REMA_BEATS_MANUAL && !seen.has(r.item_key)) {
        seen.add(r.item_key);
        overwritten.push(...manualOf.all(chainId, r.item_key));
        dropManual.run(chainId, r.item_key);
      }
      ok += ins.run({
        item_key: r.item_key, chain_id: chainId,
        pack_qty: r.pack_qty, pack_unit: r.pack_unit,
        pack_price: r.pack_price, unit_price: r.unit_price,
        observed_at: r.observed_at,
        valid_until: validUntilFor(c, new Date(r.observed_at)),
      }).changes;
    }
    return { dropped, ok };
  });
  return { ...run(), unknown, overwritten };
}

/** Til udskriften: hvilke indtastede priser REMA_BEATS_MANUAL fjernede. */
function overwrittenNote(overwritten) {
  if (!overwritten.length) return '';
  return `\n${overwritten.length} ${overwritten.length === 1 ? 'indtastet REMA-pris' : 'indtastede REMA-priser'}`
    + " overskrevet af REMA's egen (REMA_BEATS_MANUAL i src/prices/rema-store.js):\n"
    + overwritten.map((r) => `  ${r.item_key} ${r.pack_qty} ${r.pack_unit}`).join('\n');
}

module.exports = { REMA_CSV, REMA_BEATS_MANUAL, overwrittenNote, COLUMNS, writeRemaCsv, readRemaCsv, storeRemaRows };
