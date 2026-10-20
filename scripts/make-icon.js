'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Genera `build/icon.ico`: un anillo rojo neon sobre fondo transparente.
 *
 * Se dibuja a proposito con codigo, no con un editor: el icono tiene que
 * reconstruirse en cualquier maquina sin dependencias extra, y el ICO de
 * Windows necesita varios tamanos (16, 32, 48, 256).
 */

const SIZES = [16, 32, 48, 256];
const OUT = path.join(__dirname, '..', 'build', 'icon.ico');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawRing(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = cx;
  const radius = size * 0.32;
  const thickness = Math.max(1.2, size * 0.075);
  const glow = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const ring = Math.abs(dist - radius);

      const core = Math.max(0, 1 - ring / thickness);
      const halo = Math.exp(-((ring / glow) * (ring / glow)) * 3.2);
      const alpha = Math.min(255, Math.round(255 * Math.max(core, halo * 0.55)));
      if (alpha <= 0) continue;

      const hot = core * core;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(255);
      rgba[i + 1] = Math.round(18 + 70 * hot);
      rgba[i + 2] = Math.round(36 + 50 * hot);
      rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

function encodeIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  const bodies = [];

  for (const png of pngs) {
    const size = png.size;
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    bodies.push(png.data);
    offset += png.data.length;
  }

  return Buffer.concat([header, ...entries, ...bodies]);
}

const pngs = SIZES.map((size) => ({
  size,
  data: encodePng(size, size, drawRing(size)),
}));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodeIco(pngs));
console.log(`icono escrito: ${OUT} (${SIZES.join(', ')} px)`);
