/* ==========================================================================
 * SUPERSEDED — DO NOT RUN. This script no longer owns the app icons.
 *
 * It hand-drew the old clothes-hanger mark in code. The official brand is now
 * logo.jpeg, and every PNG in icons/ is a crop-and-resample of that file — see
 * tools/gen-icons-from-logo.html. Running this file would silently replace the
 * official logo with the retired hanger artwork, in all nine sizes, with no
 * error and no diff you would notice at a glance.
 *
 * The drawing code below is kept only as a record of where the old icons came
 * from. If the icons ever need to be regenerated, use the logo pipeline; only
 * reach for this file if you are deliberately restoring the hanger mark, and
 * then reset the topbar, sidebar and splash to match.
 * ==========================================================================
 */

/**
 * Generates every PNG the PWA needs (manifest icons + apple touch icon).
 *
 * Why hand-rolled? The build machine has no image library available, so this
 * writes PNGs directly: RGBA buffer -> box-filtered supersampling for clean
 * anti-aliasing -> zlib deflate -> standard PNG chunks.
 *
 * Run:  node tools/gen-icons.js        <-- see the banner above. Do not.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
const SS = 4; // supersampling factor — hard edges here, box-downsampled later

/* ------------------------------------------------------------------ *
 * Minimal RGBA surface with anti-aliased (via supersampling) shapes
 * ------------------------------------------------------------------ */
