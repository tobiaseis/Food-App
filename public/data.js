'use strict';

/**
 * Datalag med to bagender.
 *
 *   · lokal    – Node-serveren på /api/*  (npm start)
 *   · supabase – PostgREST direkte fra browseren (Vercel-deployet)
 *
 * Frontenden kalder de samme funktioner uanset hvad, så udvikling lokalt og
 * drift i skyen ikke er to forskellige apps.
 *
 * Supabase-varianten laver kun simple SELECTs: prisstatistik og
 * tilbudsvurderinger er regnet færdige af GitHub Actions og ligger klar som
 * rækker.
 *
 * Madplanen er den ene undtagelse, og med vilje. Den afhænger af brugerens
 * FAVORITBUTIKKER, og dem findes der 32.767 kombinationer af – de kan ikke
 * forudberegnes. I stedet hentes de to små opslagstabeller, planen bygges af
 * (`offer_index`, `recipe_index`), og `public/engine.js` – nøjagtig samme
 * motor som kører i GitHub Actions – sætter planen sammen her i browseren.
 */

const CFG = window.APP_CONFIG || {};
const USE_SUPABASE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

/** Stabilt id pr. browser – knytter overvågninger til denne enhed. */
function deviceId() {
  let id = null;
  try { id = localStorage.getItem('madplan_device'); } catch { /* privat vindue */ }
  if (!id) {
    id = 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('madplan_device', id); } catch { /* ignoreres */ }
    // Spejles til den native lagring. Rydder Android WebView'ens data, er
    // localStorage væk – og med den alle brugerens overvågninger, fordi de
    // kun kendes på det her id. Kopien overlever oprydningen.
    window.Native?.persist('madplan_device', id);
  }
  return id;
}

// ── Favoritbutikker ──────────────────────────────────────────────────────────

/**
 * De kæder, brugeren rent faktisk handler i.
 *
 * Tom liste = ikke valgt endnu; så bygges madplanen af alle kæder, som den
 * altid har gjort. Valget bor i localStorage, fordi det er personligt og skal
 * virke i begge bagender – kører man mod den lokale server, spejles det også
 * til dens `settings`, så `npm run update` bygger planen af de samme butikker.
 */
const FAV_KEY = 'madplan_favorite_chains';

function readFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const ids = raw ? JSON.parse(raw) : null;
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  } catch { return []; }
}

function writeFavorites(ids) {
  const raw = JSON.stringify(ids || []);
  try { localStorage.setItem(FAV_KEY, raw); } catch { /* privat vindue */ }
  window.Native?.persist(FAV_KEY, raw);
}

// ── PostgREST ────────────────────────────────────────────────────────────────

const sbHeaders = (extra = {}) => ({
  apikey: CFG.SUPABASE_ANON_KEY,
  // Er anonymt login slået til, sendes brugerens EGEN token – det er den,
  // Row Level Security kender som auth.uid(). Er det ikke, bruges anon-
  // nøglen som hidtil, og de åbne policyer fra schema.sql gælder.
  Authorization: `Bearer ${(window.Auth?.enabled && window.Auth.token()) || CFG.SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

/** Tilføjer user_id – men kun når kolonnen og login'et findes. */
const withUser = (row) => (window.Auth?.enabled
  ? { ...row, user_id: window.Auth.userId() }
  : row);

async function sb(path, options = {}, retried = false) {
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: sbHeaders(options.headers),
  });
  // Adgangstokenen lever en time og kan udløbe midt i en session. Uden det
  // her ville appen stå tom, til brugeren selv genindlæste siden.
  if (res.status === 401 && !retried && window.Auth?.enabled) {
    if (await window.Auth.refresh()) return sb(path, options, true);
  }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Henter ALLE rækker, ikke kun den første side.
 *
 * PostgREST svarer med et loft pr. forespørgsel (typisk 1.000 rækker), og
 * madplans-indekset er større end det. Uden sidevisning ville planen stille og
 * roligt blive bygget på en tilfældig tredjedel af opskrifterne.
 */
async function sbAll(path, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const page = await sb(path, {
      headers: { 'Range-Unit': 'items', Range: `${from}-${from + pageSize - 1}` },
    });
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

async function local(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

/**
 * Som `local`, men en fejl er en fejl. Flowets tabeller må ikke komme tilbage
 * som `{ error }` og blive læst som et tomt katalog: to tomme lister uden et
 * ord er præcis den fejl, `items()` kaster for at undgå.
 */
async function localRows(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Serveren svarede ${res.status} på ${path}`);
  return res.json();
}

// Kun aktive tilbud: run_till mangler eller ligger i fremtiden
const activeFilter = () => `or=(run_till.is.null,run_till.gte.${new Date().toISOString()})`;

const OFFER_COLS = 'id,heading,description,price,pre_price,unit_price,base_unit,base_qty,' +
                   'image,run_from,run_till,product_id,chain_id';

