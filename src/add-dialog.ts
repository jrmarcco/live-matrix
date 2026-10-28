import { detectLiveRoom, detectPlatform, normalizeUrl, PLATFORM_LABEL } from './shared/lib/platforms';
import type { Platform } from './shared/types/ipc';
import { dom } from './dom';
import { render, setFocusMode } from './stage';
import { MAX_CELLS, state, type PendingCell } from './state';

/* ---------------- 添加直播对话框（URL 校验 → 占位格 → 主进程解析） ---------------- */

export function openModal(): void {
  if (state.cells.length >= MAX_CELLS) return;
  // 直播视图层级高于 UI DOM，打开期间让主进程隐藏它们，保证对话框可见
  window.lm.setModalVisible(true);
  dom.modalBack.classList.remove('hidden');
  dom.urlInput.value = '';
  updateHint('');
  dom.addErr.textContent = '';
  dom.urlInput.focus();
}

export function closeModal(): void {
  dom.modalBack.classList.add('hidden');
  window.lm.setModalVisible(false);
}

function updateHint(value: string): void {
  if (!value.trim()) {
    dom.platHint.textContent = '支持哔哩哔哩 / 抖音直播间地址，如 live.bilibili.com/12345678';
    dom.platHint.classList.remove('ok', 'warn');
    return;
  }
  const room = detectLiveRoom(value);
  if (room) {
    dom.platHint.textContent = `已识别：${PLATFORM_LABEL[room]}直播间（使用其登录状态）`;
    dom.platHint.className = 'hint ok';
  } else if (detectPlatform(value)) {
    // 平台域名下的普通网页（如 bilibili 主页）：提示而不是放行去打开原始页面
    dom.platHint.textContent = '这是普通网页，不是直播间地址；请输入形如 live.bilibili.com/12345678 的直播间地址';
    dom.platHint.className = 'hint warn';
  } else {
    dom.platHint.textContent = '暂不支持该地址，仅支持 bilibili.com / douyin.com 直播间';
    dom.platHint.className = 'hint warn';
  }
}

dom.urlInput.addEventListener('input', () => updateHint(dom.urlInput.value));
document.getElementById('cancelBtn')!.addEventListener('click', closeModal);
dom.modalBack.addEventListener('pointerdown', (e) => {
  if (e.target === dom.modalBack) closeModal();
});

/**
 * 添加直播：先落一个「加载中」占位格并立即关闭对话框，解析完成后再替换成
 * 直连视频格 / 内嵌页面格（抖音接口重放最长约 15s，期间界面保持可操作）。
 */
export function beginAddStream(url: string, platform: Platform, onFail?: () => void): void {
  const pending: PendingCell = { id: state.pendingSeq--, url, platform, kind: 'pending' };
  state.cells.push(pending);
  if (state.focusMode) setFocusMode(false); // 新增副窗口时回到同屏布局展示
  render();
  void window.lm.addStream(url, platform).then((slot) => {
    const i = state.cells.findIndex((c) => c.id === pending.id);
    if (!slot) {
      // 创建失败（理论上仅剩窗口已销毁等罕见场景）：撤掉占位格并回调
      if (i >= 0) state.cells.splice(i, 1);
      render();
      onFail?.();
      return;
    }
    if (i < 0) {
      // 用户已在加载期间取消：销毁刚创建的流
      window.lm.closeStream(slot.id);
      return;
    }
    state.cells[i] = { ...slot };
    render();
  });
}

dom.addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  dom.addErr.textContent = '';
  const raw = dom.urlInput.value.trim();
  if (!raw) {
    dom.addErr.textContent = '请输入直播地址';
    return;
  }
  if (state.cells.length >= MAX_CELLS) {
    dom.addErr.textContent = '已达上限：1 个主窗口 + 7 个副窗口';
    return;
  }
  const p = detectLiveRoom(raw);
  if (!p) {
    // 普通网页（平台域名下）给可操作的提示；其余为无法识别的地址
    dom.addErr.textContent = detectPlatform(raw)
      ? '请输入直播间地址（如 live.bilibili.com/12345678），不支持打开普通网页'
      : '无法识别的地址，目前支持 live.bilibili.com 与 live.douyin.com 直播间';
    return;
  }
  const normalized = normalizeUrl(raw);
  if (!normalized) return; // detectLiveRoom 已通过，仅防御
  // 立即关闭对话框，加载过程由占位格上的遮罩反馈（问题1）
  closeModal();
  beginAddStream(normalized, p, () => {
    // 失败时回到对话框并保留输入，方便重试
    openModal();
    dom.urlInput.value = raw;
    updateHint(raw);
    dom.addErr.textContent = '创建窗口失败，请重试';
  });
});