class Surface {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = Buffer.alloc(w * h * 4);
  }

  blend(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const a = c[3] / 255;
    const ia = 1 - a;
    const da = this.d[i + 3] / 255;
    const oa = a + da * ia;
    if (oa <= 0) return;
    this.d[i] = Math.round((c[0] * a + this.d[i] * da * ia) / oa);
    this.d[i + 1] = Math.round((c[1] * a + this.d[i + 1] * da * ia) / oa);
    this.d[i + 2] = Math.round((c[2] * a + this.d[i + 2] * da * ia) / oa);
    this.d[i + 3] = Math.round(oa * 255);
  }

  /** Distance-based fill: pixels with signed distance < 0 are inside. */
  fillWhere(fn, color) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (fn(x + 0.5, y + 0.5) < 0) this.blend(x, y, color);
      }
    }
  }

  roundRect(x, y, w, h, r, color) {
    const r2 = Math.max(0, Math.min(r, w / 2, h / 2));
    const cx = x + w / 2;
    const cy = y + h / 2;
    const hx = w / 2 - r2;
    const hy = h / 2 - r2;
    this.fillWhere((px, py) => {
      const dx = Math.abs(px - cx) - hx;
      const dy = Math.abs(py - cy) - hy;
      const ox = Math.max(dx, 0);
      const oy = Math.max(dy, 0);
      return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r2;
    }, color);
  }

  circle(cx, cy, r, color) {
    this.fillWhere((px, py) => Math.hypot(px - cx, py - cy) - r, color);
  }

  /** Partial ring (stroke along an arc of a circle). */
  discArc(cx, cy, r, w, a0, a1, color) {
    const half = w / 2;
    this.fillWhere((px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.hypot(dx, dy);
      const radial = Math.abs(dist - r) - half;
      if (dist < 1e-6) return -1;
      const ang = Math.atan2(dy, dx);
      // bring ang into the [a0, a1] window (window is < 2π wide)
      let t = ang;
      while (t < a0 - 1e-9) t += Math.PI * 2;
      while (t > a0 - 1e-9 + Math.PI * 2) t -= Math.PI * 2;
      const inArc = t >= a0 - 1e-9 && t <= a1 + 1e-9;
      return inArc ? radial : 1;
    }, color);
  }

  /** Thick line rendered as a capsule (round caps). */
  line(x0, y0, x1, y1, w, color) {
    const half = w / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    this.fillWhere((px, py) => {
      let t = ((px - x0) * dx + (py - y0) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)) - half;
    }, color);
  }

  /** Downsample by SS with a box filter (premultiplied) and return SS=1. */
  downsample() {
    const w = this.w / SS;
    const h = this.h / SS;
    const out = new Surface(w, h);
    const n = SS * SS;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * this.w + (x * SS + sx)) * 4;
            const pa = this.d[i + 3];
            r += this.d[i] * pa;
            g += this.d[i + 1] * pa;
            b += this.d[i + 2] * pa;
            a += pa;
          }
        }
        const o = (y * w + x) * 4;
        out.d[o] = a ? Math.round(r / a) : 0;
        out.d[o + 1] = a ? Math.round(g / a) : 0;
        out.d[o + 2] = a ? Math.round(b / a) : 0;
        out.d[o + 3] = Math.round(a / n);
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[n] = c >>> 0;
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
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(surf) {
  const stride = surf.w * 4;
  const raw = Buffer.alloc((stride + 1) * surf.h);
  for (let y = 0; y < surf.h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    surf.d.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(surf.w, 0);
  ihdr.writeUInt32BE(surf.h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * The icon itself — a clothes hanger on a deep-wine plate
 * ------------------------------------------------------------------ */
const WINE = [0x6b, 0x1d, 0x2f, 255];
const IVORY = [0xfa, 0xf7, 0xf2, 255];
const BRASS = [0xc9, 0x97, 0x50, 255];

/**
 * Draws the hanger motif centred in a square surface.
 * @param {Surface} s        supersampled surface
 * @param {number} size      size of that square, in supersampled pixels
 * @param {boolean} maskable when true the motif sits inside the safe zone
 */
function drawHanger(s, size, maskable) {
  const unit = size * (maskable ? 0.4 : 0.56);
  const cx = size / 2;
  const cy = size / 2 + unit * 0.04; // optical centre sits a touch high
  const at = (u, v) => [cx + (u - 0.5) * unit, cy + (v - 0.5) * unit];

  const stroke = Math.max(2, unit * 0.075);

  const [bx0, by0] = at(0.13, 0.72);
  const [bx1, by1] = at(0.87, 0.72);
  const [ax, ay] = at(0.5, 0.40);
  const [lx, ly] = at(0.17, 0.71);
  const [rx, ry] = at(0.83, 0.71);

  s.line(bx0, by0, bx1, by1, stroke, IVORY);   // bottom bar
  s.line(ax, ay, lx, ly, stroke, IVORY);       // left shoulder
  s.line(ax, ay, rx, ry, stroke, IVORY);       // right shoulder

  const [sx1, sy1] = at(0.5, 0.355);
  s.line(ax, ay, sx1, sy1, stroke, IVORY);     // stem

  // hook: a ring whose gap faces straight down, so the stem enters through it
  const [hx, hy] = at(0.5, 0.292);
  s.discArc(hx, hy, unit * 0.072, stroke, Math.PI * (120 / 180), Math.PI * (420 / 180), IVORY);

  s.circle(ax, ay, stroke * 0.8, BRASS);       // brass collar
}

/**
 * @param {number} size      output pixel size
 * @param {boolean} maskable full-bleed background (required by Android/iOS)
 */
function makeIcon(size, maskable) {
  const s = new Surface(size * SS, size * SS);
  const S = size * SS;
  if (maskable) {
    s.roundRect(0, 0, S, S, 0, WINE); // full bleed
  } else {
    s.roundRect(0, 0, S, S, S * 0.22, WINE);
  }
  drawHanger(s, S, maskable);
  return encodePNG(s.downsample());
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true], // iOS always crops to a circle
  ['icon-96.png', 96, false],
  ['icon-48.png', 48, false],
  ['favicon-32.png', 32, false],
  ['favicon-16.png', 16, false],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, maskable] of targets) {
  fs.writeFileSync(path.join(OUT, name), makeIcon(size, maskable));
  console.log(`  ${name}  ${size}x${size}`);
}
console.log('icons written to /icons');
