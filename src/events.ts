import type { InitPayload, StreamMediaEvent, VolumeState } from './shared/types/ipc';
import { dom } from './dom';
import { openFavModal, renderFavList } from './favorites';
import { syncVideoAudio, updateVolumeControls } from './layout';
import { renderChips } from './login-chips';
import { attachPlayer, consumeSilentRecovery, isSilentRecovery } from './player';
import { removeCell, render, setFocusMode, setOfflineHint, setState, updateFavStates } from './stage';
import { state, type Cell } from './state';

/* ---------------- 主进程事件订阅（IPC 推送 → 本地状态/DOM 同步） ---------------- */

function updateCellDom(id: number, fn: (c: Cell) => void): void {
  const c = state.cells.find((x) => x.id === id);
  if (c && c.kind !== 'pending') fn(c);
}

window.lm.onInit((payload: InitPayload) => {
  state.cells = payload.slots.map((s) => ({ ...s }));
  for (const s of payload.logins) state.loginState[s.platform] = s.loggedIn;
  state.mainVolume = typeof payload.volume === 'number' ? payload.volume : 1;
  state.mainMuted = !!payload.muted;
  if (state.focusMode) setFocusMode(false);
  render();
  renderChips();
});

// 主槽位为内嵌页时，页内音量控件发起的变更 → 同步本地状态与直连格控件
window.lm.onVolumeChanged((v: VolumeState) => {
  state.mainVolume = v.volume;
  state.mainMuted = v.muted;
  updateVolumeControls();
  syncVideoAudio();
});

window.lm.onLoginStatus((s) => {
  state.loginState[s.platform] = s.loggedIn;
  renderChips();
});

window.lm.onStreamTitle((v) => updateCellDom(v.id, (c) => (c.title = v.title)));
window.lm.onStreamError((v) =>
  updateCellDom(v.id, (c) => {
    c.error = v.message.slice(0, 60);
    if (c.kind === 'offline') setOfflineHint(v.id, c.error || '未开播');
    // 静默自动恢复中的瞬态失败不显示文案（看门狗会继续重试），避免打扰用户
    else if (!isSilentRecovery(v.id)) setState(v.id, c.error);
  }),
);
window.lm.onStreamDead((v) => {
  const i = state.cells.findIndex((c) => c.id === v.id);
  if (i >= 0) removeCell(i);
});
// 直连格刷新发现主播已下播（含看门狗触发）：降级为统一的未开播占位页，
// 与添加时未开播/占位格刷新同一页面（先移除视频格 DOM 再 render 重建，播放器随之销毁）
window.lm.onStreamOffline((v) => {
  const c = state.cells.find((x) => x.id === v.id);
  if (!c || c.kind !== 'video') return;
  c.kind = 'offline';
  c.media = undefined;
  c.error = undefined;
  dom.stage.querySelector(`.cell[data-id="${v.id}"]`)?.remove();
  render();
  setOfflineHint(v.id, '已下播');
});
// 直连流地址刷新（过期/断线后主进程重新解析下发）；未开播格刷新后探测到
// 开播也走此事件：格子在位升级为直连格（先赋 media，移除旧 DOM 后 render 重建挂播放器）
window.lm.onStreamMedia((v: StreamMediaEvent) => {
  const c = state.cells.find((x) => x.id === v.id);
  if (!c || (c.kind !== 'video' && c.kind !== 'offline')) return;
  if (c.kind === 'offline') {
    c.kind = 'video';
    c.media = v.media;
    dom.stage.querySelector(`.cell[data-id="${v.id}"]`)?.remove();
    render();
    return;
  }
  c.media = v.media;
  const el = dom.stage.querySelector<HTMLElement>(`.cell[data-id="${v.id}"]`);
  // 静默恢复：看门狗/播放器错误触发的刷新不显示「载入中…」等过程文案
  const silent = consumeSilentRecovery(v.id);
  if (el) attachPlayer(el, c, silent);
});
// 内嵌格页内星标点击 → 弹出别名输入
window.lm.onStreamFavorite((v) => {
  const c = state.cells.find((x) => x.id === v.id);
  if (c && c.kind !== 'pending') openFavModal(c);
});
// 收藏列表变更（保存/移除/分组操作后主进程推送全量）
window.lm.onFavoritesUpdate((v) => {
  state.favorites = v.entries;
  renderFavList();
  updateFavStates();
});
// 主窗口最大化状态 → 最大化按钮图标双态
window.lm.onMaximized((maximized) => {
  dom.winMaxBtn.querySelector('i')?.classList.toggle('restore', maximized);
  dom.winMaxBtn.title = maximized ? '还原' : '最大化';
});
