const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const size = 256;
const png = new PNG({ width: size, height: size });

function setPixel(x, y, r, g, b, a = 255) {
  const idx = (png.width * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function fillRoundedRect(x0, y0, w, h, radius, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.min(x - x0, x0 + w - 1 - x);
      const dy = Math.min(y - y0, y0 + h - 1 - y);
      if (dx >= radius || dy >= radius) {
        setPixel(x, y, ...color);
        continue;
      }
      const cx = radius - dx;
      const cy = radius - dy;
      if (cx * cx + cy * cy <= radius * radius) {
        setPixel(x, y, ...color);
      }
    }
  }
}

for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const gx = x / (size - 1);
    const gy = y / (size - 1);
    const top = [14, 28, 44];
    const bottom = [3, 10, 18];
    const wave = 0.5 + 0.5 * Math.sin(gx * 6.2 + gy * 4.4);
    const r = mix(top[0], bottom[0], gy * 0.9);
    const g = mix(top[1], bottom[1], gy * 0.9);
    const b = mix(top[2], bottom[2], gy * 0.9);
    setPixel(x, y, r + Math.round(wave * 4), g + Math.round(wave * 8), b + Math.round(wave * 10), 255);
  }
}

fillRoundedRect(28, 28, 200, 200, 42, [11, 19, 30, 230]);
fillRoundedRect(40, 40, 176, 176, 34, [20, 44, 66, 255]);

for (let y = 64; y < 194; y++) {
  for (let x = 66; x < 188; x++) {
    const nx = (x - 66) / 122;
    const ny = (y - 64) / 130;
    const stripe = Math.sin(nx * 12.0 - ny * 7.5);
    const idx = (png.width * y + x) << 2;
    png.data[idx] = mix(png.data[idx], 71, 0.22);
    png.data[idx + 1] = mix(png.data[idx + 1], 145, 0.22);
    png.data[idx + 2] = mix(png.data[idx + 2], 204, 0.22);
    png.data[idx + 3] = 255;
    if (stripe > 0.55) {
      png.data[idx] = mix(png.data[idx], 117, 0.30);
      png.data[idx + 1] = mix(png.data[idx + 1], 224, 0.30);
      png.data[idx + 2] = mix(png.data[idx + 2], 255, 0.30);
    }
  }
}

fillRoundedRect(64, 74, 22, 108, 10, [105, 210, 255, 255]);
fillRoundedRect(170, 74, 22, 108, 10, [245, 168, 90, 255]);
fillRoundedRect(96, 66, 64, 22, 10, [105, 210, 255, 255]);
fillRoundedRect(96, 168, 64, 22, 10, [245, 168, 90, 255]);
fillRoundedRect(116, 96, 24, 64, 8, [255, 247, 234, 255]);

const outDir = path.join(__dirname, "..", "media");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "icon.png");
png.pack().pipe(fs.createWriteStream(outPath));
