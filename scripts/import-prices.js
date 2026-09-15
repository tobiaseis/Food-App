'use strict';

/**
 * data/item_prices.csv -> item_prices.
 *
 * Validerer hårdt: fejler ÉN linje, skrives der ingenting. En prisliste, der
 * er halvt indlæst, er værre end en, der ikke er indlæst — man opdager det
 * først, når en madplan koster det forkerte. Alle fejl printes i samme kørsel,
 * så filen kan rettes i ét hug.
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
    // Rådet skal passe til VARENS enhed. "400 g skal skrives som 0.4 kg" er
    // meningsløst for et æg, der tælles i stk, og sender læseren efter en
    // omregning, der ikke findes.
    const hint = { kg: ' — 400 g skal skrives som 0.4 kg',
                   l: ' — 250 ml skal skrives som 0.25 l',
                   stk: ' — varen tælles i stykker, ikke i vægt' }[item.base_unit] || '';
    return at(`pack_unit '${raw.pack_unit}' er ikke varens base_unit `
            + `'${item.base_unit}'${hint}`);
  }

  const qty = Number(raw.pack_qty);
  const price = Number(raw.pack_price);
  if (!(qty > 0)) return at(`pack_qty '${raw.pack_qty}' skal være et tal over 0`);
  if (!(price > 0)) return at(`pack_price '${raw.pack_price}' skal være et tal over 0`);

  // Datoen skal være ÅÅÅÅ-MM-DD og intet andet. new Date() alene er alt for
  // large: den godtager '2026' (1. januar), '2099-01-01' og — værst — den '95',
  // en dansk decimalkomma i 15,95 efterlader i kolonnen. Den sidste bliver til
  // 31-12-1994 uden et ord, og rækken lander som 'manual', det mest betroede
  // niveau vi har.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.observed_at)) {
    return at(`observed_at '${raw.observed_at}' skal skrives som ÅÅÅÅ-MM-DD `
            + '(fx 2026-09-15)');
  }
  const observed = new Date(raw.observed_at);
  if (Number.isNaN(observed.getTime())) return at(`observed_at '${raw.observed_at}' er ikke en dato`);
  // Mønstret alene er ikke nok: new Date('2026-02-30') kaster ikke — den
  // ruller frem til 2. marts. Datoen ville stå i basen som en anden dag end
  // den, der er skrevet. Tilbage gennem toISOString er den eneste måde at se
  // det på (ISO-datoer uden klokkeslæt læses som UTC, så det er en ren test).
  if (observed.toISOString().slice(0, 10) !== raw.observed_at) {
    return at(`observed_at '${raw.observed_at}' findes ikke — `
            + `den dato ville blive til ${observed.toISOString().slice(0, 10)}`);
  }
  // En observation i fremtiden er ikke en observation. Et døgns slæk, så en
  // tidszone eller et skævt ur ikke afviser dagen i dag.
  if (observed.getTime() > Date.now() + 86400000) {
    return at(`observed_at '${raw.observed_at}' ligger i fremtiden — `
            + 'datoen er den dag, prisen blev SET i butikken');
  }

  const unitPrice = Math.round((price / qty) * 1000) / 1000;

  // Samme bånd som bootstrappen og REMA-klienten bruger — reglen bor i
  // engine.js, fordi de tre skrivere skal være enige om den. Her fanger den
  // frem for alt tastefejlen: 1500 i stedet for 15,00. null betyder "vi har
  // intet bånd for kategorien" og er ikke et nej.
  if (engine.isPlausiblePrice(item.category, unitPrice, item.base_unit) === false) {
    // priceBandFor, ikke PRICE_BAND: en stk-vare måles mod stk-loftet, og en
    // besked med kilobåndets tal ville sende læseren efter en fejl, der ikke
    // findes ('brod' måles mod 60 kr/stk, ikke mod bakery-båndets 5-200).
    const band = engine.priceBandFor(item.category, item.base_unit);
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
 * Returnerer `{ line, row }` — eller `{ line, error }` for en linje, der ikke
 * kan blive til en række. `line` er linjen i FILEN: kommentarer og tomme linjer
 * siles fra, så en tæller over rækkerne ville pege det forkerte sted hen — og
 * en prisliste rettes i en editor, hvor linjenummeret er det eneste, man har
 * at gå efter.
 *
 * Fejl gives PR. LINJE og ikke som en undtagelse, så hele filen kan rettes i
 * ét hug. Samme grund som at parsePriceRow returnerer `{ error }`.
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
    // Et felt for meget er farligere end et for lidt. Filen er dansk og rettes
    // i hånden, så den nærliggende tastefejl er 15,95 i stedet for 15.95 — og
    // uden det her tjek forskubbes alle felter efter den: pack_price bliver 15,
    // observed_at bliver '95', og new Date('95') er en gyldig dato (1994). Der
    // kom ingen fejl; der kom bare en pris, der var 6 % forkert, på det mest
    // betroede niveau vi har. Vi skærer ikke de overskydende felter væk — vi
    // nægter at gætte på, hvilken kolonne der gik i stykker.
    if (cells.length !== header.length) {
      return { line: l.line, error: `linje ${l.line}: ${cells.length} felter, `
        + `men overskriften har ${header.length}` + (cells.length > header.length
          ? ' — et decimalkomma deler feltet i to. Skriv 15.95, ikke 15,95'
          : ' — der mangler et komma eller en værdi') };
    }
    return { line: l.line, row: Object.fromEntries(header.map((h, i) => [h, cells[i]])) };
  });
}

/**
 * To linjer med samme (vare, kæde, pakke) rammer den SAMME række i basen.
 *
 * ON CONFLICT DO UPDATE gjorde det tavst: den sidste linje vandt, og den, der
 * skrev begge, gik derfra i troen på, at den første stod i basen. En fil, hvor
 * to linjer strides om samme pris, er ikke en fil, nogen har ment — den skal
 * rettes, ikke tolkes.
 *
 * `parsed[i]` svarer til `rows[i]`, så linjenumrene kan følge med i beskeden.
 */
