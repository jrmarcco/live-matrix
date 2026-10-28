import { detectLiveRoom, PLATFORM_LABEL } from './shared/lib/platforms';
import { ICONS } from './shared/lib/icons';
import type { FavGroup, Favorite, FavoritesReorderRequest, Platform } from './shared/types/ipc';
import { dom } from './dom';
import { beginAddStream, closeModal } from './add-dialog';
import { CHIP_ICON } from './login-chips';
import { MAX_CELLS, state, type Cell } from './state';

/* ---------------- 收藏夹：工具栏面板（分组混排/拖拽排序/拖入分组）+ 别名与分组名弹窗 ---------------- */

/** 工具栏「收藏」按钮：星形图标（米白原图，不反色）+ 文字 */
document.getElementById('favBtn')!.innerHTML = `<img src="${ICONS.star}" alt="" draggable="false" />收藏`;

/** 面板头部按钮图标（build/ 下 PNG 内嵌 data URL，黑色图形由 CSS 反色为白） */
const headIcon = (icon: string): string => `<img src="${icon}" alt="" draggable="false" />`;
document.getElementById('favGroupAdd')!.innerHTML = headIcon(ICONS.folder);
document.getElementById('favImport')!.innerHTML = headIcon(ICONS.import);
document.getElementById('favExport')!.innerHTML = headIcon(ICONS.export);
document.getElementById('favClose')!.innerHTML = headIcon(ICONS.close);

function favItems(): Favorite[] {
  return state.favorites.filter((e): e is Favorite => e.kind === 'item');
}

/* 分组展开箭头（收起朝右，展开旋转朝下） */
const SVG_CHEVRON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" /></svg>';

/* ---------------- 分组名输入弹窗（新建/重命名共用） ---------------- */

let groupDialog: { type: 'create' } | { type: 'rename'; id: string; oldName: string } | null = null;

function openGroupDialog(mode: typeof groupDialog): void {
  groupDialog = mode;
  dom.groupTitle.textContent = mode?.type === 'rename' ? '重命名分组' : '新建分组';
  dom.groupInput.value = mode?.type === 'rename' ? mode.oldName : '';
  closeModal();
  closeFavPanel();
  window.lm.setModalVisible(true);
  dom.groupBack.classList.remove('hidden');
  dom.groupInput.focus();
  dom.groupInput.select();
}

export function closeGroupDialog(): void {
  dom.groupBack.classList.add('hidden');
  groupDialog = null;
  window.lm.setModalVisible(false);
}

document.getElementById('groupCancel')!.addEventListener('click', closeGroupDialog);
dom.groupBack.addEventListener('pointerdown', (e) => {
  if (e.target === dom.groupBack) closeGroupDialog();
});
dom.groupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = dom.groupInput.value.trim();
  if (!name || !groupDialog) return;
  if (groupDialog.type === 'create') window.lm.createGroup(name);
  else window.lm.renameGroup(groupDialog.id, name);
  closeGroupDialog();
});

/* ---------------- 面板开闭 ---------------- */

/** 正在收藏的直播（null = 弹窗未开） */
let pendingFav: { url: string; platform: Platform } | null = null;

function openFavPanel(): void {
  dom.favWrap.classList.remove('hidden');
  // 内嵌直播视图层级高于 DOM，面板期间隐藏（与对话框同机制）
  window.lm.setModalVisible(true);
}

export function closeFavPanel(): void {
  dom.favWrap.classList.add('hidden');
  window.lm.setModalVisible(false);
}

document.getElementById('favBtn')!.addEventListener('click', () => {
  if (dom.favWrap.classList.contains('hidden')) openFavPanel();
  else closeFavPanel();
});
document.getElementById('favClose')!.addEventListener('click', closeFavPanel);
document.getElementById('favShade')!.addEventListener('click', closeFavPanel);
// 新建分组：弹出分组名输入框
document.getElementById('favGroupAdd')!.addEventListener('click', () => openGroupDialog({ type: 'create' }));

