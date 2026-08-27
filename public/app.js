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

const unitPrice = (o) =>
  o.unit_price == null ? '' : `${num(o.unit_price, 2)} kr/${o.base_unit}`;

const daysLeft = (till) => {
  if (!till) return '';
  const d = Math.ceil((new Date(till) - Date.now()) / 86400000);
  if (d < 0) return 'udløbet';
  if (d === 0) return 'sidste dag';
  return `${d} dag${d === 1 ? '' : 'e'} tilbage`;
};

let STATUS = {};
let CHAINS = [];

/* ── Tilbudskort ──────────────────────────────────────────────────────────── */

function offerCard(o) {
  const img = o.image
    ? `<img src="${esc(o.image)}" alt="" loading="lazy">`
    : `<div style="width:66px;height:66px;border-radius:8px;background:var(--surface-2);flex-shrink:0"></div>`;

  return `<div class="offer" data-product="${o.product_id}">
    ${img}
    <div class="offer-body">
      <div class="offer-title">${esc(o.heading)}</div>
      <div class="offer-meta">
        <span class="chain-chip"><i class="chain-dot" style="background:${esc(o.color || 'var(--text-faint)')}"></i>${esc(o.chain_name)}</span>
        ${o.run_till ? `<span>${daysLeft(o.run_till)}</span>` : ''}
      </div>
      <div class="price-row">
        <span class="price">${kr(o.price)}</span>
        ${o.pre_price ? `<span class="pre-price">${kr(o.pre_price)}</span>` : ''}
        ${o.unit_price != null ? `<span class="unit-price">${unitPrice(o)}</span>` : ''}
      </div>
      ${o.verdict ? `<div style="margin-top:7px">${verdictTag(o.verdict, o.discount_pct)}</div>` : ''}
    </div>
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
    `<text x="${pad.l - 7}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--text-faint)">${num(v, 0)}</text>
     <line x1="${pad.l}" y1="${y(v)}" x2="${w - pad.r}" y2="${y(v)}" stroke="var(--border)" stroke-width="1"/>`).join('');

  // Yderste mærkater ankres indad, ellers klippes de af kanten
  const labels = series.map((s, i) => {
    if (!(i === 0 || i === series.length - 1 || series.length <= 6)) return '';
    const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
    return `<text x="${x(i)}" y="${h - 8}" text-anchor="${anchor}" font-size="9.5" fill="var(--text-faint)">${esc(s.period)}</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img"
            aria-label="Prisudvikling i kr pr. ${esc(unit)}">
    ${ticks}
    <polygon points="${band}" fill="var(--accent)" opacity=".13"/>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round"/>
    ${series.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.median)}" r="3" fill="var(--accent)"><title>${esc(s.period)}: ${num(s.median, 2)} kr/${esc(unit)} (${s.n} tilbud)</title></circle>`).join('')}
    ${labels}
  </svg>`;
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
    <td><span class="chain-chip"><i class="chain-dot"></i>${esc(c.chain_name)}</span></td>
    <td style="font-size:12.5px;color:var(--text-dim)">${esc(c.heading.substring(0, 44))}</td>
    <td class="num">${kr(c.price)}</td>
    <td class="num"><strong>${num(c.unit_price, 2)}</strong> <span style="color:var(--text-faint)">kr/${esc(c.base_unit)}</span></td>
  </tr>`).join('');

  $('#modal-body').innerHTML = `
    ${b ? `<div class="row" style="gap:24px;margin-bottom:16px">
      <div class="stat"><span class="v">${num(b.median, 2)}</span><span class="l">Normalpris kr/${esc(unit)}</span></div>
      <div class="stat"><span class="v">${num(b.min, 2)}</span><span class="l">Laveste set</span></div>
      <div class="stat"><span class="v">${num(b.max, 2)}</span><span class="l">Højeste set</span></div>
      <div class="stat"><span class="v">${b.samples}</span><span class="l">Observationer</span></div>
    </div>` : ''}

    <h2 style="margin-top:0">Prisudvikling</h2>
    ${d.series.length >= 2
      ? sparkline(d.series, unit) + `<p class="note">Median-pris pr. ${esc(unit)} pr. ISO-uge. Det skraverede felt viser spændet mellem billigste og dyreste kæde i ugen.</p>`
      : `<div class="chart-empty">Der er endnu kun data fra én uge.<br>Grafen tegnes, når næste uges tilbudsaviser er hentet.</div>`}

    <h2>Hvad koster den lige nu?</h2>
    ${d.chains.length
      ? `<table class="cmp"><thead><tr><th>Kæde</th><th>Vare</th><th style="text-align:right">Pris</th><th style="text-align:right">Pr. ${esc(unit)}</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="note">Ingen aktive tilbud på denne vare lige nu.</p>'}

    <div class="divider"></div>
    <button class="primary" id="follow-btn">Følg ${esc(d.product.name)}</button>
    <p class="note" style="margin-top:8px">Du får besked, når varen er på tilbud til under normalprisen.</p>
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
    <h1>Madplan for ugen</h1>
    <p class="sub">Bygget ud fra de varer, der faktisk er på tilbud i denne uge.</p>
    <div class="controls">
      <div class="seg">
        ${Object.entries(TIER_INFO).map(([k, v]) =>
          `<button data-tier="${k}" class="${k === tier ? 'active' : ''}">${v[0]}</button>`).join('')}
      </div>
      <button id="regen">Ny plan</button>
    </div>
    <p class="sub">${esc(blurb)}</p>
    <div id="plan"><div class="loading">Sammensætter madplan…</div></div>`;

  app().querySelectorAll('[data-tier]').forEach((b) =>
    b.addEventListener('click', () => { location.hash = `#/plan/${b.dataset.tier}`; }));

  let variant = 0;
  const load = async () => {
    $('#plan').innerHTML = '<div class="loading">Sammensætter madplan…</div>';
    renderPlan(await Data.mealPlan(tier, variant));
  };
  $('#regen').addEventListener('click', () => { variant++; load(); });
  await load();
}

