import { dialog, ipcMain } from 'electron';
import type { FavoriteSaveRequest, FavoritesImportResult, FavoritesReorderRequest } from '../../src/shared/types/ipc';
import { readJsonFile, writeJsonFile } from '../../src/shared/lib/json-file';
import {
  createGroup,
  deleteGroup,
  getFavoriteEntries,
  importFavorites,
  removeFavorite,
  renameGroup,
  reorderFavorites,
  saveFavorite,
  setGroupCollapsed,
} from '../services/favorites-store';
import { getWin } from '../windows';

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

  // 导出收藏到 JSON 文件（原生保存对话框）；返回写入路径，取消返回 null
  ipcMain.handle('favorites:export', async (): Promise<string | null> => {
    const win = getWin();
    if (!win) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出收藏夹',
      defaultPath: 'livematrix-favorites.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    writeJsonFile(filePath, { version: 2, exportedAt: new Date().toISOString(), entries: getFavoriteEntries() });
    return filePath;
  });

  // 从 JSON 文件合并式导入（原生打开对话框）；取消/格式不识别经 FavoritesImportResult 区分
  ipcMain.handle('favorites:import', async (): Promise<FavoritesImportResult> => {
    const win = getWin();
    if (!win) return { ok: false, reason: 'canceled' };
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入收藏夹',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths?.[0]) return { ok: false, reason: 'canceled' };
    return importFavorites(readJsonFile<unknown>(filePaths[0]));
  });
}
