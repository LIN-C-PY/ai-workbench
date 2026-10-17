/**
 * 生成 assets/aiworkbench.ico（桌面快捷方式用的图标）。
 * 纯手写 ICO：多尺寸 32bpp DIB，自带抗锯齿（4x 超采样后降采样）。
 *   node tools/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'assets', 'aiworkbench.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 超采样倍数

const BG_TOP = [0x1e, 0x24, 0x3c];
const BG_BOTTOM = [0x0d, 0x0f, 0x16];
const BORDER = [0x4c, 0x5c, 0x92];
const LINE = [0x93, 0xb2, 0xff];
const GLOW = [0x4a, 0x6b, 0xd8];

// 归一化坐标：一条「脉冲」折线
const POINTS = [
  [0.13, 0.55],
  [0.34, 0.55],
  [0.42, 0.29],
  [0.55, 0.79],
  [0.63, 0.55],
  [0.88, 0.55]
];

const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-6;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
};

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t)
];

/** 画一张 size×size 的 RGBA 图（返回 [r,g,b,a] 数组的扁平 Uint8Array） */
function renderRGBA(size) {
  const big = size * SS;
  const buf = new Uint8Array(size * size * 4);
  const radius = big * 0.22;
  const stroke = Math.max(big * 0.085, 1.4 * SS);
  const glowWidth = stroke * 2.6;
  const borderW = Math.max(big * 0.018, 1.1 * SS);
  const pts = POINTS.map(([x, y]) => [x * big, y * big]);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          // 圆角矩形内部判定
          const cx = Math.min(Math.max(px, radius), big - radius);
          const cy = Math.min(Math.max(py, radius), big - radius);
          const d = Math.hypot(px - cx, py - cy);
          if (d > radius) continue;

          // 背景渐变
          let color = mix(BG_TOP, BG_BOTTOM, py / big);
          // 描边
          if (d > radius - borderW) color = mix(color, BORDER, 0.85);

          // 折线
          let dist = Infinity;
          for (let i = 0; i < pts.length - 1; i += 1) {
            const dd = distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (dd < dist) dist = dd;
          }
          if (dist < glowWidth / 2) color = mix(color, GLOW, 0.32 * (1 - dist / (glowWidth / 2)));
          if (dist < stroke / 2) color = mix(color, LINE, Math.min(1, (stroke / 2 - dist) / (SS * 0.9) + 0.35));

          r += color[0];
          g += color[1];
          b += color[2];
          a += 255;
        }
      }

      const total = SS * SS;
      const idx = (y * size + x) * 4;
      buf[idx] = Math.round(r / total);
      buf[idx + 1] = Math.round(g / total);
      buf[idx + 2] = Math.round(b / total);
      buf[idx + 3] = Math.round(a / total);
    }
  }
  return buf;
}

/** RGBA → ICO 里的 DIB（BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码） */
function toDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 两张图
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = size - 1 - y; // 自下而上
    for (let x = 0; x < size; x += 1) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }

  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);

  return Buffer.concat([header, xor, mask]);
}

const images = SIZES.map((size) => {
  const rgba = renderRGBA(size);
  return { size, dib: toDib(rgba, size) };
});

const dir = Buffer.alloc(6 + images.length * 16);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(images.length, 4);

let offset = dir.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  dir.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
  dir.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
  dir.writeUInt8(0, entry + 2);
  dir.writeUInt8(0, entry + 3);
  dir.writeUInt16LE(1, entry + 4);
  dir.writeUInt16LE(32, entry + 6);
  dir.writeUInt32LE(image.dib.length, entry + 8);
  dir.writeUInt32LE(offset, entry + 12);
  offset += image.dib.length;
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([dir, ...images.map((i) => i.dib)]));
console.log(`已生成 ${OUT}`);
console.log(`尺寸：${SIZES.join(', ')}  共 ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);

/* ---------- 顺手导出一张预览图，方便确认效果 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  );
}

const previewFile = path.join(ROOT, 'assets', 'icon-preview.png');
writePng(previewFile, renderRGBA(256), 256);
console.log(`预览图：${previewFile}`);
