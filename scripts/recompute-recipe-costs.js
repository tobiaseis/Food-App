'use strict';

/**
 * Fylder recipe_costs for hver (opskrift, kæde).
 *
 * To pristal, fordi de svarer på hver sit spørgsmål. `cost` er proportional
 * — mængde × enhedspris — og er den rigtige til at RANGERE opskrifter mod
 * hinanden: den straffer ikke en ret for, at gulerødder sælges i poser på et
 * kilo. `cost_packs` er hele pakker og er den rigtige, hvis retten står
 * alene. Den faktiske madplanspris regnes på hele ugen, hvor flere retter
 * deles om samme pose, og ligger derfor under summen af cost_packs.
 *
 * Tabellen findes, fordi budget-sporet skal kunne sortere 2.224 opskrifter
 * uden at regne noget. Kør den, når tilbuddene er hentet.
 *
 *   npm run costs:recompute
 */

const path = require('node:path');
const { getDb } = require('../src/db');
const plans = require('../src/mealplan/generate');
const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));
const { isBoughtLine, hasMainCourse, DEFAULT_SERVINGS } = engine;

// Hvilke linjer der overhovedet købes — basisvarer og "evt. et skvæt fløde"
// gør ikke, men en valgfri hovedprotein gør — bor i engine.js som
// `isBoughtLine`. Reglen stod her alene indtil opgave 7, hvor ugens kurv
// skulle bruge den samme: købte madplanen den valgfri persille, mens
// recipe_costs lod være, ville de to tal, brugeren ser side om side, være
// regnet på hver sin ret.
//
// Baggrunden for undtagelsen: OPTIONAL_RE i src/recipes/extract.js matcher
// `optional` og `if you like` HVOR SOM HELST i linjen, mens de danske mønstre
// er forankret til linjestart. "4 chicken breasts (skinless, if you like)" og
// "2 whole tilapia … (optional to keep head on)" blev derfor flaget, og flaget
// fjerner linjen fra BÅDE prisen og nævneren: et fejlflag bliver til "fuldt
// prissat og næsten gratis" og lander øverst i budget-sporet. Den første af de
// to var indtil nu basens billigste prissatte ret til 0,08 kr med coverage 1.
//
// At forankre de engelske mønstre er målt til netto negativt — 17 ægte flag
// ("few sprigs thyme optional") tabt for at rette 5, og forskellen på
// "(optional; se tip)" og "(se tip, optional)" er ordstilling. Så grænsen
// trækkes, hvor den kan siges enkelt: en hovedprotein er aldrig valgfri.
// Prisen for reglen er de 5 linjer, hvor kødet ER en garniture (ansjoser i en
// braiseret oksebryst, pancetta på fritter) — de bliver nu købt. Færre og
// rigtige retter slår flere og forkerte, samme regel som resten af planen.

/**
 * Prisen på ÉN opskrift i ÉN kæde. Ren funktion, så reglerne kan efterprøves
 * uden en base — det er her, fælderne i denne opgave sidder.
 *
 *   recipe   fra plans.loadRecipes(): `items` med key, amount og optional
 *   items    `items`-tabellen som Map, for class, keeps, base_unit og category
 *   unknown  antal ikke-valgfri ingredienslinjer UDEN item_key på retten
 *
 * `coverage` måles mod alt, retten faktisk kræver — også de linjer,
 * taksonomien ikke kender. De når aldrig ind i `recipe.items`, så talte vi kun
 * det, vi kan genkende, ville en ret med fem kendte og to ukendte stå som
 * fuldt prissat med en pris, der mangler to ingredienser — og budget-sporet
 * ville rangere den øverst, netop fordi vi ved mindst om den.
 */
