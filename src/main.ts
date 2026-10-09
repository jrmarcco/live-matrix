import { detectPlatform, PLATFORM_LABEL, PLATFORMS } from '../electron/platforms';
import type { InitPayload, LayoutItem, Platform, SavedConfig } from '../electron/types';

/** 1 主 + 7 副 = 8 个槽位；右侧副窗口网格为 2 列 × 4 行 */
const MAX_CELLS = 8;

interface Cell {
  id: number;
  url: string;
  platform: Platform;
  title?: string;
  error?: string;
}

let cells: Cell[] = []; // index 0 为主窗口槽位（左上角大画面，有声）
const loginState: Record<Platform, boolean> = { bilibili: false, douyin: false };

const stage = document.getElementById('stage')!;
const addBtn = document.getElementById('addBtn') as HTMLButtonElement;
const subCount = document.getElementById('subCount')!;
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

/* ---------------- 工具 ---------------- */

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.host + (x.pathname === '/' ? '' : x.pathname);
  } catch {
    return u;
  }
}

function cellTitle(c: Cell): string {
  if (c.error) return `⚠ ${c.error}`;
  return c.title || shortUrl(c.url);
}

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

let resizePending = false;
window.addEventListener('resize', () => {
  if (dragState) finishDrag();
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    sendLayout();
  });
});

/* ---------------- 配置持久化（防抖） ---------------- */

let saveTimer: number | undefined;
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const cfg: SavedConfig = {
      version: 1,
      slots: cells.map((c) => ({ url: c.url, platform: c.platform })),
    };
    window.lm.saveConfig(cfg);
  }, 400);
}

/* ---------------- 渲染 ---------------- */

function makeStreamCell(c: Cell, isMain: boolean): HTMLElement {
  const el = document.createElement('section');
  el.className = isMain ? 'cell slot-main' : 'cell';
  el.dataset.id = String(c.id);
  const tag = c.platform === 'bilibili' ? 'B站' : '抖音';
  el.innerHTML = `
    <div class="cell-head">
      <span class="grip" title="按住拖动到其他窗口可互换位置">⠿</span>
      <span class="tag ${c.platform}">${tag}</span>
      <span class="title"></span>
      <span class="mute-badge">${isMain ? '🔊 主窗口' : '🔇 静音'}</span>
      ${isMain ? '' : '<button class="hb" data-act="main" title="设为主窗口（接管声音）">主</button>'}
      <button class="hb" data-act="close" title="关闭">×</button>
    </div>
    <div class="cell-body"></div>`;
  (el.querySelector('.title') as HTMLElement).textContent = cellTitle(c);

  el.querySelector('.cell-head')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const i = cells.findIndex((x) => x.id === c.id);
    if (i < 0) return;
    if (btn.dataset.act === 'close') removeCell(i);
    else if (btn.dataset.act === 'main') swapCells(i, 0);
  });
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
    '<div class="ph-inner"><span class="ph-plus">◧</span><span>主窗口<br>添加第一个直播后在此播放（有声）</span></div>';
  el.addEventListener('click', openModal);
  return el;
}

function render(): void {
  stage.innerHTML = '';
  if (cells.length === 0) {
    stage.appendChild(makeMainPlaceholder());
  } else {
    cells.forEach((c, i) => stage.appendChild(makeStreamCell(c, i === 0)));
  }
  // 副窗口共 7 格（右侧一列 3 格 + 底部一行 4 格），未用的显示占位块
  const subs = Math.max(cells.length - 1, 0);
  for (let i = subs; i < 7; i++) {
    stage.appendChild(makeSubPlaceholder());
  }
  subCount.textContent = `${subs}/7`;
  addBtn.disabled = cells.length >= MAX_CELLS;
  addBtn.title = addBtn.disabled ? '副窗口已达上限（7 个）' : '添加直播窗口';
  requestAnimationFrame(sendLayout);
}

/* ---------------- 槽位操作 ---------------- */

function removeCell(i: number): void {
  const [c] = cells.splice(i, 1);
  if (!c) return;
  window.lm.closeStream(c.id);
  render();
  scheduleSave();
}

function swapCells(i: number, j: number): void {
  if (i === j || i < 0 || j < 0 || i >= cells.length || j >= cells.length) return;
  [cells[i], cells[j]] = [cells[j], cells[i]];
  render();
  scheduleSave();
}

/* ---------------- 拖拽置换 ----------------
 * 直播画面是独立的 WebContentsView，叠放在 UI 层之上并会拦截鼠标。
 * 拖拽开始时主进程在最顶层显示一个透明覆盖视图接管全部鼠标事件，
 * 其 move/up/cancel 事件经主进程中继回 UI 层完成命中测试与置换。
 * 置换只改 bounds，不重载页面，直播不中断。
 */

interface DragState {
  id: number;
  sx: number;
  sy: number;
  moved: boolean;
  targetId: number;
  rects: { id: number; x1: number; y1: number; x2: number; y2: number }[];
}

