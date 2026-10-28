import { ipcMain } from 'electron';
import type { LayoutItem } from '../../src/shared/types/ipc';
import { applyLayout, applyModalVisibility } from '../services/slot-registry';
import { getWin } from '../windows';

/* ---------------- 布局上报与对话框可见性 ---------------- */

export function registerLayoutIpc(): void {
  ipcMain.on('layout:update', (_e, items: unknown) => {
    if (!(getWin() && Array.isArray(items))) return;
    applyLayout(items as LayoutItem[]);
  });

  ipcMain.on('modal:visible', (_e, v: unknown) => {
    if (typeof v === 'boolean') applyModalVisibility(v);
  });
}
