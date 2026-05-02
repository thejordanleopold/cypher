// Standalone build script — generates icon.svg, icon-192.png, icon-512.png,
// icon-maskable.png from the CYPHER wordmark in Bebas Neue. Not part of the
// runtime bundle. Run with `node scripts/gen-icons.mjs` after editing the
// font or layout. Requires opentype.js + sharp + a Bebas Neue ttf at
// /tmp/bebas.ttf (or env BEBAS_TTF).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const publicDir = path.join(repo, "public");
const fontPath = process.env.BEBAS_TTF ?? "/tmp/bebas.ttf";

const SIZE = 512;
const RADIUS = 112;
const TEXT = "CYPHER";

const font = opentype.parse((await fs.readFile(fontPath)).buffer);

// Pick the largest font size that keeps "CYPHER" inside an inset box.
function fitText(inset = 64) {
  const targetW = SIZE - inset * 2;
  const targetH = SIZE - inset * 2;
  let lo = 10;
  let hi = 1200;
  let best = lo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = font.getPath(TEXT, 0, 0, mid);
    const bb = p.getBoundingBox();
    if (bb.x2 - bb.x1 <= targetW && bb.y2 - bb.y1 <= targetH) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const path = font.getPath(TEXT, 0, 0, best);
  const bb = path.getBoundingBox();
  const w = bb.x2 - bb.x1;
  const h = bb.y2 - bb.y1;
  const x = (SIZE - w) / 2 - bb.x1;
  const y = (SIZE - h) / 2 - bb.y1;
  return font.getPath(TEXT, x, y, best);
}

const textPath = fitText();
const d = textPath.toPathData(2);

// Glassmorphism stack (bottom → top):
//   1. Base navy radial — slight depth, off-center brighter blue
//   2. Top specular highlight — frosted-pane sheen
//   3. Edge-light hairline (inner stroke) — gives the rounded edge
//   4. Wordmark with white→cool-gray vertical gradient
//
// Drop shadow on the wordmark adds the subtle lift you'd get from a
// real frosted surface. Kept low-opacity to avoid neon-glow slop.
function buildSvg({ pad = 0 } = {}) {
  const inner = pad
    ? `<g transform="translate(${SIZE / 2}, ${SIZE / 2}) scale(${1 - pad}) translate(${-SIZE / 2}, ${-SIZE / 2})">
         <path d="${d}" fill="url(#text-grad)" filter="url(#text-shadow)"/>
       </g>`
    : `<path d="${d}" fill="url(#text-grad)" filter="url(#text-shadow)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <radialGradient id="bg-grad" cx="22%" cy="18%" r="110%">
      <stop offset="0%" stop-color="#1d3a8a"/>
      <stop offset="35%" stop-color="#0f2150"/>
      <stop offset="100%" stop-color="#04091c"/>
    </radialGradient>
    <linearGradient id="sheen" x1="50%" y1="0%" x2="50%" y2="60%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="bloom" cx="80%" cy="92%" r="60%">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="text-grad" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#dde7f7"/>
    </linearGradient>
    <filter id="text-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000814" flood-opacity="0.45"/>
    </filter>
  </defs>

  <!-- Tile background (full bleed for maskable; same fill so non-maskable
       just clips at the corner radius). -->
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg-grad)"${pad ? "" : ` rx="${RADIUS}"`}/>
  <!-- Bottom-right blue bloom -->
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bloom)"${pad ? "" : ` rx="${RADIUS}"`}/>
  <!-- Top sheen -->
  <rect width="${SIZE}" height="${SIZE}" fill="url(#sheen)"${pad ? "" : ` rx="${RADIUS}"`}/>
  <!-- Inner edge highlight — 1px stroke inside the rounded rect for the
       "glass-pane edge" look. Skipped on maskable since launchers crop. -->
  ${
    pad
      ? ""
      : `<rect x="1.5" y="1.5" width="${SIZE - 3}" height="${SIZE - 3}" rx="${RADIUS - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>`
  }

  ${inner}
</svg>
`;
}

const svg = buildSvg();
const maskableSvg = buildSvg({ pad: 0.22 });

await fs.writeFile(path.join(publicDir, "icon.svg"), svg);

await sharp(Buffer.from(svg))
  .resize(192, 192)
  .png({ compressionLevel: 9 })
  .toFile(path.join(publicDir, "icon-192.png"));

await sharp(Buffer.from(svg))
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(path.join(publicDir, "icon-512.png"));

await sharp(Buffer.from(maskableSvg))
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(path.join(publicDir, "icon-maskable.png"));

console.log("Wrote icon.svg, icon-192.png, icon-512.png, icon-maskable.png");
