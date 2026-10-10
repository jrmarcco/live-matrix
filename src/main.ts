import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { detectPlatform, PLATFORM_LABEL, PLATFORMS } from '../electron/platforms';
import type {
  Favorite,
  InitPayload,
  LayoutItem,
  Platform,
  StreamDblClickEvent,
  StreamMedia,
  StreamMediaEvent,
} from '../electron/types';

/** 1 主 + 7 副 = 8 个槽位；右侧副窗口网格为 2 列 × 4 行 */
const MAX_CELLS = 8;

interface Cell {
  id: number;
  url: string;
  platform: Platform;
  /** video = 自研播放器直连拉流（B站/抖音）；view = 内嵌平台页面 */
  kind: 'video' | 'view';
  media?: StreamMedia;
  title?: string;
  error?: string;
}

/** 加载中的占位格（id 为负数，不与主进程分配的正数 id 冲突） */
interface PendingCell {
  id: number;
  url: string;
  platform: Platform;
  kind: 'pending';
}

type StageCell = Cell | PendingCell;

let cells: StageCell[] = []; // index 0 为主窗口槽位（左上角大画面，有声）
let pendingSeq = -1;
let focusMode = false; // 双击主窗口进入：主画面铺满舞台，副窗口隐藏；再双击还原
const loginState: Record<Platform, boolean> = { bilibili: false, douyin: false };

const stage = document.getElementById('stage')!;
const loginChips = document.getElementById('loginChips')!;
const winMaxBtn = document.getElementById('winMax') as HTMLButtonElement;

/* ---------------- 无边框窗口控制 ---------------- */

document.getElementById('winMin')!.addEventListener('click', () => window.lm.winMin());
winMaxBtn.addEventListener('click', () => window.lm.winMax());
document.getElementById('winClose')!.addEventListener('click', () => window.lm.winClose());
window.lm.onMaximized((maximized) => {
  winMaxBtn.querySelector('i')?.classList.toggle('restore', maximized);
  winMaxBtn.title = maximized ? '还原' : '最大化';
});
const modalBack = document.getElementById('modalBack')!;
const addForm = document.getElementById('addForm') as HTMLFormElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const platHint = document.getElementById('platHint')!;
const addErr = document.getElementById('addErr')!;

/* ---------------- 布局同步 ---------------- */

function sendLayout(): void {
  const items: LayoutItem[] = [];
  stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    const body = el.querySelector<HTMLElement>('.cell-body');
    if (!body) return;
    const r = body.getBoundingClientRect();
    items.push({
      id: Number(el.dataset.id),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.ceil(r.width),
        height: Math.ceil(r.height),
      },
      isMain: el.classList.contains('slot-main'),
    });
  });
  window.lm.updateLayout(items);
}

/** video 格子纯 DOM，静音在渲染层控制（view 格子由主进程按 layout 控制） */
function syncVideoMute(): void {
  stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    const video = el.querySelector('video');
    if (video) video.muted = !el.classList.contains('slot-main');
  });
}

let resizePending = false;
window.addEventListener('resize', () => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    sendLayout();
  });
});

/* ---------------- 渲染 ---------------- */

/** 星形图标（描边星，收藏态由 CSS 填充为金色实心；避免系统字体的 ☆/★ 字形不一致） */
const STAR_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';

