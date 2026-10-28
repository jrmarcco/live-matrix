import { ipcMain } from 'electron';
import { PLATFORMS } from '../../src/shared/lib/platforms';
import type { LoginStatus } from '../../src/shared/types/ipc';
import { snapshotSlots } from '../services/slot-registry';
import { settings } from '../services/settings-store';
import { isLoggedIn } from '../login';
import { getWin } from '../windows';

/* ---------------- 渲染层就绪握手 + 无边框窗口控制 ---------------- */

export function registerWinIpc(): void {
  ipcMain.on('ui:ready', () => {
    const slots = snapshotSlots();
    console.log(`[live-matrix] 渲染层就绪，当前窗口数: ${slots.length}`);
    void Promise.all(
      PLATFORMS.map(async (p): Promise<LoginStatus> => ({ platform: p, loggedIn: await isLoggedIn(p) })),
    ).then((logins) => getWin()?.webContents.send('app:init', { slots, logins, ...settings }));
  });

  ipcMain.on('win:min', () => getWin()?.minimize());
  ipcMain.on('win:max', () => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else {
      // macOS：先解除 16:9 约束再最大化，避免 zoom 按约束计算出纵向不足的尺寸
      if (process.platform === 'darwin') win.setAspectRatio(0);
      win.maximize();
    }
  });
  ipcMain.on('win:close', () => getWin()?.close());
}
