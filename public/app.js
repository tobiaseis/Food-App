'use strict';

/* ── Hjælpere ─────────────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const app = () => $('#app');

// `Data` kommer fra data.js, der indlæses før denne fil. Den må ikke
// gen-erklæres her: klassiske scripts deler ét globalt leksikalsk scope,
// så `const Data` to steder er en SyntaxError, der stopper hele app.js.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const kr = (n) => n == null ? '–' : `${Number(n).toLocaleString('da-DK', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} kr`;
const num = (n, d = 0) => n == null ? '–' : Number(n).toLocaleString('da-DK', { minimumFractionDigits: d, maximumFractionDigits: d });

const VERDICT = {
  great: 'Rigtig god pris',
  good: 'God pris',
  fair: 'Normal pris',
  poor: 'Dyrere end normalt',
  unknown: 'Uden sammenligning',
};

const verdictTag = (v, pct) => {
  const k = v && VERDICT[v] ? v : 'unknown';
  const p = pct != null && pct > 0 ? ` · ${num(pct, 0)} %` : '';
  return `<span class="verdict ${k}">${VERDICT[k]}${p}</span>`;
};

/* ── Prisinstrumentet ─────────────────────────────────────────────────────────
 * Dommen om en pris er appens hele påstand, og den fortjener en aflæsning
 * frem for et skilt: en lineal med graduering, et nulmærke ved normalprisen
 * og en nål ved dagens pris. Skalaen er den samme på hvert eneste kort, så to
 * varer kan sammenlignes med øjnene alene.
 *
 * Enderne er valgt efter tallene, ikke omvendt. Under −20 % er alt "dyrere end
 * normalt" alligevel, og ugens bedste fund lander rutinemæssigt mellem 60 og
 * 80 % under normalprisen – med en kortere skala stod alle nåle i samme
 * yderposition, og så måler instrumentet ingenting.
 *
 * 100 enheder fra ende til ende betyder samtidig, at gradueringen i CSS er
 * kalibreret: hvert streg er præcis 10 procentpoint.
 */
const GAUGE_LO = -20;
const GAUGE_HI = 80;

const gaugeAt = (pct) =>
  ((Math.min(Math.max(pct, GAUGE_LO), GAUGE_HI) - GAUGE_LO) / (GAUGE_HI - GAUGE_LO)) * 100;

const GAUGE_ZERO = gaugeAt(0);

/**
 * @param v    dommen: great | good | fair | poor | unknown
 * @param pct  procent under normalprisen; negativ betyder dyrere. Må mangle.
 */
function priceGauge(v, pct) {
  const k = v && VERDICT[v] ? v : 'unknown';
  const has = pct != null && isFinite(pct);
  const word = VERDICT[k];

  // Uden et tal er der ingen nål at sætte. Så står ordet alene frem for at
  // lade en tilfældig position se ud som en måling.
  if (!has || k === 'unknown') {
    return `<div class="gauge unknown"><span class="gauge-label">${word}</span></div>`;
  }

  const x = gaugeAt(pct);
  const n = num(Math.abs(pct), 0);
  const spoken = `${word}: ${n} % ${pct < 0 ? 'over' : 'under'} normalprisen`;

  return `<div class="gauge ${k}">
    <span class="gauge-scale" role="img" aria-label="${esc(spoken)}">
      <i class="g-fill" style="left:${Math.min(x, GAUGE_ZERO)}%;width:${Math.abs(x - GAUGE_ZERO)}%"></i>
      <i class="g-zero" style="left:${GAUGE_ZERO}%"></i>
      <i class="g-mark" style="left:${x}%"></i>
    </span>
    <span class="gauge-label" aria-hidden="true">${word} <b>${n} %</b></span>
  </div>`;
}

const unitPrice = (o) =>
  o.unit_price == null ? '' : `${num(o.unit_price, 2)} kr/${o.base_unit}`;

/**
 * Hvor længe tilbuddet gælder.
 *
 * En nedtælling er kun en oplysning, så længe den kan nås. Nogle kæder sætter
 * løbetiden på deres faste lavprisvarer til årets udgang, og "126 dage
 * tilbage" siger hverken noget om varen eller om, hvornår man skal handle –
 * så står der hellere ingenting.
 */
const COUNTDOWN_DAYS = 21;

const daysLeft = (till) => {
  if (!till) return '';
  const d = Math.ceil((new Date(till) - Date.now()) / 86400000);
  if (d < 0) return 'udløbet';
  if (d === 0) return 'sidste dag';
  if (d > COUNTDOWN_DAYS) return '';
  return `${d} dag${d === 1 ? '' : 'e'} tilbage`;
};

/**
 * Beder billedtjenesten om et billede i den størrelse, vi rent faktisk viser.
 *
 * Opskriftsfotoet står som en 108px firkant på skrivebordet og i fuld bredde
 * på en telefon – aldrig større end ~560px, selv på en 2×-skærm. Arla leverer
 * som udgangspunkt 1300px, og syv af dem er over en megabyte, der skal hentes,
 * før madplanen ser færdig ud. Tjenesten tager en width-parameter, så vi
 * spørger om det, vi bruger.
 *
 * Kun værter, vi ved understøtter det. Andre URL'er røres ikke – et gæt, der
 * ikke virker, ville give et hul, hvor der før var et billede.
 */
const THUMB_W = 560;

function thumb(url, width = THUMB_W) {
  if (!url) return url;
  try {
    const u = new URL(url, location.href);
    if (u.hostname !== 'images.arla.com') return url;
    // Højden er sat sammen med bredden i kildens egne URL'er. Fjernes den
    // ikke, beskærer tjenesten efter det gamle forhold.
    u.searchParams.delete('height');
    u.searchParams.set('width', String(width));
    return u.toString();
  } catch {
    return url;                  // ikke en URL vi kan læse – lad den være
  }
}

/**
 * ISO-ugenummeret for i dag.
 *
 * Tilbudsaviserne løber pr. ISO-uge, og hele appen regner i dem – ugen står
 * derfor i mærket øverst. Den beregnes hver gang frem for at blive skrevet
 * ind i HTML: en fane, der har stået åben natten over søndag-mandag, skal
 * ikke vise sidste uges tal.
 */
function isoWeek(d = new Date()) {
  // Torsdagsreglen: ugen hører til det år, dens torsdag ligger i.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const jan1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - jan1) / 86400000 + 1) / 7);
}

let STATUS = {};
let CHAINS = [];
let FAVORITES = [];          // kæde-id'er brugeren handler i

const chainById = (id) => CHAINS.find((c) => c.id === id) || null;
const favoriteNames = () => FAVORITES.map((id) => chainById(id)?.name).filter(Boolean);