function costRecipe(recipe, chainId, { offers, normals, items, unknown = 0 }) {
  let cost = 0; let known = 0; let total = 0;

  // Portionsantallet og hovedråvare-spærren HENTES i motoren, de skrives
  // ikke af. Det var præcis dén fejl, `bestPriceFor` blev rettet for: to
  // kopier af samme regel driver fra hinanden, og så sorterer budget-sporet
  // efter ét tal, mens madplanen vælger efter et andet.
  const servings = recipe.servings > 0 ? recipe.servings : DEFAULT_SERVINGS;

  // Behovet pr. VARE, ikke pr. linje. Samme vare står på flere linjer i 1.086
  // af de 2.224 opskrifter ("1 lemon, zested" og "zest of 1 lemon", persille
  // fire steder), og rundes hver linje op for sig, køber cost_packs en pose
  // pr. linje: Potato masa tortillas betalte 31,90 kr for to 2 kg-poser
  // kartofler, den samme pose to gange. `cost` er lineær og rammes ikke.
  // choosePack er selv skrevet til et sammenlagt behov — se dens note om
  // 1.2000000000000002.
  const packNeed = new Map();

  for (const it of recipe.items) {
    const item = items.get(it.key);
    // Basisvarer købes ikke, og "evt. et skvæt fløde" skal hverken koste noget
    // eller kunne gøre en ret uprissætbar. Samme regel som indkøbslisten og som
    // ugens kurv i engine.sharedWeek — se kommentaren ovenfor.
    if (!isBoughtLine(it, item)) continue;
    total++;

    // `amount`, ikke `weight`. De to er kun det samme for kg/l-varer.
    // `weight` er en ROLLEVÆGT — stykantal omregnet til kilo, så assignRoles
    // kan sammenligne 6 æg med 0,4 kg kylling — mens `amount` er mængden i
    // varens EGEN enhed, og det er den, prisen er målt i. For de tre
    // stk-varer (aeg, brod, tortilla) er forskellen faktoren piece_g/1000:
    // et æg til 3 kr/stk ville med vægten koste 0,058 × 3 = 17 øre, og 748
    // opskrifter har mindst én stk-vare. src/lib/units.js siger det samme om
    // amountOf: "Det er dette tal, indkøbslisten lægger sammen og runder op
    // til hele pakker."
    const need = it.amount;
    if (!(need > 0)) continue;

    // `baseUnit` er ikke pynt: uden den returnerer effectivePrice et tilbud i
    // AVISENS enhed, når der ingen normalpris er, og så ganges et behov i stk
    // med en kilopris. 257 (vare, kæde)-par i basen er præcis den sag — brod
    // hos Min Købmand står til 9,90 kr/KG på en vare, der måles i STK.
    const price = engine.effectivePrice(it.key, chainId,
      { offers, normals, baseUnit: item.base_unit });
    if (!price) continue;
    known++;

    cost += need * price.unit_price;

    // Linjen lægges i behovet for VAREN; pakken vælges først, når hele
    // opskriften er talt op.
    const prev = packNeed.get(it.key);
    if (prev) prev.need += need;
    else packNeed.set(it.key, { need, price, keeps: item.keeps });
  }

  // Først her rundes der op. choosePack må kun se pakker fra ÉT kildeniveau
  // (se dens egen dokumentation), og rangordenen bor i effectivePrice — som
  // derfor bærer hele det vindende niveau med ud i `price.packs`. Den liste
  // skal sendes videre uskåret: `[p.price]` ville kaste de andre
  // pakkestørrelser væk og gøre pakkevalget til en ren oprunding af den
  // række, der var billigst pr. enhed.
  let costPacks = 0;
  for (const p of packNeed.values()) {
    const pack = engine.choosePack(p.need, p.price.packs || [p.price], { keeps: p.keeps });
    if (pack) costPacks += pack.cost;
  }

  // De ukendte tæller med i nævneren, aldrig i tælleren.
  total += unknown;
  return {
    cost,
    cost_packs: costPacks,
    // Kroner PR. PORTION. `cost` er hele gryden, og gryderne er ikke lige
    // store: 29 af de 160 prissatte REMA-opskrifter siger servings = 1 og 18
    // siger ingenting. Sorteret på `cost` returnerer budget-sporet derfor
    // dressinger og saucer — den liste, opgave 7 afviste i madplanen — mens
    // en familiegryde ser dyr ud, fordi den mætter fire.
    //
    // Regnet på `cost` og ikke på `cost_packs`: den proportionale pris er
    // den, der kan sammenlignes på tværs af retter (se filens hoved), og
    // hele pakker hører til den ret, der står ALENE.
    cost_per_serving: cost / servings,
    coverage: total ? known / total : 0,
    // `known === total`, ikke `coverage === 1`: en ret helt uden købte
    // ingredienser giver 0/0, og det er ikke en fuldt prissat ret.
    priceable: total > 0 && known === total ? 1 : 0,
    // Er retten overhovedet aftensmad? Motorens egen spærre, ikke en kopi:
    // sirup, hot honey, mørdej og en roux er billige, fuldt prissatte og
    // ikke en middag. Flaget står i tabellen frem for at filtrere rækken væk,
    // så tallene stadig kan slås op for en ret, der bruges som tilbehør.
    has_main: hasMainCourse(recipe, items) ? 1 : 0,
  };
}

