import { ICONS } from './shared/lib/icons';
import type { StreamDblClickEvent } from './shared/types/ipc';
import { dom } from './dom';
import { openModal } from './add-dialog';
import { openFavModal } from './favorites';
import { sendLayout, syncVideoAudio, updateVolumeControls, applyVolume } from './layout';
import { attachPlayer, cancelRefreshTimer, destroyPlayer, getPlayerIds } from './player';
import { state, type StageCell } from './state';

/* ---------------- 舞台：格子 DOM 工厂、槽位渲染与操作（删除/互换/双击/焦点模式） ---------------- */

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
      const i = state.cells.findIndex((x) => x.id === c.id);
      if (i >= 0) removeCell(i);
    });
    return el;
  }
  if (c.kind === 'offline') {
    // 未开播占位格：居中提示 + 收藏/刷新/关闭按钮（纯 DOM，无直播视图覆盖，
    // 按钮/双击互换等交互天然可用）；刷新即请主进程重新探测，开播后原地升级为直连格
    el.className = 'cell kind-offline';
    el.innerHTML = `
      <div class="cell-body">
        <div class="cell-load cell-offline">
          <span class="txt">未开播</span>
          <span class="sub">主播开播后点击刷新</span>
        </div>
        <button class="cell-fav" type="button" title="收藏此直播">
          <img class="ic-fav-off" src="${ICONS.favoriteDark}" alt="" draggable="false" />
          <img class="ic-fav-on" src="${ICONS.favoriteLight}" alt="" draggable="false" />
        </button>
        <button class="cell-refresh" type="button" title="刷新直播"><img src="${ICONS.refresh}" alt="" draggable="false" /></button>
        <button class="cell-close" type="button" title="关闭此直播窗口"><img src="${ICONS.close}" alt="" draggable="false" /></button>
      </div>`;
    el.querySelector('.cell-close')!.addEventListener('click', () => {
      const i = state.cells.findIndex((x) => x.id === c.id);
      if (i >= 0) removeCell(i);
    });
    el.querySelector('.cell-fav')!.addEventListener('click', () => openFavModal(c));
    el.querySelector('.cell-refresh')!.addEventListener('click', () => {
      const cc = state.cells.find((x) => x.id === c.id);
      if (!cc || cc.kind !== 'offline') return;
      setOfflineHint(c.id, '检测中…');
      window.lm.refreshStream(c.id);
    });
    return el;
  }
  if (c.kind === 'video') {
    // 直连格子：视频元素 + 状态角标 + 收藏/刷新/关闭按钮 + 主槽位静音按钮（画面是我们自己的 DOM）
    // 图标为 build/ 下 PNG 的内嵌 data URL（黑色图标由 CSS 反色为白）
    el.innerHTML = `
      <div class="cell-body">
        <video playsinline></video>
        <span class="v-state"></span>
        <button class="cell-fav" type="button" title="收藏此直播">
          <img class="ic-fav-off" src="${ICONS.favoriteDark}" alt="" draggable="false" />
          <img class="ic-fav-on" src="${ICONS.favoriteLight}" alt="" draggable="false" />
        </button>
        <button class="cell-refresh" type="button" title="刷新直播"><img src="${ICONS.refresh}" alt="" draggable="false" /></button>
        <button class="cell-volume" type="button" title="静音 / 取消静音">
          <img class="ic-vol-on" src="${ICONS.volume}" alt="" draggable="false" />
          <img class="ic-vol-off" src="${ICONS.mute}" alt="" draggable="false" />
        </button>
        <button class="cell-close" type="button" title="关闭此直播窗口"><img src="${ICONS.close}" alt="" draggable="false" /></button>
      </div>`;
    el.querySelector('.cell-close')!.addEventListener('click', () => {
      const i = state.cells.findIndex((x) => x.id === c.id);
      if (i >= 0) removeCell(i);
    });
    el.querySelector('.cell-fav')!.addEventListener('click', () => openFavModal(c));
    el.querySelector('.cell-volume')!.addEventListener('click', () => {
      // 静音态点击 → 恢复（历史设置音量为 0 时给个默认值）；有声态点击 → 静音
      const silent = state.mainMuted || state.mainVolume === 0;
      applyVolume(silent ? (state.mainVolume > 0 ? state.mainVolume : 0.6) : state.mainVolume, !silent);
    });
    el.querySelector('.cell-refresh')!.addEventListener('click', () => {
      const cc = state.cells.find((x) => x.id === c.id);
      if (!cc || cc.kind !== 'video') return;
      // 清掉待触发的自动刷新，避免手动刷新后又被重复解析一次
      cancelRefreshTimer(c.id);
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
  el.innerHTML = '<div class="ph-inner"><span class="ph-plus">◧</span><span>主窗口</span></div>';
  el.addEventListener('click', openModal);
  return el;
}

export function render(): void {
  // 复用已有的格子 DOM：appendChild 移动节点不会中断 <video> 播放，
  // 互换/焦点模式切换时不重载直播画面
  const existing = new Map<number, HTMLElement>();
  dom.stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    existing.set(Number(el.dataset.id), el);
  });
  dom.stage.innerHTML = '';
  if (state.cells.length === 0) {
    dom.stage.appendChild(makeMainPlaceholder());
  } else {
    state.cells.forEach((c, i) => {
      let el = existing.get(c.id);
      if (!el) el = makeStreamCell(c);
      el.classList.toggle('slot-main', i === 0);
      dom.stage.appendChild(el);
    });
  }
  // 副窗口共 7 格（右侧一列 3 格 + 底部一行 4 格），未用的显示占位块
  const subs = Math.max(state.cells.length - 1, 0);
  for (let i = subs; i < 7; i++) {
    dom.stage.appendChild(makeSubPlaceholder());
  }
  // 格子已被移除的播放器随之销毁（先快照：destroyPlayer 会从 players 删项）
  const playerIds = getPlayerIds();
  for (const id of playerIds) {
    if (!dom.stage.querySelector(`.cell[data-id="${id}"]`)) destroyPlayer(id);
  }
  updateFavStates();
  updateVolumeControls();
  requestAnimationFrame(() => {
    sendLayout();
    syncVideoAudio();
  });
}