function flagDuplicates(parsed, rows) {
  const seen = new Map();
  return parsed.map((p, i) => {
    if (p.error) return p;
    const key = `${p.item_key}|${p.chain_id}|${p.pack_qty}|${p.pack_unit}`;
    const first = seen.get(key);
    if (first !== undefined) {
      return { error: `linje ${rows[i].line}: samme vare, kæde og pakke som linje `
        + `${first} — de to rammer den samme række, og kun den sidste ville stå `
        + 'i basen. Slet den ene.' };
    }
    seen.set(key, rows[i].line);
    return p;
  });
}

/**
 * Hvilke 'manual'-rækker står i basen uden længere at stå i filen?
 *
 * Importøren INDSÆTTER og opdaterer kun. Sletter man en linje — eller sætter
 * et # foran, som filens egen overskrift lærer folk — sker der ingenting: den
 * forkerte pris bliver stående for evigt på det mest betroede niveau vi har.
 *
 * Og importøren må ikke slette dem selv. En fil, der er blevet gemt halvt, en
 * fejlagtig `git checkout`, en editor der skriver 0 bytes — hver af dem ville
 * så tage rigtige priser med sig, uden at nogen bad om det. Derfor: vis
 * forskellen, og lad et menneske afgøre, om den skal væk.
 */
function reportOrphans(db, parsed) {
  const inFile = new Set(parsed.map(
    (p) => `${p.item_key}|${p.chain_id}|${p.pack_qty}|${p.pack_unit}`));
  const orphans = db.prepare(
    "SELECT item_key, chain_id, pack_qty, pack_unit, unit_price, observed_at"
    + " FROM item_prices WHERE source = 'manual'").all()
    .filter((r) => !inFile.has(`${r.item_key}|${r.chain_id}|${r.pack_qty}|${r.pack_unit}`));

  if (!orphans.length) return;
  const slugOf = new Map(db.prepare('SELECT id, slug FROM chains').all()
    .map((c) => [c.id, c.slug]));
  console.log(`\n${orphans.length} indtastet${orphans.length === 1 ? ' pris' : 'e priser'}`
            + ' står i basen uden at stå i filen:');
  for (const r of orphans) {
    console.log(`  ${r.item_key.padEnd(20)} ${(slugOf.get(r.chain_id) || r.chain_id).padEnd(13)}`
              + ` ${r.pack_qty} ${r.pack_unit}  ${r.unit_price} kr/${r.pack_unit}`
              + `  (set ${String(r.observed_at).slice(0, 10)})`);
  }
  console.log('Slet en linje i CSV\'en, og rækken her bliver stående — importøren'
            + '\nrører den ikke. Skal den væk, skal den slettes i hånden:'
            + "\n  DELETE FROM item_prices WHERE source='manual' AND item_key='…';");
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
    const parsed = flagDuplicates(
      rows.map((r) => (r.error ? r : parsePriceRow(r.row, { items, chains, line: r.line }))),
      rows,
    );

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
    reportOrphans(db, parsed);
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

module.exports = { parsePriceRow, parseCsv, flagDuplicates, reportOrphans, COLUMNS };
