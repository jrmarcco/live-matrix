import { app, BrowserWindow, ipcMain, Menu, session, WebContentsView } from 'electron';
import type { MenuItemConstructorOptions, Session } from 'electron';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { attachEnhancer } from './enhance';
import { detectPlatform, LOGIN_URL, partitionFor, PLATFORM_LABEL, PLATFORMS } from './platforms';
import type { LayoutItem, LoginStatus, Platform, SavedConfig, StreamSlot } from './types';

/** 1 个主窗口槽位 + 最多 7 个副窗口槽位 */
const MAX_STREAMS = 8;

interface StreamEntry {
  view: WebContentsView;
  url: string;
  platform: Platform;
}

let win: BrowserWindow | null = null;
const views = new Map<number, StreamEntry>();
let nextId = 1;

const loginWindows = new Map<Platform, BrowserWindow>();
const loginCheckTimers = new Map<Platform, NodeJS.Timeout>();
const preparedSessions = new Set<Platform>();

/** 拖拽期间置顶的透明覆盖层：接管全部鼠标事件并回传给 UI 层做命中测试 */
let overlayView: WebContentsView | null = null;
let dragging = false;
let overlayFailsafe: NodeJS.Timeout | null = null;

function ensureOverlay(): WebContentsView {
  if (overlayView && !overlayView.webContents.isDestroyed()) return overlayView;
  overlayView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
    },
  });
  overlayView.setBackgroundColor('#00000000');
  overlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  win?.contentView.addChildView(overlayView);
  void overlayView.webContents.loadFile(path.join(__dirname, '../renderer/overlay.html')).catch(() => {});
  return overlayView;
}

function showOverlay(): void {
  if (!win) return;
  const ov = ensureOverlay();
  const [w, h] = win.getContentSize();
  ov.setBounds({ x: 0, y: 0, width: w, height: h });
  dragging = true;
  // 保险：若松开事件因故丢失（覆盖页未就绪等），30s 后强制收起覆盖层并取消拖拽，
  // 避免覆盖层永久置顶吞掉全部点击
  if (overlayFailsafe) clearTimeout(overlayFailsafe);
  overlayFailsafe = setTimeout(() => {
    if (dragging) {
      hideOverlay();
      win?.webContents.send('drag:overlay', { type: 'cancel' });
    }
  }, 30000);
}

function hideOverlay(): void {
  dragging = false;
  if (overlayFailsafe) {
    clearTimeout(overlayFailsafe);
    overlayFailsafe = null;
  }
  overlayView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

function sessionFor(p: Platform): Session {
  const ses = session.fromPartition(partitionFor(p));
  if (!preparedSessions.has(p)) {
    preparedSessions.add(p);
    // 去掉 UA 中的 Electron/App 标识，降低直播站点对内嵌浏览器的风控概率
    const ua = ses
      .getUserAgent()
      .replace(/\s*Electron\/[\d.]+/gi, '')
      .replace(new RegExp(`\\s*${app.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[\\d.]+`, 'i'), '');
    ses.setUserAgent(ua);
    // 观看直播不需要任何设备权限，一律拒绝
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.cookies.on('changed', () => scheduleLoginCheck(p));
  }
  return ses;
}

async function isLoggedIn(p: Platform): Promise<boolean> {
  const ses = session.fromPartition(partitionFor(p));
  const match = (list: Electron.Cookie[], domain: string) =>
    list.some((c) => (c.domain ?? '').endsWith(domain));
  if (p === 'bilibili') {
    return match(await ses.cookies.get({ name: 'SESSDATA' }), 'bilibili.com');
  }
  if (match(await ses.cookies.get({ name: 'sessionid_ss' }), 'douyin.com')) return true;
  return match(await ses.cookies.get({ name: 'sessionid' }), 'douyin.com');
}

async function pushLogin(p: Platform): Promise<void> {
  const loggedIn = await isLoggedIn(p);
  const status: LoginStatus = { platform: p, loggedIn };
  win?.webContents.send('login:status', status);
  // 登录成功后自动关闭登录窗口
  const lw = loginWindows.get(p);
  if (loggedIn && lw && !lw.isDestroyed()) {
    setTimeout(() => {
      if (!lw.isDestroyed()) lw.close();
    }, 1500);
  }
}

function scheduleLoginCheck(p: Platform): void {
  const prev = loginCheckTimers.get(p);
  if (prev) clearTimeout(prev);
  loginCheckTimers.set(p, setTimeout(() => void pushLogin(p), 700));
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig(): SavedConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as SavedConfig;
    if (!raw || !Array.isArray(raw.slots)) return { version: 1, slots: [] };
    const slots = raw.slots
      .filter((s) => s && typeof s.url === 'string')
      .map((s) => ({ url: s.url, platform: detectPlatform(s.url) }))
      .filter((s): s is { url: string; platform: Platform } => s.platform !== null)
      .slice(0, MAX_STREAMS);
    return { version: 1, slots };
  } catch {
    return { version: 1, slots: [] };
  }
}