// 导入收藏（合并式：重复项跳过，同名分组并入现有分组）
document.getElementById('favImport')!.addEventListener(
  'click',
  () =>
    void window.lm.importFavorites().then((r) => {
      if (!r.ok) {
        if (r.reason === 'badfile') window.alert('无法识别该文件：请选择 LiveMatrix 导出的收藏文件（JSON）');
        return;
      }
      window.alert(
        `导入完成：新增 ${r.addedItems} 项收藏、${r.addedGroups} 个分组` +
          (r.skipped ? `，跳过重复 ${r.skipped} 项` : ''),
      );
    }),
);

// 导出收藏（含分组结构与归属）
document.getElementById('favExport')!.addEventListener(
  'click',
  () =>
    void window.lm.exportFavorites().then((p) => {
      if (p) window.alert(`已导出 ${favItems().length} 项收藏（含分组）到：\n${p}`);
    }),
);

/* ---------------- 渲染 ---------------- */

/** 正在拖动的收藏项 url / 分组 id（null = 未拖动） */
let dragFavUrl: string | null = null;
let dragGid: string | null = null;

function hasGroup(id: string): boolean {
  return state.favorites.some((e) => e.kind === 'group' && e.id === id);
}

function makeItemRow(f: Favorite, groupId: string | undefined): HTMLElement {
  const item = document.createElement('div');
  item.className = groupId ? 'fav-item in-group' : 'fav-item';
  item.draggable = true;
  item.dataset.url = f.url;
  // 归属分组随拖放落点更新（persist 时直接读取），渲染时为当前归属
  item.dataset.gid = groupId ?? '';
  const tag = PLATFORM_LABEL[f.platform];
  item.innerHTML = `<span class="fav-grip" title="拖动调整顺序">⠿</span><img class="tag" src="${CHIP_ICON[f.platform]}" alt="${tag}" title="${tag}" draggable="false" /><span class="alias"></span><span class="fav-del" title="移除收藏"><img src="${ICONS.close}" alt="" draggable="false" /></span>`;
  (item.querySelector('.alias') as HTMLElement).textContent = f.alias;
  item.title = `点击添加：${tag} · ${f.alias}（拖动可调整顺序，拖到分组行可移入分组）`;
  item.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.fav-del')) {
      window.lm.removeFavorite(f.url);
      return;
    }
    void addFavoriteToStage(f);
  });
  item.addEventListener('dragstart', (e) => {
    dragFavUrl = f.url;
    dragGid = null;
    item.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', f.url);
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    clearDropHint();
    if (dragFavUrl) persistFavOrder();
    dragFavUrl = null;
  });
  return item;
}

function makeGroupRow(g: FavGroup): HTMLElement {
  const row = document.createElement('div');
  const count = state.favorites.filter((e) => e.kind === 'item' && e.groupId === g.id).length;
  row.className = g.collapsed ? 'fav-group collapsed' : 'fav-group';
  row.dataset.gid = g.id;
  row.draggable = true;
  row.title = '点击展开/收起分组；拖动可调整分组顺序';
  row.innerHTML = `
    <span class="fav-grip" title="拖动调整顺序">⠿</span>
    <span class="chev">${SVG_CHEVRON}</span>
    <span class="gname"></span>
    <span class="gcount">${count}</span>
    <button class="g-op g-rename" type="button" title="重命名分组"><img src="${ICONS.edit}" alt="" draggable="false" /></button>
    <button class="g-op g-del" type="button" title="删除分组（连同其中收藏）"><img src="${ICONS.delete}" alt="" draggable="false" /></button>`;
  (row.querySelector('.gname') as HTMLElement).textContent = g.name;
  // 点击分组行（非按钮）：展开/收起
  row.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    window.lm.toggleGroup(g.id, !g.collapsed);
  });
  row
    .querySelector('.g-rename')!
    .addEventListener('click', () => openGroupDialog({ type: 'rename', id: g.id, oldName: g.name }));
  row.querySelector('.g-del')!.addEventListener('click', () => {
    const msg = count > 0 ? `删除分组「${g.name}」将同时移除其中 ${count} 项收藏，确定？` : `删除分组「${g.name}」？`;
    if (window.confirm(msg)) window.lm.deleteGroup(g.id);
  });
  row.addEventListener('dragstart', (e) => {
    dragGid = g.id;
    dragFavUrl = null;
    row.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', g.id);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    clearDropHint();
    if (dragGid) persistFavOrder();
    dragGid = null;
  });
  return row;
}

