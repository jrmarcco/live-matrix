import './events'; // 主进程事件订阅（副作用注册，需最先导入）
import { dom } from './dom';
import { closeModal } from './add-dialog';
import { closeFavModal, closeFavPanel, renderFavList } from './favorites';
import { renderChips } from './login-chips';
import { render, setFocusMode, updateFavStates } from './stage';
import { state } from './state';

/* ---------------- 入口：一次性 UI 接线 + 启动 ---------------- */

// 无边框窗口控制（最小化/最大化/关闭由 UI 内自绘按钮触发）
document.getElementById('winMin')!.addEventListener('click', () => window.lm.winMin());
dom.winMaxBtn.addEventListener('click', () => window.lm.winMax());
document.getElementById('winClose')!.addEventListener('click', () => window.lm.winClose());

// Escape 依次关闭：添加对话框 → 收藏弹窗 → 收藏面板 → 焦点模式
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!dom.modalBack.classList.contains('hidden')) closeModal();
  else if (!dom.favBack.classList.contains('hidden')) closeFavModal();
  else if (!dom.favWrap.classList.contains('hidden')) closeFavPanel();
  else if (state.focusMode) setFocusMode(false);
});

render();
renderChips();
void window.lm.getFavorites().then((items) => {
  state.favorites = items;
  renderFavList();
  updateFavStates();
});
window.lm.ready();
