/**
 * Draws the extension icons (no image dependencies — plain zlib PNG output).
 *
 *   node tools/make-icons.mjs
 *
 * A rounded Prime-blue tile with a white muted-speaker glyph, supersampled 4x
 * so the 16px version still has clean edges.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SS = 4; // supersampling factor
const BG = [0, 168, 225]; // Prime blue #00A8E1
const BG_DEEP = [0, 118, 168];
const FG = [255, 255, 255];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Signed distance to a rounded box centred at (0.5,0.5), half-size h, radius r. */
function sdRoundBox(x, y, hx, hy, r) {
  const qx = Math.abs(x - 0.5) - (hx - r);
  const qy = Math.abs(y - 0.5) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a thick segment (a -> b) of half-width w. */
function sdSegment(x, y, ax, ay, bx, by, w) {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h) - w;
}

function insidePolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Glyph geometry in unit space.
const SPEAKER_BODY = { x0: 0.235, x1: 0.35, y0: 0.405, y1: 0.595 };
const SPEAKER_CONE = [
  [0.35, 0.405],
  [0.5, 0.255],
  [0.5, 0.745],
  [0.35, 0.595],
];
const X_A = [0.585, 0.375, 0.79, 0.625];
const X_B = [0.79, 0.375, 0.585, 0.625];

function sample(x, y) {
  // background tile
  if (sdRoundBox(x, y, 0.5, 0.5, 0.225) > 0) return null; // transparent corner
  const bg = mix(BG, BG_DEEP, clamp01((x + y) / 2));

  const inBody =
    x >= SPEAKER_BODY.x0 && x <= SPEAKER_BODY.x1 && y >= SPEAKER_BODY.y0 && y <= SPEAKER_BODY.y1;
  const inCone = insidePolygon(x, y, SPEAKER_CONE);
  const inX =
    sdSegment(x, y, X_A[0], X_A[1], X_A[2], X_A[3], 0.052) < 0 ||
    sdSegment(x, y, X_B[0], X_B[1], X_B[2], X_B[3], 0.052) < 0;

  return inBody || inCone || inX ? FG : bg;
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxi + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = sample(x, y);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const i = (py * size + pxi) * 4;
      const cov = a / n / 255;
      // premultiplied average over covered samples, straight alpha out
      px[i] = cov > 0 ? Math.round(r / (a / 255)) : 0;
      px[i + 1] = cov > 0 ? Math.round(g / (a / 255)) : 0;
      px[i + 2] = cov > 0 ? Math.round(b / (a / 255)) : 0;
      px[i + 3] = Math.round(cov * 255);
    }
  }
  return px;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
