// Draws the plugin's black-on-transparent button icons. Run: node scripts/make-icons.mjs
import { Jimp } from 'jimp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'plugin', 'assets');
const S = 96;
const BLACK = 0x000000ff;

function canvas() {
  return new Jimp({ width: S, height: S, color: 0x00000000 });
}

function disc(img, cx, cy, r) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if (x >= 0 && y >= 0 && x < S && y < S && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.setPixelColor(BLACK, x, y);
}

function line(img, x0, y0, x1, y1, w) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) disc(img, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, w / 2);
}

function arc(img, cx, cy, r, a0, a1, w) {
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    disc(img, cx + r * Math.cos(a), cy + r * Math.sin(a), w / 2);
  }
}

function tri(img, pts) {
  const [a, b, c] = pts;
  const area = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const p = [x, y];
      const d1 = area(a, b, p), d2 = area(b, c, p), d3 = area(c, a, p);
      const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) img.setPixelColor(BLACK, x, y);
    }
}

// Sync: two arrows chasing each other round a circle.
const sync = canvas();
arc(sync, 48, 48, 30, Math.PI * 1.15, Math.PI * 1.95, 9);
arc(sync, 48, 48, 30, Math.PI * 0.15, Math.PI * 0.95, 9);
tri(sync, [[78, 30], [66, 52], [88, 50]]);
tri(sync, [[18, 66], [30, 44], [8, 46]]);
await sync.write(join(out, 'sync.png'));

// Done: a bold check mark.
const done = canvas();
line(done, 16, 50, 38, 72, 13);
line(done, 38, 72, 82, 24, 13);
await done.write(join(out, 'done.png'));

// Send highlight: a marker tip over an underline.
const hl = canvas();
tri(hl, [[30, 62], [62, 18], [76, 30]]);
tri(hl, [[30, 62], [76, 30], [46, 70]]);
tri(hl, [[30, 62], [46, 70], [24, 76]]);
line(hl, 12, 86, 84, 86, 7);
await hl.write(join(out, 'highlight.png'));

// Plugin icon: a page with an ink drop.
const icon = new Jimp({ width: 192, height: 192, color: 0x00000000 });
for (let y = 20; y < 172; y++) for (let x = 36; x < 156; x++) {
  const edge = x < 44 || x >= 148 || y < 28 || y >= 164;
  if (edge) icon.setPixelColor(BLACK, x, y);
}
for (const y of [60, 84, 108]) for (let x = 60; x < 132; x++) for (let t = 0; t < 6; t++) icon.setPixelColor(BLACK, x, y + t);
await icon.write(join(out, 'icon.png'));
console.log('icons written to', out);