/** Sætning der kan stå i en tekst: "Netto og REMA 1000". */
function listNames(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} og ${names[names.length - 1]}`;
}

/* ── Favoritbutikker ──────────────────────────────────────────────────────── */

/**
 * Madplanen skal kunne handles. Tilbud fra femten kæder på tværs af landet er
 * ikke en indkøbsliste, så brugeren vælger de butikker, der ligger i nærheden,
 * og planen bygges kun af dem.
 */
function storePicker(onSaved) {
  const modal = $('#modal');
  $('#modal-title').textContent = 'Mine butikker';

  const rows = [...CHAINS]
    .sort((a, b) => (b.active_count ?? b.offer_count ?? 0) - (a.active_count ?? a.offer_count ?? 0))
    .map((c) => {
      const n = c.active_count ?? c.offer_count;
      return `<label class="store-row">
        <input type="checkbox" value="${esc(c.id)}" ${FAVORITES.includes(c.id) ? 'checked' : ''}>
        <span class="chain-chip"><i class="chain-dot" style="background:${esc(c.color || 'var(--ink-3)')}"></i>${esc(c.name)}</span>
        <span class="note">${n != null ? `${num(n)} tilbud` : ''}</span>
      </label>`;
    }).join('');

  const max = maxStores();
  $('#modal-body').innerHTML = `
    <p class="note">Vælg de supermarkeder, du normalt handler i – højst ${max}. Madplanen
    prissættes kun i dem, og indkøbslisten bliver til én, du kan gå ud og handle efter.</p>
    <div class="store-list">${rows}</div>
    <div class="divider"></div>
    <div class="row">
      <button class="primary" id="fav-save">Gem</button>
      <button class="ghost" id="fav-none">Ryd valg – brug alle kæder</button>
      <span class="note" id="fav-count"></span>
    </div>`;

  const boxes = () => [...$('#modal-body').querySelectorAll('input[type=checkbox]')];
  // Loftet håndhæves dér, hvor butikkerne vælges: madplanens kædevalg regner
  // alle delmængder igennem og tager kun de fem første med. En sjette ville
  // først vise sig som en vare uden pris på indkøbslisten.
  const tally = () => {
    const n = boxes().filter((b) => b.checked).length;
    for (const b of boxes()) b.disabled = !b.checked && n >= max;
    $('#fav-save').disabled = n > max;
    $('#fav-count').textContent = n > max ? `${n} valgt – højst ${max}, fravælg ${n - max}`
      : n ? `${n} af højst ${max}` : 'ingen valgt = alle kæder i tilbudslisterne';
  };
  boxes().forEach((b) => b.addEventListener('change', tally));
  tally();

  const save = async (ids) => {
    FAVORITES = await Data.setFavorites(ids);
    modal.close();
    if (onSaved) onSaved();
  };
  // Favoritternes rækkefølge er motorens prioritet (chainsInPlay), så de
  // allerede valgte beholder deres plads, og nye kommer bagest.
  $('#fav-save').addEventListener('click', () => {
    const chosen = boxes().filter((b) => b.checked).map((b) => b.value);
    save([...FAVORITES.filter((id) => chosen.includes(id)),
          ...chosen.filter((id) => !FAVORITES.includes(id))]);
  });
  $('#fav-none').addEventListener('click', () => save([]));

  modal.showModal();
}

/* ── Tilbudskort ──────────────────────────────────────────────────────────── */

function offerCard(o) {
  const img = o.image
    ? `<img src="${esc(o.image)}" alt="" loading="lazy">`
    : '<div class="offer-ph"></div>';

  // Går tilbuddet ud i dag eller i morgen, er det den eneste oplysning på
  // kortet, man skal handle på med det samme – derfor den varme farve.
  const left = o.run_till ? daysLeft(o.run_till) : '';
  const urgent = left === 'sidste dag' || left === '1 dag tilbage';

  return `<div class="offer" data-product="${o.product_id}">
    <div class="offer-head">
      ${img}
      <div class="offer-body">
        <div class="offer-title">${esc(o.heading)}</div>
        <div class="offer-meta">
          <span class="chain-chip"><i class="chain-dot" style="background:${esc(o.color || 'var(--ink-3)')}"></i>${esc(o.chain_name)}</span>
          ${left ? `<span class="${urgent ? 'urgent' : ''}">${left}</span>` : ''}
        </div>
        <div class="price-row">
          <span class="price">${kr(o.price)}</span>
          ${o.pre_price ? `<span class="pre-price">${kr(o.pre_price)}</span>` : ''}
          ${o.unit_price != null ? `<span class="unit-price">${unitPrice(o)}</span>` : ''}
        </div>
      </div>
    </div>
    ${o.verdict ? priceGauge(o.verdict, o.discount_pct) : ''}
  </div>`;
}

function bindOfferCards(root) {
  root.querySelectorAll('.offer[data-product]').forEach((el) => {
    el.addEventListener('click', () => showProduct(el.dataset.product));
  });
}

/* ── Produktdetaljer: prishistorik ────────────────────────────────────────── */

function sparkline(series, unit) {
  if (!series || series.length < 2) return '';
  const w = 580, h = 150, pad = { l: 44, r: 12, t: 12, b: 26 };
  const vals = series.flatMap((s) => [s.min, s.max]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => pad.l + (i / (series.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b);

  const band = series.map((s, i) => `${x(i)},${y(s.max)}`).join(' ') + ' ' +
    series.map((s, i) => `${x(i)},${y(s.min)}`).reverse().join(' ');
  const line = series.map((s, i) => `${x(i)},${y(s.median)}`).join(' ');

  const ticks = [lo, (lo + hi) / 2, hi].map((v) =>
    `<text x="${pad.l - 7}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink-3)">${num(v, 0)}</text>
     <line x1="${pad.l}" y1="${y(v)}" x2="${w - pad.r}" y2="${y(v)}" stroke="var(--rule)" stroke-width="1"/>`).join('');

  // Yderste mærkater ankres indad, ellers klippes de af kanten
  const labels = series.map((s, i) => {
    if (!(i === 0 || i === series.length - 1 || series.length <= 6)) return '';
    const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
    return `<text x="${x(i)}" y="${h - 8}" text-anchor="${anchor}" font-size="9.5" fill="var(--ink-3)">${esc(s.period)}</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img"
            aria-label="Prisudvikling i kr pr. ${esc(unit)}">
    ${ticks}
    <polygon points="${band}" fill="var(--bay)" opacity=".13"/>
    <polyline points="${line}" fill="none" stroke="var(--bay)" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round"/>
    ${series.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.median)}" r="3" fill="var(--bay)"><title>${esc(s.period)}: ${num(s.median, 2)} kr/${esc(unit)} (${s.n} tilbud)</title></circle>`).join('')}
    ${labels}
  </svg>`;
}

/**
 * Instrumentet i fuld størrelse: varens egen prisspredning i kroner.
 *
 * Det er den samme aflæsning som på tilbudskortet, bare med rigtige tal på
 * skalaen frem for procenter. Enderne er det billigste og dyreste, der er set
 * for varen; mærket i midten er normalprisen, og nålen er den billigste pris
 * lige nu.
 *
 * Dagens pris kan sagtens ligge uden for det hidtil sete – det er jo netop
 * pointen med et godt tilbud – så skalaen strækkes til at rumme den frem for
 * at klemme nålen ind mod kanten.
 */
function priceRange(b, best, unit) {
  if (!b || b.min == null || b.max == null) return '';

  const now = best && best.unit_price != null ? best.unit_price : null;
  const lo = Math.min(b.min, now ?? b.min);
  const hi = Math.max(b.max, now ?? b.max);
  const span = hi - lo || 1;
  // Skalaen trækkes ind fra kanterne, så en nål yderst ude står helt inde på
  // linealen frem for at blive skåret over af kassen.
  const at = (v) => 2 + ((v - lo) / span) * 96;

  const reading = now != null
    ? `Normalpris ${num(b.median, 2)} kr/${unit} · billigst nu ${num(now, 2)} kr/${unit}`
    : `Normalpris ${num(b.median, 2)} kr/${unit}`;

  // Fyldet er afstanden mellem normalprisen og dagens pris – altså præcis det,
  // man sparer pr. kilo. Samme sprog som nålen på tilbudskortet.
  const fill = now == null ? null
    : { left: Math.min(at(now), at(b.median)), width: Math.abs(at(now) - at(b.median)) };

  return `<div class="range">
    <p class="note" style="margin:0 0 8px">${esc(reading)} · ${b.samples} observationer</p>
    <div class="range-scale" role="img"
         aria-label="${esc(`${reading}. Set mellem ${num(lo, 2)} og ${num(hi, 2)} kr pr. ${unit} over ${b.samples} observationer.`)}">
      ${fill ? `<i class="range-span" style="left:${fill.left}%;width:${fill.width}%"></i>` : ''}
      <i class="range-tick" style="left:${at(b.median)}%"></i>
      ${now != null ? `<i class="range-now" style="left:${at(now)}%"></i>` : ''}
    </div>
    <div class="range-labels">
      <span>${num(lo, 2)} laveste set</span>
      <span>${num(hi, 2)} højeste set</span>
    </div>
  </div>`;
}

async function showProduct(productId) {
  const modal = $('#modal');
  $('#modal-title').textContent = 'Indlæser…';
  $('#modal-body').innerHTML = '<div class="loading">Henter prishistorik…</div>';
  modal.showModal();

  const d = await Data.product(productId);
  if (d.error) { $('#modal-body').innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }

  $('#modal-title').textContent = d.product.name;
  const b = d.baseline;
  const unit = d.base_unit;

  const rows = d.chains.map((c, i) => `<tr class="${i === 0 ? 'best' : ''}">
    <td><span class="chain-chip"><i class="chain-dot" style="background:${esc(c.color || 'var(--ink-3)')}"></i>${esc(c.chain_name)}</span></td>
    <td class="note">${esc(c.heading.substring(0, 44))}</td>
    <td class="num">${kr(c.price)}</td>
    <td class="num"><strong>${num(c.unit_price, 2)}</strong> kr/${esc(c.base_unit)}</td>
  </tr>`).join('');

  $('#modal-body').innerHTML = `
    ${priceRange(b, d.chains[0], unit)}

    <h2 style="margin-top:0">Prisudvikling</h2>
    ${d.series.length >= 2
      ? sparkline(d.series, unit) + `<p class="note">Median-pris pr. ${esc(unit)} pr. ISO-uge. Det skraverede felt viser spændet mellem billigste og dyreste kæde i ugen.</p>`
      : '<div class="chart-empty">Der er endnu kun data fra én uge.<br>Grafen tegnes, når næste uges tilbudsaviser er hentet.</div>'}

    <h2>Hvad koster den lige nu?</h2>
    ${d.chains.length
      ? `<div class="scroll-x"><table class="cmp"><thead><tr><th>Kæde</th><th>Vare</th><th style="text-align:right">Pris</th><th style="text-align:right">Pr. ${esc(unit)}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="note">Ingen aktive tilbud på denne vare lige nu.</p>'}

    <div class="divider"></div>
    <button class="primary" id="follow-btn">Følg ${esc(d.product.name)}</button>
    <p class="note" style="margin-top:10px">Du får besked, når varen er på tilbud til under normalprisen.</p>
  `;

  $('#follow-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Tilføjer…';
    const r = await Data.createWatch({
      label: d.product.name, query: d.product.taxonomy_key || d.product.name,
    });
    e.target.textContent = r.error ? r.error
      : r.deferred ? 'Følger nu · træf ved næste opdatering'
      : `Følger nu · ${r.new_notifications} træf`;
    loadStatus();
  });
}

