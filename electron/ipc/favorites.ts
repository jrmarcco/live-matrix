import { ipcMain } from 'electron';
import type { FavoriteSaveRequest } from '../../src/shared/types/ipc';
import { getFavorites, removeFavorite, reorderFavorites, saveFavorite } from '../services/favorites-store';

/* ---------------- 收藏夹（业务规则在 services/favorites-store，此处只做形状校验） ---------------- */

export function registerFavoritesIpc(): void {
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
    saveFavorite(f);
  });

  ipcMain.on('favorites:remove', (_e, url: unknown) => {
    if (typeof url !== 'string') return;
    removeFavorite(url);
  });

  // 收藏排序（渲染层拖动后按 url 全量上报）
  ipcMain.on('favorites:reorder', (_e, urls: unknown) => {
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) return;
    reorderFavorites(urls);
  });
}