/* ---------------- 槽位操作 ---------------- */

export function removeCell(i: number): void {
  const [c] = state.cells.splice(i, 1);
  if (!c) return;
  // 关闭的是主窗口时退出焦点模式，避免铺满画面切到新主窗口造成困惑
  if (i === 0 && state.focusMode) setFocusMode(false);
  window.lm.closeStream(c.id);
  render();
}

export function swapCells(i: number, j: number): void {
  if (i === j || i < 0 || j < 0 || i >= state.cells.length || j >= state.cells.length) return;
  [state.cells[i], state.cells[j]] = [state.cells[j], state.cells[i]];
  render();
}

/* ---------------- 双击：互换 / 焦点模式 ---------------- */

function handleStreamDblClick(id: number): void {
  const i = state.cells.findIndex((c) => c.id === id);
  if (i < 0) return;
  if (i === 0) setFocusMode(!state.focusMode);
  else swapCells(i, 0);
}

window.lm.onStreamDblClick((v: StreamDblClickEvent) => handleStreamDblClick(v.id));

dom.stage.addEventListener('dblclick', (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (e.target.closest('button')) return;
  const cellEl = e.target.closest('.cell[data-id]') as HTMLElement | null;
  if (!cellEl) return;
  handleStreamDblClick(Number(cellEl.dataset.id));
});

export function setFocusMode(on: boolean): void {
  if (state.focusMode === on) return;
  state.focusMode = on;
  dom.stage.classList.toggle('focus', on);
  // 副窗口 display:none 后 rect 归零，主进程会把对应视图缩为 0（直播不中断）
  requestAnimationFrame(() => {
    sendLayout();
    syncVideoAudio();
  });
}

/** 直连格左上角状态角标文案（载入中…/播放中为空/错误信息/刷新中…） */
export function setState(id: number, text: string): void {
  const el = dom.stage.querySelector(`.cell[data-id="${id}"] .v-state`);
  if (el) el.textContent = text;
}

/** 未开播占位格的主提示文案（未开播 / 检测中… / 仍未开播） */
export function setOfflineHint(id: number, text: string): void {
  const el = dom.stage.querySelector(`.cell[data-id="${id}"] .cell-offline .txt`);
  if (el) el.textContent = text;
}

/** 同步各格星标状态（收藏后按钮加 on 类：星形填充为金色；内嵌格页内按钮不回显状态） */
export function updateFavStates(): void {
  dom.stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    const btn = el.querySelector<HTMLElement>('.cell-fav');
    if (!btn) return;
    const c = state.cells.find((x) => x.id === Number(el.dataset.id));
    const saved = !!c && state.favorites.some((f) => f.url === c.url);
    btn.classList.toggle('on', saved);
    btn.title = saved ? '已收藏，点击修改别名' : '收藏此直播';
  });
}
