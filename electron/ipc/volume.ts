import { ipcMain } from 'electron';
import { findViewByWebContentsId, getMainViewId, pushVolumeToMainView } from '../services/slot-registry';
import { persistSettings, settings } from '../services/settings-store';
import { getWin } from '../windows';

/* ---------------- 主窗口音量：UI 直连格控件 + 内嵌页控件两个来源 ---------------- */

/**
 * 音量状态唯一入口：主进程持有并持久化；主槽位是内嵌视图时下发给页内控件，
 * notifyUi 用于内嵌页控件发起的变更——UI 层的直连格控件与其 <video> 需要同步。
 */
function setVolumeState(volume: number, muted: boolean, notifyUi: boolean): void {
  settings.volume = Math.min(1, Math.max(0, volume));
  settings.muted = muted;
  persistSettings();
  pushVolumeToMainView(settings);
  if (notifyUi) getWin()?.webContents.send('volume:changed', { ...settings });
}

export function registerVolumeIpc(): void {
  // UI 层直连格的音量控件（主槽位为 <video> 格时由此驱动）
  ipcMain.on('volume:set', (_e, volume: unknown, muted: unknown) => {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    if (typeof muted !== 'boolean') return;
    setVolumeState(volume, muted, false);
  });

  // 内嵌页内的音量控件上报：仅接受当前主槽位视图的变更，并回推 UI 层同步
  ipcMain.on('stream:volume-self', (e, volume: unknown, muted: unknown) => {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    if (typeof muted !== 'boolean') return;
    if (getMainViewId() == null) return;
    const found = findViewByWebContentsId(e.sender.id);
    if (!found || found.id !== getMainViewId()) return;
    setVolumeState(volume, muted, true);
  });
}