function makeStreamCell(c: StageCell): HTMLElement {
  const el = document.createElement('section');
  el.className = c.kind === 'video' ? 'cell kind-video' : 'cell';
  el.dataset.id = String(c.id);
  if (c.kind === 'pending') {
    // 加载占位格：解析直连地址期间（抖音最长约 15s）的遮罩反馈
    el.className = 'cell pending';
    el.innerHTML = `
      <div class="cell-body">
        <div class="cell-load">
          <span class="spin"></span>
          <span class="txt">正在加载直播…</span>
        </div>
        <button class="cell-close" type="button" title="取消此直播">×</button>
      </div>`;
    el.querySelector('.cell-close')!.addEventListener('click', () => {
      const i = cells.findIndex((x) => x.id === c.id);
      if (i >= 0) removeCell(i);
    });
    return el;
  }
  if (c.kind === 'video') {
    // 直连格子：视频元素 + 状态角标 + 收藏/刷新/关闭按钮（画面是我们自己的 DOM）
    el.innerHTML = `
      <div class="cell-body">
        <video playsinline></video>
        <span class="v-state"></span>
        <button class="cell-fav" type="button" title="收藏此直播">${STAR_ICON}</button>
        <button class="cell-refresh" type="button" title="刷新直播">↻</button>
        <button class="cell-close" type="button" title="关闭此直播窗口">×</button>
      </div>`;
    el.querySelector('.cell-close')!.addEventListener('click', () => {
      const i = cells.findIndex((x) => x.id === c.id);
      if (i >= 0) removeCell(i);
    });
    el.querySelector('.cell-fav')!.addEventListener('click', () => openFavModal(c));
    el.querySelector('.cell-refresh')!.addEventListener('click', () => {
      const cc = cells.find((x) => x.id === c.id);
      if (!cc || cc.kind !== 'video') return;
      // 清掉待触发的自动刷新，避免手动刷新后又被重复解析一次
      const t = refreshTimers.get(c.id);
      if (t) {
        window.clearTimeout(t);
        refreshTimers.delete(c.id);
      }
      setState(c.id, '刷新中…');
      window.lm.refreshStream(c.id);
    });
    attachPlayer(el, c);
  } else {
    el.innerHTML = '<div class="cell-body"></div>';
  }
  return el;
}

function makeSubPlaceholder(): HTMLElement {
  const el = document.createElement('section');
  el.className = 'cell placeholder';
  el.innerHTML = '<div class="ph-inner"><span class="ph-plus">＋</span><span>添加直播</span></div>';
  el.addEventListener('click', openModal);
  return el;
}

function makeMainPlaceholder(): HTMLElement {
  const el = document.createElement('section');
  el.className = 'cell placeholder slot-main';
  el.innerHTML =
    '<div class="ph-inner"><span class="ph-plus">◧</span><span>主窗口</span></div>';
  el.addEventListener('click', openModal);
  return el;
}

function render(): void {
  // 复用已有的格子 DOM：appendChild 移动节点不会中断 <video> 播放，
  // 互换/焦点模式切换时不重载直播画面
  const existing = new Map<number, HTMLElement>();
  stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    existing.set(Number(el.dataset.id), el);
  });
  stage.innerHTML = '';
  if (cells.length === 0) {
    stage.appendChild(makeMainPlaceholder());
  } else {
    cells.forEach((c, i) => {
      let el = existing.get(c.id);
      if (!el) el = makeStreamCell(c);
      el.classList.toggle('slot-main', i === 0);
      el.title = i === 0 ? '双击铺满窗口，再次双击还原' : '双击与主窗口互换';
      stage.appendChild(el);
    });
  }
  // 副窗口共 7 格（右侧一列 3 格 + 底部一行 4 格），未用的显示占位块
  const subs = Math.max(cells.length - 1, 0);
  for (let i = subs; i < 7; i++) {
    stage.appendChild(makeSubPlaceholder());
  }
  // 格子已被移除的播放器随之销毁
  for (const id of [...players.keys()]) {
    if (!stage.querySelector(`.cell[data-id="${id}"]`)) destroyPlayer(id);
  }
  updateFavStates();
  requestAnimationFrame(() => {
    sendLayout();
    syncVideoMute();
  });
}

/* ---------------- 槽位操作 ---------------- */

function removeCell(i: number): void {
  const [c] = cells.splice(i, 1);
  if (!c) return;
  // 关闭的是主窗口时退出焦点模式，避免铺满画面切到新主窗口造成困惑
  if (i === 0 && focusMode) setFocusMode(false);
  window.lm.closeStream(c.id);
  render();
}

function swapCells(i: number, j: number): void {
  if (i === j || i < 0 || j < 0 || i >= cells.length || j >= cells.length) return;
  [cells[i], cells[j]] = [cells[j], cells[i]];
  render();
}