/** Flader PostgRESTs indlejrede relationer ud til den form, UI'et forventer. */
function flattenOffer(o) {
  return {
    ...o,
    product_name: o.products?.name ?? null,
    category: o.products?.category ?? null,
    taxonomy_key: o.products?.taxonomy_key ?? null,
    chain_name: o.chains?.name ?? null,
    color: o.chains?.color ?? null,
  };
}

// ── Madplans-indeks (kun Supabase-bagenden) ──────────────────────────────────

// Indekset skifter kun, når den natlige kørsel har været forbi. Vi henter det
// derfor én gang pr. sidevisning og genbruger det på tværs af spor og
// "Ny plan" – ellers ville hvert klik koste et par hundrede kilobyte.
const planIndex = {
  offers: null, prices: null, recipes: {}, items: null, normals: new Map(),
  // Flowets: hele recipe_index (alle spor) og budget-sporets priser pr. kædesæt.
  all: null, costs: new Map(),
};

const MIN_TIER_SCORE = 0.35;

const TIER_LABELS = {
  healthy: 'Sund & proteinrig (lavt kulhydrat)',
  classic: 'Klassisk hverdagsmad',
  premium: 'Gourmet',
};

async function loadPlanIndex(tier) {
  if (!planIndex.prices) {
    const [prices, offers] = await Promise.all([
      sbAll('taxonomy_prices?select=*&order=taxonomy_key.asc'),
      sbAll('offer_index?select=*&order=taxonomy_key.asc,chain_id.asc'),
    ]);
    planIndex.prices = prices;
    planIndex.offers = offers;
  }
  if (!planIndex.recipes[tier]) {
    planIndex.recipes[tier] = await sbAll(
      `recipe_index?score_${tier}=gte.${MIN_TIER_SCORE}&select=*&order=recipe_id.asc`
    );
  }
  return planIndex;
}

/**
 * Indekset som det tilbudskort, motoren vil have: ét billigste tilbud pr.
 * `vare|kæde` blandt brugerens egne butikker. Tom `chainIds` betyder alle.
 *
 * Nøglen er vare OG kæde — samme form som `activeOfferMap` på serveren og
 * som `normalPricesFor`. Kortet nøglede før på varen alene, og det gik godt,
 * fordi den eneste læser er `buildPlan`, der reducerer til én pris pr. vare
 * alligevel (`cheapestPerItem`, som med vilje tåler begge nøgleformer).
 *
 * Men det er den samme slags afdrift som `base_qty` og `unknown_count`: i det
 * øjeblik browseren kalder `sharedWeek`/`offerShoppingList` — dem, hele
 * nyttelasten er ved at blive gjort klar til — slår `effectivePrice` op på
 * `vare|kæde`, finder ingenting, og hvert eneste tilbud ville forsvinde i
 * browseren, mens serveren regnede rigtigt. Ændringen koster to linjer nu og
 * en fejl uden fejlmeddelelse senere.
 */
function offerMapFor(rows, chainIds, chainNames) {
  const allowed = chainIds && chainIds.length ? new Set(chainIds) : null;
  const map = new Map();
  for (const r of rows) {
    if (allowed && !allowed.has(r.chain_id)) continue;
    const key = `${r.taxonomy_key}|${r.chain_id}`;
    const prev = map.get(key);
    // `<=`: ved samme kilopris vinder den først indsatte, og rækkerne kommer
    // sorteret billigst først. Samme regel som cheapestPerItem i engine.js.
    if (prev && prev.unit_price <= r.unit_price) continue;
    map.set(key, { ...r, chain: chainNames[r.chain_id] || r.chain_id });
  }
  return map;
}

// ── Varekatalog og normalpriser (kun Supabase-bagenden) ──────────────────────

// Kæden, hvis hyldepriser er skønnet i alle andre (version 1). Den slås op på
// slug, som normalPricesFor gør på serveren: id'et kommer fra Tjek og hører
// ikke hjemme som en konstant i koden.
const ESTIMATE_SOURCE_SLUG = 'rema1000';

/**
 * Normalprisrækkerne som det kort, motoren slår op i: `vare|kæde → rækker[]`,
 * med REMA's hyldepriser lagt ind som skøn i de andre kæder.
 *
 * Det er PRÆCIS reglen fra `normalPricesFor` i src/mealplan/generate.js, og
 * derfor kalder begge `PlanEngine.withEstimates` i stedet for at have hver sin
 * kopi. Springes skønnet over her, prissætter serveren en ret, som browseren
 * kalder uprissat, og `recipe_costs` og skærmen er uenige om den samme ret.
 * test/sync.test.js binder de to sammen.
 *
 *   rows      item_prices for favoritterne OG for kilden til skønnet
 *   chainIds  de kæder, kortet skal dække
 *   sourceId  REMA's id, eller null når kæden ikke findes — så intet skøn
 *
 * Kildens egne rækker kommer kun med i kortet, hvis kilden selv er en favorit:
 * de hentes for skønnets skyld, ikke for at gøre REMA til en butik, brugeren
 * ikke har valgt. Samme afgrænsning som serverens.
 */
