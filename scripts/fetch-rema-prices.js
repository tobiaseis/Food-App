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
const { writeRemaCsv, storeRemaRows } = require('../src/prices/rema-store');
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
      // Hvornår REMA faktisk blev spurgt — ikke i dag. Genafspilles en
      // cache fra forrige uge, er prisen set forrige uge, og det er den dato,
      // udløbet skal regnes fra.
      fetchedAt: doc.fetched_at || new Date().toISOString(),
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
    fetchedAt: doc.fetched_at,
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

  // Lagringen bor i src/prices/rema-store.js, så hentningen og den natlige
  // indlæsning af data/rema-prices.csv skriver den SAMME slags række. Hvorfor
  // gamle rækker ryddes først, står ved storeRemaRows.

  const raw = rawSource({ fromRaw, saveRaw });
  const writes = [];
  let failed = 0;
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
        if (engine.isPlausiblePrice(item.category, parsed.unit_price, item.base_unit, item.key) === false) {
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
      // Tælles, fordi oprydningen nedenfor afhænger af, om runden var HEL.
      failed++;
      if (!raw.offline) await sleep(PAUSE_MS);
      continue;
    }

    if (!best) { miss++; if (!raw.offline) await sleep(PAUSE_MS); continue; }
    hit++;
    console.log(`${item.key.padEnd(24)} ${best.pack_qty}${best.pack_unit} `
              + `${best.pack_price} kr (${best.unit_price}/${best.pack_unit})  ${best.name}`);

    // Samles op og skrives til sidst, i ÉN transaktion sammen med
    // oprydningen. Skrev vi undervejs, ville sletningen af de gamle rækker
    // enten skulle ske først — på et tidspunkt, hvor vi endnu ikke ved, om
    // der kommer noget at sætte i stedet — eller slet ikke kunne ske.
    writes.push({
      item_key: item.key,
      // Afrundet: 350 g / 1000 er 0.35000000000000003. Det stod i filen, og
      // som nøgle ville det aldrig ramme en indtastet 0.35 på samme pakke.
      pack_qty: Math.round(best.pack_qty * 1e6) / 1e6, pack_unit: best.pack_unit,
      pack_price: best.pack_price, unit_price: best.unit_price,
      observed_at: raw.fetchedAt,
      // Står i filen, så et forkert match kan ses i en diff.
      product: best.name,
    });
    if (!raw.offline) await sleep(PAUSE_MS);
  }

  raw.done();

  if (!dryRun) {
    // Og en ufuldstændig runde rydder ikke op. Fejlede opslag er varer, vi
    // ikke har spurgt om i dag; deres gamle række er det bedste, vi ved, og
    // en oprydning bygget på en halv sweep ville slette den.
    //
    // Af SAMME grund skrives filen kun efter en hel runde. data/rema-prices.csv
    // er det, den natlige kørsel indlæser med oprydning — manglede de fejlede
    // varer i filen, ville natten slette deres priser.
    const clean = !failed;
    if (clean) writeRemaCsv(writes);
    // .changes og ikke writes.length: en indtastet pris på samme pakke afviser
    // skrivningen, og et tal, der tæller FORSØG, ville påstå, at rækken blev skrevet.
    const { dropped, ok } = storeRemaRows(db, chain.id, writes,
      { clean, validUntilFor: engine.validUntilFor });
    if (!clean) {
      console.log(`\n${ok} rækker skrevet · ${failed} opslag fejlede, så de gamle `
                + 'rækker bliver stående, og data/rema-prices.csv er IKKE opdateret '
                + '(en halv runde må ikke blive det, natten indlæser). Kør igen.');
    } else {
      console.log(`\nryddede ${dropped} tidligere api:rema-rækker · skrev ${ok}`
                + (ok < writes.length
                  ? ` (${writes.length - ok} afvist: en indtastet pris står på samme pakke)` : '')
                + `\ndata/rema-prices.csv skrevet med ${writes.length} priser — commit den, `
                + 'så den natlige kørsel får dem med.');
    }
  }

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
  if (dryRun) {
    const gamle = db.prepare(
      "SELECT count(*) c FROM item_prices WHERE chain_id = ? AND source = 'api:rema'")
      .get(chain.id).c;
    console.log(`(--dry-run: intet skrevet. En rigtig kørsel ville rydde ${gamle} `
              + `api:rema-rækker og skrive ${writes.length})`);
  }
}

// Kun når scriptet køres direkte. Et require() — fra en test eller et
// hurtigt tjek af, at filen kan indlæses — må ALDRIG starte et kald til REMA.
// Det skete under plan 3: et `node -e "require(...)"` startede en rigtig
// hentning, som kun døde, fordi outputtet blev lukket, før den nåede at
// skrive. De andre scripts i mappen har vagten af samme grund.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
