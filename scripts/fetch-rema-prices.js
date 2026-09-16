'use strict';

/**
 * Henter normalpriser fra REMA 1000 for alle varer, der skal prissættes.
 *
 * Én søgning pr. vare, på varens navn — ikke synonymerne også, for det ville
 * gange kaldene op med fem mod et API, vi ikke er inviteret til.
 *
 * Et søgeresultat er ikke et sikkert match — "kartofler" giver også
 * kartoffelsalat — så et produkt skal igennem tre sier, før prisen tælles med:
 *
 *   1. taksonomien: produktnavnet skal slå op til den SAMME vare,
 *   2. DERAILING_WORDS i src/prices/rema.js — er det overhovedet den vare?
 *      SKINKESALAT er ikke skinke, TORSKEROGN er ikke torsk,
 *   3. PRICE_BASIS_WORDS samme sted — er tallet varens kilopris? Vægten i
 *      BLOMKÅLSBLANDING er også broccoli og gulerod, olien i LAKS I
 *      OLIVENOLIE vejer med, og MADSPILD er en ryddepris, ikke en normalpris,
 *   4. kategoriens prisbånd i engine.js: er det overhovedet en hyldepris?
 *
 * Målet er ikke flest mulige match. En forkert normalpris er værre end en
 * manglende, fordi ingenting gør opmærksom på den.
 *
 *   npm run prices:rema
 *   npm run prices:rema -- --dry-run
 *
 * Tørkørslen koster knap 200 forespørgsler, og matchningen skal justeres flere
 * gange. Derfor kan søgesvarene gemmes og spilles om uden netværk:
 *
 *   npm run prices:rema -- --dry-run --save-raw tmp/rema-raw.json
 *   npm run prices:rema -- --dry-run --from-raw tmp/rema-raw.json
 *
 * Alt efter selve søgningen virker ens de to veje. Filen hører ikke i git —
 * den er et øjebliksbillede, ikke en kilde.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../src/db');
const taxonomy = require('../src/lib/taxonomy');
const { parseRemaProduct, searchRema, derailingWord, wrongPriceBasis } = require('../src/prices/rema');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

const REMA_SLUG = 'rema1000';
const PAUSE_MS = 400;   // høflighed mod et API, vi ikke er inviteret til

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `--save-raw fil` / `--save-raw=fil` -> "fil", eller null hvis flaget mangler.
 *
 * Et flag UDEN filnavn kaster. Ellers ville `--from-raw` (skrivefejl, glemt
 * sti) stille og roligt falde tilbage til netværket og koste de 184
 * forespørgsler, filen netop var til for at spare.
 */