function renderPlan(p) {
  const el = $('#plan');
  if (p.error) {
    el.innerHTML = `<div class="empty card"><h3>Ingen madplan endnu</h3><p>${esc(p.error)}</p>
      <code>node src/recipes/crawl.js --limit 300</code></div>`;
    return;
  }
  if (!p.days.length) {
    el.innerHTML = `<div class="empty card"><h3>Ingen retter matchede</h3>
      <p>Der er ${p.offers_available} varetyper på tilbud, men ingen opskrifter i dette spor bruger dem.</p></div>`;
    return;
  }

  const days = p.days.map((d) => {
    const r = d.recipe;
    const pct = Math.round((d.match_count / Math.max(d.considered, 1)) * 100);
    const ings = d.matched.slice(0, 7).map((m) =>
      `<span class="ing">${esc(m.name)} <span class="c">${esc(m.chain)}</span></span>`).join('');

    return `<div class="day">
      <div class="day-name">${esc(d.day_name)}</div>
      ${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : ''}
      <div class="day-body">
        <div class="day-title"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></div>
        <div class="day-meta">
          <span>${esc(r.source_name)}</span>
          ${r.servings ? `<span>${r.servings} pers.</span>` : ''}
          ${r.total_minutes ? `<span>${r.total_minutes} min.</span>` : ''}
          ${r.protein_g != null ? `<span><strong>${num(r.protein_g, 0)} g</strong> protein</span>` : ''}
          ${r.carbs_g != null ? `<span><strong>${num(r.carbs_g, 0)} g</strong> kulhydrat</span>` : ''}
          ${r.kcal != null ? `<span>${num(r.kcal, 0)} kcal</span>` : ''}
          ${r.nutrition_src === 'estimated' ? '<span title="Kilden oplyser ikke næringsindhold – tallene er estimeret ud fra ingredienserne">est.</span>' : ''}
        </div>
        <div class="match-bar"><i style="width:${pct}%"></i></div>
        <div class="note" style="margin-bottom:7px">
          <strong>${d.match_count} af ${d.considered}</strong> råvarer er på tilbud
          ${d.est_savings > 0 ? ` · <span class="save">spar ca. ${kr(d.est_savings)}</span>` : ''}
        </div>
        <div class="ing-list">${ings}${d.matched.length > 7 ? `<span class="ing">+${d.matched.length - 7}</span>` : ''}</div>
      </div>
    </div>`;
  }).join('');

  const shop = (p.shopping_list?.on_offer || []).map((c) => `
    <div class="card shop-chain">
      <h3><span>${esc(c.chain)}</span><span class="note">${kr(c.total)}${c.savings > 0 ? ` · <span class="save">spar ${kr(c.savings)}</span>` : ''}</span></h3>
      ${c.items.map((i) => `<div class="shop-item">
        <span class="n">${esc(i.name)}<small>${esc(i.heading.substring(0, 60))}</small></span>
        <span class="p">${kr(i.price)} · ${num(i.unit_price, 2)} kr/${esc(i.base_unit)}</span>
      </div>`).join('')}
    </div>`).join('');

  el.innerHTML = `
    <div class="plan-head">
      <div class="stat"><span class="v">${p.days.length}</span><span class="l">Retter</span></div>
      <div class="stat"><span class="v">${kr(p.est_cost)}</span><span class="l">Anslået råvarepris</span></div>
      <div class="stat"><span class="v save">${kr(p.est_savings)}</span><span class="l">Sparet vs. normalpris</span></div>
      <div class="stat"><span class="v">${p.offers_available}</span><span class="l">Varer på tilbud</span></div>
    </div>
    ${days}
    <h2>Indkøbsliste – det der er på tilbud</h2>
    <div class="grid wide">${shop}</div>
    <p class="note" style="margin-top:14px">
      Priserne er beregnet ud fra opskrifternes mængder gange tilbudsprisen pr. kg/liter.
      Basisvarer som salt, olie og krydderier er ikke regnet med.
      Opskrifterne ligger hos kilden – klik på titlen for fremgangsmåden.
    </p>`;
}

/* ── Visning: ugens fund ──────────────────────────────────────────────────── */