/* ── Visning: madplanen i fem trin ────────────────────────────────────────────
 * Brugerens egne ord: vælg butikker; vælg budget, sund, klassisk eller gourmet;
 * vælg hvor mange dage; få tre gange så mange retter at vælge imellem; få en
 * hel indkøbsliste — som TO lister, det der skal købes, og det man skal tjekke,
 * at man har.
 *
 * Trin 1-3 er et filter, og alt bliver på én side. Et trin-for-trin-guide med
 * "Næste" ville tvinge den, der kommer tilbage hver uge med de samme butikker,
 * gennem tre skærme for at nå de retter, hun kom efter. Her står valgene, hun
 * allerede har truffet, øverst, og retterne er et rul væk.
 *
 * Motoren kører her i browseren (public/engine.js, samme fil som serveren), og
 * alt, den får, hentes gennem Data.flowInputs. Tallene på skærmen SKAL være
 * serverens tal for samme butikker, spor, dage og uge — se test/sync.test.js.
 */

const TIER_INFO = {
  budget:  ['Budget', 'Det billigste først – rangeret efter prisen pr. portion i dine butikker.'],
  healthy: ['Sund & proteinrig', 'Højt proteinindhold og få kulhydrater pr. portion.'],
  classic: ['Klassisk', 'Almindelig hverdagsmad – hurtig, kendt og til at gå til.'],
  premium: ['Gourmet', 'Mere ambitiøse retter fra kokke-orienterede kilder.'],
};

// Vælgerens korte navne. Fire knapper skal kunne stå på én linje på en
// 360px-telefon; det fulde navn står i linjen under.
const TRACK_SHORT = { budget: 'Budget', healthy: 'Sund', classic: 'Klassisk', premium: 'Gourmet' };

// Hovedkategorien, som variationsspærren tæller den (engine.mainCategoryOf).
// Mærkaten på retten er den samme tælling, så "højst tre fjerkræretter" kan
// tælles efter på skærmen.
const MAIN_LABEL = { meat: 'Kød', poultry: 'Fjerkræ', fish: 'Fisk', eggs: 'Æg', legume: 'Bælgfrugter' };

const DAYS_MIN = 1, DAYS_MAX = 7;
const PEOPLE_MIN = 1, PEOPLE_MAX = 8;

// Loftet på favoritter er motorens eget tal, ikke en kopi: chooseChains regner
// alle delmængder igennem, og en sjette butik ville først vise sig som en vare
// uden pris på listen. Derfor håndhæves det dér, hvor butikkerne vælges.
const maxStores = () => window.PlanEngine.MAX_CHOICE_CHAINS;

/**
 * Valgene fra trin 2-3 og de valgte retter, pr. browser.
 *
 * Personerne huskes, fordi specet siger "forudfyldes med sidste valg". De
 * valgte retter huskes for UGEN: står man i butikken og genindlæser, skal
 * indkøbslisten stå der endnu — men ikke næste mandag, hvor puljen er en anden.
 */
const FLOW_KEY = 'madplan_flow';

function readFlow() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(FLOW_KEY) || 'null'); } catch { /* privat vindue */ }
  const f = v && typeof v === 'object' ? v : {};
  const int = (x, lo, hi, d) => (Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  return {
    track: TIER_INFO[f.track] ? f.track : 'classic',
    days: int(f.days, DAYS_MIN, DAYS_MAX, 4),
    servings: int(f.servings, PEOPLE_MIN, PEOPLE_MAX, 4),
    picks: f.picks && Array.isArray(f.picks.ids) ? f.picks : null,
  };
}

function writeFlow() {
  const s = FLOW.settings;
  const picks = FLOW.ctx ? { week: `${FLOW.ctx.year}-${FLOW.ctx.week}`, ids: FLOW.selected } : s.picks;
  try {
    localStorage.setItem(FLOW_KEY, JSON.stringify({
      track: s.track, days: s.days, servings: s.servings, picks,
    }));
  } catch { /* privat vindue – valget gælder så kun denne visning */ }
}

const FLOW = {
  settings: null,
  ctx: null,              // Data.flowInputs
  choice: null,           // { pool, thin, proposals }
  proposalLists: [],      // Data.lists for hvert forslag
  selected: [],           // opskrift-id'er i den rækkefølge, de blev valgt
  list: null,             // Data.lists for det valgte
  token: 0,               // kun den nyeste beregning må tegne
  hint: '',
};

/** Mængde, som man siger den i et køkken: 400 g, ikke 0,4 kg. */
function qty(n, unit) {
  if (n == null || !isFinite(n)) return '';
  const t = (x) => Number(x).toLocaleString('da-DK', { maximumFractionDigits: 2 });
  if (unit === 'kg') return n < 1 ? `${t(Math.round(n * 1000))} g` : `${t(n)} kg`;
  if (unit === 'l') {
    if (n >= 1) return `${t(n)} l`;
    const dl = Math.round(n * 1000) / 100;
    return Number.isInteger(dl) ? `${dl} dl` : `${t(Math.round(n * 1000))} ml`;
  }
  return `${t(n)} stk`;
}

/** Hvor mange pakker af hvad: "2 × 500 g". */
const packLabel = (b) => (b.packs ? `${b.packs} × ${qty(b.pack_qty, b.unit)}` : qty(b.need, b.unit));

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

async function viewPlan() {
  const s = readFlow();
  // Gamle links (#/plan/healthy) vælger stadig sporet.
  const fromHash = location.hash.split('/')[2];
  if (fromHash && TIER_INFO[fromHash]) s.track = fromHash;
  FLOW.settings = s;
  FLOW.ctx = null;
  FLOW.choice = null;
  FLOW.list = null;
  FLOW.hint = '';

  app().innerHTML = `
    <div class="enter">
      <p class="eyebrow">Uge ${isoWeek()}<i class="sep"></i>Madplan</p>
      <h1>Ugens aftensmad, fra butikken til indkøbssedlen.</h1>
      <p class="lede">Vælg dine butikker og din slags mad. Så finder vi tre retter
      pr. aften, som kan prissættes hos dig – og to forslag, der deler råvarerne,
      så mindre bliver til overs.</p>
    </div>
    <div class="flow">
      <section class="step" id="step-stores">
        <h2 class="step-rule"><span class="step-no">1</span>Dine butikker</h2>
        <div id="flow-stores"></div>
      </section>
      <section class="step">
        <h2 class="step-rule"><span class="step-no">2</span>Slags mad</h2>
        <div id="flow-track"></div>
      </section>
      <section class="step">
        <h2 class="step-rule"><span class="step-no">3</span>Aftener og personer</h2>
        <div id="flow-week"></div>
      </section>
      <section class="step" id="step-choose">
        <h2 class="step-rule"><span class="step-no">4</span>Vælg retterne</h2>
        <div id="flow-choose"></div>
      </section>
      <section class="step" id="step-list">
        <h2 class="step-rule"><span class="step-no">5</span>Indkøbslisten</h2>
        <div id="flow-list"></div>
      </section>
    </div>`;

  renderStores();
  renderTrack();
  renderWeek();
  await recompute();
}

/* ── Trin 1: butikkerne ───────────────────────────────────────────────────── */

function renderStores() {
  const el = $('#flow-stores');
  if (!el) return;
  const max = maxStores();
  const n = FAVORITES.length;
  const full = n >= max;

  // Kædens egen farve i prikken – den eneste kulør, grænsefladen låner ud.
  const picks = CHAINS.map((c) => {
    const on = FAVORITES.includes(c.id);
    return `<button type="button" class="chain-pick" data-chain="${esc(c.id)}"
      aria-pressed="${on}" ${!on && full ? 'disabled' : ''}>
      <i class="chain-dot" style="background:${esc(c.color || 'var(--ink-3)')}"></i>${esc(c.name)}</button>`;
  }).join('');

  // Fra før loftet kan en bruger have gemt flere end fem. Dem, motoren ikke
  // regner med, nævnes ved navn — ellers opdages de som varer uden pris.
  const over = FAVORITES.slice(max).map(chainById).filter(Boolean).map((c) => c.name);

  el.innerHTML = `
    <div class="chain-picks" role="group" aria-label="Butikker">${picks}</div>
    <p class="note step-note">${!n ? `Vælg de butikker, du handler i – højst ${max}.`
      : n > max ? `${n} valgt – højst ${max}.`
      : `${n} af højst ${max}. Vi regner alle kombinationer af dem igennem og siger, hvilke du skal i.`}</p>
    ${over.length ? `<p class="flag">Madplanen regner kun med dine fem første butikker.
      <strong>${esc(listNames(over))}</strong> er ikke med – fravælg ${over.length === 1 ? 'én' : over.length}.</p>` : ''}`;

  el.querySelectorAll('[data-chain]').forEach((b) =>
    b.addEventListener('click', () => toggleStore(b.dataset.chain)));
}

async function toggleStore(id) {
  const on = FAVORITES.includes(id);
  // Loftet holdes også her og ikke kun med `disabled` på knappen.
  if (!on && FAVORITES.length >= maxStores()) return;
  FAVORITES = await Data.setFavorites(on ? FAVORITES.filter((x) => x !== id) : [...FAVORITES, id]);
  Native.haptic();
  renderStores();
  await recompute();
}

/* ── Trin 2: sporet ───────────────────────────────────────────────────────── */

