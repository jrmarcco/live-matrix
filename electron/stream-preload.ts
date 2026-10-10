import { ipcRenderer } from 'electron';

/**
 * 注入到每个内嵌直播视图的 preload（隔离世界，先于页面脚本注册）。
 * 直播画面（WebContentsView）层级高于 UI 页面 DOM，交互只能做进页面里：
 * 1. 捕获阶段拦截真实双击，阻止站点自身的"双击全屏"等响应，上报主进程
 *    完成「副窗口与主窗口互换 / 主窗口铺满」；
 * 2. 在页面右上角挂 关闭（×）与 收藏（☆）两个按钮，右下角挂 刷新（↻）按钮
 *    （UI 层已无窗口头栏）。
 * isTrusted 过滤：忽略脚本合成的双击（如进入网页全屏时注入的合成事件）。
 */

const CLOSE_BTN_ID = 'lm-close-x';
const FAV_BTN_ID = 'lm-fav-x';
const REFRESH_BTN_ID = 'lm-refresh-x';
const STYLE_ID = 'lm-overlay-style';

/** 与 UI 层同款描边星形图标（收藏动作按钮，避免系统字体 ☆ 字形不一致） */
const STAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';

function mountButtons(): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${CLOSE_BTN_ID}, #${FAV_BTN_ID}, #${REFRESH_BTN_ID} {
  position: fixed !important;
  top: 8px !important;
  width: 30px !important;
  height: 30px !important;
  display: grid !important;
  place-items: center !important;
  padding: 0 !important;
  border: none !important;
  border-radius: 9px !important;
  background: rgba(10, 13, 20, 0.42) !important;
  backdrop-filter: blur(6px) !important;
  color: #fff !important;
  font: 400 17px/1 -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif !important;
  cursor: pointer !important;
  z-index: 2147483647 !important;
  opacity: 0.4 !important;
  transition: opacity 0.18s, background 0.18s, transform 0.18s !important;
}
#${CLOSE_BTN_ID} { right: 8px !important; font-size: 19px !important; }
#${FAV_BTN_ID} { left: 8px !important; }
#${REFRESH_BTN_ID} { top: auto !important; bottom: 8px !important; right: 8px !important; font-size: 18px !important; }
#${CLOSE_BTN_ID}:hover, #${FAV_BTN_ID}:hover, #${REFRESH_BTN_ID}:hover {
  opacity: 1 !important;
  transform: translateY(-1px) !important;
}
#${FAV_BTN_ID} svg {
  width: 16px !important;
  height: 16px !important;
  display: block !important;
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 1.7 !important;
  stroke-linejoin: round !important;
}
#${FAV_BTN_ID}:hover { background: rgba(24, 30, 44, 0.78) !important; }
#${REFRESH_BTN_ID}:hover { background: rgba(60, 90, 160, 0.85) !important; }
#${CLOSE_BTN_ID}:hover { background: rgba(200, 40, 40, 0.85) !important; }
`;
    document.head.appendChild(style);
  }
  const close = document.createElement('button');
  close.id = CLOSE_BTN_ID;
  close.type = 'button';
  close.title = '关闭此直播窗口';
  close.textContent = '×';
  close.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:close-self');
  });
  const fav = document.createElement('button');
  fav.id = FAV_BTN_ID;
  fav.type = 'button';
  fav.title = '收藏此直播';
  fav.innerHTML = STAR_SVG;
  fav.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:favorite');
  });
  const refresh = document.createElement('button');
  refresh.id = REFRESH_BTN_ID;
  refresh.type = 'button';
  refresh.title = '刷新直播';
  refresh.textContent = '↻';
  refresh.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:refresh-self');
  });
  if (!document.getElementById(CLOSE_BTN_ID)) document.body.appendChild(close);
  if (!document.getElementById(FAV_BTN_ID)) document.body.appendChild(fav);
  if (!document.getElementById(REFRESH_BTN_ID)) document.body.appendChild(refresh);
}

if (document.body) {
  mountButtons();
} else {
  document.addEventListener('DOMContentLoaded', mountButtons, { once: true });
}
// 站点 SPA 跳转可能清理 DOM，定期确保按钮仍在
setInterval(() => {
  if (
    !document.getElementById(CLOSE_BTN_ID) ||
    !document.getElementById(FAV_BTN_ID) ||
    !document.getElementById(REFRESH_BTN_ID)
  ) {
    mountButtons();
  }
}, 2000);

document.addEventListener(
  'dblclick',
  (e) => {
    if (!e.isTrusted) return;
    const id = (e.target as Element | null)?.id;
    if (id === CLOSE_BTN_ID || id === FAV_BTN_ID || id === REFRESH_BTN_ID) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:dblclick');
  },
  true,
);
