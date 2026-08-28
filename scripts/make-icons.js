'use strict';

/**
 * Tegner appens ikoner som rigtige PNG-filer.
 *
 * Favicon'et er en 🥦-emoji i en inline-SVG. Det duer i en browserfane, men
 * Android vil have PNG i faste størrelser til launcher-ikonet, og Play
 * Console vil have 512×512. Der er ingen billedbiblioteker i projektet – og
 * der skal ikke være det for fire ikoner – så filerne tegnes her: formen som
 * afstandsfelt (SDF), og PNG'en kodet direkte med zlib, som er indbygget.
 *
 *   node scripts/make-icons.js
 *
 * Mærket er et prisskilt: det er tilbuddene, appen handler om, og formen kan
 * stadig læses ved 48 px, hvor en broccoli ville være grød.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ── PNG ─────────────────────────────────────────────────────────────────────

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

/** rgba er en Uint8Array på size*size*4. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Hver scanline får en filter-byte foran. 0 = ingen filtrering; billederne
  // er små og flade, så zlib klarer komprimeringen fint uden.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, dst + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Form ────────────────────────────────────────────────────────────────────

/** Afstand til en afrundet kasse. Negativ indeni. */
function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const SQ = Math.SQRT1_2;   // cos/sin 45°

/** Prisskiltet: en afrundet kasse drejet 45° med et hul til snoren. */
function sdTag(x, y) {
  const rx = x * SQ + y * SQ;
  const ry = -x * SQ + y * SQ;
  const box = sdRoundedBox(rx, ry, 0.60, 0.60, 0.17);
  const hole = Math.hypot(rx - 0.29, ry - 0.29) - 0.15;
  return Math.max(box, -hole);         // trækker hullet ud af kassen
}

const ACCENT_TOP = [0x23, 0x7d, 0x5a];
const ACCENT_BOT = [0x17, 0x59, 0x3f];
const WHITE = [0xff, 0xff, 0xff];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Blød kant: 1 indeni formen, 0 udenfor, med w px overgang. */
const cover = (d, w) => clamp01(0.5 - d / w);

/** Afstand til baggrundsformen. Negativ indeni. */
function sdBackground(shape, nx, ny) {
  switch (shape) {
    case 'full':    return -1;                                  // dækker alt
    case 'circle':  return Math.hypot(nx, ny) - 0.985;
    case 'rounded': return sdRoundedBox(nx, ny, 0.985, 0.985, 0.44);
    default:        return 1;                                   // 'none' – gennemsigtig
  }
}

/**
 * @param size   kantlængde i px
 * @param shape  'rounded' | 'circle' | 'full' | 'none'
 *               'none' tegner kun det hvide mærke – Androids adaptive ikon
 *               vil have forgrunden for sig, så systemet selv kan parallakse
 *               og beskære laget.
 * @param markScale  mærkets størrelse i forhold til lærredet
 */
function drawIcon(size, shape, markScale) {
  const px = new Uint8Array(size * size * 4);
  const aa = 2.6 / size;                     // ~2.6 px blød kant

  for (let y = 0; y < size; y++) {
    // Normaliseret til [-1, 1], y opad.
    const ny = 1 - ((y + 0.5) / size) * 2;
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const i = (y * size + x) * 4;
      const markA = cover(sdTag(nx / markScale, ny / markScale) * markScale, aa);

      if (shape === 'none') {
        px[i] = WHITE[0]; px[i + 1] = WHITE[1]; px[i + 2] = WHITE[2];
        px[i + 3] = Math.round(markA * 255);
        continue;
      }

      const bgA = cover(sdBackground(shape, nx, ny), aa);
      if (bgA <= 0) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }

      // Blød lodret tone giver dybde uden at koste læsbarhed.
      const t = clamp01((1 - ny) / 2);
      const r = ACCENT_TOP[0] + (ACCENT_BOT[0] - ACCENT_TOP[0]) * t;
      const g = ACCENT_TOP[1] + (ACCENT_BOT[1] - ACCENT_TOP[1]) * t;
      const b = ACCENT_TOP[2] + (ACCENT_BOT[2] - ACCENT_TOP[2]) * t;

      px[i]     = Math.round(r + (WHITE[0] - r) * markA);
      px[i + 1] = Math.round(g + (WHITE[1] - g) * markA);
      px[i + 2] = Math.round(b + (WHITE[2] - b) * markA);
      px[i + 3] = Math.round(bgA * 255);
    }
  }
  return px;
}

