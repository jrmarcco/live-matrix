import { ipcMain, session } from 'electron';
import { partitionFor } from '../../src/shared/lib/platforms';
import { closeLoginWindow, isLoggedIn, openLogin, pushLogin } from '../login';

/* ---------------- 平台登录：打开登录页 / 退出 / 查询 ---------------- */

export function registerLoginIpc(): void {
  ipcMain.on('login:open', (_e, p: unknown) => {
    if (p === 'bilibili' || p === 'douyin') openLogin(p);
  });

  ipcMain.handle('login:logout', async (_e, p: unknown) => {
    if (p !== 'bilibili' && p !== 'douyin') return false;
    closeLoginWindow(p);
    await session.fromPartition(partitionFor(p)).clearStorageData();
    await pushLogin(p);
    return true;
  });

  ipcMain.handle('login:check', (_e, p: unknown) => {
    if (p !== 'bilibili' && p !== 'douyin') return false;
    return isLoggedIn(p);
  });
}