/* ---------------- 双击：互换 / 焦点模式 ---------------- */

function handleStreamDblClick(id: number): void {
  const i = cells.findIndex((c) => c.id === id);
  if (i < 0) return;
  if (i === 0) setFocusMode(!focusMode);
  else swapCells(i, 0);
}

window.lm.onStreamDblClick((v: StreamDblClickEvent) => handleStreamDblClick(v.id));

stage.addEventListener('dblclick', (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (e.target.closest('button')) return;
  const cellEl = e.target.closest('.cell[data-id]') as HTMLElement | null;
  if (!cellEl) return;
  handleStreamDblClick(Number(cellEl.dataset.id));
});

function setFocusMode(on: boolean): void {
  if (focusMode === on) return;
  focusMode = on;
  stage.classList.toggle('focus', on);
  // 副窗口 display:none 后 rect 归零，主进程会把对应视图缩为 0（直播不中断）
  requestAnimationFrame(() => {
    sendLayout();
    syncVideoMute();
  });
}

/* ---------------- 直连播放器（B站） ---------------- */

interface PlayerHandle {
  destroy: () => void;
}

const players = new Map<number, PlayerHandle>();
const refreshTimers = new Map<number, number>();

function destroyPlayer(id: number): void {
  const t = refreshTimers.get(id);
  if (t) {
    window.clearTimeout(t);
    refreshTimers.delete(id);
  }
  const p = players.get(id);
  players.delete(id);
  try {
    p?.destroy();
  } catch {
    /* 可能已销毁 */
  }
}

function setState(id: number, text: string): void {
  const el = stage.querySelector(`.cell[data-id="${id}"] .v-state`);
  if (el) el.textContent = text;
}

function attachPlayer(cellEl: HTMLElement, c: Cell): void {
  destroyPlayer(c.id);
  const video = cellEl.querySelector('video');
  if (!video || !c.media) return;
  setState(c.id, '载入中…');
  video.addEventListener(
    'playing',
    () => {
      setState(c.id, '');
    },
    { once: true },
  );

  if (c.media.format === 'flv' && mpegts.getFeatureList().mseLivePlayback) {
    console.log('[lm-player] flv via mpegts.js', c.media.url.slice(0, 70));
    // HTTP-FLV：延迟最低，mpegts.js（B站自家维护）
    const player = mpegts.createPlayer(
      { type: 'flv', url: c.media.url, isLive: true, cors: true },
      {
        enableStashBuffer: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 6,
        lazyLoad: false,
      },
    );
    player.on(mpegts.Events.ERROR, () => {
      destroyPlayer(c.id);
      scheduleRefresh(c.id);
    });
    player.attachMediaElement(video);
    player.load();
    players.set(c.id, {
      destroy: () => {
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          /* 可能已销毁 */
        }
      },
    });
  } else if (c.media.format === 'hls' && Hls.isSupported()) {
    console.log('[lm-player] hls via hls.js');
    const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, maxBufferLength: 12 });
    hls.loadSource(c.media.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      destroyPlayer(c.id);
      scheduleRefresh(c.id);
    });
    players.set(c.id, { destroy: () => hls.destroy() });
  } else {
    // 原生回退：直接给 <video> 赋源
    console.warn('[lm-player] native fallback, format=', c.media.format);
    video.src = c.media.url;
    players.set(c.id, {
      destroy: () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      },
    });
  }
  void video.play().catch(() => {
    /* 自动播放被拒时等用户点击 */
  });
}

/** 流地址过期/断线：节流后请主进程重新解析 */
function scheduleRefresh(id: number): void {
  if (refreshTimers.has(id)) return;
  refreshTimers.set(
    id,
    window.setTimeout(() => {
      refreshTimers.delete(id);
      const c = cells.find((x) => x.id === id);
      if (!c || c.kind !== 'video') return;
      setState(id, '线路刷新中…');
      window.lm.refreshStream(id);
    }, 3000),
  );
}

/* ---------------- 添加对话框 ---------------- */