function renderTrack() {
  const el = $('#flow-track');
  if (!el) return;
  const t = FLOW.settings.track;
  const [label, blurb] = TIER_INFO[t];
  el.innerHTML = `
    <div class="seg" role="radiogroup" aria-label="Slags mad">
      ${Object.keys(TIER_INFO).map((k) => `<button type="button" role="radio" data-track="${k}"
        aria-checked="${k === t}" class="${k === t ? 'active' : ''}">${TRACK_SHORT[k]}</button>`).join('')}
    </div>
    <p class="note step-note"><strong>${esc(label)}.</strong> ${esc(blurb)}</p>`;

  el.querySelectorAll('[data-track]').forEach((b) => b.addEventListener('click', () => {
    if (FLOW.settings.track === b.dataset.track) return;
    FLOW.settings.track = b.dataset.track;
    // Et nyt spor er en ny pulje. De valgte retter fra det gamle hører ikke
    // hjemme i den.
    FLOW.selected = [];
    writeFlow();
    renderTrack();
    recompute();
  }));
}

/* ── Trin 3: aftener og personer ──────────────────────────────────────────── */

function renderWeek() {
  const el = $('#flow-week');
  if (!el) return;
  const { days, servings } = FLOW.settings;
  const stepper = (field, value, lo, hi, one, many, less, more) => `
    <div class="stepper" data-field="${field}">
      <button type="button" data-delta="-1" aria-label="${less}" ${value <= lo ? 'disabled' : ''}>−</button>
      <output aria-live="polite"><b>${value}</b> ${value === 1 ? one : many}</output>
      <button type="button" data-delta="1" aria-label="${more}" ${value >= hi ? 'disabled' : ''}>+</button>
    </div>`;
  el.innerHTML = `
    <div class="week-pick">
      ${stepper('days', days, DAYS_MIN, DAYS_MAX, 'aften', 'aftener', 'Færre aftener', 'Flere aftener')}
      ${stepper('servings', servings, PEOPLE_MIN, PEOPLE_MAX, 'person', 'personer', 'Færre personer', 'Flere personer')}
    </div>
    <p class="note step-note">Opskrifterne regnes om til ${servings} ${servings === 1 ? 'person' : 'personer'}.</p>`;

  el.querySelectorAll('.stepper button').forEach((b) => b.addEventListener('click', () => {
    const field = b.closest('.stepper').dataset.field;
    const [lo, hi] = field === 'days' ? [DAYS_MIN, DAYS_MAX] : [PEOPLE_MIN, PEOPLE_MAX];
    const next = Math.min(hi, Math.max(lo, FLOW.settings[field] + Number(b.dataset.delta)));
    if (next === FLOW.settings[field]) return;
    FLOW.settings[field] = next;
    writeFlow();
    renderWeek();
    // Tre hurtige tryk på + er én beslutning, ikke tre beregninger.
    clearTimeout(renderWeek.timer);
    renderWeek.timer = setTimeout(recompute, 220);
  }));
}

/* ── Beregningen ──────────────────────────────────────────────────────────── */

/**
 * Henter (fra cache, når det kan) og kører puljen og forslagene forfra.
 *
 * Kun den nyeste beregning må tegne: skifter man butik to gange hurtigt, kan
 * den første hentning lande sidst, og så stod den gamle butiks retter på
 * skærmen under den nye butiks navn.
 */
async function recompute() {
  const token = ++FLOW.token;
  const s = FLOW.settings;
  const choose = $('#flow-choose');
  if (!choose) return;

  if (!FAVORITES.length) {
    FLOW.ctx = null;
    FLOW.choice = null;
    choose.innerHTML = `<div class="empty card"><h3>Vælg dine butikker først</h3>
      <p>Retterne vælges blandt dem, vi kan prissætte i de butikker, du handler i.</p></div>`;
    syncSelection();
    return;
  }

  choose.innerHTML = '<div class="loading">Finder retter, der kan prissættes i dine butikker…</div>';
  // Én fejlvisning for både hentningen og motoren. Kastede Data.choices eller
  // Data.lists før, blev fejlen aldrig fanget, og "Finder retter…" stod på
  // skærmen for evigt uden et ord om hvorfor.
  const fail = (title, err) => {
    if (token !== FLOW.token) return;
    choose.innerHTML = `<div class="empty card"><h3>${esc(title)}</h3>
      <p>${esc(err && err.message ? err.message : 'Ukendt fejl.')}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button class="primary" id="flow-retry">Prøv igen</button></div></div>`;
    $('#flow-retry').addEventListener('click', recompute);
  };
  let ctx;
  try {
    ctx = await Data.flowInputs(s.track, FAVORITES);
  } catch (err) {
    fail('Kunne ikke hente opskrifter og priser', err);
    return;
  }
  if (token !== FLOW.token || !$('#flow-choose')) return;

  // Lad "Finder retter…" nå at blive tegnet, før motoren tager tråden.
  await new Promise((r) => setTimeout(r, 20));
  if (token !== FLOW.token) return;

  let choice;
  try {
    choice = Data.choices(ctx, { days: s.days, servings: s.servings });
    FLOW.proposalLists = choice.proposals.map((w) => Data.lists(ctx, w.picks, { servings: s.servings }));
  } catch (err) {
    fail('Kunne ikke sætte ugen sammen', err);
    return;
  }
  FLOW.ctx = ctx;
  FLOW.choice = choice;

  // De valgte retter overlever alt, der ikke skifter puljen ud: flere
  // personer, en butik mere. Første gang i en ny uge hentes ugens valg.
  const inPool = new Set(choice.pool.map((r) => r.id));
  const saved = s.picks && s.picks.week === `${ctx.year}-${ctx.week}` ? s.picks.ids : [];
  if (!FLOW.selected.length && saved.length) FLOW.selected = saved;
  s.picks = null;
  FLOW.selected = FLOW.selected.filter((id) => inPool.has(id)).slice(0, s.days);

  renderChoose();
  syncSelection();
}

/* ── Trin 4: de 3 × dage og de to forslag ─────────────────────────────────── */

/** "deler 1,2 kg kartofler over 3 retter og 800 g hakket oksekød over 2" */
function sharedSentence(week) {
  const shared = week.shared || [];
  if (!shared.length) return 'Retterne deler ingen råvarer – hver køber sit eget.';
  // Samme udvalg som engine.explainWeek: det, der er værd at nævne, og ellers
  // de små – at fortie en ægte deling er værre end at nævne en lille.
  const worth = shared.filter((x) => x.saved_kr >= week.cost * 0.05);
  const parts = (worth.length ? worth : shared).slice(0, 2)
    .map((x) => `${qty(x.need, x.unit)} ${x.name.toLocaleLowerCase('da')} over ${x.used} retter`);
  const kr0 = shared.reduce((a, x) => a + x.saved_kr, 0);
  return `Deler ${parts.join(' og ')} – ${kr(Math.round(kr0))} mindre i pakker end hver for sig.`;
}

function proposalCard(week, list, i) {
  const name = `Forslag ${'AB'[i]}`;
  const ids = week.picks.map((r) => r.id);
  const active = ids.length && sameSet(ids, FLOW.selected);
  const shops = list.chains.map(chainById).filter(Boolean).map((c) => c.name);
  return `<article class="proposal ${active ? 'is-active' : ''}" data-proposal="${i}">
    <div class="proposal-head">
      <h3>${name}</h3>
      <span class="proposal-price">${kr(list.total)}</span>
    </div>
    <p class="note proposal-meta">${week.picks.length} retter${
      shops.length ? ` · ${esc(listNames(shops))}` : ''} · spild ca. ${kr(Math.round(list.waste_kr))}</p>
    <ol class="proposal-dishes">${week.picks.map((r) => `<li>${esc(r.title)}</li>`).join('')}</ol>
    <p class="note">${esc(sharedSentence(week))}</p>
    <button type="button" class="${active ? '' : 'primary'}" data-accept="${i}" aria-pressed="${active ? 'true' : 'false'}">
      ${active ? `${name} er valgt` : `Vælg forslag ${'AB'[i]}`}</button>
  </article>`;
}

function pickMeta(r, track) {
  const parts = [];
  const main = MAIN_LABEL[window.PlanEngine.mainCategoryOf(r, FLOW.ctx.items)];
  if (main) parts.push(main);
  // Det, sporet er valgt efter, står forrest efter kategorien.
  if (track === 'budget' && r.cost_per_serving != null) parts.push(`ca. ${kr(Math.round(r.cost_per_serving))} pr. portion`);
  if (track === 'healthy' && r.protein_g != null) parts.push(`${num(r.protein_g)} g protein`);
  if (r.total_minutes) parts.push(`${r.total_minutes} min.`);
  if (r.source_name) parts.push(esc(r.source_name));
  // Linket står inde i kortet. Et klik på et link i en <label> sætter ikke
  // fluebenet (HTML: interaktivt indhold i en label aktiverer den ikke), så
  // man kan læse opskriften uden at vælge retten.
  if (r.url) parts.push(`<a class="pick-link" href="${esc(r.url)}" target="_blank" rel="noopener">Opskrift</a>`);
  return parts.join('<i class="sep"></i>');
}