async function viewDeals() {
  app().innerHTML = `
    <h1>Ugens fund</h1>
    <p class="sub">Tilbud hvor prisen pr. kg reelt ligger under varens normalpris – ikke bare dem med det største skilt.</p>
    <div id="deals"><div class="loading">Regner på priserne…</div></div>`;

  const deals = await Data.deals(48);
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

async function viewOffers() {
  app().innerHTML = `
    <h1>Alle tilbud</h1>
    <p class="sub">${num(STATUS.active_offers)} aktive tilbud fra ${STATUS.chains} kæder. Klik på en vare for prishistorik.</p>
    <div class="controls">
      <input type="text" id="q" class="grow" placeholder="Søg – fx skyr, kyllingebryst, laks…">
      <select id="chain"><option value="">Alle kæder</option>
        ${CHAINS.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
      <select id="sort">
        <option value="unit_price">Billigst pr. kg</option>
        <option value="price">Laveste pris</option>
        <option value="newest">Nyeste</option>
      </select>
    </div>
    <div id="list"><div class="loading">Henter…</div></div>`;

  const load = async () => {
    const rows = await Data.offers({
      q: $('#q').value, chain: $('#chain').value, sort: $('#sort').value, limit: 72,
    });
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
  await load();
}

/* ── Visning: følg varer ──────────────────────────────────────────────────── */

async function viewWatch() {
  app().innerHTML = `
    <h1>Følg varer</h1>
    <p class="sub">Få besked når en vare, du ofte køber, er på reelt tilbud i en butik nær dig.</p>
    <div class="controls">
      <input type="text" id="w-label" class="grow" placeholder="Hvilken vare? fx skyr, hakket oksekød, laks">
      <input type="number" id="w-disc" placeholder="Min. rabat %" style="width:132px" min="0" max="90">
      <input type="number" id="w-km" placeholder="Maks. km" style="width:112px" min="1">
      <button class="primary" id="w-add">Følg vare</button>
    </div>
    <div id="w-msg"></div>
    <h2>Dine overvågninger</h2>
    <div class="card" id="w-list"><div class="loading">Henter…</div></div>
    <h2>Notifikationer</h2>
    <div class="row" style="margin-bottom:11px">
      <button id="w-run">Tjek for nye tilbud</button>
      <button id="w-read" class="ghost">Markér alle som læst</button>
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
          <div style="font-weight:590;font-size:13.5px">${esc(n.heading)}</div>
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
    $('#w-msg').innerHTML = r.error
      ? `<p class="note" style="color:var(--poor)">${esc(r.error)}</p>`
      : r.deferred
        ? `<p class="note">Følger nu <strong>${esc(label)}</strong>. Træf findes ved næste natlige opdatering.</p>`
        : `<p class="note">Følger nu <strong>${esc(r.watch.label)}</strong>${r.watch.taxonomy_key ? ` (varetype: ${esc(r.watch.taxonomy_key)})` : ''} · ${r.new_notifications} træf med det samme.</p>`;
    $('#w-label').value = '';
    refresh(); loadStatus();
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
    <h1>Indstillinger</h1>
    <p class="sub">Din placering bruges til at finde nærmeste butik – den forlader ikke maskinen.</p>

    <div class="card" style="padding:17px;max-width:560px">
      <h2 style="margin-top:0">Din adresse</h2>
      <div class="controls">
        <input type="number" id="lat" step="0.0001" placeholder="Breddegrad" value="${home.lat ?? ''}" style="width:160px">
        <input type="number" id="lng" step="0.0001" placeholder="Længdegrad" value="${home.lng ?? ''}" style="width:160px">
        <button id="locate">Brug min placering</button>
        <button class="primary" id="save-home">Gem</button>
      </div>
      <p class="note" id="home-msg">${home.lat != null ? `Sat til ${num(home.lat, 4)}, ${num(home.lng, 4)}.` : 'Ikke sat endnu.'}</p>
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
      ].map(([l, v]) => `<div class="card" style="padding:14px 16px">
        <div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div></div>`).join('')}
    </div>

    <h2>Opdatér data</h2>
    <div class="row">
      <button class="primary" id="do-ingest">Hent denne uges tilbudsaviser</button>
      <span class="note" id="ingest-msg">Senest hentet: ${STATUS.last_ingest ? new Date(STATUS.last_ingest).toLocaleString('da-DK') : 'aldrig'}</span>
    </div>
    <p class="note" style="margin-top:14px">
      Opskrifter hentes med <code style="padding:2px 6px">node src/recipes/crawl.js</code>.
      Hver ny uges ingest udbygger prishistorikken.
    </p>`;

  $('#locate').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => { $('#lat').value = pos.coords.latitude.toFixed(4); $('#lng').value = pos.coords.longitude.toFixed(4); },
      () => { $('#home-msg').textContent = 'Kunne ikke hente placering – indtast koordinaterne manuelt.'; }
    );
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
  const link = $('#tabs a[href="#/watch"]');
  link.innerHTML = 'Følg varer' + (STATUS.unread ? `<span class="badge-count">${STATUS.unread}</span>` : '');
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

(async function init() {
  await loadStatus();
  CHAINS = await Data.chains();
  await route();
})();