function openModal(): void {
  if (cells.length >= MAX_CELLS) return;
  // 直播视图层级高于 UI DOM，打开期间让主进程隐藏它们，保证对话框可见
  window.lm.setModalVisible(true);
  modalBack.classList.remove('hidden');
  urlInput.value = '';
  updateHint('');
  addErr.textContent = '';
  urlInput.focus();
}

function closeModal(): void {
  modalBack.classList.add('hidden');
  window.lm.setModalVisible(false);
}

function updateHint(value: string): void {
  if (!value.trim()) {
    platHint.textContent = '支持：哔哩哔哩直播 · 抖音直播';
    platHint.classList.remove('ok', 'warn');
    return;
  }
  const p = detectPlatform(value);
  if (p) {
    platHint.textContent = `已识别：${PLATFORM_LABEL[p]}（使用其登录状态）`;
    platHint.className = 'hint ok';
  } else {
    platHint.textContent = '暂不支持该地址，仅支持 bilibili.com / douyin.com';
    platHint.className = 'hint warn';
  }
}

urlInput.addEventListener('input', () => updateHint(urlInput.value));
document.getElementById('cancelBtn')!.addEventListener('click', closeModal);
modalBack.addEventListener('pointerdown', (e) => {
  if (e.target === modalBack) closeModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modalBack.classList.contains('hidden')) closeModal();
  else if (!favBack.classList.contains('hidden')) closeFavModal();
  else if (!favWrap.classList.contains('hidden')) closeFavPanel();
  else if (focusMode) setFocusMode(false);
});

/**
 * 添加直播：先落一个「加载中」占位格并立即关闭对话框，解析完成后再替换成
 * 直连视频格 / 内嵌页面格（抖音接口重放最长约 15s，期间界面保持可操作）。
 */
function beginAddStream(url: string, platform: Platform, onFail?: () => void): void {
  const pending: PendingCell = { id: pendingSeq--, url, platform, kind: 'pending' };
  cells.push(pending);
  if (focusMode) setFocusMode(false); // 新增副窗口时回到同屏布局展示
  render();
  void window.lm.addStream(url, platform).then((slot) => {
    const i = cells.findIndex((c) => c.id === pending.id);
    if (!slot) {
      // 创建失败（理论上仅剩窗口已销毁等罕见场景）：撤掉占位格并回调
      if (i >= 0) cells.splice(i, 1);
      render();
      onFail?.();
      return;
    }
    if (i < 0) {
      // 用户已在加载期间取消：销毁刚创建的流
      window.lm.closeStream(slot.id);
      return;
    }
    cells[i] = { ...slot };
    render();
  });
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addErr.textContent = '';
  const raw = urlInput.value.trim();
  if (!raw) {
    addErr.textContent = '请输入直播地址';
    return;
  }
  if (cells.length >= MAX_CELLS) {
    addErr.textContent = '已达上限：1 个主窗口 + 7 个副窗口';
    return;
  }
  const p = detectPlatform(raw);
  if (!p) {
    addErr.textContent = '无法识别的地址，目前支持 live.bilibili.com 与 live.douyin.com';
    return;
  }
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  // 立即关闭对话框，加载过程由占位格上的遮罩反馈（问题1）
  closeModal();
  beginAddStream(normalized, p, () => {
    // 失败时回到对话框并保留输入，方便重试
    openModal();
    urlInput.value = raw;
    updateHint(raw);
    addErr.textContent = '创建窗口失败，请重试';
  });
});

/* ---------------- 收藏夹 ---------------- */

const favWrap = document.getElementById('favWrap')!;
const favList = document.getElementById('favList')!;
const favBack = document.getElementById('favBack')!;
const favForm = document.getElementById('favForm') as HTMLFormElement;
const favAlias = document.getElementById('favAlias') as HTMLInputElement;

let favorites: Favorite[] = [];
let pendingFav: { url: string; platform: Platform } | null = null;

function openFavPanel(): void {
  favWrap.classList.remove('hidden');
  // 内嵌直播视图层级高于 DOM，面板期间隐藏（与对话框同机制）
  window.lm.setModalVisible(true);
}