function renderChoose() {
  const el = $('#flow-choose');
  if (!el || !FLOW.choice) return;
  const { pool, thin, proposals } = FLOW.choice;
  const { days, track } = FLOW.settings;
  const shops = FAVORITES.slice(0, maxStores()).map(chainById).filter(Boolean).map((c) => c.name);

  if (!pool.length) {
    el.innerHTML = `<div class="flag">
      <p><strong>Vi kan ikke prissætte en eneste ${esc(TIER_INFO[track][0].toLowerCase())}-ret i ${esc(listNames(shops))}.</strong>
      Flere butikker giver flere priser at regne med.</p>
      <button type="button" class="primary" data-goto-stores>Vælg flere butikker</button></div>`;
    bindGotoStores(el);
    return;
  }

  // Tynd pulje siges rent ud. Fire retter vist som et frit valg til fire
  // aftener er ikke et valg, og det skal brugeren vide, FØR hun vælger.
  const head = thin
    ? `<div class="flag">
        <p><strong>Vi kan kun prissætte ${pool.length} ${pool.length === 1 ? 'ret' : 'retter'} i dine butikker</strong>
        – for få til at vælge ${days} af ${days * 3}. Flere butikker giver flere retter at vælge imellem.</p>
        <button type="button" data-goto-stores>Vælg flere butikker</button>
      </div>`
    // Kun forslag A er bygget til at dele råvarer. B sættes sammen af de retter,
    // A IKKE tog, og målt i den afsluttende gennemgang af plan 3 var B's spild
    // værre end 85 % af alle mulige uger fra puljen. Teksten lovede delingen
    // for begge; nu lover den den dér, hvor den holder.
    : `<p class="step-lede">Vælg ${days} af de ${pool.length} retter – eller tag et af de to forslag.
        Forslag A er sat sammen, så retterne deler råvarerne, og det, du køber til den ene, bliver
        brugt i den næste. Forslag B er et andet bud, lavet af de retter, A ikke tog.</p>`;

  const inA = new Set((proposals[0]?.picks || []).map((r) => r.id));
  const inB = new Set((proposals[1]?.picks || []).map((r) => r.id));
  // To forslag med de samme retter er ét forslag. Så vises det én gang.
  const showB = proposals[1] && !sameSet([...inA], [...inB]);

  const cards = proposals.slice(0, showB ? 2 : 1)
    .map((w, i) => proposalCard(w, FLOW.proposalLists[i], i)).join('');

  const rows = pool.map((r) => {
    const marks = `${inA.has(r.id) ? '<span class="mark" title="Med i forslag A">A</span>' : ''}${
      showB && inB.has(r.id) ? '<span class="mark" title="Med i forslag B">B</span>' : ''}`;
    return `<li><label class="pick" data-id="${r.id}">
      <input type="checkbox" class="pick-box" value="${r.id}">
      ${r.image ? `<img src="${esc(thumb(r.image, 200))}" alt="" width="64" height="64" loading="lazy" decoding="async">`
                : '<span class="pick-ph" aria-hidden="true"></span>'}
      <span class="pick-body">
        <span class="pick-title">${esc(r.title)}</span>
        <span class="pick-meta">${pickMeta(r, track)}</span>
      </span>
      <span class="pick-marks">${marks}</span>
    </label></li>`;
  }).join('');

  el.innerHTML = `
    ${head}
    <div class="docket tally" id="flow-tally" aria-live="polite"></div>
    <div class="proposals">${cards}</div>
    <ul class="picks">${rows}</ul>`;

  bindGotoStores(el);
  el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => {
    const w = proposals[Number(b.dataset.accept)];
    FLOW.selected = w.picks.map((r) => r.id);
    FLOW.hint = '';
    Native.haptic();
    syncSelection();
    // Ét tryk accepterer – og så er det listen, man skal videre til.
    $('#step-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  el.querySelectorAll('.pick-box').forEach((box) => box.addEventListener('change', () => {
    const id = Number(box.value);
    if (box.checked) {
      if (FLOW.selected.length >= FLOW.settings.days) {
        // Loftet er brugerens eget antal aftener. Hellere et ord end at
        // skubbe den ret ud, hun valgte først.
        box.checked = false;
        FLOW.hint = `Du har valgt ${FLOW.settings.days} – fravælg en ret først.`;
      } else {
        FLOW.selected = [...FLOW.selected, id];
        FLOW.hint = '';
      }
    } else {
      FLOW.selected = FLOW.selected.filter((x) => x !== id);
      FLOW.hint = '';
    }
    syncSelection();
  }));
}

function bindGotoStores(root) {
  root.querySelectorAll('[data-goto-stores]').forEach((b) => b.addEventListener('click', () =>
    $('#step-stores').scrollIntoView({ behavior: 'smooth', block: 'start' })));
}

/**
 * Valget har ændret sig: flueben, forslagenes tilstand, tallene og listen.
 *
 * Retterne tegnes IKKE om — tolv billeder, der blinker ved hvert tryk, er
 * værre end en side, der står stille og bare skifter markering.
 */
