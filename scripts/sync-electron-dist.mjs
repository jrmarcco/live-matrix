#!/usr/bin/env node
/**
 * 把 node_modules/electron/dist 同步到 C:\Program Files\lm-electron（Windows 专用）。
 * 需要管理员权限，会触发 UAC 提权；执行后 electron-run.mjs 会自动改用该副本。
 * 升级 electron 依赖版本后需要重新运行本脚本。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'electron', 'dist');
const dst = 'C:\\Program Files\\lm-electron';

if (process.platform !== 'win32') {
  console.log('非 Windows 平台无需同步，跳过。');
  process.exit(0);
}

const version = readFileSync(path.join(src, 'version'), 'utf8').trim();
console.log(`同步 Electron ${version}: ${src} -> ${dst}（需要管理员权限）...`);

const ps1 = path.join(root, '.tmp-sync-electron.ps1');
writeFileSync(
  ps1,
  [
    "$ErrorActionPreference = 'Stop'",
    `New-Item -ItemType Directory -Force -Path '${dst}' | Out-Null`,
    `Copy-Item '${src}\\*' '${dst}' -Recurse -Force`,
  ].join('\r\n'),
  'utf8',
);

try {
  const elevated = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1.replace(/'/g, "''")}'`,
    ],
    { stdio: 'inherit' },
  );
  if (elevated.status !== 0) {
    console.error('提权执行失败（可能拒绝了 UAC 或被组策略阻止）。');
    process.exit(1);
  }
} finally {
  try {
    unlinkSync(ps1);
  } catch {}
}

const synced = readFileSync(path.join(dst, 'version'), 'utf8').trim();
if (synced === version) {
  console.log(`完成：${dst} 现为 Electron ${version}。`);
} else {
  console.error(`校验失败：目标目录版本为 ${synced || '(空)'}，期望 ${version}。`);
  process.exit(1);
}
