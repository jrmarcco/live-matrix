import { ipcMain } from 'electron';
import type { FavoriteSaveRequest, FavoritesReorderRequest } from '../../src/shared/types/ipc';
import {
  createGroup,
  deleteGroup,
  getFavoriteEntries,
  removeFavorite,
  renameGroup,
  reorderFavorites,
  saveFavorite,
  setGroupCollapsed,
} from '../services/favorites-store';

/* ---------------- 收藏夹（业务规则在 services/favorites-store，此处只做形状校验） ---------------- */

/** 收藏项拖拽描述符：{ kind:'item', url, groupId? } 或 { kind:'group', id } */
function isReorderRequest(v: unknown): v is FavoritesReorderRequest {
  if (!Array.isArray(v)) return false;
  return v.every((d) => {
    if (!d || typeof d !== 'object') return false;
    const x = d as { kind?: unknown; id?: unknown; url?: unknown; groupId?: unknown };
    if (x.kind === 'group') return typeof x.id === 'string';
    if (x.kind === 'item') {
      return typeof x.url === 'string' && (x.groupId === undefined || typeof x.groupId === 'string');
    }
    return false;
  });
}

export function registerFavoritesIpc(): void {
  ipcMain.handle('favorites:get', () => getFavoriteEntries());

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
    saveFavorite(f);
  });

  ipcMain.on('favorites:remove', (_e, url: unknown) => {
    if (typeof url !== 'string') return;
    removeFavorite(url);
  });

  // 拖拽排序（渲染层按界面顺序全量上报，含移入分组）
  ipcMain.on('favorites:reorder', (_e, v: unknown) => {
    if (!isReorderRequest(v)) return;
    reorderFavorites(v);
  });

  ipcMain.on('favorites:group-create', (_e, name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return;
    createGroup(name);
  });

  ipcMain.on('favorites:group-rename', (_e, v: unknown) => {
    const x = v as { id?: unknown; name?: unknown };
    if (!x || typeof x.id !== 'string' || typeof x.name !== 'string' || !x.name.trim()) return;
    renameGroup(x.id, x.name);
  });

  ipcMain.on('favorites:group-delete', (_e, v: unknown) => {
    const x = v as { id?: unknown };
    if (!x || typeof x.id !== 'string') return;
    deleteGroup(x.id);
  });

  ipcMain.on('favorites:group-toggle', (_e, v: unknown) => {
    const x = v as { id?: unknown; collapsed?: unknown };
    if (!x || typeof x.id !== 'string' || typeof x.collapsed !== 'boolean') return;
    setGroupCollapsed(x.id, x.collapsed);
  });
}