function syncSelection() {
  const picks = FLOW.choice
    ? FLOW.selected.map((id) => FLOW.choice.pool.find((r) => r.id === id)).filter(Boolean)
    : [];
  FLOW.list = FLOW.ctx && picks.length
    ? Data.lists(FLOW.ctx, picks, { servings: FLOW.settings.servings })
    : null;
  writeFlow();

  const choose = $('#flow-choose');
  if (choose && FLOW.choice) {
    choose.querySelectorAll('.pick').forEach((el) => {
      const on = FLOW.selected.includes(Number(el.dataset.id));
      el.classList.toggle('is-on', on);
      el.querySelector('.pick-box').checked = on;
    });
    choose.querySelectorAll('.proposal').forEach((card) => {
      const i = Number(card.dataset.proposal);
      const ids = FLOW.choice.proposals[i].picks.map((r) => r.id);
      const on = ids.length > 0 && sameSet(ids, FLOW.selected);
      const name = `Forslag ${'AB'[i]}`;
      const btn = card.querySelector('[data-accept]');
      card.classList.toggle('is-active', on);
      btn.classList.toggle('primary', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? `${name} er valgt` : `Vælg forslag ${'AB'[i]}`;
    });
    renderTally(picks.length);
  }
  renderList(picks);
}

/** Bonen over retterne: hvad det valgte koster, mens man vælger. */
function renderTally(n) {
  const el = $('#flow-tally');
  if (!el) return;
  const days = FLOW.settings.days;
  const l = FLOW.list;
  el.innerHTML = `
    <span class="figure"><b>${n} af ${days}</b> valgt</span>
    <span class="figure"><b>${l ? kr(l.total) : '–'}</b> i alt</span>
    <span class="figure"><b>${l ? kr(Math.round(l.waste_kr)) : '–'}</b> spild</span>
    <span class="figure"><b>${l ? l.chains.length : '–'}</b> ${l && l.chains.length === 1 ? 'butik' : 'butikker'}</span>
    ${FLOW.hint ? `<span class="tally-hint">${esc(FLOW.hint)}</span>` : ''}`;
}

/* ── Trin 5: de to lister ─────────────────────────────────────────────────── */

/**
 * Hvor prisen kommer fra, sagt som en person ville sige det.
 *
 * Version 1 bruger REMA's hyldepris som skøn i alle andre kæder. Står der
 * 29 kr ved løg i Netto uden et ord, læses det som Nettos pris — og det er det
 * ikke. Et tilbud står der, fordi det er grunden til, at varen er billig.
 */
function sourceNote(b) {
  const notes = [];
  if (b.source === 'offer') notes.push('<span class="src offer">tilbud</span>');
  else if (b.source === 'estimate:rema') notes.push('<span class="src">pris fra REMA</span>');
  else if (b.source === 'derived') notes.push('<span class="src">anslået pris</span>');
  if (b.stale) notes.push('<span class="src">ældre pris</span>');
  return notes.join(' · ');
}

function buyLine(b) {
  const used = b.used_in.length === 1 ? `til ${esc(b.used_in[0])}` : `til ${b.used_in.length} retter`;
  const left = b.leftover > 0 ? ` · ${qty(b.leftover, b.unit)} til overs` : '';
  return `<div class="shop-item">
    <span class="n">${esc(b.name)}<small>${packLabel(b)} · ${used}${left}</small></span>
    <span class="p">${b.est_cost != null ? kr(b.est_cost) : '–'}${sourceNote(b) ? `<small>${sourceNote(b)}</small>` : ''}</span>
  </div>`;
}

function renderList(picks) {
  const el = $('#flow-list');
  if (!el) return;
  const l = FLOW.list;
  if (!l) {
    el.innerHTML = `<div class="empty card"><p>Vælg et forslag eller dine egne retter ovenfor,
      så skriver vi listen – det, du skal købe, og det, du skal tjekke, at du har.</p></div>`;
    return;
  }

  const priced = l.buy.filter((b) => b.chain);
  const unpriced = l.buy.filter((b) => !b.chain);

  // Én kasse pr. butik: man står i én ad gangen.
  const groups = l.chains.map((id) => {
    const c = chainById(id);
    const lines = priced.filter((b) => b.chain === id);
    const sum = Math.round(lines.reduce((a, b) => a + b.est_cost, 0) * 100) / 100;
    return `<div class="card shop-chain">
      <h3><span class="row" style="gap:8px"><i class="chain-dot" style="background:${esc(c?.color || 'var(--ink-3)')}"></i>${esc(c?.name || id)}</span>
        <span class="note">${kr(sum)}</span></h3>
      ${lines.map(buyLine).join('')}
    </div>`;
  }).join('');

  // Butikker, der ikke skal besøges, og butikker, loftet skar fra.
  const inPlay = FAVORITES.slice(0, maxStores());
  const skipped = inPlay.filter((id) => !l.chains.includes(id)).map(chainById).filter(Boolean).map((c) => c.name);
  const dropped = (l.dropped_chains || []).map(chainById).filter(Boolean).map((c) => c.name);

  const estimated = priced.some((b) => b.source === 'estimate:rema');

  el.innerHTML = `
    <div class="docket">
      <span class="figure"><b>${kr(l.total)}</b> i alt</span>
      <span class="figure"><b>${l.chains.length}</b> ${l.chains.length === 1 ? 'butik' : 'butikker'}</span>
      <span class="figure"><b>${kr(Math.round(l.waste_kr))}</b> spild</span>
      <span class="figure"><b>${picks.length}</b> ${picks.length === 1 ? 'ret' : 'retter'} til ${FLOW.settings.servings}</span>
    </div>
    ${skipped.length ? `<p class="note">Alt kan købes i ${esc(listNames(l.chains.map((id) => chainById(id)?.name || id)))} –
      du behøver ikke i ${esc(listNames(skipped))} denne gang.</p>` : ''}
    ${dropped.length ? `<p class="flag">Listen regner kun med dine fem første butikker. <strong>${esc(listNames(dropped))}</strong> er ikke med.</p>` : ''}

    <div class="spread list-head">
      <h3>Køb ind</h3>
      <button type="button" id="share-list">Del listen</button>
    </div>
    <div class="buy-groups ${l.chains.length === 1 ? 'single' : ''}">${groups}</div>
    ${unpriced.length ? `<div class="card shop-chain unpriced">
      <h3><span>Uden pris i dine butikker</span><span class="note">${unpriced.length} ${unpriced.length === 1 ? 'vare' : 'varer'}</span></h3>
      ${unpriced.map((b) => `<div class="shop-item"><span class="n">${esc(b.name)}<small>brug ${qty(b.need, b.unit)} · ${
        b.used_in.length === 1 ? `til ${esc(b.used_in[0])}` : `til ${b.used_in.length} retter`}</small></span><span class="p">–</span></div>`).join('')}
      <p class="note">Dem kender vi ingen pris på i dine butikker. De er ikke regnet med i ${kr(l.total)}.</p>
    </div>` : ''}

    <h3 class="list-head">Tjek at du har</h3>
    ${l.pantry.length ? `<div class="card pantry">
      ${l.pantry.map((p) => `<label class="pantry-row"><input type="checkbox"> ${esc(p.name)}</label>`).join('')}
    </div>
    <p class="note">Basisvarer, retterne bruger. Dem regner vi med, du har – de er ikke med i prisen.</p>`
    : '<p class="note">Retterne bruger ingen basisvarer, vi kender til.</p>'}

    <h3 class="list-head">Ugens retter</h3>
    <ol class="week-dishes">${picks.map((r) => `<li>${r.url
      ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</li>`).join('')}</ol>

    <p class="note list-foot">
      Priserne er hele pakker: har en vare kun én pakkestørrelse, købes den, og resten står
      som "til overs". Spild er den del af resterne, der ikke holder til næste uge, regnet i kroner.
      ${estimated ? 'Hvor en butik ikke selv har en pris, bruger vi REMA 1000’s hyldepris som skøn – det står ved varen.' : ''}
    </p>`;

  const share = $('#share-list');
  if (share) share.addEventListener('click', async () => {
    try {
      const how = await Native.share({ title: 'Indkøbsliste – Madplan', text: listText(l, picks) });
      share.textContent = how === 'copied' ? 'Kopieret' : 'Delt';
    } catch {
      return;                    // brugeren fortrød i delingsarket – ikke en fejl
    }
    setTimeout(() => { share.textContent = 'Del listen'; }, 2200);
  });
}

/**
 * Listen som ren tekst: butikken som overskrift, varerne under den, og
 * lagerlisten til sidst. Samme form som på skærmen, fordi den bruges ens —
 * én butik ad gangen.
 */
function listText(l, picks) {
  const out = [`Indkøbsliste – Madplan uge ${FLOW.ctx.week}`, ''];
  out.push(`Retter: ${picks.map((r) => r.title).join(', ')}`, '');
  for (const id of l.chains) {
    const c = chainById(id);
    out.push((c?.name || id).toUpperCase());
    for (const b of l.buy.filter((x) => x.chain === id)) {
      const src = b.source === 'estimate:rema' ? ' (pris fra REMA)' : b.source === 'offer' ? ' (tilbud)' : '';
      out.push(`  · ${b.name} — ${packLabel(b)} — ${kr(b.est_cost)}${src}`);
    }
    out.push('');
  }
  const unpriced = l.buy.filter((b) => !b.chain);
  if (unpriced.length) {
    out.push('UDEN PRIS');
    for (const b of unpriced) out.push(`  · ${b.name} — ${qty(b.need, b.unit)}`);
    out.push('');
  }
  if (l.pantry.length) {
    out.push('TJEK AT DU HAR');
    out.push(`  · ${l.pantry.map((p) => p.name).join(', ')}`);
    out.push('');
  }
  out.push(`I alt ca. ${kr(l.total)}.`);
  return out.join('\n');
}

/* ── Visning: ugens fund ──────────────────────────────────────────────────── */

/**
 * Filteret "kun mine butikker" deles af Ugens fund og Alle tilbud. Det står i
 * localStorage frem for i hukommelsen, så det overlever en genindlæsning –
 * det er en indstilling, ikke et klik.
 */
const FAV_FILTER_KEY = 'madplan_only_favorites';
function onlyFavorites() {
  if (!FAVORITES.length) return false;
  try { return localStorage.getItem(FAV_FILTER_KEY) !== '0'; } catch { return true; }
}
function setOnlyFavorites(on) {
  try { localStorage.setItem(FAV_FILTER_KEY, on ? '1' : '0'); } catch { /* privat vindue */ }
}

/** Afkrydsningsfelt til de to tilbudslister. Skjult indtil man har valgt butikker. */
function favFilterToggle() {
  if (!FAVORITES.length) return '';
  return `<label class="fav-toggle">
    <input type="checkbox" id="only-fav" ${onlyFavorites() ? 'checked' : ''}>
    Kun ${esc(listNames(favoriteNames()))}
  </label>`;
}

async function viewDeals() {
  app().innerHTML = `
    <div class="enter">
      <p class="eyebrow">Uge ${isoWeek()}<i class="sep"></i>Ugens fund</p>
      <h1>Tilbuddene der holder, når kiloprisen tjekkes efter.</h1>
      <p class="lede">Skiltet siger rabat. Skalaen på hvert kort siger, hvor prisen
      ligger i forhold til varens egen normalpris – det er den, du kan handle efter.</p>
      <div class="controls">${favFilterToggle()}</div>
    </div>
    <div id="deals"><div class="loading">Regner på priserne…</div></div>`;

  const box = $('#only-fav');
  if (box) box.addEventListener('change', () => { setOnlyFavorites(box.checked); viewDeals(); });

  const deals = await Data.deals(48, onlyFavorites() ? FAVORITES.join(',') : '');
  const el = $('#deals');
  if (!deals.length) {
    el.innerHTML = `<div class="empty card"><h3>Ingen data endnu</h3>
      <p>Hent ugens tilbudsaviser først.</p><code>node src/ingest/run.js</code></div>`;
    return;
  }
  el.innerHTML = `<div class="grid cols">${deals.map(offerCard).join('')}</div>`;
  bindOfferCards(el);
}

/* ── Visning: alle tilbud ─────────────────────────────────────────────────── */

/**
 * Én række pr. vare pr. kæde – den billigste.
 *
 * Basen kan indeholde det samme tilbud beskrevet på et par forskellige måder
 * ("Originale, fedtreducerede" / "Dybfrosne, nøddebrune"), fordi kæden trykker
 * den samme avis med lidt forskellig sats i hver region. Rækkerne er ikke ens
 * nok til at kunne slås sammen i basen – men på et kort, der ikke viser
 * beskrivelsen, ser de fuldstændig ens ud, og tre identiske kort i træk ligner
 * en fejl. Sammenlægningen hører derfor til her i visningen, hvor det er
 * kortets indhold, der afgør, hvad der er en gentagelse.
 *
 * Prishistorikken bag varen er urørt: arket viser stadig hver kæde for sig.
 */
function collapseOffers(rows) {
  const best = new Map();
  for (const o of rows) {
    const key = `${o.chain_id}|${o.heading}`;
    const prev = best.get(key);
    // Billigst pr. kg vinder; mangler kiloprisen, afgør hyldeprisen.
    const better = !prev
      || (o.unit_price != null && prev.unit_price != null && o.unit_price < prev.unit_price)
      || (prev.unit_price == null && o.unit_price != null)
      || (o.unit_price == null && prev.unit_price == null && o.price < prev.price);
    if (better) best.set(key, o);
  }
  return [...best.values()];
}

async function viewOffers() {
  app().innerHTML = `
    <div class="enter">
      <p class="eyebrow">Uge ${isoWeek()}<i class="sep"></i>Alle tilbud</p>
      <h1>${num(STATUS.active_offers)} aktive tilbud fra ${num(STATUS.chains)} kæder.</h1>
      <p class="lede">Åbn en vare for at se, hvad den har kostet uge for uge, og hvor
      den er billigst lige nu.</p>
      <div class="controls">
        <input type="text" id="q" class="grow" placeholder="Søg – fx skyr, kyllingebryst, laks…">
        <select id="chain"><option value="">Alle kæder</option>
          ${CHAINS.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
        <select id="sort">
          <option value="unit_price">Billigst pr. kg</option>
          <option value="price">Laveste pris</option>
          <option value="newest">Nyeste</option>
        </select>
        ${favFilterToggle()}
      </div>
    </div>
    <div id="list"><div class="loading">Henter…</div></div>`;

  const load = async () => {
    // Den enkelte kæde i rullelisten slår filteret fra: har man valgt netop
    // den, er det den, man vil se – også selvom den ikke er en favorit.
    const one = $('#chain').value;
    const box = $('#only-fav');
    const chain = one ? one : (box && box.checked ? FAVORITES.join(',') : '');
    const rows = collapseOffers(await Data.offers({
      q: $('#q').value, chain, sort: $('#sort').value, limit: 72,
    }));
    const el = $('#list');
    el.innerHTML = rows.length
      ? `<div class="grid cols">${rows.map(offerCard).join('')}</div>`
      : '<div class="empty card"><h3>Ingen træf</h3><p>Prøv et andet søgeord.</p></div>';
    bindOfferCards(el);
  };

  let t;
  $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 220); });
  $('#chain').addEventListener('change', load);
  $('#sort').addEventListener('change', load);
  const favBox = $('#only-fav');
  if (favBox) favBox.addEventListener('change', () => { setOnlyFavorites(favBox.checked); load(); });
  await load();
}

