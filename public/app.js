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

function thumb(url) {
  if (!url) return url;
  try {
    const u = new URL(url, location.href);
    if (u.hostname !== 'images.arla.com') return url;
    // Højden er sat sammen med bredden i kildens egne URL'er. Fjernes den
    // ikke, beskærer tjenesten efter det gamle forhold.
    u.searchParams.delete('height');
    u.searchParams.set('width', String(THUMB_W));
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

  $('#modal-body').innerHTML = `
    <p class="note">Vælg de supermarkeder, du normalt handler i. Madplanen bygges
    kun af tilbud fra dem – og indkøbslisten bliver til én, du kan gå ud og handle efter.</p>
    <div class="store-list">${rows}</div>
    <div class="divider"></div>
    <div class="row">
      <button class="primary" id="fav-save">Gem</button>
      <button class="ghost" id="fav-none">Ryd valg – brug alle kæder</button>
      <span class="note" id="fav-count"></span>
    </div>`;

  const boxes = () => [...$('#modal-body').querySelectorAll('input[type=checkbox]')];
  const tally = () => {
    const n = boxes().filter((b) => b.checked).length;
    $('#fav-count').textContent = n ? `${n} valgt` : 'ingen valgt = alle kæder';
  };
  boxes().forEach((b) => b.addEventListener('change', tally));
  tally();

  const save = async (ids) => {
    FAVORITES = await Data.setFavorites(ids);
    modal.close();
    if (onSaved) onSaved();
  };
  $('#fav-save').addEventListener('click', () => save(boxes().filter((b) => b.checked).map((b) => b.value)));
  $('#fav-none').addEventListener('click', () => save([]));

  modal.showModal();
}

/**
 * Linjen over madplanen: hvilke butikker den er bygget af.
 *
 * Kædernes egne farver er den eneste kulør, grænsefladen selv låner ud – de
 * er data, ikke pynt, og prikkerne gør linjen læsbar med et blik.
 */
function favoriteBar() {
  const chosen = FAVORITES.map(chainById).filter(Boolean);
  const dots = chosen.map((c) =>
    `<i class="chain-dot" style="background:${esc(c.color || 'var(--ink-3)')}"></i>`).join('');

  return `<div class="fav-bar">
    <div class="row" style="gap:8px">
      ${dots}
      <span>${chosen.length
        ? `Bygget på tilbud fra <strong>${esc(listNames(chosen.map((c) => c.name)))}</strong>`
        : '<strong>Alle kæder</strong> – også dem, der ikke ligger i nærheden af dig'}</span>
    </div>
    <button class="ghost" id="pick-stores">${chosen.length ? 'Skift butikker' : 'Vælg mine butikker'}</button>
  </div>`;
}

function bindFavoriteBar(reload) {
  const btn = $('#pick-stores');
  if (btn) btn.addEventListener('click', () => storePicker(reload));
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

/* ── Visning: madplan ─────────────────────────────────────────────────────── */

const TIER_INFO = {
  healthy: ['Sund & proteinrig', 'Højt proteinindhold og få kulhydrater pr. portion.'],
  classic: ['Klassisk', 'Almindelig hverdagsmad – hurtig, kendt og til at gå til.'],
  premium: ['Gourmet', 'Mere ambitiøse retter fra kokke-orienterede kilder.'],
};

async function viewPlan() {
  const tier = location.hash.split('/')[2] || 'classic';
  const [label, blurb] = TIER_INFO[tier] || TIER_INFO.classic;

  app().innerHTML = `
    <div class="enter">
      <p class="eyebrow">Uge ${isoWeek()}<i class="sep"></i>${esc(label)}</p>
      <h1>Syv retter bygget på det, der faktisk er på tilbud.</h1>
      <p class="lede">${esc(blurb)}</p>
      ${favoriteBar()}
      <div class="controls">
        <div class="seg">
          ${Object.entries(TIER_INFO).map(([k, v]) =>
            `<button data-tier="${k}" class="${k === tier ? 'active' : ''}">${v[0]}</button>`).join('')}
        </div>
        <button id="regen">Ny plan</button>
      </div>
    </div>
    <div id="plan"><div class="loading">Sammensætter madplan…</div></div>`;

  app().querySelectorAll('[data-tier]').forEach((b) =>
    b.addEventListener('click', () => { location.hash = `#/plan/${b.dataset.tier}`; }));

  let variant = 0;
  const load = async () => {
    $('#plan').innerHTML = '<div class="loading">Sammensætter madplan…</div>';
    renderPlan(await Data.mealPlan(tier, variant));
  };
  // Nye butikker = ny plan. Variantnummeret nulstilles, så man ser
  // hovedplanen for det nye valg og ikke en omrokering af den gamle.
  bindFavoriteBar(() => { variant = 0; viewPlan(); });
  $('#regen').addEventListener('click', () => { variant++; Native.haptic(); load(); });
  await load();
}

/** Råvare-mærkat: hovedråvarer markeres, så løftet er til at se. */
function ingChip(m) {
  const cls = m.role === 'main' ? 'ing main' : 'ing';
  return `<span class="${cls}">${esc(m.name)} <span class="c">${esc(m.chain)}</span></span>`;
}

function renderPlan(p) {
  const el = $('#plan');
  if (p.error) {
    el.innerHTML = `<div class="empty card"><h3>Ingen madplan</h3><p>${esc(p.error)}</p>
      ${FAVORITES.length ? '<button class="primary" id="plan-pick">Vælg flere butikker</button>' : ''}</div>`;
    const b = $('#plan-pick');
    if (b) b.addEventListener('click', () => storePicker(() => viewPlan()));
    return;
  }
  if (!p.days.length) {
    el.innerHTML = `<div class="empty card"><h3>Ingen retter matchede</h3>
      <p>Der er ${p.offers_available} varetyper på tilbud, men ingen opskrifter i dette spor bruger dem.</p></div>`;
    return;
  }

  const days = p.days.map((d) => {
    const r = d.recipe;
    const pct = Math.round((d.coverage || 0) * 100);
    const chips = d.matched.slice(0, 7).map(ingChip).join('');
    const missingAll = (d.unmatched || []).filter((u) => u.role === 'support');
    const missing = missingAll.slice(0, 5);

    // Dagsnavnet står i en streg hen over siden, ikke som en etiket inde i
    // kortet: ugen er en rækkefølge, og stregerne gør den til én.
    return `<article class="day">
      <div class="day-rule">${esc(d.day_name)}</div>
      <div class="day-card">
        ${r.image ? `<img src="${esc(thumb(r.image))}" alt="" width="108" height="108" loading="lazy" decoding="async">` : ''}
        <div class="day-body">
          <h3 class="day-title"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></h3>
          <div class="day-meta">
            <span>${esc(r.source_name)}</span>
            ${r.servings ? `<span>${r.servings} pers.</span>` : ''}
            ${r.total_minutes ? `<span>${r.total_minutes} min.</span>` : ''}
            ${r.protein_g != null ? `<span><strong>${num(r.protein_g, 0)} g</strong> protein</span>` : ''}
            ${r.carbs_g != null ? `<span><strong>${num(r.carbs_g, 0)} g</strong> kulhydrat</span>` : ''}
            ${r.kcal != null ? `<span>${num(r.kcal, 0)} kcal</span>` : ''}
            ${r.nutrition_src === 'estimated' ? '<span title="Kilden oplyser ikke næringsindhold – tallene er estimeret ud fra ingredienserne">est.</span>' : ''}
          </div>
          <div class="cover">
            <div class="match-bar"><i style="width:${pct}%"></i></div>
            <span class="note">
              <strong>${d.main_count} af ${d.main_total}</strong> hovedråvare${d.main_total === 1 ? '' : 'r'} på tilbud${
                d.support_total ? ` · ${d.support_count} af ${d.support_total} øvrige` : ''}
              ${d.est_savings > 0 ? ` · <span class="save">spar ca. ${kr(d.est_savings)}</span>` : ''}
            </span>
          </div>
          <div class="ing-list">${chips}${d.matched.length > 7 ? `<span class="ing">+${d.matched.length - 7}</span>` : ''}</div>
          ${missing.length ? `<p class="note missing">Køb også: ${missing.map((m) => esc(m.name)).join(', ')}${
            missingAll.length > missing.length ? ' m.fl.' : ''}</p>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');

  const shop = (p.shopping_list?.on_offer || []).map((c) => `
    <div class="card shop-chain">
      <h3>
        <span class="row" style="gap:8px"><i class="chain-dot" style="background:${
          esc(CHAINS.find((x) => x.name === c.chain)?.color || 'var(--ink-3)')}"></i>${esc(c.chain)}</span>
        <span class="note">${kr(c.total)}${c.savings > 0 ? ` · <span class="save">spar ${kr(c.savings)}</span>` : ''}</span>
      </h3>
      ${c.items.map((i) => `<div class="shop-item">
        <span class="n">${esc(i.name)}<small>${esc((i.heading || '').substring(0, 60))}</small></span>
        <span class="p">${kr(i.price)} · ${num(i.unit_price, 2)} kr/${esc(i.base_unit)}</span>
      </div>`).join('')}
    </div>`).join('');

  const rest = p.shopping_list?.rest || [];

  // Tallene står som på en bon: én linje, faste cifre, hårfine skillelinjer –
  // og kun det sparede beløb får vægt, for det er hele løftet.
  el.innerHTML = `
    <div class="docket">
      <span class="figure"><b>${p.days.length}</b> retter</span>
      <span class="figure"><b>${kr(p.est_cost)}</b> anslået råvarepris</span>
      <span class="figure saved"><b>${kr(p.est_savings)}</b> sparet mod normalpris</span>
      <span class="figure"><b>${num(p.offers_available)}</b> varer på tilbud</span>
    </div>
    ${planRule(p)}
    <div class="days">${days}</div>
    <div class="spread" style="margin:38px 0 14px">
      <h2 style="margin:0">Indkøbsliste – det der er på tilbud</h2>
      <button id="share-list">Del listen</button>
    </div>
    <div class="grid wide">${shop}</div>
    ${rest.length ? `<h2>Resten</h2>
      <div class="card" style="padding:16px 18px">
        <p class="note" style="margin:0 0 10px">Ikke på tilbud i dine butikker – men skal med i kurven.</p>
        <div class="rest-list">${rest.map((i) =>
          `<span class="ing">${esc(i.name)}${i.used_in.length > 1 ? ` <span class="c">${i.used_in.length} retter</span>` : ''}</span>`).join('')}</div>
      </div>` : ''}
    <p class="note" style="margin-top:18px;max-width:70ch">
      Priserne er beregnet ud fra opskrifternes mængder gange tilbudsprisen pr. kg/liter.
      Basisvarer som salt, olie, mel og krydderier er hverken talt med i prisen eller i kravet –
      dem regner vi med, du har hjemme.
      Opskrifterne ligger hos kilden – klik på titlen for fremgangsmåden.
    </p>`;

  const share = $('#share-list');
  if (share) share.addEventListener('click', async () => {
    try {
      const how = await Native.share({
        title: 'Indkøbsliste – Madplan',
        text: shoppingListText(p),
      });
      share.textContent = how === 'copied' ? 'Kopieret' : 'Delt';
    } catch {
      // Brugeren fortrød i systemets delingsark. Ikke en fejl.
      return;
    }
    setTimeout(() => { share.textContent = 'Del listen'; }, 2200);
  });
}

/**
 * Indkøbslisten som ren tekst, grupperet efter butik.
 *
 * Formen er den, listen faktisk bruges i: man står i én butik ad gangen, så
 * butikken er overskriften og varerne står under den. Prisen kommer med –
 * det er hele grunden til, at planen ser ud, som den gør.
 */
function shoppingListText(p) {
  const lines = [];
  if (p.week && p.year) lines.push(`Indkøbsliste – Madplan uge ${p.week}, ${p.year}`);
  else lines.push('Indkøbsliste – Madplan');
  lines.push('');

  for (const c of p.shopping_list?.on_offer || []) {
    lines.push(`${c.chain.toUpperCase()} – anslået ${kr(c.total)}${c.savings > 0 ? ` (spar ${kr(c.savings)})` : ''}`);
    // Både hyldeprisen og kr/kg med. Uden kr/kg ser hyldepriserne ud som om
    // de skulle lægge sammen til totalen – og det gør de ikke: totalen er
    // prisen på DEN MÆNGDE, ugens retter bruger, ikke på hele pakken.
    for (const i of c.items) {
      const unit = i.unit_price != null ? ` (${num(i.unit_price, 2)} kr/${i.base_unit})` : '';
      lines.push(`  · ${i.name} — ${kr(i.price)}${unit}`);
    }
    lines.push('');
  }

  const rest = p.shopping_list?.rest || [];
  if (rest.length) {
    lines.push('RESTEN – ikke på tilbud, men skal med');
    lines.push(`  · ${rest.map((i) => i.name).join(', ')}`);
    lines.push('');
  }

  lines.push(`I alt ca. ${kr(p.est_cost)} · sparet ${kr(p.est_savings)} mod normalpris.`);
  return lines.join('\n');
}

/**
 * Hvad blev der egentlig krævet af ugens retter?
 *
 * Kravet lempes af sig selv, når der ikke er tilbud nok til at holde det. Det
 * skal stå der – ellers kan man ikke se forskel på "alt er på tilbud" og
 * "vi gav op og tog, hvad vi kunne finde".
 */
function planRule(p) {
  if (!p.rule) return '';
  const names = p.chain_names && p.chain_names.length ? listNames(p.chain_names) : 'alle kæder';
  return `<div class="rule ${p.rule.relaxed ? 'relaxed' : ''}">
    <strong>${esc(p.rule.label)}</strong>
    <span class="note">${esc(names)} · ${num(p.candidates_qualified)} af ${num(p.candidates_scored)} opskrifter kunne opfylde kravet</span>
    ${p.rule.relaxed ? '<span class="note">Der var ikke tilbud nok i dine butikker til det strengeste krav, så det er lempet et trin.</span>' : ''}
    ${p.index_missing ? '<span class="note">Viser en forudberegnet plan for alle kæder – madplans-indekset mangler i databasen (kør supabase/schema.sql).</span>' : ''}
  </div>`;
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