let dragState: DragState | null = null;
let dragWatchdog: number | undefined;

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !(e.target instanceof HTMLElement)) return;
  const head = e.target.closest('.cell-head');
  if (!head || e.target.closest('button')) return;
  const cellEl = head.closest('.cell') as HTMLElement | null;
  const id = Number(cellEl?.dataset.id ?? 0);
  if (!id || dragState) return;

  dragState = { id, sx: e.clientX, sy: e.clientY, moved: false, targetId: 0, rects: [] };
  window.lm.dragBegin();
  // 渲染层看门狗：覆盖层事件链断裂时 10s 后自动结束拖拽
  window.clearTimeout(dragWatchdog);
  dragWatchdog = window.setTimeout(() => {
    if (dragState) finishDrag();
  }, 10000);
  e.preventDefault();
});

window.lm.onDragOverlay((v) => {
  if (!dragState) return;
  if (v.type === 'move') onDragMove(v.x, v.y);
  else if (v.type === 'up') finishDrag(v.x, v.y);
  else finishDrag();
});

function onDragMove(x: number, y: number): void {
  const st = dragState;
  if (!st) return;
  if (!st.moved) {
    if (Math.hypot(x - st.sx, y - st.sy) < 5) return;
    st.moved = true;
    document.body.classList.add('dragging');
    st.rects = [...stage.querySelectorAll<HTMLElement>('.cell[data-id]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: Number(el.dataset.id), x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
    });
  }
  setDropTarget(st, hitTest(st, x, y));
}

function finishDrag(x?: number, y?: number): void {
  const st = dragState;
  dragState = null;
  window.clearTimeout(dragWatchdog);
  window.lm.dragEnd();
  document.body.classList.remove('dragging');
  stage.querySelectorAll<HTMLElement>('.cell.drop-target').forEach((el) =>
    el.classList.remove('drop-target'),
  );
  if (st && st.moved && typeof x === 'number' && typeof y === 'number') {
    const t = hitTest(st, x, y);
    if (t && t !== st.id) {
      const i = cells.findIndex((c) => c.id === st.id);
      const j = cells.findIndex((c) => c.id === t);
      swapCells(i, j);
    }
  }
}

// 覆盖层异常时的兜底：光标仍在 UI 层可接收时直接结束拖拽
window.addEventListener('pointerup', (e) => {
  if (dragState) finishDrag(e.clientX, e.clientY);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dragState) finishDrag();
});
window.addEventListener('blur', () => {
  if (dragState) finishDrag();
});

function hitTest(st: DragState, x: number, y: number): number {
  for (const r of st.rects) {
    if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) return r.id;
  }
  return 0;
}

function setDropTarget(st: DragState, id: number): void {
  if (st.targetId === id) return;
  stage.querySelectorAll<HTMLElement>('.cell.drop-target').forEach((el) =>
    el.classList.remove('drop-target'),
  );
  st.targetId = id;
  if (id && id !== st.id) {
    stage.querySelector(`.cell[data-id="${id}"]`)?.classList.add('drop-target');
  }
}

/* ---------------- 添加对话框 ---------------- */

function openModal(): void {
  if (cells.length >= MAX_CELLS) return;
  modalBack.classList.remove('hidden');
  urlInput.value = '';
  updateHint('');
  addErr.textContent = '';
  urlInput.focus();
}

function closeModal(): void {
  modalBack.classList.add('hidden');
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
addBtn.addEventListener('click', openModal);
document.getElementById('cancelBtn')!.addEventListener('click', closeModal);
modalBack.addEventListener('pointerdown', (e) => {
  if (e.target === modalBack) closeModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalBack.classList.contains('hidden')) closeModal();
});

addForm.addEventListener('submit', async (e) => {
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
  const slot = await window.lm.addStream(normalized, p);
  if (!slot) {
    addErr.textContent = '创建窗口失败，请重试';
    return;
  }
  cells.push(slot);
  render();
  scheduleSave();
  closeModal();
});

/* ---------------- 登录状态 ---------------- */

function renderChips(): void {
  loginChips.innerHTML = '';
  for (const p of PLATFORMS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = loginState[p] ? `chip ${p} on` : `chip ${p}`;
    b.innerHTML = `<span class="dot"></span>${PLATFORM_LABEL[p]}<em>${
      loginState[p] ? '已登录' : '未登录'
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
  if (!c) return;
  fn(c);
  const el = stage.querySelector<HTMLElement>(`.cell[data-id="${id}"] .title`);
  if (el) el.textContent = cellTitle(c);
}

window.lm.onInit((payload: InitPayload) => {
  cells = payload.slots.map((s) => ({ ...s }));
  for (const s of payload.logins) loginState[s.platform] = s.loggedIn;
  render();
  renderChips();
});

window.lm.onLoginStatus((s) => {
  loginState[s.platform] = s.loggedIn;
  renderChips();
});

window.lm.onStreamTitle((v) => updateCellDom(v.id, (c) => (c.title = v.title)));
window.lm.onStreamError((v) => updateCellDom(v.id, (c) => (c.error = v.message.slice(0, 40))));
window.lm.onStreamDead((v) => {
  const i = cells.findIndex((c) => c.id === v.id);
  if (i >= 0) removeCell(i);
});

/* ---------------- 启动 ---------------- */

render();
renderChips();
window.lm.ready();