/* ── Visning: følg varer ──────────────────────────────────────────────────── */

/**
 * Beder om lov til at sende push og melder enheden til.
 *
 * Returnerer en sætning, der kan stå efter kvitteringen for overvågningen –
 * eller tom streng, hvis der ikke er noget at sige (nettet har ingen push,
 * og er der allerede sagt ja, skal brugeren ikke mindes om det hver gang).
 */
async function askForPush() {
  if (!Native.isNative) return '';
  switch (await Native.enablePush()) {
    case 'granted':
      return 'Du får besked på telefonen, når der er nyt.';
    case 'denied':
      return 'Beskeder på telefonen er slået fra for Madplan – du kan slå dem til i Androids indstillinger.';
    default:
      return '';
  }
}

async function viewWatch() {
  app().innerHTML = `
    <div class="enter">
      <p class="eyebrow">Følg varer</p>
      <h1>Få besked, når en vare du ofte køber er reelt billig.</h1>
      <p class="lede">Skriv varen, som du ville sige den. Appen holder øje i alle
      kæder og siger til, når prisen pr. kg ligger under normalprisen.</p>
      <div class="controls">
        <input type="text" id="w-label" class="grow" placeholder="Hvilken vare? fx skyr, hakket oksekød, laks">
        <input type="number" id="w-disc" placeholder="Min. rabat %" style="width:140px" min="0" max="90">
        <input type="number" id="w-km" placeholder="Maks. km" style="width:122px" min="1">
        <button class="primary" id="w-add">Følg vare</button>
      </div>
      <div id="w-msg"></div>
    </div>
    <h2>Dine overvågninger</h2>
    <div class="card" id="w-list"><div class="loading">Henter…</div></div>
    <div class="spread" style="margin:38px 0 14px">
      <h2 style="margin:0">Notifikationer</h2>
      <div class="row">
        <button id="w-run">Tjek for nye tilbud</button>
        <button id="w-read" class="ghost">Markér alle som læst</button>
      </div>
    </div>
    <div class="card" id="n-list"><div class="loading">Henter…</div></div>`;

  const refresh = async () => {
    const [ws, ns] = await Promise.all([Data.watches(), Data.notifications(60)]);

    $('#w-list').innerHTML = ws.length ? ws.map((w) => `
      <div class="watch-row">
        <div style="flex:1">
          <div class="lbl">${esc(w.label)}</div>
          <div class="det">
            ${w.taxonomy_key ? `varetype: ${esc(w.taxonomy_key)}` : `fritekst: “${esc(w.query)}”`}
            ${w.min_discount ? ` · min. ${Math.round(w.min_discount * 100)} % rabat` : ''}
            ${w.max_km ? ` · maks. ${w.max_km} km` : ''}
            · ${w.notif_count} træf
          </div>
        </div>
        <button class="ghost" data-del="${w.id}">Fjern</button>
      </div>`).join('')
      : '<div class="empty"><h3>Ingen overvågninger endnu</h3><p>Skriv en vare ovenfor – fx “skyr” – så holder appen øje med den i alle kæder.</p></div>';

    $('#w-list').querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        await Data.deleteWatch(b.dataset.del);
        refresh(); loadStatus();
      }));

    $('#n-list').innerHTML = ns.length ? ns.map((n) => `
      <div class="notif ${n.read_at ? '' : 'unread'}">
        ${n.image ? `<img src="${esc(n.image)}" alt="" loading="lazy">` : ''}
        <div style="flex:1;min-width:0">
          <div class="hd">${esc(n.heading)}</div>
          <div class="det note">
            <strong>${esc(n.watch_label)}</strong> · ${esc(n.chain_name)} · ${kr(n.price)}
            ${n.unit_price != null ? ` · ${num(n.unit_price, 2)} kr/${esc(n.base_unit)}` : ''}
            ${n.nearest_store ? ` · nærmeste: ${esc(n.nearest_store)} (${num(n.nearest_km, 1)} km)` : ''}
          </div>
          <div style="margin-top:5px">${verdictTag(n.discount >= 0.25 ? 'great' : n.discount >= 0.1 ? 'good' : 'fair', n.discount != null ? n.discount * 100 : null)}</div>
        </div>
      </div>`).join('')
      : '<div class="empty"><h3>Ingen notifikationer</h3><p>Tilføj en overvågning, eller tryk “Tjek for nye tilbud”.</p></div>';
  };

  $('#w-add').addEventListener('click', async () => {
    const label = $('#w-label').value.trim();
    if (!label) return;
    const disc = parseFloat($('#w-disc').value);
    const km = parseFloat($('#w-km').value);
    const home = (() => { try { return JSON.parse(localStorage.getItem('madplan_home') || '{}'); } catch { return {}; } })();
    const r = await Data.createWatch({
      label, query: label,
      min_discount: isFinite(disc) ? disc / 100 : null,
      max_km: isFinite(km) ? km : null,
      home_lat: home.home_lat ?? null,
      home_lng: home.home_lng ?? null,
    });
    if (r.error) {
      $('#w-msg').innerHTML = `<p class="note" style="color:var(--clay)">${esc(r.error)}</p>`;
      return;
    }

    const created = r.deferred
      ? `Følger nu <strong>${esc(label)}</strong>. Træf findes ved næste natlige opdatering.`
      : `Følger nu <strong>${esc(r.watch.label)}</strong>${r.watch.taxonomy_key ? ` (varetype: ${esc(r.watch.taxonomy_key)})` : ''} · ${r.new_notifications} træf med det samme.`;

    $('#w-msg').innerHTML = `<p class="note">${created}</p>`;
    $('#w-label').value = '';
    refresh(); loadStatus();

    // Først her spørges der om lov til at sende push. Brugeren har lige bedt
    // om at få besked, så spørgsmålet giver mening – og det er hele pointen:
    // spørger man ved opstart, siger folk nej, og fra Android 13 er et nej
    // svært at komme tilbage fra.
    const pushMsg = await askForPush();
    if (pushMsg) $('#w-msg').innerHTML = `<p class="note">${created} ${pushMsg}</p>`;
  });

  $('#w-run').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Tjekker…';
    const r = await Data.runWatches();
    e.target.disabled = false;
    e.target.textContent = r.deferred
      ? 'Tjekkes automatisk hver nat'
      : `Tjek for nye tilbud (${r.created.length} nye)`;
    refresh(); loadStatus();
  });

  $('#w-read').addEventListener('click', async () => {
    await Data.markRead();
    refresh(); loadStatus();
  });

  await refresh();
}

/* ── Visning: indstillinger ───────────────────────────────────────────────── */

