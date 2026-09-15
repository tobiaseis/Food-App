'use strict';

/**
 * data/item_prices.csv -> item_prices.
 *
 * Validerer hårdt og afviser HELE filen ved den første fejl. En prisliste,
 * der er halvt indlæst, er værre end en, der ikke er indlæst: man opdager
 * det først, når en madplan koster det forkerte.
 *
 * Efter API-undersøgelsen er det her hovedvejen, ikke reservevejen — kun
 * 1 af 14 kæder kan hentes automatisk, og 101 af de 184 prissætbare varer
 * har ingen tilbudshistorik at gætte ud fra.
 *
 *   npm run prices:import
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../src/db');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

const CSV = path.join(__dirname, '..', 'data', 'item_prices.csv');
const COLUMNS = ['item_key', 'chain_slug', 'pack_qty', 'pack_unit', 'pack_price', 'observed_at'];

/** Én CSV-række til en item_prices-række, eller `{ error }`. */
function parsePriceRow(raw, { items, chains, line }) {
  const at = (msg) => ({ error: `linje ${line}: ${msg}` });

  // En række med for få kolonner giver undefined i de sidste felter. Uden
  // dette tjek bliver det til "observed_at 'undefined' er ikke en dato", og
  // den, der retter filen, leder efter en dato i stedet for et manglende komma.
  for (const c of COLUMNS) {
    if (raw[c] === undefined || raw[c] === '') return at(`mangler en værdi i '${c}'`);
  }

  const item = items.get(raw.item_key);
  if (!item) return at(`ukendt item_key '${raw.item_key}'`);
  if (item.class === 'essential') {
    return at(`'${raw.item_key}' er essential og skal aldrig prissættes`);
  }

  const chainId = chains.get(raw.chain_slug);
  if (!chainId) return at(`ukendt chain_slug '${raw.chain_slug}'`);

  if (raw.pack_unit !== item.base_unit) {
    return at(`pack_unit '${raw.pack_unit}' er ikke varens base_unit `
            + `'${item.base_unit}' — 400 g skal skrives som 0.4 kg`);
  }

  const qty = Number(raw.pack_qty);
  const price = Number(raw.pack_price);
  if (!(qty > 0)) return at(`pack_qty '${raw.pack_qty}' skal være et tal over 0`);
  if (!(price > 0)) return at(`pack_price '${raw.pack_price}' skal være et tal over 0`);

  const observed = new Date(raw.observed_at);
  if (Number.isNaN(observed.getTime())) return at(`observed_at '${raw.observed_at}' er ikke en dato`);

  const unitPrice = Math.round((price / qty) * 1000) / 1000;

  // Samme bånd som bootstrappen og REMA-klienten bruger — reglen bor i
  // engine.js, fordi de tre skrivere skal være enige om den. Her fanger den
  // frem for alt tastefejlen: 1500 i stedet for 15,00. null betyder "vi har
  // intet bånd for kategorien" og er ikke et nej.
  if (engine.isPlausiblePrice(item.category, unitPrice, item.base_unit) === false) {
    const band = engine.PRICE_BAND[item.category];
    return at(`${unitPrice} kr/${item.base_unit} er en usandsynlig pris for `
            + `'${item.key}' (${item.category}: ${band[0]}-${band[1]} kr/${item.base_unit})`
            + ' — tjek pack_qty og pack_price');
  }

  return {
    item_key: item.key,
    chain_id: chainId,
    pack_qty: qty,
    pack_unit: raw.pack_unit,
    pack_price: price,
    unit_price: unitPrice,
    source: 'manual',
    observed_at: observed.toISOString(),
    valid_until: engine.validUntilFor(item.class, observed),
  };
}

/**
 * Minimal CSV: ingen citationstegn, ingen indlejrede kommaer. Prisdata har ingen.
 *
 * Returnerer `{ line, row }`, hvor `line` er linjen i FILEN. Kommentarer og
 * tomme linjer siles fra, så en tæller over rækkerne ville pege det forkerte
 * sted hen — og en prisliste rettes i en editor, hvor linjenummeret er det
 * eneste, man har at gå efter.
 */
function parseCsv(text) {
  const all = text.split(/\r?\n/).map((text, i) => ({ line: i + 1, text }));
  const useful = all.filter((l) => l.text.trim() && !l.text.startsWith('#'));

  const head = useful.shift();
  if (!head) throw new Error('CSV er tom');
  const header = head.text.split(',').map((h) => h.trim());
  for (const c of COLUMNS) {
    if (!header.includes(c)) throw new Error(`CSV mangler kolonnen '${c}'`);
  }

  return useful.map((l) => {
    const cells = l.text.split(',').map((c) => c.trim());
    return { line: l.line, row: Object.fromEntries(header.map((h, i) => [h, cells[i]])) };
  });
}

function main() {
  const db = getDb();
  try {
    // category skal med: den er nøglen til prisbåndet i engine.js.
    const items = new Map(db.prepare('SELECT key, class, category, base_unit FROM items').all()
      .map((i) => [i.key, i]));
    const chains = new Map(db.prepare('SELECT id, slug FROM chains').all()
      .map((c) => [c.slug, c.id]));

    const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
    const parsed = rows.map(({ line, row }) => parsePriceRow(row, { items, chains, line }));
    const errors = parsed.filter((p) => p.error);

    if (errors.length) {
      for (const e of errors) console.error(e.error);
      console.error(`\n${errors.length} fejl — intet er skrevet.`);
      process.exitCode = 1;
      return;
    }

    const ins = db.prepare(`
      INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit,
                               pack_price, unit_price, source, observed_at, valid_until)
      VALUES (@item_key, @chain_id, @pack_qty, @pack_unit,
              @pack_price, @unit_price, @source, @observed_at, @valid_until)
      ON CONFLICT(item_key, chain_id, pack_qty, pack_unit) DO UPDATE SET
        pack_price = excluded.pack_price, unit_price = excluded.unit_price,
        source = excluded.source, observed_at = excluded.observed_at,
        valid_until = excluded.valid_until,
        -- En indtastet pris er ikke gættet frem. Står der et n_obs fra et
        -- tidligere 'derived'-gæt på samme (vare, kæde, pakke), ville det
        -- blive hængende og få arbejdslisten til at tro, rækken er et gæt.
        n_obs = 0
    `);
    db.transaction(() => { for (const p of parsed) ins.run(p); })();

    console.log(`${parsed.length} priser importeret fra ${path.relative(process.cwd(), CSV)}`);
  } finally {
    // I finally: kastes der undervejs — en låst base, en CSV der ikke findes —
    // ville en close() til sidst aldrig blive nået, og håndtaget blive
    // hængende med sine WAL-filer åbne. Samme grund som i bootstrap-prices.js.
    db.close();
  }
}

// Testen indlæser filen for at få fat i parsePriceRow og må ikke komme til at
// køre importen som bivirkning.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('import afbrudt:', err.message);
    process.exitCode = 1;
  }
}

module.exports = { parsePriceRow, parseCsv, COLUMNS };