function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0) {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} kræver et filnavn`);
    return next;
  }
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (!eq) return null;
  const val = eq.slice(flag.length + 1);
  if (!val) throw new Error(`${flag} kræver et filnavn`);
  return val;
}

/**
 * Søgesvarene, enten fra nettet eller fra en gemt fil.
 *
 * De to veje har med vilje samme grænseflade: alt efter søgningen — parsning,
 * taksonomi, produktnavne-liste, prisbånd, skrivning — kører ens, uanset hvor
 * svaret kom fra. Ellers ville en fil kun kunne bruges til at kigge på, og
 * rettelser i matchningen skulle stadig betales med nye kald.
 */
function rawSource({ fromRaw, saveRaw }) {
  if (fromRaw) {
    const doc = JSON.parse(fs.readFileSync(fromRaw, 'utf8'));
    const queries = doc.queries || {};
    console.log(`(--from-raw: ${Object.keys(queries).length} gemte søgninger fra `
              + `${doc.fetched_at || 'ukendt tidspunkt'} — intet netværk)`);
    return {
      offline: true,
      // En vare, der ikke står i filen, er IKKE det samme som en vare uden
      // træf. Den kastes, så en gammel fil ikke stille viser sig som "intet
      // match" på varer, der aldrig blev søgt på.
      async get(item) {
        if (!queries[item.key]) throw new Error(`ikke i --from-raw-filen: ${item.key}`);
        return queries[item.key].products || [];
      },
      done() {},
    };
  }

  const doc = { fetched_at: new Date().toISOString(), source: 'api.digital.rema1000.dk', queries: {} };
  return {
    offline: false,
    async get(item) {
      const products = await searchRema(item.name);
      if (saveRaw) {
        doc.queries[item.key] = { query: item.name, products };
        // Skrives efter HVER vare, ikke til sidst: går kørslen i stykker
        // halvvejs, er de kald, der allerede er betalt for, stadig gemt.
        fs.mkdirSync(path.dirname(path.resolve(saveRaw)), { recursive: true });
        fs.writeFileSync(saveRaw, JSON.stringify(doc, null, 1));
      }
      return products;
    },
    done() {
      if (saveRaw) console.log(`(--save-raw: ${Object.keys(doc.queries).length} søgninger gemt i ${saveRaw})`);
    },
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const saveRaw = argValue(process.argv, '--save-raw');
  const fromRaw = argValue(process.argv, '--from-raw');
  if (saveRaw && fromRaw) throw new Error('--save-raw og --from-raw kan ikke bruges sammen');

  const db = getDb();

  const chain = db.prepare('SELECT id, name FROM chains WHERE slug = ?').get(REMA_SLUG);
  if (!chain) throw new Error(`kæden '${REMA_SLUG}' findes ikke i chains`);

  const items = db.prepare(
    `SELECT key, name, class, base_unit, category FROM items
      WHERE class <> 'essential' AND category <> 'nonfood' ORDER BY key`
  ).all();

  const ins = db.prepare(`
    INSERT INTO item_prices (item_key, chain_id, pack_qty, pack_unit,
                             pack_price, unit_price, source, observed_at, valid_until)
    VALUES (@item_key, @chain_id, @pack_qty, @pack_unit,
            @pack_price, @unit_price, 'api:rema', @observed_at, @valid_until)
    ON CONFLICT(item_key, chain_id, pack_qty, pack_unit) DO UPDATE SET
      pack_price = excluded.pack_price, unit_price = excluded.unit_price,
      source = excluded.source, observed_at = excluded.observed_at,
      valid_until = excluded.valid_until,
      -- En hentet pris er ikke gættet frem. Ramte den et 'derived'-gæt på samme
      -- (vare, kæde, pakke), ville gættets n_obs blive hængende og få rækken
      -- til at se ud som et gæt bygget på n observationer. Samme grund som i
      -- import-prices.js.
      n_obs = 0
     -- En indtastet pris er set af et menneske. Den vinder over et API.
     WHERE item_prices.source <> 'manual'
  `);

  const raw = rawSource({ fromRaw, saveRaw });
  const now = new Date();
  let hit = 0, miss = 0, skipped = 0;
  const derailed = [];
  const wrongBasis = [];
  const implausible = [];

  for (const item of items) {
    let best = null;
    try {
      for (const product of await raw.get(item)) {
        const parsed = parseRemaProduct(product);
        if (!parsed || parsed.pack_unit !== item.base_unit) continue;
        // Navnet skal slå op til den samme vare gennem vores egen taksonomi.
        if (taxonomy.lookup(product.name)?.entry.key !== item.key) { skipped++; continue; }
        // Taksonomien er ikke nok: SKINKESALAT slår op til skinke, fordi
        // navnet indeholder ordet. Listen i rema.js fanger de produkter,
        // hvor varens ord står i noget helt andet.
        const self = `${item.key} ${item.name}`;
        const word = derailingWord(product, self);
        if (word) { derailed.push({ key: item.key, word: word.label, name: parsed.name, underline: product.underline || '' }); continue; }
        // Anden si, anden slags fejl. Her ER varen rigtig, men kiloprisen er
        // regnet på en vægt, der ikke kun er varen — eller på en ryddepris.
        const basis = wrongPriceBasis(product, self);
        if (basis) { wrongBasis.push({ key: item.key, word: basis.label, name: parsed.name, underline: product.underline || '' }); continue; }
        // Sidste værn før skrivning: er det overhovedet en hyldepris?
        if (engine.isPlausiblePrice(item.category, parsed.unit_price, item.base_unit) === false) {
          implausible.push({ key: item.key, ...parsed });
          continue;
        }
        // BEMÆRK en systematisk skævhed i "billigst vinder": det forarbejdede,
        // blandede eller nedsatte produkt er næsten altid billigere pr. kilo
        // end råvaren selv, så den regel trækker HVER normalpris nedad. Alle
        // seks fejl, PRICE_BASIS_WORDS fanger, var billigste match på deres
        // vare. Det er spejlbilledet af den skævhed, opgave 1 fjernede, og de
        // to lister er en lap på den, ikke en løsning: så længe den billigste
        // overlevende vinder, er det kun de fejl, nogen har sat ord på, der
        // ikke slipper igennem. Se rapporten til opgave 3 for medianen som
        // alternativ.
        if (!best || parsed.unit_price < best.unit_price) best = parsed;
      }
    } catch (err) {
      console.error(`${item.key}: ${err.message}`);
      if (!raw.offline) await sleep(PAUSE_MS);
      continue;
    }

    if (!best) { miss++; if (!raw.offline) await sleep(PAUSE_MS); continue; }
    hit++;
    console.log(`${item.key.padEnd(24)} ${best.pack_qty}${best.pack_unit} `
              + `${best.pack_price} kr (${best.unit_price}/${best.pack_unit})  ${best.name}`);

    if (!dryRun) {
      ins.run({
        item_key: item.key, chain_id: chain.id,
        pack_qty: best.pack_qty, pack_unit: best.pack_unit,
        pack_price: best.pack_price, unit_price: best.unit_price,
        observed_at: now.toISOString(),
        valid_until: engine.validUntilFor(item.class, now),
      });
    }
    if (!raw.offline) await sleep(PAUSE_MS);
  }

  raw.done();

  console.log(`\nfundet: ${hit} · intet match: ${miss} · forkastet på taksonomi: ${skipped}`
            + ` · forkastet på produktnavn: ${derailed.length}`
            + ` · forkastet på vægtgrundlag: ${wrongBasis.length}`
            + ` · forkastet på prisbånd: ${implausible.length}`);
  // Printes, ikke bare tælles: hver afvisning er et produkt, taksonomien
  // slap igennem, og listen skal kunne læses med øjnene — både for at se, at
  // den rammer det rigtige, og for at opdage det, den endnu ikke fanger.
  //
  // De to lister holdes adskilt i udskriften, fordi de svarer på hver sit
  // spørgsmål. Blandet sammen kan man ikke se, hvilken slags fejl der vokser,
  // og de kræver hver sin rettelse: et nyt ord i den ene liste, eller en
  // erkendelse af, at kiloprisen på en hel varegruppe ikke er sammenlignelig.
  console.log('\n— forkert vare (produktnavnet siger noget andet) —');
  for (const r of derailed) {
    console.log(`  ${r.key.padEnd(20)} ${String(r.word).padEnd(12)} ${r.name}  ||  ${r.underline}`);
  }
  console.log('\n— rigtig vare, men prisen er ikke pr. kilo af den —');
  for (const r of wrongBasis) {
    console.log(`  ${r.key.padEnd(20)} ${String(r.word).padEnd(12)} ${r.name}  ||  ${r.underline}`);
  }
  console.log('\n— uden for kategoriens prisbånd —');
  for (const r of implausible) {
    console.log(`  ${r.key.padEnd(20)} ${r.unit_price}/${r.pack_unit}  ${r.name}`);
  }
  if (dryRun) console.log('(--dry-run: intet skrevet)');
}

main().catch((e) => { console.error(e); process.exit(1); });