function normalMapFor(rows, chainIds, sourceId) {
  const wanted = new Set(chainIds);
  const own = new Map();
  const sourceRows = [];
  for (const raw of rows) {
    // PostgREST sender timestamptz som '…+00:00' i basens tidszone, SQLite
    // gemmer '…Z'. effectivePrice måler udløb ved at sammenligne valid_until
    // med nu som STRENGE, så formen skal være den, serveren regner med.
    const r = raw.valid_until
      ? { ...raw, valid_until: new Date(raw.valid_until).toISOString() }
      : raw;
    if (r.chain_id === sourceId) sourceRows.push(r);
    if (!wanted.has(r.chain_id)) continue;
    const k = `${r.item_key}|${r.chain_id}`;
    if (!own.has(k)) own.set(k, []);
    own.get(k).push(r);
  }
  if (!sourceId) return own;
  return window.PlanEngine.withEstimates(own, sourceRows, chainIds, sourceId);
}

// ── API ──────────────────────────────────────────────────────────────────────

// Opskrifterne ændrer sig kun ved den natlige kørsel.
const recipeCache = new Map();

const Data = {
  backend: USE_SUPABASE ? 'supabase' : 'local',

  async status() {
    if (!USE_SUPABASE) return local('/api/status');
    const rows = await sb('sync_state?key=eq.last_build&select=value,updated_at');
    const v = rows?.[0]?.value || {};
    return {
      offers: v.offers ?? 0,
      active_offers: v.offers ?? 0,
      products: v.products ?? 0,
      chains: 14,
      stores: 0,
      recipes: v.recipes ?? 0,
      weeks_of_history: null,
      last_ingest: rows?.[0]?.updated_at ?? v.at ?? null,
      unread: await this.unreadCount(),
      home: { lat: null, lng: null },
    };
  },

  async unreadCount() {
    if (!USE_SUPABASE) {
      const s = await local('/api/status');
      return s.unread || 0;
    }
    const rows = await sb(
      `notifications?device_id=eq.${deviceId()}&read_at=is.null&select=id`,
      { headers: { Prefer: 'count=exact' } }
    );
    return Array.isArray(rows) ? rows.length : 0;
  },

  async chains() {
    if (!USE_SUPABASE) return local('/api/chains');
    const [rows, state] = await Promise.all([
      sb('chains?select=id,name,slug,logo,color&order=name.asc'),
      sb('sync_state?key=eq.last_build&select=value'),
    ]);
    const counts = state?.[0]?.value?.chain_offers || {};
    return rows.map((c) => ({ ...c, active_count: counts[c.id] ?? null }));
  },

  // ── Favoritbutikker ───────────────────────────────────────────────────────

  favorites: readFavorites,

  async setFavorites(ids) {
    const clean = [...new Set((ids || []).filter(Boolean))];
    writeFavorites(clean);
    // Den lokale server bygger også planer uden for browseren (npm run update),
    // så den skal kende valget. Supabase-bagenden har ingen server at fortælle.
    if (!USE_SUPABASE) await local('/api/settings', { method: 'POST', body: { favorite_chains: clean } });
    return clean;
  },

  /** Første besøg i en ny browser: overtag serverens gemte valg. */
  async adoptServerFavorites(status) {
    if (USE_SUPABASE || readFavorites().length) return readFavorites();
    const saved = (status && status.favorite_chains) || [];
    if (saved.length) writeFavorites(saved);
    return readFavorites();
  },

  // `chain` er en kommasepareret liste (eller tom = alle kæder), så de samme
  // favoritbutikker kan bruges her som i madplanen.
  async offers({ q = '', chain = '', sort = 'unit_price', limit = 72 } = {}) {
    if (!USE_SUPABASE) {
      const p = new URLSearchParams({ q, chain, sort, limit: String(limit) });
      return local(`/api/offers?${p}`);
    }
    const order = { price: 'price.asc', newest: 'run_from.desc' }[sort] || 'unit_price.asc.nullslast';
    let path = `offers?select=${OFFER_COLS},products(name,category,taxonomy_key),chains(name,color)` +
               `&${activeFilter()}&order=${order}&limit=${limit}`;
    if (q) path += `&heading=ilike.*${encodeURIComponent(q)}*`;
    const ids = String(chain).split(',').filter(Boolean);
    if (ids.length) path += `&chain_id=in.(${ids.map(encodeURIComponent).join(',')})`;
    return (await sb(path)).map(flattenOffer);
  },

  async deals(limit = 48, chain = '') {
    const ids = String(chain).split(',').filter(Boolean);

    if (!USE_SUPABASE) {
      const p = new URLSearchParams({ limit: String(limit) });
      if (ids.length) p.set('chain', ids.join(','));
      return local(`/api/deals?${p}`);
    }

    // Listen er kort nok til at filtrere her. Alternativet – et filter på den
    // indlejrede offers-relation – kræver !inner-join og gør forespørgslen
    // væsentligt mere skrøbelig for at spare et par kilobyte.
    const rows = await sb(
      `deals?select=verdict,discount_pct,confidence,is_cheapest,rank,` +
      `offers(${OFFER_COLS},products(name,category,taxonomy_key),chains(name,color))` +
      `&order=rank.asc&limit=${ids.length ? 100 : limit}`
    );
    const allowed = ids.length ? new Set(ids) : null;
    return rows
      .filter((r) => r.offers && (!allowed || allowed.has(r.offers.chain_id)))
      .slice(0, limit)
      .map((r) => ({ ...flattenOffer(r.offers), verdict: r.verdict,
                     discount_pct: r.discount_pct, confidence: r.confidence,
                     is_cheapest: r.is_cheapest }));
  },

  async product(id) {
    if (!USE_SUPABASE) return local(`/api/products/${id}`);

    const [product] = await sb(`products?id=eq.${id}&select=*`);
    if (!product) return { error: 'Ukendt vare' };

    const stats = await sb(`price_stats?product_id=eq.${id}&select=*&order=samples.desc`);
    const unit = stats[0]?.base_unit || 'stk';

    const [series, offers] = await Promise.all([
      sb(`price_series?product_id=eq.${id}&base_unit=eq.${unit}&select=*&order=period.asc`),
      sb(`offers?product_id=eq.${id}&base_unit=eq.${unit}&unit_price=not.is.null&${activeFilter()}` +
         `&select=${OFFER_COLS},chains(name,color)&order=unit_price.asc`),
    ]);

    // Billigste tilbud pr. kæde – PostgREST kan ikke lave DISTINCT ON,
    // og listen er kort nok til at reducere her.
    const best = new Map();
    for (const o of offers.map(flattenOffer)) if (!best.has(o.chain_id)) best.set(o.chain_id, o);

    const s = stats[0];
    return {
      product,
      base_unit: unit,
      baseline: s ? { median: s.median, min: s.min_price, max: s.max_price,
                      samples: s.samples, chains: s.chains, periods: s.periods } : null,
      chains: [...best.values()],
      series: series.map((p) => ({ period: p.period, median: p.median,
                                   min: p.min_price, max: p.max_price, n: p.n })),
      history: [],
    };
  },

  /**
   * Ugens madplan for ét spor, bygget af tilbuddene i brugerens egne butikker.
   *
   * `variant` er "Ny plan": et nyt seed, ikke en ny forespørgsel til serveren.
   */
  async mealPlan(tier, variant = 0, chainIds = null) {
    const chains = chainIds || readFavorites();

    if (!USE_SUPABASE) {
      const q = new URLSearchParams({ tier });
      q.set('chains', chains.length ? chains.join(',') : 'all');
      if (variant) q.set('refresh', String(variant));
      return local(`/api/mealplan?${q}`);
    }

    let index;
    try {
      index = await loadPlanIndex(tier);
    } catch (err) {
      // Er skemaet ikke migreret endnu, findes tabellerne ikke. Fald tilbage
      // på den forudberegnede plan – den bruger alle kæder, men er bedre end
      // en tom side, og beskeden siger hvorfor.
      const rows = await sb(
        `meal_plans?tier=eq.${tier}&select=variant,payload&order=year.desc,week.desc,variant.asc`
      );
      if (!rows.length) return { error: `Madplans-indekset kunne ikke hentes (${err.message}).` };
      const plan = rows[variant % rows.length].payload;
      return { ...plan, index_missing: true };
    }

    const chainRows = await this.chains();
    const chainNames = Object.fromEntries(chainRows.map((c) => [c.id, c.name]));

    const names = {};
    const normalPrices = new Map();
    for (const p of index.prices) {
      names[p.taxonomy_key] = p.name;
      if (p.unit_price != null) {
        normalPrices.set(p.taxonomy_key,
          { unit_price: p.unit_price, base_unit: p.base_unit, name: p.name });
      }
    }

    const recipes = index.recipes[tier].map((r) => ({
      id: r.recipe_id,
      title: r.title, url: r.url, image: r.image,
      source: r.source, source_name: r.source_name,
      servings: r.servings, total_minutes: r.total_minutes,
      active_minutes: r.active_minutes ?? null,
      kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g,
      nutrition_src: r.nutrition_src,
      tier_score: r[`score_${tier}`],
      unknown_main: r.unknown_main,
      // Kolonnen blev lagt på recipe_index, fyldt i build.js og erklæret i
      // supabase/schema.sql — og tabt her, i det fjerde led. `canPrice` i
      // engine.js spørger til `rec.unknown_count`, og uden linjen er den
      // undefined i browseren: de 678 opskrifter med mindst én ukendt
      // ingrediens ser fuldt prissatte ud, og en havbars-middag står til 6 kr,
      // fordi tre fjerdedele af dens ingredienser er usynlige.
      unknown_count: r.unknown_count || 0,
      // Samme grund: engine.isDinner spoerger til `rec.keywords` for at
      // skelne en middag fra en dessert. Uden linjen er alt aftensmad, og
      // browseren ville foreslaa Marie Rose sauce til mandag.
      keywords: r.keywords || null,
      // Indekset sender kun nøgle, kategori og mængde. Navnet ligger i
      // taxonomy_prices, så det ikke gentages på 2.000 opskrifter.
      items: (r.items || []).map((i) => ({ ...i, ingredient: names[i.key] || i.key })),
    }));

    const { week, year } = window.PlanEngine.isoWeek(new Date());
    const plan = window.PlanEngine.buildPlan({
      tier,
      tierLabel: TIER_LABELS[tier] || '',
      recipes,
      offers: offerMapFor(index.offers, chains, chainNames),
      normalPrices,
      seed: variant ? (year * 1000 + week * 10 + variant) : (year * 100 + week),
      chainIds: chains.length ? chains : null,
      chainNames: chains.length ? chains.map((id) => chainNames[id]).filter(Boolean) : null,
    });

    // offerShoppingList og ikke shoppingList: denne visning er den gamle
    // tilbudsplan. De to nye lister (køb ind / tjek at du har) bygges af
    // `Data.items()` og `Data.normalPrices()` herunder og hører til de fem
    // trin i brugerfladen (plan 3, opgave 3), ikke til denne plan.
    if (!plan.error) plan.shopping_list = window.PlanEngine.offerShoppingList(plan);
    return plan;
  },

  /**
   * Varekataloget som `key → { name, category, class, keeps, base_unit, piece_g }`
   * — det kort, `shoppingList` og `chooseChains` slår op i.
   *
   * Det kan ikke udledes af recipe_index: dér er essentials allerede skåret
   * fra, og så ville lagerlisten komme tom tilbage. Hentes én gang pr.
   * sidevisning som de øvrige opslagstabeller; 205 varer skifter sjældnere
   * end priserne.
   */
  async items() {
    if (!planIndex.items) {
      // Den lokale server svarer med de rækker, build.js ville have synket
      // (collectItems) — samme form, så resten af funktionen er fælles.
      const rows = USE_SUPABASE
        ? await sbAll('items?select=*&order=key.asc')
        : await localRows('/api/items');
      // Kaster frem for at svare med et tomt kort: shoppingList springer en
      // vare uden katalogrække stiltiende over, så et tomt kort ville give to
      // tomme lister og ingen fejl. En tom tabel er ikke et tomt katalog, men
      // en synk midt i sin sletning eller en, der fejlede. Caches kortet tomt,
      // holder siden fast i to tomme lister, til den genindlæses.
      if (!Array.isArray(rows) || !rows.length) throw new Error('Varekataloget er tomt — prøv igen om lidt.');
      planIndex.items = new Map(rows.map((r) => [r.key, r]));
    }
    return planIndex.items;
  },

  /**
   * Normalpriskortet `vare|kæde → rækker[]` for favoritterne, med REMA's
   * hyldepriser som skøn i de andre kæder — samme kort som serverens
   * `normalPricesFor`, og det `effectivePrice` og hele plan 2's motor kræver.
   *
   * `chainIds` som i mealPlan: udeladt = de gemte favoritter, tom = alle kæder.
   *
   * REMA's rækker hentes OGSÅ, når REMA ikke er en favorit: det er dem,
   * skønnet bygges af. Uden dem har en bruger uden REMA næsten ingen
   * prissatte retter — det var hele grunden til version 1-skønnet.
   */
  async normalPrices(chainIds = null) {
    const favs = chainIds || readFavorites();
    const cacheKey = favs.length ? [...favs].sort().join(',') : '*';
    if (planIndex.normals.has(cacheKey)) return planIndex.normals.get(cacheKey);

    // Lokalt bygger serveren kortet selv, med normalPricesFor — den funktion,
    // madplanen og recipe_costs regnes med. Kortet kommer som et objekt og
    // bliver til det samme Map, Supabase-vejen bygger nedenfor.
    if (!USE_SUPABASE) {
      const obj = await localRows(`/api/item-prices?chains=${favs.length
        ? favs.map(encodeURIComponent).join(',') : 'all'}`);
      const map = new Map(Object.entries(obj || {}));
      planIndex.normals.set(cacheKey, map);
      return map;
    }

    const chains = await sb('chains?select=id,slug');
    const source = chains.find((c) => c.slug === ESTIMATE_SOURCE_SLUG) || null;
    const ids = favs.length ? favs : chains.map((c) => c.id);
    const fetchIds = [...new Set(source ? [...ids, source.id] : ids)];

    // Ordnet på hele primærnøglen: sbAll henter i sider, og uden en total
    // orden kan Postgres levere en række på to sider eller på ingen.
    const rows = await sbAll(
      `item_prices?chain_id=in.(${fetchIds.map(encodeURIComponent).join(',')})` +
      '&select=*&order=item_key.asc,chain_id.asc,pack_qty.asc,pack_unit.asc'
    );
    const map = normalMapFor(rows, ids, source ? source.id : null);
    planIndex.normals.set(cacheKey, map);
    return map;
  },

  // ── Madplansflowet: de fem trin ───────────────────────────────────────────
  //
  // Trin 1-3 er et filter (butikker, spor, dage og personer), trin 4 er puljen
  // og de to forslag, trin 5 de to lister. Motoren er public/engine.js, den
  // samme fil serveren kører; her hentes kun det, den skal have, i den form
  // serveren giver den. Enhver forskel i formen er en forskel i tallene — se
  // test/sync.test.js, der kører begge veje og sammenligner.

  /**
   * Hele recipe_index — alle spor på én gang.
   *
   * Klassisk alene er 1.912 af 2.173 retter, så at hente pr. spor sparer
   * næsten intet ved første visning og koster en hentning ved hvert skift.
   * Hentes én gang pr. sidevisning.
   */
  async recipeIndex() {
    if (!planIndex.all) {
      const rows = USE_SUPABASE
        ? await sbAll('recipe_index?select=*&order=recipe_id.asc')
        : await localRows('/api/recipe-index');
      // Samme skelnen som i items(): tomt er en fejl, ikke et svar.
      if (!Array.isArray(rows) || !rows.length) throw new Error('Opskrifterne kunne ikke hentes — prøv igen om lidt.');
      planIndex.all = rows;
    }
    return planIndex.all;
  },

  /**
   * Én opskrift med ingredienser og fremgangsmåde (recipe_details). Hentes
   * først, når den åbnes, og huskes resten af sidevisningen.
   */
  async recipe(id) {
    const key = Number(id);
    if (recipeCache.has(key)) return recipeCache.get(key);
    const row = USE_SUPABASE
      ? (await sb(`recipe_details?recipe_id=eq.${key}&select=*`))[0]
      : await local(`/api/recipes/${key}`);
    if (!row || row.error) return { error: (row && row.error) || 'Opskriften findes ikke på dansk endnu.' };
    recipeCache.set(key, row);
    return row;
  },

  /** Tilbudskortet `vare|kæde → tilbud` for favoritterne (offer_index). */
  async offerMap(chainIds) {
    if (!planIndex.offers) {
      planIndex.offers = USE_SUPABASE
        ? await sbAll('offer_index?select=*&order=taxonomy_key.asc,chain_id.asc')
        : await localRows('/api/offer-index');
    }
    // Kun tilbud, der stadig gælder NU. offer_index hentes én gang pr.
    // sidevisning og caches, så uden dette ville et tilbud, der udløb i løbet
    // af dagen, blive ved med at prissætte retter til næste synk — mens
    // serverens activeOfferMap filtrerer på klokkeslættet. Samme ret, to
    // priser. `run_till` sammenlignes som tidspunkt, ikke som tekst: Supabase
    // svarer '+02:00', og det er netop den fælde, valid_until faldt i.
    const now = Date.now();
    const live = planIndex.offers.filter((o) => !o.run_till || Date.parse(o.run_till) >= now);
    // Navnene bruges kun af den gamle tilbudsplan; flowet slår op på id.
    return offerMapFor(live, chainIds, {});
  },

  /**
   * Budget-sporets pris pr. ret: den LAVESTE `cost_per_serving` blandt de
   * butikker, ugen må handle i — `recipe_id → kr pr. portion`.
   *
   * Kun de fem første favoritter: motoren handler ikke i den sjette (se
   * chainsInPlay i engine.js), så en ret, der kun er billig dér, er ikke
   * billig for brugeren. Kun middage (`has_main`): rækkerne dækker hele
   * korpusset, dressinger og kager med, og de billigste retter i basen er
   * netop dem.
   */
  async recipeCosts(chainIds) {
    const ids = (chainIds || []).slice(0, window.PlanEngine.MAX_CHOICE_CHAINS);
    const key = [...ids].sort().join(',');
    if (!planIndex.costs.has(key)) {
      const rows = !ids.length ? []
        : USE_SUPABASE
          ? await sbAll(`recipe_costs?chain_id=in.(${ids.map(encodeURIComponent).join(',')})` +
                        '&has_main=eq.true&select=recipe_id,chain_id,cost_per_serving' +
                        '&order=recipe_id.asc,chain_id.asc')
          : await localRows(`/api/recipe-costs?chains=${ids.map(encodeURIComponent).join(',')}`);
      const best = new Map();
      for (const r of rows) {
        if (!(r.cost_per_serving >= 0)) continue;
        const prev = best.get(r.recipe_id);
        if (prev == null || r.cost_per_serving < prev) best.set(r.recipe_id, r.cost_per_serving);
      }
      planIndex.costs.set(key, best);
    }
    return planIndex.costs.get(key);
  },

  /**
   * Alt, motoren skal have til trin 4 og 5, for ét spor og ét sæt butikker.
   *
   *   track     'budget' | 'healthy' | 'classic' | 'premium'
   *   chainIds  favoritterne i prioriteret rækkefølge
   *
   * Tre ting, der hver især har været en stille fejl et andet sted:
   *
   *   · `score`, ikke `tier_score`. recipe_index bærer sporets score som
   *     `score_<spor>`, loadRecipes som `tier_score`, og candidatePool læser
   *     `score` — og udelader MED VILJE en ret uden. Glemmes omsætningen, er
   *     puljen tom og `thin`: højlydt, men forkert.
   *   · `chainIds` skal med til puljen. Uden dem er den tom (candidatePool).
   *   · Frøet er ugen, `år × 100 + uge`, så samme uge giver de samme tolv her
   *     og på serveren.
   *
   * Budget har ingen score — om en ret er billig, afhænger af ugens priser og
   * af butikkerne, så den kan ikke gemmes på opskriften (spec 1.5). Den
   * rangeres efter prisen pr. portion, og dens `score` er 0: så afgør ugens
   * egen pris og spild forslagene alene, og det er, hvad budget betyder.
   */
  async flowInputs(track, chainIds = null) {
    const favs = chainIds || readFavorites();
    const budget = track === 'budget';
    const [rows, items, normals, offers, costs] = await Promise.all([
      this.recipeIndex(), this.items(), this.normalPrices(favs), this.offerMap(favs),
      budget ? this.recipeCosts(favs) : null,
    ]);

    const recipes = [];
    for (const r of rows) {
      let score = 0;
      let cost = null;
      if (budget) {
        cost = costs.has(r.recipe_id) ? costs.get(r.recipe_id) : null;
        if (cost == null) continue;
      } else {
        score = r[`score_${track}`];
        // Samme grænse som loadRecipes' minTierScore på serveren.
        if (!(score >= MIN_TIER_SCORE)) continue;
      }
      recipes.push({
        id: r.recipe_id,
        title: r.title, url: r.url, image: r.image,
        source: r.source, source_name: r.source_name,
        servings: r.servings, total_minutes: r.total_minutes,
        active_minutes: r.active_minutes ?? null,
        kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g,
        nutrition_src: r.nutrition_src,
        score,
        cost_per_serving: cost,
        unknown_main: Boolean(r.unknown_main),
        unknown_count: r.unknown_count || 0,
        keywords: r.keywords || null,
        items: (r.items || []).map((i) => ({ ...i, ingredient: items.get(i.key)?.name || i.key })),
      });
    }

    const { week, year } = window.PlanEngine.isoWeek(new Date());
    return {
      track, recipes, items, normals, offers,
      chainIds: favs,
      rank: budget ? (r) => (r.cost_per_serving == null ? null : -r.cost_per_serving) : undefined,
      seed: year * 100 + week,
      week, year,
    };
  },

  /**
   * Trin 4: de 3 × dage retter og de to forslag blandt dem.
   *
   * Forslagene bygges af PULJEN og ikke af hele sporet: de er præ-markerede
   * delmængder af det, brugeren ser (spec 2.1). En tom pulje giver ingen
   * forslag frem for to tomme uger.
   */
  choices(ctx, { days, servings, have = null }) {
    const E = window.PlanEngine;
    const { pool, thin } = E.candidatePool(ctx.recipes, {
      days, items: ctx.items, rank: ctx.rank, seed: ctx.seed,
      offers: ctx.offers, normals: ctx.normals, chainIds: ctx.chainIds, have,
    });
    const proposals = pool.length
      ? E.twoProposals(pool, {
        days, servings, items: ctx.items,
        offers: ctx.offers, normals: ctx.normals, chainIds: ctx.chainIds, have,
      })
      : [];
    return { pool, thin, proposals };
  },

  /**
   * Trin 5: køb ind og tjek at du har, for de valgte retter.
   *
   * Hver købslinje får sin priskilde med (`source`, `stale`). shoppingList
   * giver den ikke selv — kun `on_offer` — og uden den kan skærmen ikke sige
   * "pris fra REMA" ved en vare, hvor Netto ingen egen pris har; så læses 29 kr
   * i Netto som Nettos pris. Kilden slås op med den samme effectivePrice og de
   * samme argumenter, som kædevalget brugte til at vælge linjen, og giver
   * derfor den samme pris.
   */
  lists(ctx, picks, { servings, have = null }) {
    const E = window.PlanEngine;
    const list = E.shoppingList({ days: picks.map((recipe) => ({ recipe })) }, {
      items: ctx.items, offers: ctx.offers, normals: ctx.normals,
      chainIds: ctx.chainIds, servings, have,
    });
    for (const line of list.buy) {
      line.source = null;
      line.stale = false;
      if (!line.chain) continue;
      const meta = ctx.items.get(line.key);
      const price = E.effectivePrice(line.key, line.chain, {
        offers: ctx.offers, normals: ctx.normals, baseUnit: meta ? meta.base_unit : null,
      });
      if (price) { line.source = price.source; line.stale = Boolean(price.stale); }
    }
    return list;
  },

  // ── Overvågninger ─────────────────────────────────────────────────────────

  async watches() {
    if (!USE_SUPABASE) return local('/api/watches');
    const rows = await sb(
      `watches?device_id=eq.${deviceId()}&select=*&order=created_at.desc`
    );
    // Tællinger som den lokale server ellers laver med underforespørgsler
    const notifs = await sb(
      `notifications?device_id=eq.${deviceId()}&select=watch_id,read_at`
    );
    return rows.map((w) => ({
      ...w,
      notif_count: notifs.filter((n) => n.watch_id === w.id).length,
      unread: notifs.filter((n) => n.watch_id === w.id && !n.read_at).length,
    }));
  },

  async createWatch(body) {
    if (!USE_SUPABASE) return local('/api/watches', { method: 'POST', body });
    const row = await sb('watches', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([withUser({
        device_id: deviceId(),
        label: body.label,
        query: body.query || body.label,
        chain_ids: body.chain_ids || [],
        max_km: body.max_km ?? null,
        min_discount: body.min_discount ?? null,
        max_unit_price: body.max_unit_price ?? null,
        home_lat: body.home_lat ?? null,
        home_lng: body.home_lng ?? null,
      })]),
    });
    // Træf dannes af den natlige kørsel – der er ingen generator i browseren.
    return { watch: row[0], new_notifications: 0, deferred: true };
  },

  async deleteWatch(id) {
    if (!USE_SUPABASE) return local(`/api/watches/${id}`, { method: 'DELETE' });
    await sb(`watches?id=eq.${id}&device_id=eq.${deviceId()}`, { method: 'DELETE' });
    return { deleted: true };
  },

  async runWatches() {
    if (!USE_SUPABASE) return local('/api/watches/run', { method: 'POST' });
    return { created: [], deferred: true };
  },

  async notifications(limit = 60) {
    if (!USE_SUPABASE) return local(`/api/notifications?limit=${limit}`);
    const rows = await sb(
      `notifications?device_id=eq.${deviceId()}&select=*,` +
      `watches(label),offers(heading,price,base_unit,image,run_till,chains(name))` +
      `&order=created_at.desc&limit=${limit}`
    );
    return rows.map((n) => ({
      ...n,
      watch_label: n.watches?.label ?? '',
      heading: n.offers?.heading ?? '',
      price: n.offers?.price ?? null,
      base_unit: n.offers?.base_unit ?? null,
      image: n.offers?.image ?? null,
      chain_name: n.offers?.chains?.name ?? '',
    }));
  },

  /**
   * Melder enheden til push. Kaldes af native.js, hver gang FCM udleverer et
   * token – både første gang og når det senere udskiftes.
   *
   * Tabellen har ingen læsepolitik: et token er nok til at sende beskeder til
   * telefonen, så det skrives blindt og læses kun af den natlige kørsel, der
   * bruger service_role-nøglen.
   */
  async registerPushToken(token, platform = 'android') {
    if (!token) return { ok: false };
    // Den lokale server sender ikke push – det gør den natlige kørsel mod
    // Supabase. Kører appen mod localhost, er der ingen at melde sig til.
    if (!USE_SUPABASE) return { ok: false, deferred: true };
    await sb('device_tokens?on_conflict=token', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([withUser({
        token,
        device_id: deviceId(),
        platform,
        updated_at: new Date().toISOString(),
      })]),
    });
    return { ok: true };
  },

  async markRead() {
    if (!USE_SUPABASE) return local('/api/notifications/read', { method: 'POST', body: {} });
    await sb(`notifications?device_id=eq.${deviceId()}&read_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    });
    return { marked: true };
  },

  async storesNear(lat, lng, radius = 5) {
    if (!USE_SUPABASE) return local(`/api/stores/near?lat=${lat}&lng=${lng}&radius=${radius}`);
    // Groft koordinat-vindue, finafstand regnes her
    const d = radius / 111;
    const rows = await sb(
      `stores?lat=gte.${lat - d}&lat=lte.${lat + d}&lng=gte.${lng - d * 1.8}&lng=lte.${lng + d * 1.8}` +
      `&select=*,chains(name,color)&limit=400`
    );
    const km = (a, b, c, e) => {
      const R = 6371, r = (x) => (x * Math.PI) / 180;
      const dLat = r(c - a), dLng = r(e - b);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    return rows
      .map((s) => ({ ...s, chain_name: s.chains?.name ?? '', km: Math.round(km(lat, lng, s.lat, s.lng) * 10) / 10 }))
      .filter((s) => s.km <= radius)
      .sort((a, b) => a.km - b.km);
  },

  async saveSettings(body) {
    if (!USE_SUPABASE) return local('/api/settings', { method: 'POST', body });
    const raw = JSON.stringify(body);
    try { localStorage.setItem('madplan_home', raw); } catch { /* ignoreres */ }
    window.Native?.persist('madplan_home', raw);
    return { ok: true };
  },

  async ingest() {
    if (!USE_SUPABASE) return local('/api/ingest', { method: 'POST', body: {} });
    return { deferred: true };
  },

  deviceId,
};

window.Data = Data;
