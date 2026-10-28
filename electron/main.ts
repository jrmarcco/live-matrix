import { app, BrowserWindow, ipcMain, Menu, screen, session, WebContentsView } from 'electron';
import type { MenuItemConstructorOptions, Session } from 'electron';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { resolveBiliLive } from './bilibili';
import { sniffDouyinLive } from './douyin';
import { attachEnhancer } from './enhance';
import { LOGIN_URL, detectLiveRoom, partitionFor, PLATFORM_LABEL, PLATFORMS } from '../src/shared/lib/platforms';
import { OfflineError } from './types';
import type {
  Favorite,
  FavoriteSaveRequest,
  LayoutItem,
  LoginStatus,
  Platform,
  StreamSlot,
  StreamMedia,
  ViewRect,
  VolumeState,
} from '../src/shared/types/ipc';

/** 1 个主窗口槽位 + 最多 7 个副窗口槽位 */
const MAX_STREAMS = 8;

interface StreamEntry {
  view: WebContentsView;
  url: string;
  platform: Platform;
}

let win: BrowserWindow | null = null;
/** 内嵌页面模式的直播（抖音 / B站直连失败回退） */
const views = new Map<number, StreamEntry>();
/** 直连播放模式的直播（B站 API 解析 / 抖音页面嗅探）：记录原地址以便流过期后重新解析 */
const videoSlots = new Map<number, { url: string; platform: Platform; media: StreamMedia }>();
/** 未开播的直播间（纯 UI 占位格，不加载页面）：记录原地址以便刷新重试 */
const offlineSlots = new Map<number, { url: string; platform: Platform }>();
/** 当前处于主窗口槽位的内嵌视图 id（主槽位是直连视频格或无直播时为 null） */
let mainViewId: number | null = null;
let nextId = 1;

const loginWindows = new Map<Platform, BrowserWindow>();
const loginCheckTimers = new Map<Platform, NodeJS.Timeout>();
const preparedSessions = new Set<Platform>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('请求超时')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 对话框打开期间隐藏直播视图：WebContentsView 层级永远高于 UI 页面 DOM，
 *  不隐藏的话地址输入对话框会被直播画面盖住 */
let modalVisible = false;
/** 最近一次 layout:update 上报的各视图矩形，对话框关闭后据此恢复 */
const lastRects = new Map<number, ViewRect>();