async function viewSettings() {
  const home = STATUS.home || {};
  app().innerHTML = `
    <div class="enter">
      <p class="eyebrow">Indstillinger</p>
      <h1>Butikkerne, adressen og de data planen bygger på.</h1>
      <p class="lede">Placeringen bruges kun til at finde nærmeste butik. Den forlader ikke maskinen.</p>
    </div>

    <div class="card" style="padding:18px;max-width:660px;margin-bottom:16px">
      <h3>Mine butikker</h3>
      <p class="note" style="margin:0 0 14px">${FAVORITES.length
        ? `Madplanen bygges kun af tilbud fra <strong>${esc(listNames(favoriteNames()))}</strong>.`
        : 'Ikke valgt endnu – madplanen bygges af alle kæder, også dem langt væk.'}</p>
      <button class="primary" id="settings-stores">${FAVORITES.length ? 'Skift butikker' : 'Vælg butikker'}</button>
    </div>

    <div class="card" style="padding:18px;max-width:660px">
      <h3>Din adresse</h3>
      <div class="controls" style="margin-bottom:12px">
        <input type="number" id="lat" step="0.0001" placeholder="Breddegrad" value="${home.lat ?? ''}" style="width:150px">
        <input type="number" id="lng" step="0.0001" placeholder="Længdegrad" value="${home.lng ?? ''}" style="width:150px">
        <button id="locate">Brug min placering</button>
        <button class="primary" id="save-home">Gem</button>
      </div>
      <p class="note" id="home-msg" style="margin:0">${home.lat != null ? `Sat til ${num(home.lat, 4)}, ${num(home.lng, 4)}.` : 'Ikke sat endnu.'}</p>
      <div id="near"></div>
    </div>

    <h2>Data i basen</h2>
    <div class="grid cols">
      ${[
        ['Tilbud i alt', num(STATUS.offers)],
        ['Aktive tilbud', num(STATUS.active_offers)],
        ['Varetyper', num(STATUS.products)],
        ['Kæder', num(STATUS.chains)],
        ['Butikker', num(STATUS.stores)],
        ['Opskrifter', num(STATUS.recipes)],
        ['Uger med data', num(STATUS.weeks_of_history)],
        ['Overvågninger', num(STATUS.watches)],
      ].map(([l, v]) => `<div class="card" style="padding:16px 18px">
        <div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div></div>`).join('')}
    </div>

    <h2>Opdatér data</h2>
    <div class="row">
      <button class="primary" id="do-ingest">Hent denne uges tilbudsaviser</button>
      <span class="note" id="ingest-msg">Senest hentet: ${STATUS.last_ingest ? new Date(STATUS.last_ingest).toLocaleString('da-DK') : 'aldrig'}</span>
    </div>
    <p class="note" style="margin-top:14px;max-width:70ch">
      Opskrifter hentes med <code>node src/recipes/crawl.js</code>.
      Hver ny uges ingest udbygger prishistorikken.
    </p>

    <div class="divider"></div>
    <p class="note"><a href="/privatliv">Privatlivspolitik</a> – hvad appen gemmer, og hvor.</p>`;

  $('#settings-stores').addEventListener('click', () => storePicker(() => viewSettings()));

  // Native.getPosition tager den native plugin i appen og browserens API på
  // nettet. Forskellen betyder noget: i appen kommer der en rigtig
  // systemdialog, hvor browseren bare kan tie stille.
  $('#locate').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const before = e.target.textContent;
    e.target.textContent = 'Finder…';
    try {
      const { lat, lng } = await Native.getPosition();
      $('#lat').value = lat.toFixed(4);
      $('#lng').value = lng.toFixed(4);
      $('#home-msg').textContent = 'Placering hentet – tryk Gem.';
    } catch {
      $('#home-msg').textContent = 'Kunne ikke hente placering – indtast koordinaterne manuelt.';
    }
    e.target.disabled = false;
    e.target.textContent = before;
  });

  $('#save-home').addEventListener('click', async () => {
    const lat = parseFloat($('#lat').value), lng = parseFloat($('#lng').value);
    if (!isFinite(lat) || !isFinite(lng)) { $('#home-msg').textContent = 'Ugyldige koordinater.'; return; }
    await Data.saveSettings({ home_lat: lat, home_lng: lng });
    await loadStatus();
    $('#home-msg').textContent = 'Gemt.';
    const near = await Data.storesNear(lat, lng, 5);
    $('#near').innerHTML = near.length
      ? `<p class="note"><strong>${near.length} butikker</strong> inden for 5 km. Nærmeste:</p>
         <ul class="note" style="margin:6px 0 0;padding-left:18px">
           ${near.slice(0, 6).map((s) => `<li>${esc(s.chain_name)} – ${esc(s.street || s.name || '')}, ${esc(s.city || '')} (${num(s.km, 1)} km)</li>`).join('')}
         </ul>`
      : '<p class="note">Ingen butikker fundet inden for 5 km.</p>';
  });

  $('#do-ingest').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Henter… (kan tage et par minutter)';
    const s = await Data.ingest();
    e.target.disabled = false; e.target.textContent = 'Hent denne uges tilbudsaviser';
    $('#ingest-msg').textContent = s.deferred
      ? 'Data hentes automatisk af GitHub Actions hver nat.'
      : `${s.inserted} nye tilbud fra ${s.chains} kæder.`;
    loadStatus();
  });
}

/* ── Router ───────────────────────────────────────────────────────────────── */

async function loadStatus() {
  STATUS = await Data.status();
  // Kun tallet røres. Skrev vi hele linkets innerHTML – som før – forsvandt
  // fanens ikon ved første statusopdatering, og bundlinjen stod med huller.
  const badge = $('#watch-badge');
  if (badge) {
    badge.textContent = STATUS.unread ? String(STATUS.unread) : '';
    badge.hidden = !STATUS.unread;
  }

  // Foden siger, hvor friske tallene er. Uden det kan man ikke se forskel på
  // "der er ingen gode tilbud i denne uge" og "dataene er en måned gamle".
  const upd = $('#site-updated');
  if (upd && STATUS.last_ingest) {
    upd.textContent = `Tilbud opdateret ${new Date(STATUS.last_ingest)
      .toLocaleDateString('da-DK', { day: 'numeric', month: 'long' })}.`;
  }
}

const ROUTES = {
  '/plan': viewPlan,
  '/deals': viewDeals,
  '/offers': viewOffers,
  '/watch': viewWatch,
  '/settings': viewSettings,
};

async function route() {
  const hash = location.hash || '#/plan';
  const base = '/' + (hash.replace(/^#\//, '').split('/')[0] || 'plan');
  document.querySelectorAll('#tabs a').forEach((a) =>
    a.classList.toggle('active', a.getAttribute('href').startsWith('#' + base)));

  // Ugen i mærket sættes ved hvert rutehop frem for én gang ved opstart: en
  // fane, der har stået åben natten over søndag-mandag, skal ikke vise
  // sidste uges nummer.
  const wk = $('#brand-week');
  if (wk) wk.textContent = `Uge ${isoWeek()}`;

  window.scrollTo(0, 0);
  await (ROUTES[base] || viewPlan)();
}

// Erstatter inline onclick/onerror i HTML. En streng Content-Security-Policy
// (script-src 'self') blokerer inline handlere, så de bor her i stedet.
document.getElementById('modal-close')
  .addEventListener('click', () => document.getElementById('modal').close());

// 'error' bobler ikke - derfor capture-fasen. Skjuler billeder der ikke kan hentes
// (opskriftsfotos peger på eksterne sites, som kan nå at fjerne dem).
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.style.visibility = 'hidden';
}, true);

window.addEventListener('hashchange', route);

// Lander en push, mens appen er åben, vises der ingen systembesked – brugeren
// kigger jo på skærmen. I stedet opdateres tallet, og står man på "Følg
// varer", hentes listen igen, så det nye træf dukker op af sig selv.
window.addEventListener('madplan:push', async () => {
  await loadStatus();
  if ((location.hash || '').startsWith('#/watch')) await route();
});

/**
 * Når opstarten ikke kan hente data.
 *
 * På en telefon er det helt almindeligt: man står i en kælderbutik uden
 * dækning. Uden det her blev "Indlæser…" stående for evigt, og appen så
 * gået i stå frem for offline – to helt forskellige ting for den, der
 * kigger på skærmen.
 */
function startupError(err) {
  const offline = typeof navigator.onLine === 'boolean' && !navigator.onLine;
  const misconfigured = Native.isNative && Data.backend === 'local';

  app().innerHTML = `<div class="empty card">
    <h3>${offline ? 'Ingen forbindelse' : 'Kunne ikke hente data'}</h3>
    <p>${offline
      ? 'Madplanen hentes, så snart du er online igen.'
      : misconfigured
        // Præcis den fejl, --android-tjekket i scripts/build-web.js findes
        // for at fange. Slipper en sådan udgave alligevel igennem, skal
        // beskeden sige hvorfor – ikke bare stå tom.
        ? 'Appen er bygget uden Supabase-nøgler og har ingen server at spørge. Byg igen med <code>npm run android:sync</code>.'
        : esc(err && err.message ? err.message : 'Ukendt fejl.')}</p>
    <div class="row" style="justify-content:center;margin-top:16px">
      <button class="primary" id="retry-start">Prøv igen</button>
    </div>
  </div>`;

  $('#retry-start').addEventListener('click', () => location.reload());

  // Kommer forbindelsen tilbage af sig selv, skal brugeren ikke skulle
  // gætte, at der nu er noget at hente.
  window.addEventListener('online', () => location.reload(), { once: true });
}

/* ── Service worker ───────────────────────────────────────────────────────── */

/**
 * Kun på nettet. I Capacitor ligger skallen allerede lokalt i APK'en, og en
 * service worker oveni ville kun give ét sted mere, hvor en gammel version
 * kan blive hængende efter en opdatering.
 */
function registerServiceWorker() {
  if (Native.isNative || !('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* ikke kritisk */ });
}

(async function init() {
  registerServiceWorker();

  // Opstartstrinnene må ikke kunne tage resten af appen med sig. Fejler
  // broen til den native skal eller login'et, skal madplanen stadig vises –
  // en tom skærm er værre end en app uden push.
  try { await Native.init(); } catch { /* appen kører videre uden */ }

  // Anonymt login før første kald: de skal bære brugerens egen token, ikke
  // anon-nøglen. Er anonymt login ikke slået til i Supabase-projektet, går
  // Auth stille tilbage til anon-nøglen, og resten kører som før.
  try { await Auth.init(); } catch { /* falder tilbage på anon-nøglen */ }

  try {
    await loadStatus();
    CHAINS = await Data.chains();
    // Nyt vindue, samme server: overtag det valg, serveren allerede har gemt,
    // så madplanen ikke pludselig bygges af alle kæder igen.
    FAVORITES = await Data.adoptServerFavorites(STATUS);
    await route();
  } catch (err) {
    startupError(err);
  }
})();
