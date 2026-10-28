import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Favorite } from '../../src/shared/types/ipc';

// favorites-store 依赖 electron（app.getPath 定位 userData）与 windows（getWin 推送更新），
// 单测中全部替换：userData 指向每个用例独立的临时目录，推送目标为 null
const mocks = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.dataDir } }));
vi.mock('../windows', () => ({ getWin: () => null }));

// entriesCache 是模块级缓存：每个用例重置模块拿到干净的 store
async function loadStore() {
  vi.resetModules();
  return await import('./favorites-store');
}

/** 写入一份 v1 旧格式收藏文件（迁移用） */
function writeLegacyFile(items: unknown[]): void {
  fs.writeFileSync(path.join(mocks.dataDir, 'favorites.json'), JSON.stringify({ version: 1, items }), 'utf8');
}

function aliases(store: Awaited<ReturnType<typeof loadStore>>): string[] {
  return store
    .getFavoriteEntries()
    .filter((e) => e.kind === 'item')
    .map((f) => f.alias);
}

beforeEach(() => {
  mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-fav-'));
});

describe('favorites-store：条目基础', () => {
  it('无持久化文件时从空列表开始', async () => {
    const store = await loadStore();
    expect(store.getFavoriteEntries()).toEqual([]);
  });

  it('保存按 url 去重（存在即改名）并落盘，重启后可读回', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '第一个' });
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '改名后' });
    store.saveFavorite({ url: 'https://live.douyin.com/2', platform: 'douyin', alias: '抖音' });
    expect(aliases(store)).toEqual(['改名后', '抖音']);

    // 模拟重启：模块缓存重置后从磁盘读回
    const reopened = await loadStore();
    expect(aliases(reopened)).toEqual(['改名后', '抖音']);
    expect(fs.existsSync(path.join(mocks.dataDir, 'favorites.json'))).toBe(true);
  });

  it('别名去空白并截断 40 字符', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/9', platform: 'bilibili', alias: `  ${'很'.repeat(50)}  ` });
    const [f] = store.getFavoriteEntries() as { alias: string }[];
    expect(f.alias).toBe('很'.repeat(40));
  });

  it('损坏的持久化文件按空列表处理（不抛出）', async () => {
    fs.writeFileSync(path.join(mocks.dataDir, 'favorites.json'), '{oops', 'utf8');
    const store = await loadStore();
    expect(store.getFavoriteEntries()).toEqual([]);
  });

  it('v1 旧格式自动迁移为未分组条目（首次保存升级 v2 落盘）', async () => {
    writeLegacyFile([
      { url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '旧A' },
      { url: 'https://live.douyin.com/2', platform: 'douyin', alias: '旧B' },
      'garbage',
    ]);
    const store = await loadStore();
    expect(aliases(store)).toEqual(['旧A', '旧B']);
    expect(store.getFavoriteEntries().every((e) => e.kind === 'item' && !e.groupId)).toBe(true);
    // 触发一次保存后落盘为 v2
    store.saveFavorite({ url: 'https://live.bilibili.com/3', platform: 'bilibili', alias: '新C' });
    const raw = JSON.parse(fs.readFileSync(path.join(mocks.dataDir, 'favorites.json'), 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.entries).toHaveLength(3);
  });

  it('remove 不存在的 url 无副作用', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: 'A' });
    store.removeFavorite('https://live.bilibili.com/404');
    expect(store.getFavoriteEntries()).toHaveLength(1);
    store.removeFavorite('https://live.bilibili.com/1');
    expect(store.getFavoriteEntries()).toEqual([]);
  });
});

