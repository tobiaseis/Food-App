'use strict';

/**
 * Materialet til Play Console-siden.
 *
 *   node scripts/store-assets.js            # mod http://localhost:3000
 *   node scripts/store-assets.js --url https://madplan.example
 *
 * Play kræver et 512×512-ikon (det laver scripts/make-icons.js), en
 * feature graphic på 1024×500 og mindst to telefonskærmbilleder. Ikonet og
 * grafikken tegnes her; skærmbillederne tages af den kørende app, så de
 * altid viser rigtige tilbud og ikke en attrap.
 *
 * Filerne lander i store/ – de skal ikke i git, se .gitignore.
 *
 * Playwright er en optionalDependency. Er den ikke installeret, laves
 * feature graphic'en alligevel, og skærmbillederne springes over.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'store');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = argOf('--url', 'http://localhost:3000').replace(/\/+$/, '');

// ── PNG (samme kodning som make-icons.js) ───────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const dst = y * (w * 4 + 1);
    raw[dst] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, dst + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Feature graphic ─────────────────────────────────────────────────────────
//
// Play viser den øverst på butikssiden, ofte med appens navn lagt hen over.
// Derfor ingen tekst her: en tone i accentfarven med mærket forskudt til
// højre, så venstre halvdel står fri til det, Play selv skriver.

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const SQ = Math.SQRT1_2;

function sdTag(x, y) {
  const rx = x * SQ + y * SQ, ry = -x * SQ + y * SQ;
  const box = sdRoundedBox(rx, ry, 0.60, 0.60, 0.17);
  const hole = Math.hypot(rx - 0.29, ry - 0.29) - 0.15;
  return Math.max(box, -hole);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function featureGraphic(w = 1024, h = 500) {
  const px = new Uint8Array(w * h * 4);
  const aa = 2.4 / h;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Diagonal tone fra mørk nederst til venstre mod lysere øverst til højre.
      const t = clamp01((x / w) * 0.55 + (1 - y / h) * 0.45);
      let r = Math.round(0x13 + (0x2a - 0x13) * t);
      let g = Math.round(0x2f + (0x65 - 0x2f) * t);
      let b = Math.round(0x24 + (0x49 - 0x24) * t);

      // Mærket, forskudt mod højre. Koordinaterne normaliseres efter HØJDEN,
      // ellers ville formen blive trukket ud i bredden.
      const nx = (x - w * 0.74) / (h / 2);
      const ny = (h / 2 - y) / (h / 2);
      const s = 0.62;
      const mark = clamp01(0.5 - (sdTag(nx / s, ny / s) * s) / aa);

      // Diskret aftegning i stedet for fuld hvid – grafikken skal ikke
      // konkurrere med den tekst, Play lægger ovenpå.
      const a = mark * 0.16;
      px[i] = Math.round(r + (255 - r) * a);
      px[i + 1] = Math.round(g + (255 - g) * a);
      px[i + 2] = Math.round(b + (255 - b) * a);
      px[i + 3] = 255;
    }
  }
  return encodePng(px, w, h);
}

// ── Skærmbilleder ───────────────────────────────────────────────────────────

/**
 * Play vil have mindst to telefonbilleder, mellem 320 og 3840 px på den
 * korte led. 1080×2160 er et almindeligt telefonformat og rigeligt.
 */
const SHOTS = [
  ['1-madplan.png', '/#/plan', 'Ugens madplan'],
  ['2-indkoebsliste.png', '/#/plan', 'Indkøbslisten', { scrollTo: 'h2' }],
  ['3-fund.png', '/#/deals', 'Ugens fund'],
  ['4-foelg.png', '/#/watch', 'Følg varer'],
];

async function screenshots() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    console.log('\nPlaywright er ikke installeret – skærmbilleder springes over.');
    console.log('  npm i -D playwright && npx playwright install chromium');
    return 0;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 412, height: 824 },
    deviceScaleFactor: 2.62,      // ⇒ 1080×2160
    colorScheme: 'light',
  });

  let n = 0;
  for (const [name, route, label, opts = {}] of SHOTS) {
    try {
      await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1400);
      if (opts.scrollTo) {
        await page.evaluate((sel) => {
          const els = [...document.querySelectorAll(sel)];
          const target = els.find((e) => /Indkøbsliste/.test(e.textContent));
          if (target) target.scrollIntoView({ block: 'start' });
        }, opts.scrollTo);
        await page.waitForTimeout(500);
      }
      await page.screenshot({ path: path.join(outDir, name) });
      console.log(`  ${name.padEnd(24)} ${label}`);
      n++;
    } catch (err) {
      console.log(`  ${name.padEnd(24)} SPRUNGET OVER (${err.message.split('\n')[0]})`);
    }
  }

  await browser.close();
  return n;
}

// ── Kørsel ──────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const fg = path.join(outDir, 'feature-graphic.png');
  fs.writeFileSync(fg, featureGraphic());
  console.log('store/');
  console.log(`  feature-graphic.png      1024×500  ${(fs.statSync(fg).size / 1024).toFixed(1)} kB`);

  // Ikonet ligger allerede i public/icons – kopiér det med, så alt til Play
  // ligger samlet ét sted.
  const icon = path.join(root, 'public', 'icons', 'icon-512.png');
  if (fs.existsSync(icon)) {
    fs.copyFileSync(icon, path.join(outDir, 'icon-512.png'));
    console.log('  icon-512.png             512×512   (fra public/icons)');
  }

  console.log(`\nSkærmbilleder fra ${BASE}`);
  const n = await screenshots();

  console.log(`\n${n} skærmbillede(r). Play kræver mindst 2.`);
  console.log('Kører appen ikke? Start den med "npm start" i en anden terminal.');
})();
