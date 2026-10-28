import * as path from 'node:path';
import { app } from 'electron';
import type { VolumeState } from '../../src/shared/types/ipc';
import { readJsonFile, writeJsonFile } from '../../src/shared/lib/json-file';

/* ---------------- 主窗口音量（跨启动持久化，userData/settings.json） ---------------- */

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export const settings: VolumeState = { volume: 1, muted: false };
const saved = readJsonFile<Partial<VolumeState>>(settingsPath());
if (saved) {
  if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) {
    settings.volume = Math.min(1, Math.max(0, saved.volume));
  }
  if (typeof saved.muted === 'boolean') settings.muted = saved.muted;
}

let saveSettingsTimer: NodeJS.Timeout | null = null;

function writeSettings(): void {
  writeJsonFile(settingsPath(), settings);
}

/** 滑杆拖动会高频触发，防抖后再落盘 */
export function persistSettings(): void {
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    writeSettings();
  }, 500);
}

/** 退出前把防抖中的保存立刻落盘（will-quit 兜底：刚调完音量就关窗也不丢） */
export function flushSettings(): void {
  if (saveSettingsTimer) {
    clearTimeout(saveSettingsTimer);
    saveSettingsTimer = null;
    writeSettings();
  }
}
