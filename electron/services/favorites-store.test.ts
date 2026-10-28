import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// favorites-store 依赖 electron（app.getPath 定位 userData）与 windows（getWin 推送更新），
// 单测中全部替换：userData 指向每个用例独立的临时目录，推送目标为 null
const mocks = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.dataDir } }));
vi.mock('../windows', () => ({ getWin: () => null }));

// favoritesCache 是模块级缓存：每个用例重置模块拿到干净的 store
async function loadStore() {
  vi.resetModules();
  return await import('./favorites-store');
}

beforeEach(() => {
  mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-fav-'));
});

describe('favorites-store', () => {
  it('无持久化文件时从空列表开始', async () => {
    const store = await loadStore();
    expect(store.getFavorites()).toEqual([]);
  });

  it('保存按 url 去重（存在即改名）并落盘，重启后可读回', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '第一个' });
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: '改名后' });
    store.saveFavorite({ url: 'https://live.douyin.com/2', platform: 'douyin', alias: '抖音' });
    expect(store.getFavorites().map((f) => f.alias)).toEqual(['改名后', '抖音']);

    // 模拟重启：模块缓存重置后从磁盘读回
    const reopened = await loadStore();
    expect(reopened.getFavorites().map((f) => f.alias)).toEqual(['改名后', '抖音']);
    expect(fs.existsSync(path.join(mocks.dataDir, 'favorites.json'))).toBe(true);
  });

  it('别名去空白并截断 40 字符', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/9', platform: 'bilibili', alias: `  ${'很'.repeat(50)}  ` });
    const [f] = store.getFavorites();
    expect(f.alias).toBe('很'.repeat(40));
  });

  it('损坏的持久化文件按空列表处理（不抛出）', async () => {
    fs.writeFileSync(path.join(mocks.dataDir, 'favorites.json'), '{oops', 'utf8');
    const store = await loadStore();
    expect(store.getFavorites()).toEqual([]);
  });

  it('reorder 按 url 全量重排：未知/遗漏条目沉底，顺序未变不写盘', async () => {
    const store = await loadStore();
    for (const [i, p] of ['bilibili', 'bilibili', 'douyin'].entries()) {
      store.saveFavorite({
        url: `https://live.${p}.com/${100 + i}`,
        platform: p as 'bilibili' | 'douyin',
        alias: `条目${i}`,
      });
    }
    // 把 [A,B,C] 重排为 [C,A]，B 未上报 → 沉底
    store.reorderFavorites(['https://live.douyin.com/102', 'https://live.bilibili.com/100']);
    expect(store.getFavorites().map((f) => f.alias)).toEqual(['条目2', '条目0', '条目1']);
    // 恢复原序（这是一次变更，会落盘）
    store.reorderFavorites([
      'https://live.bilibili.com/100',
      'https://live.bilibili.com/101',
      'https://live.douyin.com/102',
    ]);
    expect(store.getFavorites().map((f) => f.alias)).toEqual(['条目0', '条目1', '条目2']);
    // 再次以相同顺序上报 → 顺序未变，不落盘（mtime 不变）
    const mtime = fs.statSync(path.join(mocks.dataDir, 'favorites.json')).mtimeMs;
    store.reorderFavorites([
      'https://live.bilibili.com/100',
      'https://live.bilibili.com/101',
      'https://live.douyin.com/102',
    ]);
    expect(fs.statSync(path.join(mocks.dataDir, 'favorites.json')).mtimeMs).toBe(mtime);
  });

  it('remove 不存在的 url 无副作用', async () => {
    const store = await loadStore();
    store.saveFavorite({ url: 'https://live.bilibili.com/1', platform: 'bilibili', alias: 'A' });
    store.removeFavorite('https://live.bilibili.com/404');
    expect(store.getFavorites()).toHaveLength(1);
    store.removeFavorite('https://live.bilibili.com/1');
    expect(store.getFavorites()).toEqual([]);
  });
});
