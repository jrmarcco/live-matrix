import { detectLiveRoom, PLATFORM_LABEL } from './shared/lib/platforms';
import { ICONS } from './shared/lib/icons';
import type { Favorite, Platform } from './shared/types/ipc';
import { dom } from './dom';
import { beginAddStream, closeModal } from './add-dialog';
import { CHIP_ICON } from './login-chips';
import { MAX_CELLS, state, type Cell } from './state';

/* ---------------- 收藏夹：工具栏面板（列表/拖拽排序）+ 别名弹窗 ---------------- */

/** 工具栏「收藏」按钮：星形图标（米白原图，不反色）+ 文字 */
document.getElementById('favBtn')!.innerHTML = `<img src="${ICONS.star}" alt="" draggable="false" />收藏`;

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

/** 正在拖动的收藏项 url（null = 未拖动） */
let dragFavUrl: string | null = null;

export function renderFavList(): void {
  dom.favList.innerHTML = '';
  if (!state.favorites.length) {
    const empty = document.createElement('div');
    empty.className = 'fav-empty';
    empty.textContent = '暂无收藏';
    dom.favList.appendChild(empty);
    return;
  }
  for (const f of state.favorites) {
    const item = document.createElement('div');
    item.className = 'fav-item';
    item.draggable = true;
    item.dataset.url = f.url;
    const tag = PLATFORM_LABEL[f.platform];
    item.innerHTML = `<span class="fav-grip" title="拖动调整顺序">⠿</span><img class="tag" src="${CHIP_ICON[f.platform]}" alt="${tag}" title="${tag}" draggable="false" /><span class="alias"></span><span class="fav-del" title="移除收藏">×</span>`;
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
    dom.favList.appendChild(item);
  }
}

// 拖动经过其他条目时实时移动 DOM（半透明随行），松手后统一持久化
dom.favList.addEventListener('dragover', (e) => {
  if (!dragFavUrl) return;
  const dragging = dom.favList.querySelector<HTMLElement>('.fav-item.dragging');
  if (!dragging) return;
  e.preventDefault();
  const overItem = (e.target as HTMLElement).closest?.('.fav-item') as HTMLElement | null;
  if (!overItem || overItem === dragging) {
    // 列表末尾空白区 → 拖到最后一项之后；条目间隙太小，忽略避免跳动
    const last = [...dom.favList.querySelectorAll<HTMLElement>('.fav-item:not(.dragging)')].pop();
    if (!overItem && last && e.clientY > last.getBoundingClientRect().bottom) {
      dom.favList.appendChild(dragging);
    }
    return;
  }
  const r = overItem.getBoundingClientRect();
  if (e.clientY > r.top + r.height / 2) overItem.after(dragging);
  else overItem.before(dragging);
});

/** 按 DOM 顺序上报新排序；顺序未变则不落盘 */
function persistFavOrder(): void {
  const urls = [...dom.favList.querySelectorAll<HTMLElement>('.fav-item')]
    .map((el) => el.dataset.url)
    .filter((u): u is string => !!u);
  const changed = urls.some((u, i) => state.favorites[i]?.url !== u) || urls.length !== state.favorites.length;
  if (changed) window.lm.reorderFavorites(urls);
}

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
  const existing = state.favorites.find((f) => f.url === c.url);
  dom.favAlias.value = existing ? existing.alias : `收藏${state.favorites.length + 1}`;
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
