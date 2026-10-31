// Generates the PWA icons (no image deps — raw PNG encoded with zlib).
// Run: node scripts/make-icons.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "web", "icons");
fs.mkdirSync(outDir, { recursive: true });

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function blend(px, i, [r, g, b], a) {
  const na = px[i + 3] / 255;
  const out = a + na * (1 - a);
  if (out === 0) return;
  px[i] = Math.round((r * a + px[i] * na * (1 - a)) / out);
  px[i + 1] = Math.round((g * a + px[i + 1] * na * (1 - a)) / out);
  px[i + 2] = Math.round((b * a + px[i + 2] * na * (1 - a)) / out);
  px[i + 3] = Math.round(out * 255);
}

function solid(size, color) {
  const [r, g, b] = hex(color);
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = 255;
  }
  return px;
}

function draw(size, inset, bg = true) {
  const px = Buffer.alloc(size * size * 4);
  const at = (x, y) => (y * size + x) * 4;
  const radius = size * (0.22 + inset * 0.06);
  const bgA = hex("#9184d9");
  const bg2 = hex("#5d5294");
  // rounded-square background with a soft vertical gradient
  if (bg) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = Math.min(x, size - 1 - x);
        const cy = Math.min(y, size - 1 - y);
        let inside = true;
        if (cx < radius && cy < radius) {
          const dx = radius - cx;
          const dy = radius - cy;
          inside = dx * dx + dy * dy <= radius * radius;
        }
        if (!inside) continue;
        const t = y / size;
        const col = [
          Math.round(bgA[0] + (bg2[0] - bgA[0]) * t),
          Math.round(bgA[1] + (bg2[1] - bgA[1]) * t),
          Math.round(bgA[2] + (bg2[2] - bgA[2]) * t),
        ];
        blend(px, at(x, y), col, 1);
      }
    }
  }
  // glyph: an inbox tray with a down arrow, in near-white
  const white = [243, 245, 254];
  const s = size * (1 - inset * 2);
  const ox = (size - s) / 2;
  const oy = (size - s) / 2;
  const rect = (x0, y0, x1, y1, a = 1) => {
    for (let y = Math.round(oy + y0 * s); y < Math.round(oy + y1 * s); y++) {
      for (let x = Math.round(ox + x0 * s); x < Math.round(ox + x1 * s); x++) {
        if (x >= 0 && y >= 0 && x < size && y < size) blend(px, at(x, y), white, a);
      }
    }
  };
  // tray body (open box) — outline
  const t = 0.055;
  rect(0.24, 0.5, 0.76, 0.5 + t); // top lip
  rect(0.24, 0.5, 0.24 + t, 0.78); // left wall
  rect(0.76 - t, 0.5, 0.76, 0.78); // right wall
  rect(0.24, 0.78 - t, 0.76, 0.78); // base
  // inner shelf
  rect(0.33, 0.62, 0.44, 0.62 + t);
  rect(0.56, 0.62, 0.67, 0.62 + t);
  // down arrow above the tray
  rect(0.465, 0.22, 0.535, 0.5); // shaft
  for (let row = 0; row < 0.14; row += 1 / s) {
    const y = 0.44 + row;
    const half = 0.14 - row;
    rect(0.5 - half, y, 0.5 + half, y + 1 / s); // head
  }
  return encodePng(size, size, px);
}

for (const [name, size, inset] of [
  ["icon-192.png", 192, 0.06],
  ["icon-512.png", 512, 0.06],
  ["icon-maskable-512.png", 512, 0.16],
  ["apple-touch-icon.png", 180, 0.06],
]) {
  fs.writeFileSync(path.join(outDir, name), draw(size, inset));
  console.log("wrote", path.join("web/icons", name));
}

// Android launcher icons + splash, when the Capacitor project is present.
const androidRes = path.join(root, "android", "app", "src", "main", "res");
if (fs.existsSync(androidRes)) {
  const densities = [
    ["mdpi", 48],
    ["hdpi", 72],
    ["xhdpi", 96],
    ["xxhdpi", 144],
    ["xxxhdpi", 192],
  ];
  for (const [density, size] of densities) {
    const dir = path.join(androidRes, `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ic_launcher.png"), draw(size, 0.06));
    fs.writeFileSync(path.join(dir, "ic_launcher_round.png"), draw(size, 0.06));
    // adaptive foreground: glyph only, transparent, shrunk into the safe zone
    fs.writeFileSync(path.join(dir, "ic_launcher_foreground.png"), draw(size, 0.22, false));
  }
  // flat dark splash instead of the Cordova logo
  const splash = encodePng(96, 96, solid(96, "#161826"));
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "splash.png") fs.writeFileSync(p, splash);
    }
  };
  walk(androidRes);
  const bgFile = path.join(androidRes, "values", "ic_launcher_background.xml");
  if (fs.existsSync(bgFile)) {
    fs.writeFileSync(
      bgFile,
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#9184d9</color>\n</resources>\n`
    );
  }
  console.log("wrote android launcher icons + splash");
}
