#!/usr/bin/env node
/**
 * 构建入口：等价于 `tsc -p tsconfig.electron.json && vite build`。
 *
 * 2026-10 中旬的 Windows/Defender 更新后，esbuild 服务在系统 %TEMP% 创建的临时文件
 * 会被安全软件短暂占用，导致删除失败、vite build 报 "remove ...: Access is denied"。
 * 这里在 Windows 上把 TMP/TEMP 重定向到项目内目录规避；macOS/Linux 不受影响。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
if (process.platform === 'win32') {
  const tmp = path.join(root, '.vite-tmp');
  mkdirSync(tmp, { recursive: true });
  env.TMP = tmp;
  env.TEMP = tmp;
}

// tsc 不清理 outDir：先清掉 dist/electron，防止模块移动/删除后留下 stale 产物被打进安装包
// （dist/renderer 由 vite 全量覆盖，无需清理）
rmSync(path.join(root, 'dist', 'electron'), { recursive: true, force: true });

const steps = [
  ['typescript/bin/tsc', ['-p', 'tsconfig.electron.json']],
  ['vite/bin/vite.js', ['build']],
];

for (const [bin, args] of steps) {
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules', bin), ...args], {
    stdio: 'inherit',
    cwd: root,
    env,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}
