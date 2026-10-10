import { app, BrowserWindow, ipcMain, Menu, session, WebContentsView } from 'electron';
import type { MenuItemConstructorOptions, Session } from 'electron';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { resolveBiliLive } from './bilibili';
import { attachDouyinSniffer, sniffDouyinLive } from './douyin';
import { attachEnhancer } from './enhance';
import { LOGIN_URL, partitionFor, PLATFORM_LABEL, PLATFORMS } from './platforms';
import type {
  Favorite,
  FavoriteSaveRequest,
  LayoutItem,
  LoginStatus,
  Platform,
  StreamSlot,
  StreamMedia,
  ViewRect,
} from './types';

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
    // 抖音分区挂常驻拉流观察器（页面嗅探直连用）
    if (p === 'douyin') attachDouyinSniffer(ses);
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
  void view.webContents.loadURL(url).catch(() => { });
  views.set(id, { view, url, platform });
  return { id, url, platform, kind: 'view' };
}

/** B站走 API 直连、抖音走页面嗅探直连；解析失败回退内嵌页面 */
async function addStream(url: string, platform: Platform): Promise<StreamSlot | null> {
  if (!win || views.size + videoSlots.size >= MAX_STREAMS) return null;
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
    console.warn(`[live-matrix] ${platform} 直连解析失败，回退页面模式: ${String(err)}`);
  }
  return addViewStream(url, platform);
}

function removeStream(id: number): void {
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
        favoritesCache = raw.items.filter(
          (f) => f && typeof f.url === 'string' && typeof f.alias === 'string',
        );
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
    fs.writeFileSync(
      favoritesPath(),
      JSON.stringify({ version: 1, items: getFavorites() }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.error('[live-matrix] 保存收藏失败:', err);
  }
}

function pushFavorites(): void {
  win?.webContents.send('favorites:update', { items: getFavorites() });
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
  void lw.loadURL(LOGIN_URL[p]).catch(() => { });
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

  win.once('ready-to-show', () => {
    // 保持窗口 16:9（标题栏高度不计入比例计算）
    const tbh = Math.max(0, (win?.getBounds().height ?? 0) - (win?.getContentBounds().height ?? 0));
    win?.setAspectRatio(16 / 9, { width: 0, height: tbh });
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
              const urls = [
                'https://live.bilibili.com/1986380859', // 直播中 → B站 API 直连
                'https://live.douyin.com/86730210516', // 抖音开播中 → 页面嗅探直连
                'https://live.bilibili.com/21452505', // 未开播 → 回退内嵌页面
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
              // 抖音嗅探最长约 18s：等全部格子就位再断言
              for (let i = 0; i < 44 && document.querySelectorAll('.cell[data-id]').length < urls.length; i++) {
                await new Promise((res) => setTimeout(res, 500));
              }
              out.streamCellCount = document.querySelectorAll('.cell[data-id]').length;
              out.subCountText = document.getElementById('subCount').textContent;
              out.headBarCount = document.querySelectorAll('.cell-head').length;
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
          console.log(
            `[live-matrix] diag direct=${id} src=${s.url} fmt=${s.media.format} qn=${s.media.qn ?? '?'}`,
          );
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
  });
  const sendMax = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
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
    const slots: StreamSlot[] = [
      ...views.entries(),
    ].map(([id, e]) => ({ id, url: e.url, platform: e.platform, kind: 'view' as const }));
    for (const [id, s] of videoSlots) {
      slots.push({ id, url: s.url, platform: s.platform, kind: 'video', media: s.media });
    }
    console.log(`[live-matrix] 渲染层就绪，当前窗口数: ${slots.length}`);
    void Promise.all(
      PLATFORMS.map(async (p): Promise<LoginStatus> => ({ platform: p, loggedIn: await isLoggedIn(p) })),
    ).then((logins) => win?.webContents.send('app:init', { slots, logins }));
  });

  ipcMain.handle('stream:add', async (_e, url: unknown, platform: unknown) => {
    if (typeof url !== 'string' || (platform !== 'bilibili' && platform !== 'douyin')) return null;
    return addStream(url, platform);
  });

  ipcMain.on('stream:close', (_e, id: unknown) => {
    if (typeof id === 'number') removeStream(id);
  });

  // 直连流过期/断线：重新解析并下发新地址（B站 API / 抖音重新嗅探）
  ipcMain.on('stream:refresh', (_e, id: unknown) => {
    if (typeof id !== 'number') return;
    const slot = videoSlots.get(id);
    if (!slot || !win) return;
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
      .catch((err) => {
        win?.webContents.send('stream:error', { id, message: `刷新直播流失败: ${String(err)}` });
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
      // 核心规则：只有主窗口槽位有声，副窗口一律静音
      entry.view.webContents.setAudioMuted(!it.isMain);
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

  ipcMain.on('win:min', () => win?.minimize());
  ipcMain.on('win:max', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([edit]));
}

function bootstrap(): void {
  // 直连 <video> 允许无手势自动播放（含主窗口的有声播放）
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  registerIpc();
  app.whenReady().then(() => {
    installMenu();
    // 每次启动都是全新布局：不恢复上次的直播窗口（登录态在 session 分区中，仍然保留）
    createWindow();
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
