import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import type { VolumeState } from '../../src/shared/types/ipc';

/* ---------------- 主窗口音量（跨启动持久化，userData/settings.json） ---------------- */

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export const settings: VolumeState = { volume: 1, muted: false };
try {
  const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<VolumeState>;
  if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) {
    settings.volume = Math.min(1, Math.max(0, raw.volume));
  }
  if (typeof raw.muted === 'boolean') settings.muted = raw.muted;
} catch {
  /* 文件不存在或损坏则用默认值 */
}

let saveSettingsTimer: NodeJS.Timeout | null = null;

function writeSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[live-matrix] 保存设置失败:', err);
  }
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