export function renderFavList(): void {
  dom.favList.innerHTML = '';
  if (!state.favorites.length) {
    const empty = document.createElement('div');
    empty.className = 'fav-empty';
    empty.textContent = '暂无收藏';
    dom.favList.appendChild(empty);
    return;
  }
  // 按条目顺序渲染：分组渲染行头（展开时其后跟组内项，顺序取条目数组序）；
  // 有归属的项只渲染在其分组块内，孤儿项（分组已删）自愈为平级显示
  for (const entry of state.favorites) {
    if (entry.kind === 'group') {
      dom.favList.appendChild(makeGroupRow(entry));
      if (!entry.collapsed) {
        for (const it of state.favorites) {
          if (it.kind === 'item' && it.groupId === entry.id) dom.favList.appendChild(makeItemRow(it, it.groupId));
        }
      }
    } else if (!entry.groupId || !hasGroup(entry.groupId)) {
      dom.favList.appendChild(makeItemRow(entry, undefined));
    }
  }
}

/* ---------------- 拖拽：项排序 / 拖入分组 / 分组排序 ---------------- */

function clearDropHint(): void {
  dom.favList.querySelectorAll<HTMLElement>('.fav-group.droptarget').forEach((el) => el.classList.remove('droptarget'));
}

/** 按指针在目标行的上/下半区决定插到其前/后 */
function insertNearRow(overRow: HTMLElement, dragging: HTMLElement, e: DragEvent): void {
  const r = overRow.getBoundingClientRect();
  if (e.clientY > r.top + r.height / 2) overRow.after(dragging);
  else overRow.before(dragging);
}

dom.favList.addEventListener('dragover', (e) => {
  if (!dragFavUrl && !dragGid) return;
  const dragging = dom.favList.querySelector<HTMLElement>('.dragging');
  if (!dragging) return;
  e.preventDefault();
  clearDropHint();
  const target = e.target as HTMLElement;

  if (dragGid) {
    // 分组排序：只相对分组头/未分组条目插入；组内条目不是有效落点
    const overRow = target.closest<HTMLElement>('.fav-group, .fav-item:not(.in-group)');
    if (!overRow || overRow === dragging) {
      const rows = [...dom.favList.querySelectorAll<HTMLElement>('.fav-group, .fav-item:not(.in-group)')].filter(
        (r) => r !== dragging,
      );
      const last = rows.at(-1);
      if (last && e.clientY > last.getBoundingClientRect().bottom) dom.favList.appendChild(dragging);
      return;
    }
    insertNearRow(overRow, dragging, e);
    return;
  }

  // 收藏项拖动：悬停分组头 = 移入该分组（放到组内末尾；空/收起组则紧跟分组头）
  const overGroup = target.closest<HTMLElement>('.fav-group');
  if (overGroup && overGroup !== dragging) {
    overGroup.classList.add('droptarget');
    const gid = overGroup.dataset.gid!;
    const members = [...dom.favList.querySelectorAll<HTMLElement>(`.fav-item[data-gid="${CSS.escape(gid)}"]`)].filter(
      (r) => r !== dragging,
    );
    const last = members.at(-1);
    if (last) last.after(dragging);
    else overGroup.after(dragging);
    dragging.dataset.gid = gid;
    return;
  }
  const overItem = target.closest<HTMLElement>('.fav-item');
  if (!overItem || overItem === dragging) {
    // 列表末尾空白区 → 拖到最后一项之后并回到未分组（顶层）
    const rows = [...dom.favList.querySelectorAll<HTMLElement>('.fav-item')].filter((r) => r !== dragging);
    const last = rows.at(-1);
    if (last && e.clientY > last.getBoundingClientRect().bottom) {
      dom.favList.appendChild(dragging);
      dragging.dataset.gid = '';
    }
    return;
  }
  // 悬停普通条目：插到其前/后，并加入该条目所在分组（与相邻项同组）
  insertNearRow(overItem, dragging, e);
  dragging.dataset.gid = overItem.dataset.gid ?? '';
});

