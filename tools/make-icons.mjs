// Generates the PWA / store icons (the lit-pixel mark) as PNGs with no dependencies.
// Usage: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BG = [5, 5, 8];
const OFF = [35, 35, 47];
const ON = [140, 124, 255];

function crc32(buf) {
  let c;
  const table = crc32.t ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function icon(size, padFrac) {
  const px = Buffer.alloc(size * size * 3);
  const pad = size * padFrac;
  const grid = size - pad * 2;
  const gap = grid / 22;
  const cell = (grid - gap * 4) / 5;
  const r = cell * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let col = BG;
      const gx = x - pad;
      const gy = y - pad;
      const i = Math.floor(gx / (cell + gap));
      const j = Math.floor(gy / (cell + gap));
      if (i >= 0 && i < 5 && j >= 0 && j < 5) {
        const lx = gx - i * (cell + gap);
        const ly = gy - j * (cell + gap);
        if (lx < cell && ly < cell) {
          const dx = Math.max(r - lx, 0, lx - (cell - r));
          const dy = Math.max(r - ly, 0, ly - (cell - r));
          if (dx * dx + dy * dy <= r * r) col = i === 2 && j === 2 ? ON : OFF;
        }
      }
      px.set(col, (y * size + x) * 3);
    }
  }
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const root = join(import.meta.dirname, '..');
for (const [dir, files] of [
  ['apps/participant/public', [['icon-192.png', 192, 0.2], ['icon-512.png', 512, 0.2], ['apple-touch-icon.png', 180, 0.18]]],
  ['apps/console/public', [['icon-192.png', 192, 0.2]]],
]) {
  for (const [name, size, pad] of files) {
    writeFileSync(join(root, dir, name), icon(size, pad));
    console.log('wrote', join(dir, name));
  }
}