function main() {
  const db = getDb();
  const chains = db.prepare('SELECT id, name FROM chains ORDER BY name').all();
  const recipes = plans.loadRecipes({});
  // `category` er med, fordi MAIN_PROTEIN spørger til den: et 'optional'-flag
  // på kød, fjerkræ eller fisk skal ikke tros.
  const items = new Map(db.prepare('SELECT key, class, keeps, base_unit, category FROM items').all()
    .map((i) => [i.key, i]));

  // Ingredienser, taksonomien ikke kender, når ALDRIG ind i r.items:
  // loadRecipes springer dem over. Talte man kun de kendte, ville en ret med
  // 5 kendte og 2 ukendte få coverage = 1 og en pris, der mangler to
  // ingredienser — og budget-sporet ville rangere den øverst, netop fordi vi
  // ved mindst om den. 678 af de 2.224 opskrifter (30,5 %) har mindst én
  // ukendt, ikke-valgfri linje, så det er ikke et randtilfælde.
  //
  // De valgfri tælles ikke med: "evt. et skvæt fløde" købes ikke, og en
  // ukendt evt.-linje skal derfor heller ikke kunne gøre retten uprissætbar.
  //
  // Tallet REGNES IKKE her. `loadRecipes` tæller det allerede — samme regel,
  // samme WHERE — og lægger det på `r.unknown_count`, som både browserens
  // canPrice og recipe_index bygger på. Stod der også en SQL her, ville ét
  // tal have to definitioner, og den dag den ene ændrer sig, ville
  // budget-sporet og madplanen være uenige om, hvilke retter vi kender helt.

  const ins = db.prepare(`
    INSERT INTO recipe_costs (recipe_id, chain_id, cost, cost_packs, cost_per_serving,
                              coverage, priceable, has_main, computed_at)
    VALUES (@recipe_id, @chain_id, @cost, @cost_packs, @cost_per_serving,
            @coverage, @priceable, @has_main, @computed_at)
    ON CONFLICT(recipe_id, chain_id) DO UPDATE SET
      cost = excluded.cost, cost_packs = excluded.cost_packs,
      cost_per_serving = excluded.cost_per_serving,
      coverage = excluded.coverage, priceable = excluded.priceable,
      has_main = excluded.has_main,
      computed_at = excluded.computed_at
  `);

  const now = new Date().toISOString();
  let written = 0;
  let priceableTotal = 0;
  // cost_packs kan ALDRIG være mindre end cost: man kan ikke købe færre varer
  // end behovet. Sker det alligevel, er de to regnestykker uenige, og det skal
  // siges højt frem for at ende som en billig ret i budget-sporet.
  //
  // Én kendt kilde til det, målt: `item_prices.unit_price` er gemt afrundet og
  // kan ligge en anelse OVER pack_price/pack_qty (150 af 650 rækker; baer hos
  // ABC Lavpris har 24,98 mod 24,975). Går behovet præcist op i pakker, vender
  // de to tal med under en øre. Alt større end det er noget andet.
  const inverted = [];

  for (const chain of chains) {
    const offers = plans.activeOfferMap({ chainIds: [chain.id] });
    const normals = plans.normalPricesFor([chain.id]);
    let priceableHere = 0;

    const run = db.transaction(() => {
      for (const r of recipes) {
        const c = costRecipe(r, chain.id,
          { offers, normals, items, unknown: r.unknown_count || 0 });
        if (c.priceable) { priceableHere++; priceableTotal++; }
        // Tolerancen er en halv øre: de gemte tal afrundes til to decimaler,
        // og en uenighed under den kan ikke ses i tabellen.
        if (c.cost_packs < c.cost - 0.005) {
          inverted.push({ recipe: r.title, chain: chain.name, cost: c.cost, costPacks: c.cost_packs });
        }

        ins.run({
          recipe_id: r.id,
          chain_id: chain.id,
          cost: Math.round(c.cost * 100) / 100,
          cost_packs: Math.round(c.cost_packs * 100) / 100,
          cost_per_serving: Math.round(c.cost_per_serving * 100) / 100,
          coverage: Math.round(c.coverage * 1000) / 1000,
          priceable: c.priceable,
          has_main: c.has_main,
          computed_at: now,
        });
        written++;
      }
    });
    run();
    console.log(`${chain.name.padEnd(16)} ${String(recipes.length).padStart(5)} opskrifter`
              + ` · fuldt prissat: ${String(priceableHere).padStart(5)}`);
  }

  console.log(`\nrækker: ${written} · fuldt prissatte (opskrift × kæde): ${priceableTotal}`);

  if (inverted.length) {
    console.log(`\ncost_packs LAVERE end cost i ${inverted.length} rækker — de to`
              + ' regnestykker er uenige, og det skal undersøges:');
    for (const x of inverted.slice(0, 10)) {
      console.log(`  ${x.chain.padEnd(14)} ${x.cost.toFixed(2).padStart(8)} >`
                + ` ${x.costPacks.toFixed(2).padStart(8)}  ${String(x.recipe).slice(0, 44)}`);
    }
  }
}

// Testen indlæser filen for at få fat i costRecipe og må ikke komme til at
// genberegne hele basen som bivirkning.
if (require.main === module) main();

module.exports = { costRecipe };
