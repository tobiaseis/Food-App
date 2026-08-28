'use strict';

/**
 * Madplans-motoren – ren logik, ingen database.
 *
 * Filen ligger i `public/`, fordi den køres BEGGE steder:
 *
 *   · Node   – `src/mealplan/generate.js` henter data fra SQLite og kalder her.
 *   · Browser – `public/data.js` henter færdige indeks fra Supabase og kalder her.
 *
 * Én kopi af reglerne, to datakilder. Alternativet – en kopi hvert sted – ville
 * betyde, at madplanen lokalt og madplanen i skyen langsomt blev to
 * forskellige apps.
 *
 * ── Hvad motoren afgør ──────────────────────────────────────────────────────
 *
 * En ret kommer med i planen, hvis dens HOVEDRÅVARER er på tilbud i de
 * butikker, brugeren rent faktisk handler i. Ikke alle ingredienser skal være
 * på tilbud – det ville aldrig kunne lade sig gøre – og basisvarer (salt,
 * olie, krydderier, mel) tæller slet ikke med, fordi de står i skabet i
 * forvejen.
 *
 * Ingredienserne deles derfor i tre:
 *
 *   HOVEDRÅVARE   kødet, fisken, bønnerne – det retten hedder noget efter, og
 *                 det der fylder mest på bonen. I en fajita: kyllingen.
 *   STØTTERÅVARE  peberfrugt, tortillas, flåede tomater. Tæller positivt, når
 *                 de er på tilbud, men er ikke et krav.
 *   BASISVARE     salt, peber, olie, mel, krydderier. Tælles slet ikke.
 *
 * Kravet strammes eller lempes automatisk efter, hvor mange retter der rent
 * faktisk kan bygges af ugens tilbud i brugerens butikker – se LEVELS. Har man
 * kun to butikker i nærheden, er der færre tilbud at bygge på, og så er det
 * bedre at lempe kravet end at svare "ingen madplan".
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ── Rollefordeling ─────────────────────────────────────────────────────────

  // Kategorier der kan bære en ret. Det er dem, retten planlægges omkring.
  const MAIN_CATS = new Set(['meat', 'poultry', 'fish', 'eggs', 'legume']);

  // Bærende, men ikke hovedrolle. Bruges som reserve-hovedråvare i
  // vegetarretter, hvor der ikke er noget kød at pege på.
  const CARRIER_CATS = new Set(['veg', 'grain', 'bakery', 'cheese', 'dairy', 'fruit']);

  // Må aldrig indgå i en madplans-vurdering. En rødvin til en gryderet er
  // ikke et argument for at lave retten, og et tilbud på chips er slet ikke.
  const IGNORED_CATS = new Set(['drink', 'snack', 'nonfood']);

  // Tilbehøret, en ret bygges op om. Bruges kun til at holde ugen varieret:
  // syv retter med hver sin protein er stadig en kedelig uge, hvis alle syv
  // serveres med pasta.
  const STARCH_KEYS = new Set(['pasta', 'ris', 'kartofler', 'brod', 'tortilla',
                               'bulgur', 'pizza', 'sodkartoffel', 'havregryn']);

  // Ingredienser uden oplyst mængde vægtes som en middelstor portion, så et
  // "bacon til pynt" ikke pludselig bliver rettens hovedråvare.
  const ROLE_FALLBACK_G = 100;

  const MAIN_MIN_G  = 40;      // under det er man pynt, ikke hovedråvare
  const MAIN_SHARE  = 0.35;    // … og mindst en tredjedel af den største
  const MAX_MAINS   = 3;       // flere end det er et krav, ingen uge kan opfylde

  const roleWeight = (item) => (item.grams != null && item.grams > 0 ? item.grams : ROLE_FALLBACK_G);

  /**
   * Deler en opskrifts ingredienser i hovedråvarer, støtteråvarer og basisvarer.
   *
   * `items` er `{ key, cat, staple, grams, ingredient }` – taksonomien er
   * allerede slået op af den, der kalder, så motoren selv er fri for opslag.
   *
   * `unknownMain` sættes, når opskriften indeholder en ingrediens, der ligner
   * kød eller fisk, men ikke kunne slås op. Så må reserve-reglen for
   * vegetarretter IKKE træde til: retten ville ellers blive planlagt op om
   * kartoflerne ved siden af og love et tilbud på et lam, vi aldrig har
   * kigget efter. Uden hovedråvare falder retten ud af planen i stedet.
   */
  function assignRoles(items, { unknownMain = false } = {}) {
    const staples = [];
    const usable = [];

    for (const raw of items || []) {
      if (!raw || !raw.key) continue;
      const item = {
        key: raw.key,
        cat: raw.cat || null,
        ingredient: raw.ingredient || raw.name || raw.key,
        name: raw.name || null,
        grams: raw.grams != null && raw.grams > 0 ? raw.grams : null,
      };
      if (raw.staple || IGNORED_CATS.has(item.cat)) { staples.push(item); continue; }
      usable.push(item);
    }

    // Samme varetype kan optræde flere gange i en ingrediensliste ("2 løg" +
    // "1 løg til dressingen"). Den skal kun stilles som ét krav – vi beholder
    // den største mængde, fordi det er den, prisen skal regnes på.
    const byKey = new Map();
    for (const it of usable) {
      const prev = byKey.get(it.key);
      if (!prev || roleWeight(it) > roleWeight(prev)) byKey.set(it.key, it);
    }
    const list = [...byKey.values()];

    let mains = list
      .filter((i) => MAIN_CATS.has(i.cat))
      .sort((a, b) => roleWeight(b) - roleWeight(a));

    if (mains.length) {
      const top = roleWeight(mains[0]);
      mains = mains
        .filter((i) => roleWeight(i) >= Math.max(MAIN_MIN_G, top * MAIN_SHARE))
        .slice(0, MAX_MAINS);
    } else if (!unknownMain) {
      // Vegetarret: den tungeste bærende råvare træder i stedet for kødet,
      // så en linsegryde stadig har noget, planen kan stilles op omkring.
      mains = list
        .filter((i) => CARRIER_CATS.has(i.cat))
        .sort((a, b) => roleWeight(b) - roleWeight(a))
        .slice(0, 1);
    }

    const mainKeys = new Set(mains.map((m) => m.key));
    const support = list.filter((i) => !mainKeys.has(i.key));

    return { mains, support, staples };
  }

  // ── Krav-trin ──────────────────────────────────────────────────────────────

  /**
   * Fra strengest til mildest. Motoren vælger det STRENGESTE trin, der stadig
   * giver nok retter at vælge imellem, og fortæller hvilket det blev – ellers
   * ville brugeren ikke kunne se forskel på "alt er på tilbud" og "vi gav op".
   */
  const LEVELS = [
    { id: 'strict', mains: 'all', support: 0.25,
      label: 'Alle hovedråvarer på tilbud – og mindst en fjerdedel af resten' },
    { id: 'mains', mains: 'all', support: 0,
      label: 'Alle hovedråvarer på tilbud' },
    { id: 'main', mains: 'top', support: 0,
      label: 'Rettens vigtigste hovedråvare på tilbud' },
    { id: 'loose', mains: 'none', support: 0,
      label: 'Mindst én råvare på tilbud' },
  ];

  function qualifies(s, level) {
    if (level.mains === 'all' && !s.mains_all_on_offer) return false;
    if (level.mains === 'top' && !s.main_on_offer) return false;
    if (level.mains === 'none' && s.match_count === 0) return false;
    if (level.support > 0 && s.support_coverage < level.support) return false;
    return true;
  }

  // ── Scoring af én opskrift ─────────────────────────────────────────────────

  const round2 = (n) => Math.round(n * 100) / 100;

  // Over dette er mængden næsten altid en fejllæsning ("1 pakke" tolket som
  // kilo). Et enkelt sådant tal ville alene bestemme hele planens prisoverslag.
  const MAX_SANE_G = 5000;

  /** Kun vægt-/rumfangstilbud kan prissættes ud fra en opskrifts mængder. */
  function qtyInBase(grams, baseUnit) {
    if (!grams || grams > MAX_SANE_G) return null;
    return baseUnit === 'kg' || baseUnit === 'l' ? grams / 1000 : null;
  }

  /**
   * Hvor stor en del af retten er på tilbud – og hvad koster den cirka?
   *
   * `offers` slår varetype op i det billigste aktive tilbud i brugerens egne
   * butikker. `normalPrices` er varetypens normalpris (median kr/kg) og bruges
   * både som reference for besparelsen og til at prissætte de ingredienser,
   * der ikke er på tilbud.
   */
  function scoreRecipe(recipe, roles, offers, normalPrices) {
    const get = (m, k) => (m instanceof Map ? m.get(k) : m && m[k]) || null;

    const matched = [];
    const missing = [];
    let estCost = 0, estSavings = 0, pricedCount = 0;

    const consider = (item, role) => {
      const offer = get(offers, item.key);
      const normal = get(normalPrices, item.key);

      if (offer) {
        const qty = qtyInBase(item.grams, offer.base_unit);
        const normalUnit = offer.normal_unit_price != null ? offer.normal_unit_price
          : (normal && normal.base_unit === offer.base_unit ? normal.unit_price : null);

        let cost = null, saving = null;
        if (qty != null) {
          cost = qty * offer.unit_price;
          if (normalUnit != null && normalUnit > offer.unit_price) {
            saving = qty * (normalUnit - offer.unit_price);
          }
        }
        if (cost != null) { estCost += cost; pricedCount++; }
        if (saving != null) estSavings += saving;

        matched.push({
          taxonomy_key: item.key,
          role,
          name: offer.product_name || item.ingredient,
          ingredient: item.ingredient,
          offer_id: offer.offer_id,
          chain: offer.chain,
          chain_id: offer.chain_id,
          heading: offer.heading,
          price: offer.price,
          unit_price: offer.unit_price,
          base_unit: offer.base_unit,
          normal_unit_price: normalUnit,
          grams: item.grams ? Math.round(item.grams) : null,
          est_cost: cost != null ? round2(cost) : null,
          est_saving: saving != null ? round2(saving) : null,
          image: offer.image,
        });
        return true;
      }

      // Ikke på tilbud – den skal stadig købes, og den skal med i prisen,
      // hvis vi kender varens normalpris.
      const qty = normal ? qtyInBase(item.grams, normal.base_unit) : null;
      if (qty != null && normal.unit_price != null) {
        estCost += qty * normal.unit_price;
        pricedCount++;
      }
      missing.push({
        taxonomy_key: item.key,
        role,
        ingredient: item.ingredient,
        name: normal && normal.name ? normal.name : item.ingredient,
        grams: item.grams ? Math.round(item.grams) : null,
        est_cost: qty != null && normal.unit_price != null ? round2(qty * normal.unit_price) : null,
      });
      return false;
    };

    const mainHits = roles.mains.map((m) => consider(m, 'main'));
    const supportHits = roles.support.map((s) => consider(s, 'support'));

    const mainCount = mainHits.filter(Boolean).length;
    const supportCount = supportHits.filter(Boolean).length;
    const mainTotal = roles.mains.length;
    const supportTotal = roles.support.length;

    // Hovedråvarer vejer dobbelt: det er dem, planen står og falder med.
    const weighted = (2 * mainCount + supportCount) / Math.max(2 * mainTotal + supportTotal, 1);
    const servings = recipe.servings && recipe.servings > 0 ? recipe.servings : 4;

    return {
      matched,
      unmatched: missing,
      mains: roles.mains.map((m, i) => ({
        taxonomy_key: m.key, ingredient: m.ingredient, on_offer: mainHits[i],
      })),
      match_count: matched.length,
      considered: mainTotal + supportTotal,
      main_count: mainCount,
      main_total: mainTotal,
      support_count: supportCount,
      support_total: supportTotal,
      main_on_offer: mainTotal > 0 ? mainHits[0] === true : false,
      mains_all_on_offer: mainTotal > 0 && mainCount === mainTotal,
      main_coverage: mainTotal ? mainCount / mainTotal : 0,
      support_coverage: supportTotal ? supportCount / supportTotal : 1,
      coverage: round2(weighted),
      est_cost: round2(estCost),
      est_cost_per_serving: round2(estCost / servings),
      est_savings: round2(estSavings),
      priced_ingredients: pricedCount,
    };
  }

  // ── Udvælgelse ─────────────────────────────────────────────────────────────

  const DAYS = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];

  /** Lille deterministisk PRNG, så et givet seed altid giver samme plan. */
  function seededNoise(seed, id) {
    let h = (seed ^ (id * 2654435761)) >>> 0;
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;  h >>>= 0;
    return (h % 1000) / 1000;                        // 0…1
  }

  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return { week, year: d.getUTCFullYear() };
  }

  /**
   * Bygger ugens plan.
   *
   *   recipes       [{ id, title, …, tier_score, items: [{key,cat,staple,grams,ingredient}] }]
   *   offers        varetype → billigste aktive tilbud i brugerens butikker
   *   normalPrices  varetype → { unit_price, base_unit, name }
   *   recentIds     opskrifter fra de seneste ugers planer; de trykkes ned
   */
  function buildPlan({
    tier = 'classic',
    tierLabel = '',
    recipes = [],
    offers = new Map(),
    normalPrices = new Map(),
    days = 7,
    seed = 0,
    variety = 0.18,
    recentIds = null,
    chainIds = null,
    chainNames = null,
    at = new Date(),
  } = {}) {
    const recent = recentIds instanceof Set ? recentIds
      : new Set(Array.isArray(recentIds) ? recentIds : []);

    const offerCount = offers instanceof Map ? offers.size : Object.keys(offers || {}).length;

    // 1) Scor alt én gang. Scoren afhænger ikke af kravniveauet – kun af
    //    hvilke varer der er på tilbud – så den skal ikke regnes forfra,
    //    når kravet lempes.
    const scored = [];
    for (const r of recipes) {
      const roles = assignRoles(r.items, { unknownMain: r.unknown_main });
      if (!roles.mains.length) continue;                  // ingen bærende råvare
      if (roles.mains.length + roles.support.length < 2) continue;
      const s = scoreRecipe(r, roles, offers, normalPrices);
      const starch = [...roles.mains, ...roles.support].find((i) => STARCH_KEYS.has(i.key));
      scored.push({
        recipe: r, roles, score: s,
        main: roles.mains[0].key,
        starch: starch ? starch.key : null,
      });
    }

    // 2) Vælg det strengeste krav, der stadig giver nok at vælge imellem.
    //    Feltet skal være større end ugen selv – ellers er der ingen variation
    //    at hente, og "Ny plan" ville give samme syv retter igen.
    const target = Math.max(days * 2, days);
    let level = LEVELS[LEVELS.length - 1];
    let pool = [];
    for (const lv of LEVELS) {
      const p = scored.filter((c) => qualifies(c.score, lv));
      if (p.length > pool.length) { level = lv; pool = p; }
      if (p.length >= target) { level = lv; pool = p; break; }
    }

    // 3) Ranger. Tilbudsdækning vejer tungest, men sporet skal stadig kunne
    //    skubbe en ret ud, hvis den ikke passer.
    for (const cand of pool) {
      const tierScore = cand.recipe.tier_score ?? 0;
      let total = 0.40 * cand.score.coverage
                + 0.20 * cand.score.main_coverage
                + 0.30 * tierScore
                + 0.10 * Math.min(cand.score.est_savings / 40, 1);
      cand.repeat = recent.has(cand.recipe.id);
      if (cand.repeat) total -= 0.22;         // var med i en af de sidste ugers planer
      total += seededNoise(seed, cand.recipe.id) * variety;
      cand.tierScore = tierScore;
      cand.total = total;
    }
    pool.sort((a, b) => b.total - a.total);

    // 4) Grådigt valg med variation.
    //
    // To spærrer, ikke én. Hovedråvaren alene rækker ikke: syv retter med hver
    // sin protein kan sagtens ende som syv gange pasta, fordi det er pastaen,
    // der er på tilbud. Tilbehøret skal derfor også variere.
    const chosen = [];
    const mainCount = new Map();
    const starchCount = new Map();
    for (const pass of [[2, 3], [99, 99]]) {
      const [maxMain, maxStarch] = pass;
      for (const cand of pool) {
        if (chosen.length >= days) break;
        if (chosen.some((c) => c.recipe.id === cand.recipe.id)) continue;
        if (cand.main && (mainCount.get(cand.main) || 0) >= maxMain) continue;
        if (cand.starch && (starchCount.get(cand.starch) || 0) >= maxStarch) continue;
        chosen.push(cand);
        mainCount.set(cand.main, (mainCount.get(cand.main) || 0) + 1);
        if (cand.starch) starchCount.set(cand.starch, (starchCount.get(cand.starch) || 0) + 1);
      }
      if (chosen.length >= days) break;
    }

    const plan = {
      tier,
      tier_label: tierLabel,
      generated_at: new Date().toISOString(),
      ...isoWeek(at),
      chain_ids: chainIds,
      chain_names: chainNames,
      seed,
      offers_available: offerCount,
      candidates_scored: scored.length,
      candidates_qualified: pool.length,
      rule: {
        level: level.id,
        label: level.label,
        relaxed: level.id !== LEVELS[0].id,
      },
      est_cost: round2(chosen.reduce((a, c) => a + c.score.est_cost, 0)),
      est_savings: round2(chosen.reduce((a, c) => a + c.score.est_savings, 0)),
      days: chosen.map((c, i) => ({
        day: i,
        day_name: DAYS[i % 7],
        recipe: {
          id: c.recipe.id,
          title: c.recipe.title,
          url: c.recipe.url,
          image: c.recipe.image,
          source: c.recipe.source,
          source_name: c.recipe.source_name,
          servings: c.recipe.servings,
          total_minutes: c.recipe.total_minutes,
          kcal: c.recipe.kcal,
          protein_g: c.recipe.protein_g,
          carbs_g: c.recipe.carbs_g,
          nutrition_src: c.recipe.nutrition_src,
        },
        tier_score: c.tierScore,
        ...c.score,
      })),
    };

    if (!plan.days.length) {
      plan.error = offerCount === 0
        ? 'Der er ingen aktive tilbud i de valgte butikker. Vælg flere butikker, eller hent ugens tilbudsaviser.'
        : 'Ingen retter kunne bygges af tilbuddene i de valgte butikker. Prøv at vælge en butik mere.';
    }
    return plan;
  }

  // ── Indkøbsliste ───────────────────────────────────────────────────────────

  /**
   * Samlet indkøbsliste: det, der er på tilbud, grupperet efter butik – og
   * resten som én liste, for den skal jo også købes.
   */
  function shoppingList(plan) {
    const byChain = new Map();
    const rest = new Map();

    for (const day of plan.days || []) {
      for (const m of day.matched || []) {
        if (!byChain.has(m.chain)) byChain.set(m.chain, new Map());
        const items = byChain.get(m.chain);
        const prev = items.get(m.taxonomy_key);
        if (prev) {
          prev.grams += m.grams || 0;
          prev.est_cost = round2(prev.est_cost + (m.est_cost || 0));
          prev.est_saving = round2(prev.est_saving + (m.est_saving || 0));
          prev.used_in.push(day.recipe.title);
        } else {
          items.set(m.taxonomy_key, {
            name: m.name, heading: m.heading, chain: m.chain, role: m.role,
            price: m.price, unit_price: m.unit_price, base_unit: m.base_unit,
            grams: m.grams || 0, est_cost: m.est_cost || 0, est_saving: m.est_saving || 0,
            image: m.image, used_in: [day.recipe.title],
          });
        }
      }

      for (const u of day.unmatched || []) {
        const prev = rest.get(u.taxonomy_key);
        if (prev) {
          prev.grams += u.grams || 0;
          prev.est_cost = round2(prev.est_cost + (u.est_cost || 0));
          prev.used_in.push(day.recipe.title);
        } else {
          rest.set(u.taxonomy_key, {
            name: u.name || u.ingredient, role: u.role,
            grams: u.grams || 0, est_cost: u.est_cost || 0,
            used_in: [day.recipe.title],
          });
        }
      }
    }

    return {
      on_offer: [...byChain.entries()].map(([chain, items]) => ({
        chain,
        items: [...items.values()].sort((a, b) => b.est_saving - a.est_saving),
        total: round2([...items.values()].reduce((a, i) => a + i.est_cost, 0)),
        savings: round2([...items.values()].reduce((a, i) => a + i.est_saving, 0)),
      })).sort((a, b) => b.savings - a.savings),

      rest: [...rest.values()].sort((a, b) => b.used_in.length - a.used_in.length),
    };
  }

  return {
    assignRoles, scoreRecipe, buildPlan, shoppingList, qualifies,
    seededNoise, isoWeek,
    LEVELS, DAYS, MAIN_CATS, CARRIER_CATS, IGNORED_CATS, STARCH_KEYS,
  };
}));