function addStream(url: string, platform: Platform): StreamSlot | null {
  if (!win || views.size >= MAX_STREAMS) return null;
  const id = nextId++;
  const view = new WebContentsView({ webPreferences: { session: sessionFor(platform) } });
  view.setBackgroundColor('#000000');
  // 初始不可见、静音，等待渲染层上报布局后再定位并按槽位解除静音
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.webContents.setAudioMuted(true);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('page-title-updated', (_e, title) => {
    win?.webContents.send('stream:title', { id, title });
  });
  view.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code !== -3) win?.webContents.send('stream:error', { id, message: `${desc} (${code})` });
  });
  view.webContents.on('render-process-gone', () => {
    removeStream(id);
    win?.webContents.send('stream:dead', { id });
  });
  // 打开后自动进入网页全屏并隐藏非视频元素
  attachEnhancer(view.webContents, platform);
  // index 0：插到子视图栈底，保证拖拽覆盖层始终在最上层
  win.contentView.addChildView(view, 0);
  void view.webContents.loadURL(url).catch(() => {});
  views.set(id, { view, url, platform });
  return { id, url, platform };
}

function removeStream(id: number): void {
  const entry = views.get(id);
  if (!entry) return;
  views.delete(id);
  try {
    win?.contentView.removeChildView(entry.view);
  } catch {
    /* 窗口可能已销毁 */
  }
  try {
    entry.view.webContents.close();
  } catch {
    /* 忽略重复销毁 */
  }
}

function openLogin(p: Platform): void {
  const existing = loginWindows.get(p);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  if (!win) return;
  const lw = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 380,
    minHeight: 520,
    parent: win,
    title: `登录${PLATFORM_LABEL[p]}`,
    backgroundColor: '#ffffff',
    webPreferences: { session: sessionFor(p) },
  });
  loginWindows.set(p, lw);
  lw.on('closed', () => {
    loginWindows.delete(p);
    scheduleLoginCheck(p);
  });
  void lw.loadURL(LOGIN_URL[p]).catch(() => {});
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