function closeFavPanel(): void {
  favWrap.classList.add('hidden');
  window.lm.setModalVisible(false);
}

document.getElementById('favBtn')!.addEventListener('click', () => {
  if (favWrap.classList.contains('hidden')) openFavPanel();
  else closeFavPanel();
});
document.getElementById('favClose')!.addEventListener('click', closeFavPanel);
document.getElementById('favShade')!.addEventListener('click', closeFavPanel);

/** 正在拖动的收藏项 url（null = 未拖动） */
let dragFavUrl: string | null = null;

function renderFavList(): void {
  favList.innerHTML = '';
  if (!favorites.length) {
    const empty = document.createElement('div');
    empty.className = 'fav-empty';
    empty.textContent = '暂无收藏';
    favList.appendChild(empty);
    return;
  }
  for (const f of favorites) {
    const item = document.createElement('div');
    item.className = 'fav-item';
    item.draggable = true;
    item.dataset.url = f.url;
    const tag = f.platform === 'bilibili' ? 'B站' : '抖音';
    item.innerHTML = `<span class="fav-grip" title="拖动调整顺序">⠿</span><span class="tag ${f.platform}">${tag}</span><span class="alias"></span><span class="fav-del" title="移除收藏">×</span>`;
    (item.querySelector('.alias') as HTMLElement).textContent = f.alias;
    item.title = `点击添加：${tag} · ${f.alias}（拖动可调整顺序）`;
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.fav-del')) {
        window.lm.removeFavorite(f.url);
        return;
      }
      void addFavoriteToStage(f);
    });
    item.addEventListener('dragstart', (e) => {
      dragFavUrl = f.url;
      item.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', f.url);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      if (dragFavUrl) persistFavOrder();
      dragFavUrl = null;
    });
    favList.appendChild(item);
  }
}

// 拖动经过其他条目时实时移动 DOM（半透明随行），松手后统一持久化
favList.addEventListener('dragover', (e) => {
  if (!dragFavUrl) return;
  const dragging = favList.querySelector<HTMLElement>('.fav-item.dragging');
  if (!dragging) return;
  e.preventDefault();
  const overItem = (e.target as HTMLElement).closest?.('.fav-item') as HTMLElement | null;
  if (!overItem || overItem === dragging) {
    // 列表末尾空白区 → 拖到最后一项之后；条目间隙太小，忽略避免跳动
    const last = [...favList.querySelectorAll<HTMLElement>('.fav-item:not(.dragging)')].pop();
    if (!overItem && last && e.clientY > last.getBoundingClientRect().bottom) {
      favList.appendChild(dragging);
    }
    return;
  }
  const r = overItem.getBoundingClientRect();
  if (e.clientY > r.top + r.height / 2) overItem.after(dragging);
  else overItem.before(dragging);
});

/** 按 DOM 顺序上报新排序；顺序未变则不落盘 */
function persistFavOrder(): void {
  const urls = [...favList.querySelectorAll<HTMLElement>('.fav-item')]
    .map((el) => el.dataset.url)
    .filter((u): u is string => !!u);
  const changed = urls.some((u, i) => favorites[i]?.url !== u) || urls.length !== favorites.length;
  if (changed) window.lm.reorderFavorites(urls);
}

function addFavoriteToStage(f: Favorite): void {
  if (cells.length >= MAX_CELLS) return;
  // 收藏面板立即收起，加载过程同样由占位格遮罩反馈
  closeFavPanel();
  beginAddStream(f.url, f.platform);
}

function openFavModal(c: Cell): void {
  pendingFav = { url: c.url, platform: c.platform };
  const existing = favorites.find((f) => f.url === c.url);
  favAlias.value = existing ? existing.alias : `收藏${favorites.length + 1}`;
  closeModal();
  closeFavPanel();
  window.lm.setModalVisible(true);
  favBack.classList.remove('hidden');
  favAlias.focus();
  favAlias.select();
}

