import { PLATFORM_LABEL, PLATFORMS } from './shared/lib/platforms';
import type { Platform } from './shared/types/ipc';
import { ICONS } from './shared/lib/icons';
import { dom } from './dom';
import { state } from './state';

/* ---------------- 工具栏登录状态芯片（点击打开登录页 / 退出登录） ---------------- */

/** 登录标签的平台图标（B站粉 / TikTok 浅白，均为亮色原图） */
export const CHIP_ICON: Record<Platform, string> = { bilibili: ICONS.bilibili, douyin: ICONS.tiktok };

export function renderChips(): void {
  dom.loginChips.innerHTML = '';
  for (const p of PLATFORMS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = state.loginState[p] ? `chip ${p} on` : `chip ${p}`;
    // 平台图标替代文字标签
    b.innerHTML = `<span class="dot"></span><img class="chip-ico" src="${CHIP_ICON[p]}" alt="" draggable="false" />`;
    b.title = state.loginState[p]
      ? `${PLATFORM_LABEL[p]}已登录，点击退出`
      : `点击打开${PLATFORM_LABEL[p]}登录页（扫码登录，状态会自动保存）`;
    b.addEventListener('click', async () => {
      if (state.loginState[p]) {
        if (window.confirm(`确定退出${PLATFORM_LABEL[p]}登录？`)) {
          await window.lm.logout(p);
        }
      } else {
        window.lm.openLogin(p);
      }
    });
    dom.loginChips.appendChild(b);
  }
}
