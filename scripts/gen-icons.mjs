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
const RADIUS = 96;
const BG = "#0a0a0a";
const FG = "#10b981";
const TEXT = "CYPHER";

const font = opentype.parse((await fs.readFile(fontPath)).buffer);

// Pick the largest font size that keeps "CYPHER" inside an inset box and
// renders the path commands at integer-friendly coordinates.
function fitText() {
  const inset = 56;
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

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="${BG}"/>
  <path d="${d}" fill="${FG}"/>
</svg>
`;

// Maskable icons need ~10% safe-area padding inside a full bleed background
// so OS launchers can crop to a circle/squircle without clipping the mark.
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>
  <g transform="translate(${SIZE / 2}, ${SIZE / 2}) scale(0.78) translate(${-SIZE / 2}, ${-SIZE / 2})">
    <path d="${d}" fill="${FG}"/>
  </g>
</svg>
`;

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
