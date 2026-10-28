import { WebContentsView } from 'electron';
import * as path from 'node:path';
import { attachEnhancer } from '../enhance';
import { withTimeout } from '../lib/async';
import { sessionFor } from '../login';
import { getWin } from '../windows';
import { OfflineError } from '../types';
import { resolveStream } from './stream-resolver';
import { settings } from './settings-store';
import type { LayoutItem, Platform, StreamMedia, StreamSlot, ViewRect, VolumeState } from '../../src/shared/types/ipc';

/* ---------------- 槽位注册表：三类直播槽位（内嵌视图 / 直连视频 / 未开播占位）的唯一状态源 ---------------- */

/** 1 个主窗口槽位 + 最多 7 个副窗口槽位 */
const MAX_STREAMS = 8;

export interface StreamEntry {
  view: WebContentsView;
  url: string;
  platform: Platform;
}

/** 内嵌页面模式的直播（抖音 / B站直连失败回退） */
const views = new Map<number, StreamEntry>();
/** 直连播放模式的直播（B站 API 解析 / 抖音页面嗅探）：记录原地址以便流过期后重新解析 */
const videoSlots = new Map<number, { url: string; platform: Platform; media: StreamMedia }>();
/** 未开播的直播间（纯 UI 占位格，不加载页面）：记录原地址以便刷新重试 */
const offlineSlots = new Map<number, { url: string; platform: Platform }>();
/** 当前处于主窗口槽位的内嵌视图 id（主槽位是直连视频格或无直播时为 null） */
let mainViewId: number | null = null;
let nextId = 1;

/** 对话框打开期间隐藏直播视图：WebContentsView 层级永远高于 UI 页面 DOM，
 *  不隐藏的话地址输入对话框会被直播画面盖住 */
let modalVisible = false;
/** 最近一次 layout:update 上报的各视图矩形，对话框关闭后据此恢复 */
const lastRects = new Map<number, ViewRect>();

export function applyModalVisibility(v: boolean): void {
  modalVisible = v;
  const win = getWin();
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

function addViewStream(url: string, platform: Platform): StreamSlot | null {
  const win = getWin();
  if (!win) return null;
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      session: sessionFor(platform),
      // 注入双击拦截：双击直播画面 = 副窗口与主窗口互换 / 主窗口铺满
      preload: path.join(__dirname, '..', 'stream-preload.js'),
      contextIsolation: true,
    },
  });
  view.setBackgroundColor('#000000');
  // 初始不可见、静音，等待渲染层上报布局后再定位并按槽位解除静音
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.webContents.setAudioMuted(true);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('page-title-updated', (_e, title) => {
    getWin()?.webContents.send('stream:title', { id, title });
  });
  view.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code !== -3) getWin()?.webContents.send('stream:error', { id, message: `${desc} (${code})` });
  });
  view.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[live-matrix] 直播视图 ${id} 渲染进程退出: ${details.reason}`);
    removeStream(id);
    getWin()?.webContents.send('stream:dead', { id });
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
export async function addStream(url: string, platform: Platform): Promise<StreamSlot | null> {
  const win = getWin();
  if (!win || views.size + videoSlots.size + offlineSlots.size >= MAX_STREAMS) return null;
  try {
    const media = await withTimeout(
      resolveStream(platform, url, sessionFor(platform), win),
      platform === 'bilibili' ? 8000 : 20000,
    );
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

export function removeStream(id: number): void {
  const win = getWin();
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

/** 直连流过期/断线：重新解析并下发新地址；未开播占位格：重新探测，开播后原地升级为直连格 */
export function refreshStream(id: number): void {
  const win = getWin();
  if (!win) return;
  const slot = videoSlots.get(id);
  if (slot) {
    const resolve = resolveStream(slot.platform, slot.url, sessionFor(slot.platform), win).then((media) => ({
      media,
      url: slot.url,
    }));
    void withTimeout(resolve, 20000)
      .then(({ media }) => {
        if (!videoSlots.has(id)) return;
        videoSlots.set(id, { url: slot.url, platform: slot.platform, media });
        getWin()?.webContents.send('stream:media', { id, media });
        console.log(`[live-matrix] 直连流已刷新: id=${id} ${media.format}`);
      })
      .catch((err: unknown) => {
        if (err instanceof OfflineError) {
          // 主播已下播：直连槽位降级为未开播占位格（与添加时/占位格刷新同一页面）
          videoSlots.delete(id);
          offlineSlots.set(id, { url: slot.url, platform: slot.platform });
          getWin()?.webContents.send('stream:offline', { id });
          console.log(`[live-matrix] 直播已下播，转未开播占位格: id=${id}`);
          return;
        }
        getWin()?.webContents.send('stream:error', { id, message: `刷新直播流失败: ${String(err)}` });
      });
    return;
  }
  const offline = offlineSlots.get(id);
  if (!offline) return;
  const recheck = resolveStream(offline.platform, offline.url, sessionFor(offline.platform), win);
  void withTimeout(recheck, 20000)
    .then((media) => {
      if (!offlineSlots.has(id)) return;
      offlineSlots.delete(id);
      videoSlots.set(id, { url: offline.url, platform: offline.platform, media });
      getWin()?.webContents.send('stream:media', { id, media });
      console.log(`[live-matrix] 未开播格已开播，转直连: id=${id} ${media.format}`);
    })
    .catch((err: unknown) => {
      const message = err instanceof OfflineError ? '未开播' : `检测开播状态失败: ${String(err)}`;
      getWin()?.webContents.send('stream:error', { id, message });
    });
}

/** 渲染层 ready 时下发的槽位快照（Map 保持插入顺序，即槽位顺序，第一个为主窗口） */
export function snapshotSlots(): StreamSlot[] {
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
  return slots;
}

/** 渲染层上报的布局落位：视图矩形 + 主槽位静音规则 + 页内音量控件跟随 */
export function applyLayout(items: LayoutItem[]): void {
  for (const it of items) {
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
}

/** 按发送方 webContents id 反查直播视图（stream-preload 内嵌页事件中继用） */
export function findViewByWebContentsId(wcId: number): { id: number; entry: StreamEntry } | undefined {
  for (const [id, entry] of views) {
    if (entry.view.webContents.id === wcId) return { id, entry };
  }
  return undefined;
}

export function getMainViewId(): number | null {
  return mainViewId;
}

/** 把音量状态下发给主槽位内嵌视图（音量作用于页内媒体元素，静音走 setAudioMuted）；
 *  主槽位视图本就不静音（副窗口才静音），这里只叠加用户的静音开关 */
export function pushVolumeToMainView(state: VolumeState): void {
  if (mainViewId == null) return;
  const entry = views.get(mainViewId);
  if (entry && !entry.view.webContents.isDestroyed()) {
    entry.view.webContents.send('lm-volume', { ...state });
    entry.view.webContents.setAudioMuted(state.muted);
  }
}

/** 诊断用：内嵌视图与直连槽位的只读快照（冒烟/E2E 探针） */
export function listViewEntries(): [number, StreamEntry][] {
  return [...views.entries()];
}

export function listVideoSlots(): [number, { url: string; platform: Platform; media: StreamMedia }][] {
  return [...videoSlots.entries()];
}