describe('favorites-store：分组', () => {
  it('新建分组（名称截断）、重命名、收起状态持久化', async () => {
    const store = await loadStore();
    store.createGroup(`  ${'组'.repeat(50)}  `);
    const [g] = store.getFavoriteEntries() as { kind: string; name: string; id: string }[];
    expect(g.kind).toBe('group');
    expect(g.name).toBe('组'.repeat(40));

    store.renameGroup(g.id, '常看');
    expect((store.getFavoriteEntries()[0] as { name: string }).name).toBe('常看');

    store.setGroupCollapsed(g.id, true);
    expect((store.getFavoriteEntries()[0] as { collapsed: boolean }).collapsed).toBe(true);

    // 重启读回收起状态
    const reopened = await loadStore();
    expect((reopened.getFavoriteEntries()[0] as { collapsed: boolean }).collapsed).toBe(true);
  });

  it('删除分组级联删除组内收藏，组外收藏不受影响', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '组内A' });
    store.saveFavorite({ url: 'https://live.bilibili.com/2', platform: 'bilibili', alias: '组内B' });
    store.saveFavorite({ url: 'https://live.bilibili.com/3', platform: 'bilibili', alias: '组外' });
    store.createGroup('分组');
    const gid = (store.getFavoriteEntries().find((e) => e.kind === 'group') as { id: string }).id;

    // 移入分组：A、B 进组
    store.reorderFavorites([
      { kind: 'group', id: gid },
      { kind: 'item', url: 'https://live.bilibili.com/1', groupId: gid },
      { kind: 'item', url: 'https://live.bilibili.com/2', groupId: gid },
      { kind: 'item', url: 'https://live.bilibili.com/3' },
    ]);
    store.deleteGroup(gid);
    expect(aliases(store)).toEqual(['组外']);
    expect(store.getFavoriteEntries().some((e) => e.kind === 'group')).toBe(false);
  });

  it('重排：移入分组改写归属，未知分组 id 的归属被剥离，未提及条目沉底，顺序未变不写盘', async () => {
    const store = await loadStore();
    for (const [i, p] of ['bilibili', 'bilibili', 'douyin'].entries()) {
      store.saveFavorite({
        url: `https://live.${p}.com/${100 + i}`,
        platform: p as 'bilibili' | 'douyin',
        alias: `条目${i}`,
      });
    }
    store.createGroup('分组');
    const gid = (store.getFavoriteEntries().find((e) => e.kind === 'group') as { id: string }).id;

    // 组放最前，条目0 拖入组，条目1 上报指向不存在的分组 → 剥离为未分组，条目2 未提及 → 沉底
    store.reorderFavorites([
      { kind: 'group', id: gid },
      { kind: 'item', url: 'https://live.bilibili.com/100', groupId: gid },
      { kind: 'item', url: 'https://live.bilibili.com/101', groupId: 'g-nope' },
    ]);
    const entries = store.getFavoriteEntries();
    expect(aliases(store)).toEqual(['条目0', '条目1', '条目2']);
    const item0 = entries.find((e): e is Favorite => e.kind === 'item' && e.url === 'https://live.bilibili.com/100');
    expect(item0?.groupId).toBe(gid);

    // 相同顺序再上报 → 不落盘（mtime 不变）
    const file = path.join(mocks.dataDir, 'favorites.json');
    const mtime = fs.statSync(file).mtimeMs;
    store.reorderFavorites([
      { kind: 'group', id: gid },
      { kind: 'item', url: 'https://live.bilibili.com/100', groupId: gid },
      { kind: 'item', url: 'https://live.bilibili.com/101' },
      { kind: 'item', url: 'https://live.douyin.com/102' },
    ]);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);

    // 重复上报同一 url 只生效一次
    store.reorderFavorites([
      { kind: 'item', url: 'https://live.bilibili.com/100' },
      { kind: 'item', url: 'https://live.bilibili.com/100' },
    ]);
    expect(store.getFavoriteEntries().filter((e) => e.kind === 'item')).toHaveLength(3);
  });
});

describe('favorites-store：导入（合并式）', () => {
  it('v2 文件：新增分组与项、重复 url 跳过、归属正确映射并持久化', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '本地已有' });

    const r = store.importFavorites({
      version: 2,
      entries: [
        { kind: 'group', id: 'g-imp1', name: '导入组', collapsed: false },
        { kind: 'item', url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '远端改名' },
        { kind: 'item', url: 'https://live.douyin.com/2', platform: 'douyin', alias: '远端新项', groupId: 'g-imp1' },
      ],
    });
    expect(r).toEqual({ ok: true, addedItems: 1, addedGroups: 1, skipped: 1 });
    // 重复项保留本地别名，不被远端覆盖
    expect(aliases(store)).toEqual(['本地已有', '远端新项']);
    const imported = store
      .getFavoriteEntries()
      .find((e): e is Favorite => e.kind === 'item' && e.url === 'https://live.douyin.com/2');
    expect(imported?.groupId).toBe('g-imp1');
    // 持久化可读回
    const reopened = await loadStore();
    expect(reopened.getFavoriteEntries()).toHaveLength(3);
  });

  it('同名分组并入现有分组（成员归属重映射），不重复建组', async () => {
    const store = await loadStore();
    store.createGroup('常看');
    const localGid = (store.getFavoriteEntries().find((e) => e.kind === 'group') as { id: string }).id;

    const r = store.importFavorites({
      version: 2,
      entries: [
        { kind: 'group', id: 'g-other', name: '常看', collapsed: true },
        { kind: 'item', url: 'https://live.bilibili.com/9', platform: 'bilibili', alias: '并入项', groupId: 'g-other' },
      ],
    });
    expect(r).toEqual({ ok: true, addedItems: 1, addedGroups: 0, skipped: 0 });
    expect(store.getFavoriteEntries().filter((e) => e.kind === 'group')).toHaveLength(1);
    const moved = store
      .getFavoriteEntries()
      .find((e): e is Favorite => e.kind === 'item' && e.url === 'https://live.bilibili.com/9');
    expect(moved?.groupId).toBe(localGid);
  });

  it('归属指向双方都不存在的分组 → 剥离为顶层未分组', async () => {
    const store = await loadStore();
    store.importFavorites({
      version: 2,
      entries: [
        { kind: 'item', url: 'https://live.bilibili.com/7', platform: 'bilibili', alias: '孤儿', groupId: 'g-ghost' },
      ],
    });
    const item = store.getFavoriteEntries().find((e): e is Favorite => e.kind === 'item');
    expect(item?.groupId).toBeUndefined();
  });

  it('v1 旧格式文件（items 数组）可导入', async () => {
    const store = await loadStore();
    const r = store.importFavorites({
      version: 1,
      items: [{ url: 'https://live.douyin.com/5', platform: 'douyin', alias: '旧格式项' }],
    });
    expect(r).toEqual({ ok: true, addedItems: 1, addedGroups: 0, skipped: 0 });
    expect(aliases(store)).toEqual(['旧格式项']);
  });

  it('无法识别的内容返回 badfile，不改动数据', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: 'A' });
    expect(store.importFavorites(null)).toEqual({ ok: false, reason: 'badfile' });
    expect(store.importFavorites({ hello: 1 })).toEqual({ ok: false, reason: 'badfile' });
    expect(store.importFavorites('not json object' as unknown)).toEqual({ ok: false, reason: 'badfile' });
    expect(store.getFavoriteEntries()).toHaveLength(1);
  });
});
