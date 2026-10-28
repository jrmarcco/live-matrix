import { dom } from './dom';
import { state } from './state';
import type { LayoutItem } from './shared/types/ipc';

/* ---------------- 布局上报（渲染层 DOM 矩形 → 主进程视图 bounds）与音量同步 ---------------- */

export function sendLayout(): void {
  const items: LayoutItem[] = [];
  dom.stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    const body = el.querySelector<HTMLElement>('.cell-body');
    if (!body) return;
    const r = body.getBoundingClientRect();
    items.push({
      id: Number(el.dataset.id),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.ceil(r.width),
        height: Math.ceil(r.height),
      },
      isMain: el.classList.contains('slot-main'),
    });
  });
  window.lm.updateLayout(items);
}

/** video 格子纯 DOM，音量/静音在渲染层控制（view 格子由主进程按 layout 控制） */
export function syncVideoAudio(): void {
  dom.stage.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((el) => {
    const video = el.querySelector('video');
    if (!video) return;
    video.volume = state.mainVolume;
    video.muted = !el.classList.contains('slot-main') || state.mainMuted;
  });
}

/** 静音按钮操作入口：本地立即生效，同时交主进程持久化/转发 */
export function applyVolume(volume: number, muted: boolean): void {
  state.mainVolume = Math.min(1, Math.max(0, volume));
  state.mainMuted = muted;
  window.lm.setVolume(state.mainVolume, state.mainMuted);
  updateVolumeControls();
  syncVideoAudio();
}

/** 把当前静音态刷到所有直连格的音量按钮（显隐由 .slot-main CSS 控制，
 *  图标双态由 .muted 类切换：有声喇叭 / 静音） */
export function updateVolumeControls(): void {
  const silent = state.mainMuted || state.mainVolume === 0;
  dom.stage.querySelectorAll<HTMLElement>('.cell-volume').forEach((btn) => {
    btn.classList.toggle('muted', silent);
  });
}

let resizePending = false;
window.addEventListener('resize', () => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    sendLayout();
  });
});
