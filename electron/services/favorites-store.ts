import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type {
  FavEntry,
  FavGroup,
  Favorite,
  FavoriteSaveRequest,
  FavoritesReorderRequest,
} from '../../src/shared/types/ipc';
import { readJsonFile, writeJsonFile } from '../../src/shared/lib/json-file';
import { getWin } from '../windows';

/* ---------------- 收藏夹（分组 + 收藏项平级混排；userData/favorites.json v2，跨启动保留） ---------------- */

/** v1 格式的收藏项（无 kind/groupId，迁移时全部转为未分组项） */
interface LegacyFavorite {
  url?: unknown;
  platform?: unknown;
  alias?: unknown;
}

function favoritesPath(): string {
  return path.join(app.getPath('userData'), 'favorites.json');
}

let entriesCache: FavEntry[] | null = null;

/** 逐项校验形状，坏项丢弃（手工编辑/写坏盘自愈） */
function parseEntry(e: unknown): FavEntry | null {
  const v = e as Partial<FavGroup> & Partial<Favorite>;
  if (!v || typeof v !== 'object') return null;
  if (v.kind === 'group') {
    if (typeof v.id !== 'string' || typeof v.name !== 'string') return null;
    return { kind: 'group', id: v.id, name: v.name, collapsed: !!v.collapsed };
  }
  if (
    v.kind === 'item' &&
    typeof v.url === 'string' &&
    (v.platform === 'bilibili' || v.platform === 'douyin') &&
    typeof v.alias === 'string'
  ) {
    return typeof v.groupId === 'string'
      ? { kind: 'item', url: v.url, platform: v.platform, alias: v.alias, groupId: v.groupId }
      : { kind: 'item', url: v.url, platform: v.platform, alias: v.alias };
  }
  return null;
}

function loadEntries(): FavEntry[] {
  const raw = readJsonFile<{ entries?: unknown[]; items?: LegacyFavorite[] }>(favoritesPath());
  if (!raw) return [];
  if (Array.isArray(raw.entries)) {
    const out: FavEntry[] = [];
    for (const e of raw.entries) {
      const parsed = parseEntry(e);
      if (parsed) out.push(parsed);
    }
    return out;
  }
  // v1 迁移：旧 items 全部转为未分组收藏项（首次保存时升级为 v2 落盘）
  if (Array.isArray(raw.items)) {
    const out: FavEntry[] = [];
    for (const it of raw.items) {
      const parsed = parseEntry({ ...it, kind: 'item' });
      if (parsed) out.push(parsed);
    }
    return out;
  }
  return [];
}

export function getFavoriteEntries(): FavEntry[] {
  if (!entriesCache) entriesCache = loadEntries();
  return entriesCache;
}

function saveFavorites(): void {
  writeJsonFile(favoritesPath(), { version: 2, entries: getFavoriteEntries() });
}

export function pushFavorites(): void {
  getWin()?.webContents.send('favorites:update', { entries: getFavoriteEntries() });
}

/** 保存收藏（按 url 去重，存在即改名；不改变已有条目的分组归属，新条目未分组追加到末尾） */
export function saveFavorite(f: FavoriteSaveRequest): void {
  const alias = f.alias.trim().slice(0, 40);
  const list = getFavoriteEntries();
  const i = list.findIndex((x) => x.kind === 'item' && x.url === f.url);
  if (i >= 0) {
    const existing = list[i];
    if (existing.kind === 'item') list[i] = { ...existing, platform: f.platform, alias };
  } else {
    list.push({ kind: 'item', url: f.url, platform: f.platform, alias });
  }
  saveFavorites();
  pushFavorites();
}

export function removeFavorite(url: string): void {
  const list = getFavoriteEntries();
  const i = list.findIndex((x) => x.kind === 'item' && x.url === url);
  if (i < 0) return;
  list.splice(i, 1);
  saveFavorites();
  pushFavorites();
}

export function createGroup(name: string): void {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return;
  getFavoriteEntries().push({ kind: 'group', id: `g-${randomUUID().slice(0, 8)}`, name: trimmed, collapsed: false });
  saveFavorites();
  pushFavorites();
}

export function renameGroup(id: string, name: string): void {
  const trimmed = name.trim().slice(0, 40);
  const g = getFavoriteEntries().find((x): x is FavGroup => x.kind === 'group' && x.id === id);
  if (!g || !trimmed) return;
  g.name = trimmed;
  saveFavorites();
  pushFavorites();
}

/** 删除分组：级联删除组内全部收藏项 */
export function deleteGroup(id: string): void {
  const list = getFavoriteEntries();
  const next = list.filter((x) => !(x.kind === 'group' && x.id === id) && !(x.kind === 'item' && x.groupId === id));
  if (next.length === list.length) return;
  list.splice(0, list.length, ...next);
  saveFavorites();
  pushFavorites();
}

export function setGroupCollapsed(id: string, collapsed: boolean): void {
  const g = getFavoriteEntries().find((x): x is FavGroup => x.kind === 'group' && x.id === id);
  if (!g || g.collapsed === collapsed) return;
  g.collapsed = collapsed;
  saveFavorites();
  pushFavorites();
}

/**
 * 拖拽后的全量重排（渲染层拖动后按界面顺序上报）：
 * 按 id/url 匹配现有条目，groupId 仅接受指向现存分组的值；
 * 未提及的条目按原顺序沉底，防并发丢数据；顺序与归属均未变则不落盘。
 */
export function reorderFavorites(req: FavoritesReorderRequest): void {
  const list = getFavoriteEntries();
  const groupIds = new Set(list.filter((x): x is FavGroup => x.kind === 'group').map((g) => g.id));
  const byUrl = new Map(list.filter((x): x is Favorite => x.kind === 'item').map((x) => [x.url, x]));
  const next: FavEntry[] = [];
  const usedGroups = new Set<string>();
  const usedUrls = new Set<string>();
  for (const d of req) {
    if (d.kind === 'group') {
      const g = list.find((x): x is FavGroup => x.kind === 'group' && x.id === d.id);
      if (g && !usedGroups.has(g.id)) {
        next.push(g);
        usedGroups.add(g.id);
      }
    } else {
      const it = byUrl.get(d.url);
      if (it && !usedUrls.has(it.url)) {
        const groupId = d.groupId && groupIds.has(d.groupId) ? d.groupId : undefined;
        next.push({ ...it, groupId });
        usedUrls.add(it.url);
      }
    }
  }
  for (const e of list) {
    if (e.kind === 'group' ? !usedGroups.has(e.id) : !usedUrls.has(e.url)) next.push(e);
  }
  const same =
    next.length === list.length &&
    next.every((e, i) => {
      const o = list[i];
      if (e.kind === 'group' && o.kind === 'group') return e.id === o.id;
      if (e.kind === 'item' && o.kind === 'item') return e.url === o.url && e.groupId === o.groupId;
      return false;
    });
  if (same) return;
  list.splice(0, list.length, ...next);
  saveFavorites();
  pushFavorites();
}
