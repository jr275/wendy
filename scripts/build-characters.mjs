/**
 * node scripts/build-characters.mjs
 * Builds the 256×256 avatars in web/public/characters from assets/characters/source.
 * `cx`,`cy` = centre of the crop in source pixels, `s` = side of the square crop (clamped to the image).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.resolve('web/package.json'));
const sharp = require('sharp');

// bg: true → the source has a flat light or baked-in "transparency checkerboard" background, removed
// by flood-filling the near-white, colourless pixels that touch the image border (teeth and highlights
// inside the character are untouched).
const CROPS = {
  joy: { file: 'joy.png', cx: 165, cy: 160, s: 270, bg: true },
  anxiety: { file: 'anxiety.webp', cx: 460, cy: 330, s: 640 },
  anger: { file: 'anger.webp', cx: 720, cy: 340, s: 760, bg: true },
  sadness: { file: 'sadness.webp', cx: 300, cy: 200, s: 400 },
  ennui: { file: 'ennui.webp', cx: 330, cy: 240, s: 520, bg: true },
  disgust: { file: 'disgust.png', cx: 210, cy: 190, s: 340, bg: true },
  fear: { file: 'fear.png', cx: 200, cy: 135, s: 250, bg: true },
  envy: { file: 'envy.png', cx: 340, cy: 330, s: 560, bg: true },
};

async function withoutLightBackground(src) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const light = (i) => { const r = data[i], g = data[i + 1], b = data[i + 2]; return data[i + 3] > 0 && Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 16; };
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => { const k = y * w + x; if (!seen[k] && light(k * 4)) { seen[k] = 1; stack.push(k); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const k = stack.pop(); const x = k % w, y = (k - x) / w;
    data[k * 4 + 3] = 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  return sharp(data, { raw: info });
}
const out = 'web/public/characters';
for (const [id, c] of Object.entries(CROPS)) {
  const srcPath = `assets/characters/source/${c.file}`;
  const src = c.bg ? await withoutLightBackground(srcPath) : sharp(srcPath);
  const { width, height } = await sharp(srcPath).metadata();
  const s = Math.min(c.s, width, height);
  const left = Math.round(Math.min(Math.max(0, c.cx - s / 2), width - s));
  const top = Math.round(Math.min(Math.max(0, c.cy - s / 2), height - s));
  await src.extract({ left, top, width: Math.round(s), height: Math.round(s) }).resize(256, 256).webp({ quality: 88, alphaQuality: 90 }).toFile(`${out}/${id}.webp`);
}
console.log(Object.keys(CROPS).length, 'avatars →', out);
