#!/usr/bin/env node
/**
 * Regenerates the menu-bar tray template icons.
 *
 * What it replaces: trayTemplate.png/trayTemplate@2x.png used to be 36pt artwork with ~1px
 * strokes, and the two files were different drawings. The menu bar is ~22pt tall, so macOS
 * downscaled the art and the hairlines dissolved into a gray blob. This script draws the mark
 * the app icon actually carries — a shield with the aperture eye — as a *solid* silhouette at
 * real status-item size (18pt): bold shapes survive the slot, hairlines never do.
 *
 * Template images are alpha-only: any opaque pixel renders as the menu bar's foreground color
 * in both light and dark mode, which is why the fill is opaque black and the detail is carved
 * out as transparency rather than drawn as gray.
 *
 * No dependencies: the rasterizer is a supersampled point-in-polygon and the PNG encoder is
 * zlib + hand-built chunks. Run: node scripts/generate-tray-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '../assets');

/** Point size of the finished icon — the menu bar's comfortable height. */
const SIZE = 18;
/** Sub-pixel raster grid per output pixel — cheap anti-aliasing. */
const SS = 8;

// The shield path, as (bezier) segments on an 18×18 canvas, flattened to a polygon below.
//   M 9 1.4  C shoulders out to the sides, down to the bottom point, back up, close.
const SEGMENTS = [
  { type: 'M', p: [9, 1.4] },
  { type: 'C', p: [5.8, 2.9, 4.0, 3.3, 2.9, 3.6] },
  { type: 'L', p: [2.9, 8.4] },
  { type: 'C', p: [2.9, 12.6, 5.3, 15.3, 9, 16.7] },
  { type: 'C', p: [12.7, 15.3, 15.1, 12.6, 15.1, 8.4] },
  { type: 'L', p: [15.1, 3.6] },
  { type: 'C', p: [14.0, 3.3, 12.2, 2.9, 9, 1.4] },
];

// The aperture: an annulus carved out of the shield — outer edge r, hole edge r — leaving the
// center pupil solid. Proportions match the 2048px app icon's iris, simplified for 18pt.
const EYE = { cx: 9, cy: 8.9, rOuter: 3.45, rInner: 1.85 };

const CURVE_STEPS = 24;
function flattenPath(segments) {
  const poly = [];
  let pen = null;
  for (const seg of segments) {
    if (seg.type === 'M') {
      pen = seg.p;
      poly.push([...seg.p]);
    } else if (seg.type === 'L') {
      pen = seg.p;
      poly.push([...seg.p]);
    } else if (seg.type === 'C') {
      const [x0, y0] = pen;
      const [x1, y1, x2, y2, x3, y3] = seg.p;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        poly.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      pen = [x3, y3];
    }
  }
  return poly;
}

function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const shield = flattenPath(SEGMENTS);

/** Alpha (0–255) of one output pixel, by sub-pixel coverage of shield-minus-aperture. */
function pixelAlpha(px, py) {
  let covered = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS;
      const y = py + (sy + 0.5) / SS;
      if (!inPolygon(shield, x, y)) continue;
      const d = Math.hypot(x - EYE.cx, y - EYE.cy);
      if (d >= EYE.rInner && d <= EYE.rOuter) continue; // the carved ring
      covered++;
    }
  }
  return Math.round((covered / (SS * SS)) * 255);
}

// --- minimal PNG encoder (8-bit RGBA, no interlace) -----------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: none
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(px) {
  const rgba = Buffer.alloc(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const i = (y * px + x) * 4;
      rgba[i + 3] = pixelAlpha((x / px) * SIZE, (y / px) * SIZE);
    }
  }
  return encodePng(px, px, rgba);
}

const oneX = render(18);
const twoX = render(36);
writeFileSync(join(ASSETS, 'trayTemplate.png'), oneX);
writeFileSync(join(ASSETS, 'trayTemplate@2x.png'), twoX);
console.log(`Wrote trayTemplate.png (18×18, ${oneX.length}B) and trayTemplate@2x.png (36×36, ${twoX.length}B)`);