function createWindow(): void {
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  // 无边框窗口：工具栏为拖拽区，最小化/最大化/关闭由 UI 内自绘按钮触发（见 IPC win:*）
  // 覆盖层随窗口创建即预加载，保证首次拖拽前事件监听已就绪
  ensureOverlay();

  // 禁止 UI 页面缩放，保证 DOM 坐标与直播视图 bounds 始终一一对应
  win.webContents.on('before-input-event', (e, input) => {
    if ((input.control || input.meta) && ['+', '-', '=', '0'].includes(input.key)) {
      e.preventDefault();
    }
  });

  win.once('ready-to-show', () => {
    // 保持窗口 16:9（标题栏高度不计入比例计算）
    const tbh = Math.max(0, (win?.getBounds().height ?? 0) - (win?.getContentBounds().height ?? 0));
    win?.setAspectRatio(16 / 9, { width: 0, height: tbh });
    win?.show();
    if (process.argv.includes('--lm-smoke')) {
      // 冒烟模式：截图后自动退出，用于 CI 验证可启动与布局
      setTimeout(async () => {
        if (process.env.LM_E2E === '1') {
          try {
            const r = await win?.webContents.executeJavaScript(`(async () => {
              const out = {};
              const modal = document.getElementById('modalBack');
              out.modalInitiallyHidden = modal.classList.contains('hidden');
              document.getElementById('addBtn').click();
              await new Promise((res) => setTimeout(res, 120));
              out.modalOpenAfterClick = !modal.classList.contains('hidden');
              const input = document.getElementById('urlInput');
              input.value = 'https://live.bilibili.com/21452505';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              document.getElementById('addForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              await new Promise((res) => setTimeout(res, 900));
              out.modalClosedAfterSubmit = modal.classList.contains('hidden');
              out.streamCellCount = document.querySelectorAll('.cell[data-id]').length;
              out.subCountText = document.getElementById('subCount').textContent;
              return out;
            })()`);
            console.log('[live-matrix] E2E ' + JSON.stringify(r));
          } catch (err) {
            console.log('[live-matrix] E2E 失败: ' + err);
          }
        }
        try {
          const img = await win?.webContents.capturePage();
          if (img && !img.isEmpty()) {
            fs.writeFileSync('/tmp/lm-smoke.png', img.toPNG());
            console.log('[live-matrix] 冒烟截图: /tmp/lm-smoke.png');
          }
        } catch {
          /* 截图失败不影响退出码 */
        }
        app.quit();
      }, 4000);
    }
  });
  win.on('closed', () => {
    win = null;
    overlayView = null;
    dragging = false;
  });
  const sendMax = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  // UI 渲染进程崩溃时收起覆盖层并重载界面，避免整窗无响应
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[live-matrix] UI 渲染进程异常:', details.reason);
    hideOverlay();
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
  win.on('resize', () => {
    // 拖拽期间窗口尺寸变化时保持覆盖层铺满，渲染层会同时取消本次拖拽
    if (dragging && win) {
      const [w, h] = win.getContentSize();
      overlayView?.setBounds({ x: 0, y: 0, width: w, height: h });
    }
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

function registerIpc(): void {
  ipcMain.on('ui:ready', () => {
    // Map 保持插入顺序，即槽位顺序（第一个为主窗口）
    const slots: StreamSlot[] = [...views.entries()].map(([id, e]) => ({
      id,
      url: e.url,
      platform: e.platform,
    }));
    console.log(`[live-matrix] 渲染层就绪，恢复窗口数: ${slots.length}`);
    void Promise.all(
      PLATFORMS.map(async (p): Promise<LoginStatus> => ({ platform: p, loggedIn: await isLoggedIn(p) })),
    ).then((logins) => win?.webContents.send('app:init', { slots, logins }));
  });

  ipcMain.handle('stream:add', (_e, url: unknown, platform: unknown) => {
    if (typeof url !== 'string' || (platform !== 'bilibili' && platform !== 'douyin')) return null;
    return addStream(url, platform);
  });

  ipcMain.on('stream:close', (_e, id: unknown) => {
    if (typeof id === 'number') removeStream(id);
  });

  ipcMain.on('layout:update', (_e, items: unknown) => {
    if (!(win && Array.isArray(items))) return;
    for (const it of items as LayoutItem[]) {
      const entry = views.get(it?.id);
      if (!entry || !it?.rect) continue;
      const { x, y, width, height } = it.rect;
      if (![x, y, width, height].every(Number.isFinite)) continue;
      entry.view.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
      });
      // 核心规则：只有主窗口槽位有声，副窗口一律静音
      entry.view.webContents.setAudioMuted(!it.isMain);
    }
  });

  ipcMain.on('win:min', () => win?.minimize());
  ipcMain.on('win:max', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', () => win?.close());

  ipcMain.on('drag:begin', () => showOverlay());
  ipcMain.on('drag:end', () => hideOverlay());

  // 覆盖层页面转发的拖拽事件，中继给 UI 渲染层
  ipcMain.on('ov:event', (_e, v: unknown) => {
    if (
      win &&
      v &&
      typeof v === 'object' &&
      typeof (v as { type?: unknown }).type === 'string'
    ) {
      win.webContents.send('drag:overlay', v);
    }
  });

  ipcMain.on('config:save', (_e, cfg: unknown) => {
    try {
      const c = cfg as SavedConfig;
      if (!c || !Array.isArray(c.slots)) return;
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8');
    } catch (err) {
      console.error('[live-matrix] 保存配置失败:', err);
    }
  });

  ipcMain.on('login:open', (_e, p: unknown) => {
    if (p === 'bilibili' || p === 'douyin') openLogin(p);
  });

  ipcMain.handle('login:logout', async (_e, p: unknown) => {
    if (p !== 'bilibili' && p !== 'douyin') return false;
    const lw = loginWindows.get(p);
    if (lw && !lw.isDestroyed()) lw.destroy();
    loginWindows.delete(p);
    await session.fromPartition(partitionFor(p)).clearStorageData();
    await pushLogin(p);
    return true;
  });

  ipcMain.handle('login:check', (_e, p: unknown) => {
    if (p !== 'bilibili' && p !== 'douyin') return false;
    return isLoggedIn(p);
  });
}

/** 极简菜单：仅保留编辑能力（macOS 上维持 Cmd+C/V 等快捷键），无边框下不显示菜单栏 */
function installMenu(): void {
  const edit: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([edit]));
}

function bootstrap(): void {
  registerIpc();
  app.whenReady().then(() => {
    installMenu();
    const cfg = loadConfig();
    createWindow();
    for (const s of cfg.slots) addStream(s.url, s.platform);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  bootstrap();
}