// ── Kørsel ──────────────────────────────────────────────────────────────────

const root = path.join(__dirname, '..');

function write(file, size, shape, markScale) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(drawIcon(size, shape, markScale), size));
  return fs.statSync(file).size;
}

// ── Web / PWA ───────────────────────────────────────────────────────────────

const webDir = path.join(root, 'public', 'icons');

const webTargets = [
  ['icon-192.png',         192, 'rounded', 0.62],
  ['icon-512.png',         512, 'rounded', 0.62],
  // maskable: Android beskærer selv, så baggrunden går til kanten og mærket
  // holder sig inden for sikkerhedszonen (de inderste 80 %).
  ['maskable-512.png',     512, 'full',    0.55],
  ['apple-touch-icon.png', 180, 'full',    0.60],   // iOS afrunder selv
];

console.log('public/icons/');
for (const [name, size, shape, scale] of webTargets) {
  const kb = write(path.join(webDir, name), size, shape, scale) / 1024;
  console.log(`  ${name.padEnd(22)} ${String(size).padStart(3)}²  ${kb.toFixed(1)} kB`);
}

// ── Android ─────────────────────────────────────────────────────────────────
//
// Fra API 26 tegnes launcher-ikonet af to lag, som systemet selv maskerer og
// parallakser. Baggrunden er en farve (values/ic_launcher_background.xml),
// forgrunden ligger på et 108dp-lærred, hvor kun de inderste ~66dp er
// garanteret synlige – derfor det mindre mærke i forgrundslaget.
//
// De flade ic_launcher.png bruges stadig på API 24-25, som minSdk tillader.

const resDir = path.join(root, 'android', 'app', 'src', 'main', 'res');

const DENSITIES = [
  ['mdpi',    48,  108],
  ['hdpi',    72,  162],
  ['xhdpi',   96,  216],
  ['xxhdpi',  144, 324],
  ['xxxhdpi', 192, 432],
];

if (fs.existsSync(path.join(root, 'android'))) {
  console.log('\nandroid/app/src/main/res/');
  for (const [density, legacy, adaptive] of DENSITIES) {
    const dir = path.join(resDir, `mipmap-${density}`);
    write(path.join(dir, 'ic_launcher.png'), legacy, 'rounded', 0.62);
    write(path.join(dir, 'ic_launcher_round.png'), legacy, 'circle', 0.58);
    write(path.join(dir, 'ic_launcher_foreground.png'), adaptive, 'none', 0.55);
    console.log(`  mipmap-${density.padEnd(8)} ${String(legacy).padStart(3)}² flad · ${String(adaptive).padStart(3)}² adaptiv`);
  }

  // Statuslinjens notifikationsikon. Android bruger KUN alfakanalen her og
  // farver silhuetten selv – et almindeligt farvet ikon ender som en hvid
  // klat. Derfor samme mærke, tegnet uden baggrund.
  const NOTIF = [['mdpi', 24], ['hdpi', 36], ['xhdpi', 48], ['xxhdpi', 72], ['xxxhdpi', 96]];
  for (const [density, size] of NOTIF) {
    write(path.join(resDir, `drawable-${density}`, 'ic_stat_madplan.png'), size, 'none', 0.78);
  }
  console.log(`  drawable-*/ic_stat_madplan.png     ${NOTIF.map((n) => n[1]).join('/')}² silhuet`);

  // Baggrundslaget er accentfarven, ikke Capacitors hvide standard.
  const bgXml = path.join(resDir, 'values', 'ic_launcher_background.xml');
  fs.writeFileSync(bgXml,
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<resources>\n' +
    '    <color name="ic_launcher_background">#1D6F4F</color>\n' +
    '</resources>\n');
  console.log('  values/ic_launcher_background.xml  #1D6F4F');
} else {
  console.log('\n(android/ findes ikke – springer launcher-ikonerne over)');
}

console.log('\nicon-512.png bruges også som Play Console-ikon (512×512).');
