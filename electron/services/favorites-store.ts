import * as path from 'node:path';
import { app } from 'electron';
import type { Favorite, FavoriteSaveRequest } from '../../src/shared/types/ipc';
import { readJsonFile, writeJsonFile } from '../../src/shared/lib/json-file';
import { getWin } from '../windows';

/* ---------------- 收藏夹（跨启动持久化，userData/favorites.json，与窗口会话无关） ---------------- */

function favoritesPath(): string {
  return path.join(app.getPath('userData'), 'favorites.json');
}

let favoritesCache: Favorite[] | null = null;

export function getFavorites(): Favorite[] {
  if (!favoritesCache) {
    favoritesCache = [];
    const raw = readJsonFile<{ items?: Favorite[] }>(favoritesPath());
    if (raw && Array.isArray(raw.items)) {
      favoritesCache = raw.items.filter((f) => f && typeof f.url === 'string' && typeof f.alias === 'string');
    }
  }
  return favoritesCache;
}

function saveFavorites(): void {
  writeJsonFile(favoritesPath(), { version: 1, items: getFavorites() });
}

export function pushFavorites(): void {
  getWin()?.webContents.send('favorites:update', { items: getFavorites() });
}

/** 保存收藏（按 url 去重，存在即改名；别名去空白并截断 40 字符） */
export function saveFavorite(f: FavoriteSaveRequest): void {
  const alias = f.alias.trim().slice(0, 40);
  const list = getFavorites();
  const i = list.findIndex((x) => x.url === f.url);
  if (i >= 0) list[i] = { url: f.url, platform: f.platform, alias };
  else list.push({ url: f.url, platform: f.platform, alias });
  saveFavorites();
  pushFavorites();
}

export function removeFavorite(url: string): void {
  const list = getFavorites();
  const i = list.findIndex((x) => x.url === url);
  if (i < 0) return;
  list.splice(i, 1);
  saveFavorites();
  pushFavorites();
}

/** 收藏排序（渲染层拖动后按 url 全量上报）：未知/遗漏条目沉底，防并发丢数据；顺序未变不落盘 */
export function reorderFavorites(urls: string[]): void {
  const list = getFavorites();
  const byUrl = new Map(list.map((f) => [f.url, f]));
  const next: Favorite[] = [];
  for (const u of urls) {
    const f = byUrl.get(u);
    if (f && !next.includes(f)) {
      next.push(f);
      byUrl.delete(u);
    }
  }
  for (const f of byUrl.values()) next.push(f);
  if (next.every((f, i) => list[i] === f)) return;
  list.splice(0, list.length, ...next);
  saveFavorites();
  pushFavorites();
}
