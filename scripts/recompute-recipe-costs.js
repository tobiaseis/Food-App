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

/**
 * Prisen på ÉN opskrift i ÉN kæde. Ren funktion, så reglerne kan efterprøves
 * uden en base — det er her, de tre fælder i denne opgave sidder.
 *
 *   recipe   fra plans.loadRecipes(): `items` med key, amount og optional
 *   items    `items`-tabellen som Map, for class, keeps og base_unit
 *   unknown  antal ikke-valgfri ingredienslinjer UDEN item_key på retten
 *
 * `coverage` måles mod alt, retten faktisk kræver — også de linjer,
 * taksonomien ikke kender. De når aldrig ind i `recipe.items`, så talte vi kun
 * det, vi kan genkende, ville en ret med fem kendte og to ukendte stå som
 * fuldt prissat med en pris, der mangler to ingredienser — og budget-sporet
 * ville rangere den øverst, netop fordi vi ved mindst om den.
 */
function costRecipe(recipe, chainId, { offers, normals, items, unknown = 0 }) {
  let cost = 0; let costPacks = 0; let known = 0; let total = 0;

  for (const it of recipe.items) {
    const item = items.get(it.key);
    if (!item || item.class === 'essential') continue;   // essentials købes ikke
    // "evt. et skvæt fløde" købes ikke, og skal derfor hverken koste noget
    // eller kunne gøre en ret uprissætbar. Samme regel som indkøbslisten.
    if (it.optional) continue;
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

    // Kun den række, effectivePrice valgte. choosePack må kun se pakker fra
    // ÉT kildeniveau (se dens egen dokumentation), og rangordenen bor i
    // effectivePrice — den skal ikke skrives af her for at kunne sende flere
    // pakker med. I dag har hvert (vare, kæde)-par alligevel præcis én
    // pakkestørrelse på sit bedste niveau, så valget er givet på forhånd;
    // det, der tæller her, er oprundingen.
    const pack = engine.choosePack(need, [price], { keeps: item.keeps });
    if (pack) costPacks += pack.cost;
  }

  // De ukendte tæller med i nævneren, aldrig i tælleren.
  total += unknown;
  return {
    cost,
    cost_packs: costPacks,
    coverage: total ? known / total : 0,
    // `known === total`, ikke `coverage === 1`: en ret helt uden købte
    // ingredienser giver 0/0, og det er ikke en fuldt prissat ret.
    priceable: total > 0 && known === total ? 1 : 0,
  };
}

function main() {
  const db = getDb();
  const chains = db.prepare('SELECT id, name FROM chains ORDER BY name').all();
  const recipes = plans.loadRecipes({});
  const items = new Map(db.prepare('SELECT key, class, keeps, base_unit FROM items').all()
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
  const unknownCount = new Map(db.prepare(`
    SELECT recipe_id, count(*) n FROM recipe_ingredients
     WHERE item_key IS NULL AND COALESCE(optional, 0) = 0
     GROUP BY recipe_id`).all().map((r) => [r.recipe_id, r.n]));

  const ins = db.prepare(`
    INSERT INTO recipe_costs (recipe_id, chain_id, cost, cost_packs,
                              coverage, priceable, computed_at)
    VALUES (@recipe_id, @chain_id, @cost, @cost_packs, @coverage, @priceable, @computed_at)
    ON CONFLICT(recipe_id, chain_id) DO UPDATE SET
      cost = excluded.cost, cost_packs = excluded.cost_packs,
      coverage = excluded.coverage, priceable = excluded.priceable,
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
          { offers, normals, items, unknown: unknownCount.get(r.id) || 0 });
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
          coverage: Math.round(c.coverage * 1000) / 1000,
          priceable: c.priceable,
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
