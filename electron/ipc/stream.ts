import { ipcMain } from 'electron';
import { detectLiveRoom } from '../../src/shared/lib/platforms';
import type { StreamSlot } from '../../src/shared/types/ipc';
import {
  addStream,
  findViewByWebContentsId,
  getMainViewId,
  refreshStream,
  removeStream,
} from '../services/slot-registry';
import { settings } from '../services/settings-store';
import { getWin } from '../windows';

/* ---------------- 直播流：添加/关闭/刷新 + 内嵌页事件中继（stream-preload → UI 层） ---------------- */

export function registerStreamIpc(): void {
  ipcMain.handle('stream:add', async (_e, url: unknown, platform: unknown): Promise<StreamSlot | null> => {
    if (typeof url !== 'string' || (platform !== 'bilibili' && platform !== 'douyin')) return null;
    // 兜底：非直播间地址（普通网页）拒绝创建，绝不回退为打开原始页面
    if (!detectLiveRoom(url)) {
      console.warn(`[live-matrix] 忽略非直播间地址: ${url}`);
      return null;
    }
    return addStream(url, platform);
  });

  ipcMain.on('stream:close', (_e, id: unknown) => {
    if (typeof id === 'number') removeStream(id);
  });

  // 直连流过期/断线：重新解析并下发新地址；未开播占位格：重新探测，开播后原地升级为直连格
  ipcMain.on('stream:refresh', (_e, id: unknown) => {
    if (typeof id === 'number') refreshStream(id);
  });

  // 直播视图内的双击（stream-preload 捕获上报）：中继给 UI 层做互换/铺满
  ipcMain.on('stream:dblclick', (e) => {
    const found = findViewByWebContentsId(e.sender.id);
    if (found) getWin()?.webContents.send('stream:dblclick', { id: found.id });
  });

  // 直播页面内右下角刷新按钮：按发送者定位并重载对应视图
  ipcMain.on('stream:refresh-self', (e) => {
    findViewByWebContentsId(e.sender.id)?.entry.view.webContents.reload();
  });

  // 直播页面内右上角关闭按钮：按发送者定位并关闭对应视图
  ipcMain.on('stream:close-self', (e) => {
    const found = findViewByWebContentsId(e.sender.id);
    if (found) {
      removeStream(found.id);
      getWin()?.webContents.send('stream:dead', { id: found.id });
    }
  });

  // 内嵌格页内星标按钮：中继给 UI 层弹出别名输入
  ipcMain.on('stream:favorite', (e) => {
    const found = findViewByWebContentsId(e.sender.id);
    if (found) getWin()?.webContents.send('stream:favorite', { id: found.id });
  });

  // 页内覆盖层挂载完成（含页面 reload 后）：回发当前槽位与音量状态
  ipcMain.on('stream:overlay-ready', (e) => {
    const found = findViewByWebContentsId(e.sender.id);
    if (found) {
      found.entry.view.webContents.send('lm-state', { isMain: getMainViewId() === found.id, ...settings });
    }
  });
}
