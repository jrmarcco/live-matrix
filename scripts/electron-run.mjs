#!/usr/bin/env node
/**
 * Electron 启动包装（Windows 安全策略绕过）。
 *
 * 2026-10 中旬的 Windows/Defender 更新后，本机会静默终止「从用户可写目录启动的
 * 未签名 Electron 二进制」（进程在执行应用代码前即退出，退出码 3/0x80000003，
 * 无任何拦截日志），Program Files 与已签名应用不受影响。
 *
 * 因此把 node_modules/electron/dist 同步一份到 C:\Program Files\lm-electron
 * （运行 `pnpm run sync-electron`），再通过官方环境变量 ELECTRON_OVERRIDE_DIST_PATH
 * 指向该副本运行。非 Windows 平台、或副本不存在时按原方式直跑，行为不受影响。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', 'electron', 'cli.js');
const overrideDir = 'C:\\Program Files\\lm-electron';

const readVersion = (p) => {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
};

const env = { ...process.env };
if (process.platform === 'win32') {
  const localVersion = readVersion(path.join(root, 'node_modules', 'electron', 'dist', 'version'));
  const overrideExe = path.join(overrideDir, 'electron.exe');
  if (existsSync(overrideExe)) {
    const overrideVersion = readVersion(path.join(overrideDir, 'version'));
    if (localVersion && overrideVersion && localVersion !== overrideVersion) {
      console.error(
        `[electron-run] 受信任目录中的 Electron 副本（${overrideVersion}）与项目依赖（${localVersion}）版本不一致，` +
          '请先运行: pnpm run sync-electron',
      );
      process.exit(1);
    }
    env.ELECTRON_OVERRIDE_DIST_PATH = overrideDir;
  } else if (localVersion) {
    console.warn(
      '[electron-run] 未找到受信任目录副本 C:\\Program Files\\lm-electron，' +
        '若 Electron 启动即退出（退出码 3），请以管理员身份运行: pnpm run sync-electron',
    );
  }
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (process.platform === 'win32' && child.pid) {
      // Windows 下向整棵进程树下发终止，避免残留 GPU/渲染子进程
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      child.kill(sig);
    }
  });
}
child.on('exit', (code, signal) => {
  if (signal && process.platform !== 'win32') {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
