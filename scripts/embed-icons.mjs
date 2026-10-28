/**
 * 把 build/ 下的按钮图标内嵌为 data URL（src/shared/lib/icons.ts）。
 * UI 层（经 vite）与内嵌页注入层（stream-preload，无打包器）共用同一份数据，
 * 避免 stream-preload 在运行时读文件（打包产物不含 build/）以及站点 CSP 限制。
 * 图标更新后重新运行：pnpm run icons:embed
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAP = {
  close: 'close.png',
  volume: 'volume.png',
  mute: 'mute.png',
  favoriteDark: 'favorite_dark.png',
  favoriteLight: 'favorite_light.png',
  refresh: 'refresh.png',
  bilibili: 'bilibili.png',
  tiktok: 'tiktok-light.png',
  star: 'star.png',
  folder: 'folder.png',
  import: 'import.png',
  export: 'export.png',
  edit: 'edit.png',
  delete: 'delete.png',
};

const root = path.join(import.meta.dirname, '..');
const lines = [];
for (const [key, file] of Object.entries(MAP)) {
  const buf = fs.readFileSync(path.join(root, 'build', file));
  lines.push(`  ${key}: 'data:image/png;base64,${buf.toString('base64')}',`);
}

const out = `/* eslint-disable *//* 由 scripts/embed-icons.mjs 生成，请勿手改 */
/** 内嵌图标（data URL）：UI 层与内嵌页注入层共用；黑色图标在样式里反色为白 */
export const ICONS = {
${lines.join('\n')}
} as const;
`;
const target = path.join(root, 'src', 'shared', 'lib', 'icons.ts');
fs.writeFileSync(target, out, 'utf8');
console.log(`[embed-icons] ${Object.keys(MAP).length} 个图标 → ${path.relative(root, target)}`);