function applyModalVisibility(v: boolean): void {
  modalVisible = v;
  if (!win) return;
  for (const [id, entry] of views) {
    if (v) {
      entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } else {
      const r = lastRects.get(id);
      if (r) entry.view.setBounds(r);
    }
  }
  console.log(`[live-matrix] 对话框${v ? '打开，隐藏' : '关闭，恢复'} ${views.size} 个直播视图`);
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

/** 判断 cookie 列表中是否存在指定域名后缀的 cookie */
function matchDomain(list: Electron.Cookie[], domain: string): boolean {
  return list.some((c) => (c.domain ?? '').endsWith(domain));
}

async function isLoggedIn(p: Platform): Promise<boolean> {
  const ses = session.fromPartition(partitionFor(p));
  if (p === 'bilibili') {
    return matchDomain(await ses.cookies.get({ name: 'SESSDATA' }), 'bilibili.com');
  }
  if (matchDomain(await ses.cookies.get({ name: 'sessionid_ss' }), 'douyin.com')) return true;
  return matchDomain(await ses.cookies.get({ name: 'sessionid' }), 'douyin.com');
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
  loginCheckTimers.set(
    p,
    setTimeout(() => void pushLogin(p), 700),
  );
}

function addViewStream(url: string, platform: Platform): StreamSlot | null {
  if (!win) return null;
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      session: sessionFor(platform),
      // 注入双击拦截：双击直播画面 = 副窗口与主窗口互换 / 主窗口铺满
      preload: path.join(__dirname, 'stream-preload.js'),
      contextIsolation: true,
    },
  });
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
  view.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[live-matrix] 直播视图 ${id} 渲染进程退出: ${details.reason}`);
    removeStream(id);
    win?.webContents.send('stream:dead', { id });
  });
  // 打开后自动进入网页全屏并隐藏非视频元素
  attachEnhancer(view.webContents, platform);
  // index 0：插到子视图栈底，保证 UI 层之上按槽位叠放
  win.contentView.addChildView(view, 0);
  void view.webContents.loadURL(url).catch(() => {});
  views.set(id, { view, url, platform });
  return { id, url, platform, kind: 'view' };
}

/**
 * B站走 API 直连、抖音走页面嗅探直连；未开播落「未开播」占位格（不回退内嵌
 * 页面——未开播页面的轮播视频/浮层会盖住注入的控制按钮，导致窗口关不掉）；
 * 其余解析失败（风控/接口变动）回退内嵌页面。
 */
async function addStream(url: string, platform: Platform): Promise<StreamSlot | null> {
  if (!win || views.size + videoSlots.size + offlineSlots.size >= MAX_STREAMS) return null;
  try {
    let media: StreamMedia;
    if (platform === 'bilibili') {
      media = await withTimeout(resolveBiliLive(url, sessionFor('bilibili')), 8000);
    } else {
      media = await withTimeout(sniffDouyinLive(url, sessionFor('douyin'), win), 20000);
    }
    const id = nextId++;
    videoSlots.set(id, { url, platform, media });
    console.log(
      `[live-matrix] ${platform === 'bilibili' ? 'B站直连' : '抖音嗅探直连'}: 房间${media.roomId ?? url} qn=${media.qn ?? '-'} ${media.format}`,
    );
    return { id, url, platform, kind: 'video', media, title: media.title };
  } catch (err) {
    if (err instanceof OfflineError) {
      const id = nextId++;
      offlineSlots.set(id, { url, platform });
      console.log(`[live-matrix] ${platform} 未开播，落占位格: ${url}`);
      return { id, url, platform, kind: 'offline' };
    }
    console.warn(`[live-matrix] ${platform} 直连解析失败，回退页面模式: ${String(err)}`);
  }
  return addViewStream(url, platform);
}

function removeStream(id: number): void {
  if (mainViewId === id) mainViewId = null;
  const entry = views.get(id);
  if (entry) {
    views.delete(id);
    lastRects.delete(id);
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
    return;
  }
  videoSlots.delete(id);
  offlineSlots.delete(id);
}

/* ---------------- 收藏夹（跨启动持久化，与窗口会话无关） ---------------- */

function favoritesPath(): string {
  return path.join(app.getPath('userData'), 'favorites.json');
}

let favoritesCache: Favorite[] | null = null;

function getFavorites(): Favorite[] {
  if (!favoritesCache) {
    favoritesCache = [];
    try {
      const raw = JSON.parse(fs.readFileSync(favoritesPath(), 'utf8')) as { items?: Favorite[] };
      if (Array.isArray(raw.items)) {
        favoritesCache = raw.items.filter((f) => f && typeof f.url === 'string' && typeof f.alias === 'string');
      }
    } catch {
      /* 文件不存在或损坏则从空列表开始 */
    }
  }
  return favoritesCache;
}

function saveFavorites(): void {
  try {
    fs.mkdirSync(path.dirname(favoritesPath()), { recursive: true });
    fs.writeFileSync(favoritesPath(), JSON.stringify({ version: 1, items: getFavorites() }, null, 2), 'utf8');
  } catch (err) {
    console.error('[live-matrix] 保存收藏失败:', err);
  }
}

function pushFavorites(): void {
  win?.webContents.send('favorites:update', { items: getFavorites() });
}

/* ---------------- 主窗口音量（跨启动持久化） ---------------- */

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

const settings: VolumeState = { volume: 1, muted: false };
try {
  const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<VolumeState>;
  if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) {
    settings.volume = Math.min(1, Math.max(0, raw.volume));
  }
  if (typeof raw.muted === 'boolean') settings.muted = raw.muted;
} catch {
  /* 文件不存在或损坏则用默认值 */
}

let saveSettingsTimer: NodeJS.Timeout | null = null;

function writeSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[live-matrix] 保存设置失败:', err);
  }
}

/** 滑杆拖动会高频触发，防抖后再落盘 */
function persistSettings(): void {
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    writeSettings();
  }, 500);
}

/**
 * 音量状态唯一入口：主进程持有并持久化；主槽位是内嵌视图时下发给页内控件
 * （音量作用于页内媒体元素，静音走 setAudioMuted）。notifyUi 用于内嵌页控件
 * 发起的变更——UI 层的直连格控件与其 <video> 需要同步。
 */
function setVolumeState(volume: number, muted: boolean, notifyUi: boolean): void {
  settings.volume = Math.min(1, Math.max(0, volume));
  settings.muted = muted;
  persistSettings();
  if (mainViewId == null) {
    if (notifyUi) win?.webContents.send('volume:changed', { ...settings });
    return;
  }
  const entry = views.get(mainViewId);
  if (entry && !entry.view.webContents.isDestroyed()) {
    entry.view.webContents.send('lm-volume', { ...settings });
    // 主槽位视图本就不静音（!isMain = false），这里只叠加用户的静音开关
    entry.view.webContents.setAudioMuted(settings.muted);
  }
  if (notifyUi) win?.webContents.send('volume:changed', { ...settings });
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
      setTimeout(async () => {
        if (process.env.LM_E2E === '1') {
          try {
            const r = await win?.webContents.executeJavaScript(`(async () => {
              const out = {};
              const modal = document.getElementById('modalBack');
              out.modalInitiallyHidden = modal.classList.contains('hidden');
              // 普通网页地址（bilibili 主页）：提交后应停留在对话框并给出友好提示，
              // 不会关闭对话框去打开原始页面
              document.querySelector('.placeholder').click();
              await new Promise((res) => setTimeout(res, 150));
              const badInput = document.getElementById('urlInput');
              badInput.value = 'https://www.bilibili.com/';
              badInput.dispatchEvent(new Event('input', { bubbles: true }));
              document.getElementById('addForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              await new Promise((res) => setTimeout(res, 200));
              out.webpageRejected = !modal.classList.contains('hidden');
              out.webpageErr = document.getElementById('addErr').textContent;
              document.getElementById('cancelBtn').click();
              await new Promise((res) => setTimeout(res, 150));
              const urls = [
                'https://live.bilibili.com/1986380859', // 直播中 → B站 API 直连
                'https://live.douyin.com/531854687617', // 抖音未开播（女流66）→ 捕获 enter 响应判定 → 未开播占位格
                'https://live.bilibili.com/21452505', // 未开播 → 未开播占位格
              ];
              for (const u of urls) {
                document.querySelector('.placeholder').click();
                await new Promise((res) => setTimeout(res, 150));
                const input = document.getElementById('urlInput');
                input.value = u;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('addForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                await new Promise((res) => setTimeout(res, 700));
              }
              // 确认后对话框应立即关闭（问题1场景），加载格立即出现
              out.modalClosedImmediately = modal.classList.contains('hidden');
              out.pendingShownDuringAdd = !!document.querySelector('.cell.pending');
              // 抖音解析最长约 15s：等全部格子就位（pending 格会被真实格替换）再断言
              for (let i = 0; i < 44 && document.querySelectorAll('.cell[data-id]:not(.pending)').length < urls.length; i++) {
                await new Promise((res) => setTimeout(res, 500));
              }
              out.streamCellCount = document.querySelectorAll('.cell[data-id]').length;
              out.offlineCellCount = document.querySelectorAll('.cell.kind-offline').length;
              out.pendingLeftAfterSettle = document.querySelectorAll('.cell.pending').length;
              out.videoCellCount = document.querySelectorAll('.cell[data-id] video').length;
              const dyChip = document.querySelector('.chip.douyin');
              out.douyinLoginClass = dyChip ? dyChip.className : 'none';
              // 播放中再次打开对话框（问题1场景）
              document.querySelector('.placeholder').click();
              await new Promise((res) => setTimeout(res, 300));
              out.modalOpenWithStreams = !modal.classList.contains('hidden');
              document.getElementById('cancelBtn').click();
              await new Promise((res) => setTimeout(res, 300));
              out.modalClosedAfterCancel = modal.classList.contains('hidden');
              // 双击副窗口 → 与主窗口互换
              const cellIds = () => [...document.querySelectorAll('.cell[data-id]')].map((c) => c.dataset.id);
              const beforeSwap = cellIds();
              const dbl = () => document.querySelector('.cell[data-id]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
              if (beforeSwap.length >= 2) {
                document.querySelectorAll('.cell[data-id]')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                await new Promise((res) => setTimeout(res, 600));
                out.orderAfterSubDblClick = cellIds();
                // 双击主窗口 → 铺满；再次双击 → 还原
                dbl();
                await new Promise((res) => setTimeout(res, 600));
                out.focusOn = document.getElementById('stage').classList.contains('focus');
                dbl();
                await new Promise((res) => setTimeout(res, 600));
                out.focusOff = !document.getElementById('stage').classList.contains('focus');
                out.orderAfterAll = cellIds();
              }
              // E2E 直接跑在真实用户数据上：先快照收藏夹，结束后完整还原
              // （收藏测试按 url 去重保存，可能覆盖用户已有条目的别名）
              const favSnapshot = await window.lm.getFavorites();
              // 收藏流程：星标 → 输入别名 → 面板列表 → 点击添加
              const favBtnCell = document.querySelector('.cell[data-id] .cell-fav');
              if (favBtnCell) {
                favBtnCell.click();
                await new Promise((res) => setTimeout(res, 250));
                out.favModalShown = !document.getElementById('favBack').classList.contains('hidden');
                const ai = document.getElementById('favAlias');
                ai.value = 'E2E收藏';
                document.getElementById('favForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                await new Promise((res) => setTimeout(res, 500));
                // 记录本次写入的条目，测试末尾按 url 移除（save 按 url 去重，
                // 可能覆盖同名旧条目，按 url 删除才准确）
                out.favSavedUrl = (await window.lm.getFavorites()).find((f) => f.alias === 'E2E收藏')?.url ?? null;
                document.getElementById('favBtn').click();
                await new Promise((res) => setTimeout(res, 300));
                out.favPanelShown = !document.getElementById('favWrap').classList.contains('hidden');
                out.favItemCount = document.querySelectorAll('.fav-item').length;
                const before = document.querySelectorAll('.cell[data-id]').length;
                const first = document.querySelector('.fav-item');
                if (first) {
                  first.click();
                  await new Promise((res) => setTimeout(res, 4000)); // B站直连约 1-2s
                  out.cellCountAfterFavAdd = document.querySelectorAll('.cell[data-id]').length - before;
                  out.favPanelClosedAfterAdd = document.getElementById('favWrap').classList.contains('hidden');
                }
                document.getElementById('favClose').click();
                await new Promise((res) => setTimeout(res, 200));
              }
              // 收藏拖动排序（合成 DragEvent）：把「拖拽A」拖到「拖拽C」之后，应变为 B,C,A
              const favItemByAlias = (a) => [...document.querySelectorAll('.fav-item')]
                .find((it) => it.querySelector('.alias').textContent === a);
              const favAliases = () => [...document.querySelectorAll('.fav-item .alias')].map((e2) => e2.textContent);
              const dragFavs = [
                { url: 'https://live.bilibili.com/9001', platform: 'bilibili', alias: '拖拽A' },
                { url: 'https://live.bilibili.com/9002', platform: 'bilibili', alias: '拖拽B' },
                { url: 'https://live.douyin.com/9003', platform: 'douyin', alias: '拖拽C' },
              ];
              for (const saved of await window.lm.getFavorites()) {
                if (dragFavs.some((d) => d.url === saved.url)) window.lm.removeFavorite(saved.url);
              }
              await new Promise((res) => setTimeout(res, 250));
              for (const f of dragFavs) window.lm.saveFavorite(f);
              await new Promise((res) => setTimeout(res, 400));
              document.getElementById('favBtn').click();
              await new Promise((res) => setTimeout(res, 250));
              const sub3 = (list) => ['拖拽A', '拖拽B', '拖拽C'].map((a) => list.indexOf(a));
              out.favOrderBeforeDrag = sub3(favAliases());
              const itemA = favItemByAlias('拖拽A');
              const itemC = favItemByAlias('拖拽C');
              const dt = new DataTransfer();
              itemA.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
              const rc = itemC.getBoundingClientRect();
              itemC.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, clientX: rc.left + 5, clientY: rc.bottom - 2, dataTransfer: dt,
              }));
              itemA.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
              await new Promise((res) => setTimeout(res, 400));
              out.favOrderAfterDrag = sub3(favAliases());
              out.favOrderPersisted = sub3((await window.lm.getFavorites()).map((f) => f.alias));
              for (const f of dragFavs) window.lm.removeFavorite(f.url);
              document.getElementById('favClose').click();
              await new Promise((res) => setTimeout(res, 250));
              // 直连格右下角刷新按钮：点击后应显示「刷新中…」并触发重新解析
              const vCell = document.querySelector('.cell.kind-video[data-id]');
              const rBtn = vCell ? vCell.querySelector('.cell-refresh') : null;
              out.videoRefreshBtn = !!rBtn;
              if (rBtn) {
                rBtn.click();
                await new Promise((res) => setTimeout(res, 120));
                out.videoRefreshState = vCell.querySelector('.v-state').textContent;
              }
              // 未开播格刷新按钮：点击后显示「检测中…」，探测完成回到「仍未开播」
              //（主播已开播时该格会被替换为直连格，原元素从 DOM 脱离）
              const oCell = document.querySelector('.cell.kind-offline[data-id]');
              const oBtn = oCell ? oCell.querySelector('.cell-refresh') : null;
              out.offlineRefreshBtn = !!oBtn;
              if (oBtn) {
                oBtn.click();
                await new Promise((res) => setTimeout(res, 150));
                out.offlineHintDuringCheck = oCell.querySelector('.cell-offline .txt').textContent;
                for (let i = 0; i < 20 && oCell.isConnected
                  && oCell.querySelector('.cell-offline .txt').textContent === '检测中…'; i++) {
                  await new Promise((res) => setTimeout(res, 500));
                }
                out.offlineHintAfterCheck = oCell.isConnected
                  ? oCell.querySelector('.cell-offline .txt').textContent
                  : '已开播升级为直连格';
              }
              // 还原收藏夹到快照状态：删除 E2E 新增、恢复被测试覆盖的
              // 别名/条目，并按快照顺序重排（对用户数据零副作用）
              const favNow = await window.lm.getFavorites();
              for (const f of favNow) {
                if (!favSnapshot.some((s) => s.url === f.url)) window.lm.removeFavorite(f.url);
              }
              for (const s of favSnapshot) {
                const c = (await window.lm.getFavorites()).find((f) => f.url === s.url);
                if (!c || c.alias !== s.alias || c.platform !== s.platform) window.lm.saveFavorite(s);
              }
              await new Promise((res) => setTimeout(res, 250));
              window.lm.reorderFavorites(favSnapshot.map((s) => s.url));
              await new Promise((res) => setTimeout(res, 250));
              out.favoritesRestored =
                JSON.stringify(await window.lm.getFavorites()) === JSON.stringify(favSnapshot);
              return out;
            })()`);
            console.log('[live-matrix] E2E ' + JSON.stringify(r));
          } catch (err) {
            console.log('[live-matrix] E2E 失败: ' + err);
          }
        }
        // 主进程侧最终视图位置（应回到网格布局：主窗口大格 + 副窗口小格）
        console.log(
          `[live-matrix] bounds:最终 ${JSON.stringify(
            [...views.entries()].map(([id, e]) => ({ id, b: e.view.getBounds() })),
          )}`,
        );
        // 直连视频格状态（UI 页面内 <video> 元素）
        try {
          const vs = await withTimeout(
            win!.webContents.executeJavaScript(
              `[...document.querySelectorAll('.cell[data-id] video')].map((v) => ({
                ready: v.readyState, paused: v.paused, w: v.videoWidth, t: Math.round(v.currentTime),
                state: (v.closest('.cell')?.querySelector('.v-state') || {}).textContent || '',
              }))`,
            ),
            3000,
          );
          console.log(`[live-matrix] diag videos=${JSON.stringify(vs)}`);
        } catch {
          /* 页面可能尚未就绪 */
        }
        // 直连槽位信息
        for (const [id, s] of videoSlots) {
          console.log(`[live-matrix] diag direct=${id} src=${s.url} fmt=${s.media.format} qn=${s.media.qn ?? '?'}`);
        }
        // 主进程侧诊断：每个直播视图的 bounds 与页面内播放器几何
        for (const [id, e] of views) {
          let probe: unknown = null;
          try {
            probe = await e.view.webContents.executeJavaScript(`(() => {
              const rect = (el) => {
                const r = el.getBoundingClientRect();
                return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
              };
              return {
                url: location.href.slice(0, 80),
                ready: document.readyState,
                vp: [innerWidth, innerHeight],
                scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
                bodyClass: document.body ? document.body.className : '',
                videos: [...document.querySelectorAll('video')].map(rect),
                closeBtn: !!document.getElementById('lm-close-x'),
                refreshBtn: !!document.getElementById('lm-refresh-x'),
                key: [...document.querySelectorAll('#live-player,#playerWraper,#fullscreen-container,#player-ctnr,div[data-e2e="living-container"]')]
                  .slice(0, 5)
                  .map((el) => ({ id: el.id || el.getAttribute('data-e2e') || '', r: rect(el) })),
              };
            })()`);
          } catch {
            /* 页面可能尚未就绪 */
          }
          console.log(
            `[live-matrix] 诊断 view=${id} bounds=${JSON.stringify(e.view.getBounds())} probe=${JSON.stringify(probe)}`,
          );
        }
        // view 格页内右下角刷新按钮：点击后应触发整页 reload（navigation type 变为 reload）
        for (const [id, e] of views) {
          try {
            const hasBtn = await withTimeout(
              e.view.webContents.executeJavaScript(`!!document.getElementById('lm-refresh-x')`),
              3000,
            );
            if (!hasBtn) continue;
            await e.view.webContents.executeJavaScript(`document.getElementById('lm-refresh-x').click()`);
            await new Promise((res) => setTimeout(res, 1500));
            const navType = await withTimeout(
              e.view.webContents.executeJavaScript(`(performance.getEntriesByType('navigation')[0] || {}).type || ''`),
              3000,
            );
            console.log(`[live-matrix] view刷新按钮 id=${id} navType=${navType}`);
            break;
          } catch {
            /* 页面可能尚未就绪 */
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
      }, smokeMs);
    }
  });
  win.on('closed', () => {
    win = null;
    // 主窗口已关：登录子窗口一并带走，否则 window-all-closed 会等它们而进程驻留
    for (const lw of loginWindows.values()) {
      if (!lw.isDestroyed()) lw.destroy();
    }
    loginWindows.clear();
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

function registerIpc(): void {
  ipcMain.on('ui:ready', () => {
    // Map 保持插入顺序，即槽位顺序（第一个为主窗口）
    const slots: StreamSlot[] = [...views.entries()].map(([id, e]) => ({
      id,
      url: e.url,
      platform: e.platform,
      kind: 'view' as const,
    }));
    for (const [id, s] of videoSlots) {
      slots.push({ id, url: s.url, platform: s.platform, kind: 'video', media: s.media });
    }
    for (const [id, s] of offlineSlots) {
      slots.push({ id, url: s.url, platform: s.platform, kind: 'offline' });
    }
    console.log(`[live-matrix] 渲染层就绪，当前窗口数: ${slots.length}`);
    void Promise.all(
      PLATFORMS.map(async (p): Promise<LoginStatus> => ({ platform: p, loggedIn: await isLoggedIn(p) })),
    ).then((logins) => win?.webContents.send('app:init', { slots, logins, ...settings }));
  });

  ipcMain.handle('stream:add', async (_e, url: unknown, platform: unknown) => {
    if (typeof url !== 'string' || (platform !== 'bilibili' && platform !== 'douyin')) return null;
    // 兜底：非直播间地址（普通网页）拒绝创建，绝不回退为打开原始页面
    if (!detectLiveRoom(url)) {
      console.warn(`[live-matrix] 忽略非直播间地址: ${url}`);
      return null;
    }
    return addStream(url, platform);
  });

  ipcMain.on('stream:close', (_e, id: unknown) => {
    if (typeof id === 'number') removeStream(id);
  });

  // 直连流过期/断线：重新解析并下发新地址（B站 API / 抖音重新嗅探）；
  // 未开播占位格：重新探测，开播后原地升级为直连格
  ipcMain.on('stream:refresh', (_e, id: unknown) => {
    if (typeof id !== 'number' || !win) return;
    const slot = videoSlots.get(id);
    if (slot) {
      const resolve =
        slot.platform === 'bilibili'
          ? resolveBiliLive(slot.url, sessionFor('bilibili')).then((media) => ({ media, url: slot.url }))
          : sniffDouyinLive(slot.url, sessionFor('douyin'), win).then((media) => ({ media, url: slot.url }));
      void withTimeout(resolve, 20000)
        .then(({ media }) => {
          if (!videoSlots.has(id)) return;
          videoSlots.set(id, { url: slot.url, platform: slot.platform, media });
          win?.webContents.send('stream:media', { id, media });
          console.log(`[live-matrix] 直连流已刷新: id=${id} ${media.format}`);
        })
        .catch((err: unknown) => {
          win?.webContents.send('stream:error', { id, message: `刷新直播流失败: ${String(err)}` });
        });
      return;
    }
    const offline = offlineSlots.get(id);
    if (!offline) return;
    const recheck =
      offline.platform === 'bilibili'
        ? resolveBiliLive(offline.url, sessionFor('bilibili'))
        : sniffDouyinLive(offline.url, sessionFor('douyin'), win);
    void withTimeout(recheck, 20000)
      .then((media) => {
        if (!offlineSlots.has(id)) return;
        offlineSlots.delete(id);
        videoSlots.set(id, { url: offline.url, platform: offline.platform, media });
        win?.webContents.send('stream:media', { id, media });
        console.log(`[live-matrix] 未开播格已开播，转直连: id=${id} ${media.format}`);
      })
      .catch((err: unknown) => {
        const message = err instanceof OfflineError ? '仍未开播' : `检测开播状态失败: ${String(err)}`;
        win?.webContents.send('stream:error', { id, message });
      });
  });

  ipcMain.on('layout:update', (_e, items: unknown) => {
    if (!(win && Array.isArray(items))) return;
    for (const it of items as LayoutItem[]) {
      const entry = views.get(it?.id);
      if (!entry || !it?.rect) continue;
      const { x, y, width, height } = it.rect;
      if (![x, y, width, height].every(Number.isFinite)) continue;
      const rect = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
      };
      lastRects.set(it.id, rect);
      // 对话框打开期间不落位（视图保持隐藏），关闭时由 applyModalVisibility 统一恢复
      if (!modalVisible) entry.view.setBounds(rect);
      // 核心规则：只有主窗口槽位有声，副窗口一律静音（再叠加用户的主窗口静音开关）
      const wasMain = mainViewId === it.id;
      if (it.isMain) mainViewId = it.id;
      else if (mainViewId === it.id) mainViewId = null;
      entry.view.webContents.setAudioMuted(!it.isMain || settings.muted);
      // 主/副槽位互换时通知页内音量控件跟随显隐
      if (wasMain !== it.isMain) {
        entry.view.webContents.send('lm-slot', { isMain: it.isMain, ...settings });
      }
    }
  });

  ipcMain.on('modal:visible', (_e, v: unknown) => {
    if (typeof v === 'boolean') applyModalVisibility(v);
  });

  // 直播视图内的双击（stream-preload 捕获上报）：中继给 UI 层做互换/铺满
  ipcMain.on('stream:dblclick', (e) => {
    if (!win) return;
    for (const [id, entry] of views) {
      if (entry.view.webContents.id === e.sender.id) {
        win.webContents.send('stream:dblclick', { id });
        return;
      }
    }
  });

  // 直播页面内右下角刷新按钮：按发送者定位并重载对应视图
  ipcMain.on('stream:refresh-self', (e) => {
    for (const entry of views.values()) {
      if (entry.view.webContents.id === e.sender.id) {
        entry.view.webContents.reload();
        return;
      }
    }
  });

  // 直播页面内右上角关闭按钮：按发送者定位并关闭对应视图
  ipcMain.on('stream:close-self', (e) => {
    for (const [id, entry] of views) {
      if (entry.view.webContents.id === e.sender.id) {
        removeStream(id);
        win?.webContents.send('stream:dead', { id });
        return;
      }
    }
  });

  // 内嵌格页内星标按钮：中继给 UI 层弹出别名输入
  ipcMain.on('stream:favorite', (e) => {
    if (!win) return;
    for (const [id, entry] of views) {
      if (entry.view.webContents.id === e.sender.id) {
        win.webContents.send('stream:favorite', { id });
        return;
      }
    }
  });

  // UI 层直连格的音量控件（主槽位为 <video> 格时由此驱动）
  ipcMain.on('volume:set', (_e, volume: unknown, muted: unknown) => {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    if (typeof muted !== 'boolean') return;
    setVolumeState(volume, muted, false);
  });

  // 内嵌页内的音量控件上报：仅接受当前主槽位视图的变更，并回推 UI 层同步
  ipcMain.on('stream:volume-self', (e, volume: unknown, muted: unknown) => {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    if (typeof muted !== 'boolean') return;
    if (mainViewId == null) return;
    const entry = views.get(mainViewId);
    if (!entry || entry.view.webContents.id !== e.sender.id) return;
    setVolumeState(volume, muted, true);
  });

  // 页内覆盖层挂载完成（含页面 reload 后）：回发当前槽位与音量状态
  ipcMain.on('stream:overlay-ready', (e) => {
    for (const [id, entry] of views) {
      if (entry.view.webContents.id === e.sender.id) {
        entry.view.webContents.send('lm-state', { isMain: mainViewId === id, ...settings });
        return;
      }
    }
  });

  // 收藏夹
  ipcMain.handle('favorites:get', () => getFavorites());
  ipcMain.on('favorites:save', (_e, v: unknown) => {
    const f = v as FavoriteSaveRequest;
    if (
      !f ||
      typeof f.url !== 'string' ||
      typeof f.alias !== 'string' ||
      !f.alias.trim() ||
      (f.platform !== 'bilibili' && f.platform !== 'douyin')
    ) {
      return;
    }
    const alias = f.alias.trim().slice(0, 40);
    const list = getFavorites();
    const i = list.findIndex((x) => x.url === f.url);
    if (i >= 0) list[i] = { url: f.url, platform: f.platform, alias };
    else list.push({ url: f.url, platform: f.platform, alias });
    saveFavorites();
    pushFavorites();
  });
  ipcMain.on('favorites:remove', (_e, url: unknown) => {
    if (typeof url !== 'string') return;
    const list = getFavorites();
    const i = list.findIndex((x) => x.url === url);
    if (i < 0) return;
    list.splice(i, 1);
    saveFavorites();
    pushFavorites();
  });
  // 收藏排序（渲染层拖动后按 url 全量上报）：未知/遗漏条目沉底，防并发丢数据
  ipcMain.on('favorites:reorder', (_e, urls: unknown) => {
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) return;
    const list = getFavorites();
    const byUrl = new Map(list.map((f) => [f.url, f]));
    const next: Favorite[] = [];
    for (const u of urls) {
      const f = byUrl.get(u);
      if (f && !next.includes(f)) {
        next.push(f);
        byUrl.delete(u);
      }
    }
    for (const f of byUrl.values()) next.push(f);
    if (next.every((f, i) => list[i] === f)) return;
    list.splice(0, list.length, ...next);
    saveFavorites();
    pushFavorites();
  });

  ipcMain.on('win:min', () => win?.minimize());
  ipcMain.on('win:max', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else {
      // macOS：先解除 16:9 约束再最大化，避免 zoom 按约束计算出纵向不足的尺寸
      if (process.platform === 'darwin') win.setAspectRatio(0);
      win.maximize();
    }
  });
  ipcMain.on('win:close', () => win?.close());

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
  // macOS：首个菜单即应用程序菜单，补上退出项（Cmd+Q）——自定义菜单会整体
  // 覆盖默认菜单，不提供的话应用没有任何键盘退出入口
  const template: MenuItemConstructorOptions[] =
    process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'quit', label: '退出' }] }, edit] : [edit];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function bootstrap(): void {
  // 直连 <video> 允许无手势自动播放（含主窗口的有声播放）
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  registerIpc();
  app.whenReady().then(() => {
    installMenu();
    // 每次启动都是全新布局：不恢复上次的直播窗口（登录态在 session 分区中，仍然保留）
    createWindow();
  });
  // 单主窗口应用：关窗即退出，所有平台一致。macOS 不按驻留惯例处理——本应用
  // 无边框窗口关掉后没有任何再入口/退出入口，驻留表现为「点关闭按钮不退出」
  app.on('window-all-closed', () => app.quit());
  // 防抖中的音量保存兜底：刚调完音量就关窗也不丢
  app.on('will-quit', () => {
    if (saveSettingsTimer) {
      clearTimeout(saveSettingsTimer);
      saveSettingsTimer = null;
      writeSettings();
    }
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
