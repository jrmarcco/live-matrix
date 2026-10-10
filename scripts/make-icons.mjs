/**
 * 从 build/icon.jpg 生成全套应用图标：
 *   build/icon.png  — 1024×1024 PNG（Linux / 通用兜底，electron-builder 也可用它自动转换）
 *   build/icon.ico  — 多尺寸 ICO（16/24/32/48/64/128/256，PNG 内嵌格式，Vista+ 通用）
 *   build/icon.icns — macOS 图标集（ic07~ic10：128/256/512/1024）
 *
 * 用法：pnpm run icons   （依赖 sharp，仅开发期使用）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'build', 'icon.jpg');
const OUT = path.join(ROOT, 'build');

function pngBuffer(size) {
  return sharp(SRC).resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
}

async function buildIco() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map(pngBuffer));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const e = 16 * i;
    entries.writeUInt8(s >= 256 ? 0 : s, e); // 宽（256 用 0 表示）
    entries.writeUInt8(s >= 256 ? 0 : s, e + 1); // 高
    entries.writeUInt8(0, e + 2); // 调色板数
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // planes
    entries.writeUInt16LE(32, e + 6); // bpp
    entries.writeUInt32LE(pngs[i].length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  await writeFile(path.join(OUT, 'icon.ico'), Buffer.concat([header, entries, ...pngs]));
}

async function buildIcns() {
  const spec = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const pngs = await Promise.all(spec.map(([, s]) => pngBuffer(s)));
  let total = 8;
  for (const p of pngs) total += 8 + p.length;
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);
  const parts = [];
  spec.forEach(([type], i) => {
    const e = Buffer.alloc(8);
    e.write(type, 0, 'ascii');
    e.writeUInt32BE(8 + pngs[i].length, 4);
    parts.push(e, pngs[i]);
  });
  await writeFile(path.join(OUT, 'icon.icns'), Buffer.concat([header, ...parts]));
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'icon.png'), await pngBuffer(1024));
await buildIco();
await buildIcns();
console.log('[make-icons] build/icon.png · build/icon.ico · build/icon.icns 已生成');