function closeFavModal(): void {
  favBack.classList.add('hidden');
  pendingFav = null;
  window.lm.setModalVisible(false);
}

document.getElementById('favCancel')!.addEventListener('click', closeFavModal);
favBack.addEventListener('pointerdown', (e) => {
  if (e.target === favBack) closeFavModal();
});
favForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const alias = favAlias.value.trim();
  if (!alias || !pendingFav) return;
  window.lm.saveFavorite({ ...pendingFav, alias });
  closeFavModal();
});

/** 同步各格星标状态（收藏后按钮加 on 类：星形填充为金色；内嵌格页内按钮不回显状态） */
function updateFavStates(): void {
  stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    const btn = el.querySelector<HTMLElement>('.cell-fav');
    if (!btn) return;
    const c = cells.find((x) => x.id === Number(el.dataset.id));
    const saved = !!c && favorites.some((f) => f.url === c.url);
    btn.classList.toggle('on', saved);
    btn.title = saved ? '已收藏，点击修改别名' : '收藏此直播';
  });
}

/* ---------------- 登录状态 ---------------- */

function renderChips(): void {
  loginChips.innerHTML = '';
  for (const p of PLATFORMS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = loginState[p] ? `chip ${p} on` : `chip ${p}`;
    b.innerHTML = `<span class="dot"></span>${PLATFORM_LABEL[p]}<em>${loginState[p] ? '已登录' : '未登录'
      }</em>`;
    b.title = loginState[p]
      ? `点击退出${PLATFORM_LABEL[p]}登录`
      : `点击打开${PLATFORM_LABEL[p]}登录页（扫码登录，状态会自动保存）`;
    b.addEventListener('click', async () => {
      if (loginState[p]) {
        if (window.confirm(`确定退出${PLATFORM_LABEL[p]}登录？`)) {
          await window.lm.logout(p);
        }
      } else {
        window.lm.openLogin(p);
      }
    });
    loginChips.appendChild(b);
  }
}

/* ---------------- 主进程事件 ---------------- */

function updateCellDom(id: number, fn: (c: Cell) => void): void {
  const c = cells.find((x) => x.id === id);
  if (c && c.kind !== 'pending') fn(c);
}

window.lm.onInit((payload: InitPayload) => {
  cells = payload.slots.map((s) => ({ ...s }));
  for (const s of payload.logins) loginState[s.platform] = s.loggedIn;
  if (focusMode) setFocusMode(false);
  render();
  renderChips();
});

window.lm.onLoginStatus((s) => {
  loginState[s.platform] = s.loggedIn;
  renderChips();
});

window.lm.onStreamTitle((v) => updateCellDom(v.id, (c) => (c.title = v.title)));
window.lm.onStreamError((v) =>
  updateCellDom(v.id, (c) => {
    c.error = v.message.slice(0, 60);
    setState(v.id, c.error);
  }),
);
window.lm.onStreamDead((v) => {
  const i = cells.findIndex((c) => c.id === v.id);
  if (i >= 0) removeCell(i);
});
// 直连流地址刷新（过期/断线后主进程重新解析下发）
window.lm.onStreamMedia((v: StreamMediaEvent) => {
  const c = cells.find((x) => x.id === v.id);
  if (!c || c.kind !== 'video') return;
  c.media = v.media;
  const el = stage.querySelector<HTMLElement>(`.cell[data-id="${v.id}"]`);
  if (el) attachPlayer(el, c);
});
// 内嵌格页内星标点击 → 弹出别名输入
window.lm.onStreamFavorite((v) => {
  const c = cells.find((x) => x.id === v.id);
  if (c && c.kind !== 'pending') openFavModal(c);
});
// 收藏列表变更（保存/移除后主进程推送全量）
window.lm.onFavoritesUpdate((v) => {
  favorites = v.items;
  renderFavList();
  updateFavStates();
});

/* ---------------- 启动 ---------------- */

render();
renderChips();
void window.lm.getFavorites().then((items) => {
  favorites = items;
  renderFavList();
  updateFavStates();
});
window.lm.ready();
