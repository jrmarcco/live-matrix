import { BrowserWindow, screen } from 'electron';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { runSmokeSequence } from './e2e/probe';
import { closeAllLoginWindows } from './login';

/* ---------------- 主窗口装配（无边框 + 16:9 约束 + CDN header 注入 + 冒烟挂钩） ---------------- */

let win: BrowserWindow | null = null;

export function getWin(): BrowserWindow | null {
  return win;
}

function waitForDevServer(url: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tryOnce = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`dev server 超时: ${url}`));
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else setTimeout(tryOnce, 400);
      });
      req.on('error', () => setTimeout(tryOnce, 400));
    };
    tryOnce();
  });
}

export function createWindow(): void {
  // 开发模式下给窗口/任务栏提供图标（打包后由 exe 内嵌图标接管）；打包产物不含 build/，需判存在
  const icoPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  const icon = fs.existsSync(icoPath) ? icoPath : undefined;
  win = new BrowserWindow({
    // 16:9 内容区；4×4 网格下每个窗口（主 3×3 / 副 1×1）都接近 16:9
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0a0c10',
    title: 'LiveMatrix — 同屏多直播',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  // 无边框窗口：工具栏为拖拽区，最小化/最大化/关闭由 UI 内自绘按钮触发（见 IPC win:*）
  // 直连拉流的 CDN 校验（B站实测无 Referer 返回 403）：为 UI 会话中的拉流请求注入
  // 对应平台的 Referer 与浏览器 UA（hls.js / mpegts.js 的请求都走 UI 页面会话）
  const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  win.webContents.session.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.bilivideo.com/*',
        '*://*.bilivideo.cn/*',
        '*://*.akamaized.net/*',
        '*://*.douyincdn.com/*',
        '*://*.douyinliving.com/*',
        '*://*.bytecdn.cn/*',
        '*://*.smtcdns.net/*',
      ],
    },
    (details, callback) => {
      if (/(^|\.)bilivideo\.(com|cn)$|(^|\.)akamaized\.net$/.test(new URL(details.url).hostname)) {
        details.requestHeaders['Referer'] = 'https://live.bilibili.com/';
      } else {
        details.requestHeaders['Referer'] = 'https://live.douyin.com/';
      }
      details.requestHeaders['User-Agent'] = BROWSER_UA;
      callback({ requestHeaders: details.requestHeaders });
    },
  );
  // 调试：把 UI 渲染层 console 转发到主进程 stdout（诊断用）
  win.webContents.on('console-message', (e) => {
    console.log(`[ui] ${e.message}`);
  });
  // 禁止 UI 页面缩放，保证 DOM 坐标与直播视图 bounds 始终一一对应
  win.webContents.on('before-input-event', (e, input) => {
    if ((input.control || input.meta) && ['+', '-', '=', '0'].includes(input.key)) {
      e.preventDefault();
    }
  });

  // 保持窗口 16:9（标题栏高度不计入比例计算）。
  // macOS 的最大化（zoom）会遵守该约束导致横向铺满但纵向留空，
  // 因此最大化期间临时解除约束、还原时重新套用（见下方 maximize/unmaximize 处理）
  const applyAspect16x9 = () => {
    if (!win || win.isDestroyed()) return;
    const tbh = Math.max(0, win.getBounds().height - win.getContentBounds().height);
    win.setAspectRatio(16 / 9, { width: 0, height: tbh });
  };
  win.once('ready-to-show', () => {
    applyAspect16x9();
    win?.show();
    if (process.argv.includes('--lm-smoke')) {
      // 冒烟模式：截图后自动退出，用于 CI 验证可启动与布局
      const smokeMs = Math.max(4000, Number(process.env.LM_SMOKE_MS) || 4000);
      setTimeout(() => {
        const w = getWin();
        if (w) void runSmokeSequence(w);
      }, smokeMs);
    }
  });
  win.on('closed', () => {
    win = null;
    // 主窗口已关：登录子窗口一并带走，否则 window-all-closed 会等它们而进程驻留
    closeAllLoginWindows();
  });
  const sendMax = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  // macOS：zoom 会按 16:9 约束计算目标尺寸，纵向铺不满——
  // 最大化时解除约束，若已被约束成非全尺寸则补齐到工作区；还原时恢复 16:9。
  // Windows 的最大化本就不受 aspect 约束，保持原行为。
  win.on('maximize', () => {
    if (process.platform === 'darwin' && win && !win.isDestroyed()) {
      win.setAspectRatio(0);
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      const b = win.getBounds();
      if (
        Math.abs(b.x - wa.x) > 1 ||
        Math.abs(b.y - wa.y) > 1 ||
        Math.abs(b.width - wa.width) > 1 ||
        Math.abs(b.height - wa.height) > 1
      ) {
        win.setBounds(wa);
      }
    }
    sendMax();
  });
  win.on('unmaximize', () => {
    if (process.platform === 'darwin') applyAspect16x9();
    sendMax();
  });
  // UI 渲染进程崩溃时重载界面，避免整窗无响应
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[live-matrix] UI 渲染进程异常:', details.reason);
    if (win && !win.isDestroyed()) win.webContents.reload();
  });

  const devUrl = process.env.LM_DEV ? 'http://localhost:5173/' : null;
  const indexFile = path.join(__dirname, '../renderer/index.html');
  if (devUrl) {
    waitForDevServer(devUrl)
      .then(() => win?.loadURL(devUrl))
      .catch(() => win?.loadFile(indexFile));
  } else {
    void win.loadFile(indexFile);
  }
}
