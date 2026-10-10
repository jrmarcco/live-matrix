import { ipcRenderer } from 'electron';

/**
 * 注入到每个直播视图的 preload（隔离世界，先于页面脚本注册）。
 * 直播画面（WebContentsView）层级高于 UI 页面 DOM，交互只能做进页面里：
 * 1. 捕获阶段拦截真实双击，阻止站点自身的"双击全屏"等响应，上报主进程
 *    完成「副窗口与主窗口互换 / 主窗口铺满」；
 * 2. 在页面右上角挂一个关闭按钮（UI 层已无窗口头栏）。
 * isTrusted 过滤：忽略脚本合成的双击（如进入网页全屏时注入的合成事件）。
 */

const CLOSE_BTN_ID = 'lm-close-x';

function mountCloseButton(): void {
  if (document.getElementById(CLOSE_BTN_ID)) return;
  const style = document.createElement('style');
  style.textContent = `
#${CLOSE_BTN_ID} {
  position: fixed !important;
  top: 8px !important;
  right: 8px !important;
  width: 30px !important;
  height: 30px !important;
  display: grid !important;
  place-items: center !important;
  padding: 0 !important;
  border: none !important;
  border-radius: 8px !important;
  background: rgba(8, 10, 16, 0.55) !important;
  color: #fff !important;
  font: 400 19px/1 -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif !important;
  cursor: pointer !important;
  z-index: 2147483647 !important;
  opacity: 0.35 !important;
  transition: opacity 0.15s, background 0.15s !important;
}
#${CLOSE_BTN_ID}:hover {
  background: rgba(200, 40, 40, 0.85) !important;
  opacity: 1 !important;
}`;
  const btn = document.createElement('button');
  btn.id = CLOSE_BTN_ID;
  btn.type = 'button';
  btn.title = '关闭此直播窗口';
  btn.textContent = '×';
  btn.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:close-self');
  });
  btn.addEventListener('dblclick', (e) => e.stopImmediatePropagation(), true);
  document.head.appendChild(style);
  document.body.appendChild(btn);
}

if (document.body) {
  mountCloseButton();
} else {
  document.addEventListener('DOMContentLoaded', mountCloseButton, { once: true });
}
// 站点 SPA 跳转可能清理 DOM，定期确保按钮仍在
setInterval(() => {
  if (!document.getElementById(CLOSE_BTN_ID)) mountCloseButton();
}, 2000);

document.addEventListener(
  'dblclick',
  (e) => {
    if (!e.isTrusted) return;
    if ((e.target as Element | null)?.id === CLOSE_BTN_ID) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:dblclick');
  },
  true,
);