/** 拖动结束按 DOM 顺序上报全量重排；收起分组内的条目不可见，按原顺序回插到其分组之后 */
function persistFavOrder(): void {
  const collapsedMembers = new Map<string, Favorite[]>();
  for (const e of state.favorites) {
    if (e.kind === 'group' && e.collapsed) {
      collapsedMembers.set(
        e.id,
        state.favorites.filter((x): x is Favorite => x.kind === 'item' && x.groupId === e.id),
      );
    }
  }
  const req: FavoritesReorderRequest = [];
  for (const row of [...dom.favList.children] as HTMLElement[]) {
    if (row.classList.contains('fav-group')) {
      const gid = row.dataset.gid!;
      req.push({ kind: 'group', id: gid });
      const hidden = collapsedMembers.get(gid);
      if (hidden) for (const it of hidden) req.push({ kind: 'item', url: it.url, groupId: it.groupId });
    } else if (row.classList.contains('fav-item')) {
      const gid = row.dataset.gid || undefined;
      req.push(gid ? { kind: 'item', url: row.dataset.url!, groupId: gid } : { kind: 'item', url: row.dataset.url! });
    }
  }
  const current: FavoritesReorderRequest = state.favorites.map((e) =>
    e.kind === 'group'
      ? { kind: 'group', id: e.id }
      : { kind: 'item', url: e.url, ...(e.groupId ? { groupId: e.groupId } : {}) },
  );
  if (JSON.stringify(req) === JSON.stringify(current)) return;
  window.lm.reorderFavorites(req);
}

/* ---------------- 添加到舞台 / 收藏弹窗 ---------------- */

function addFavoriteToStage(f: Favorite): void {
  if (state.cells.length >= MAX_CELLS) return;
  // 历史收藏里可能存有非直播间地址：不放行（不会打开原始页面）
  if (!detectLiveRoom(f.url)) return;
  // 收藏面板立即收起，加载过程同样由占位格遮罩反馈
  closeFavPanel();
  beginAddStream(f.url, f.platform);
}

export function openFavModal(c: Cell): void {
  pendingFav = { url: c.url, platform: c.platform };
  const existing = favItems().find((f) => f.url === c.url);
  dom.favAlias.value = existing ? existing.alias : `收藏${favItems().length + 1}`;
  closeModal();
  closeFavPanel();
  window.lm.setModalVisible(true);
  dom.favBack.classList.remove('hidden');
  dom.favAlias.focus();
  dom.favAlias.select();
}

export function closeFavModal(): void {
  dom.favBack.classList.add('hidden');
  pendingFav = null;
  window.lm.setModalVisible(false);
}

document.getElementById('favCancel')!.addEventListener('click', closeFavModal);
dom.favBack.addEventListener('pointerdown', (e) => {
  if (e.target === dom.favBack) closeFavModal();
});
dom.favForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const alias = dom.favAlias.value.trim();
  if (!alias || !pendingFav) return;
  window.lm.saveFavorite({ ...pendingFav, alias });
  closeFavModal();
});
