import type { Platform } from './types';
import type { WebContents } from 'electron';

/**
 * 打开直播间后自动增强：
 * 1. 触发平台自带的"网页全屏"，让视频区铺满所在窗口；
 * 2. 用 CSS 隐藏礼物栏、聊天区、浮层等非视频元素。
 *
 * 注入的 JS 自带最长约 40s 的重试循环（播放器为异步挂载），
 * 多次注入通过 window 上的 URL 标记去重；若最终仍未进入网页全屏，
 * 添加 __lmForce 类由 CSS 兜底把播放器强制铺满。
 */

const BILI_JS = `
(function () {
  var GUARD = '__lmBiliFs';
  if (window[GUARD] === location.href) return;
  var tries = 0;
  function isOn() {
    return !!(document.body && document.body.classList.contains('player-full-win'));
  }
  function step() {
    if (isOn()) { window[GUARD] = location.href; return; }
    tries++;
    if (tries > 40) {
      if (document.body) document.body.classList.add('__lmForce');
      window[GUARD] = location.href;
      return;
    }
    var p = document.getElementById('live-player');
    if (p && document.body) {
      document.body.classList.add('hide-aside-area');
      var r = p.getBoundingClientRect();
      var o = { view: window, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      p.dispatchEvent(new MouseEvent('mousedown', o));
      p.dispatchEvent(new MouseEvent('mouseup', o));
      p.dispatchEvent(new MouseEvent('click', o));
      p.dispatchEvent(new MouseEvent('mousedown', o));
      p.dispatchEvent(new MouseEvent('mouseup', o));
      p.dispatchEvent(new MouseEvent('click', o));
      p.dispatchEvent(new MouseEvent('dblclick', o));
    }
    setTimeout(step, 1000);
  }
  step();
})();
`;

const BILI_CSS = `
body.player-full-win #gift-control-vm,
body.player-full-win .gift-control-section,
body.player-full-win #web-player__bottom-bar__container { display: none !important; }
body.player-full-win #fullscreen-container { grid-template-rows: 1fr 0px !important; padding-bottom: 0 !important; }
body.hide-aside-area #aside-area-vm { display: none !important; }
body.__lmForce #player-ctnr { position: fixed !important; inset: 0 !important; z-index: 2147483000 !important; }
`;

const DOUYIN_JS = `
(function () {
  var GUARD = '__lmDyFs';
  if (window[GUARD] === location.href) return;
  var tries = 0;
  function container() {
    return document.querySelector('.live-main div[data-e2e="living-container"]')
      || document.querySelector('div[data-e2e="living-container"]')
      || document.querySelector('.live-main');
  }
  function isOn() {
    var c = container();
    return !!c && (c.classList.contains('__fullScreenOrTheaterOn') || !!c.querySelector('.__fullScreenOrTheaterOn'));
  }
  function closeChat() {
    var btns = document.querySelectorAll('.chatroom_close');
    for (var i = 0; i < btns.length; i++) btns[i].click();
  }
  function clickTextButton() {
    var divs = document.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      if (divs[i].innerText === '网页全屏') {
        var t = divs[i].nextElementSibling || divs[i].parentElement;
        if (t) t.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
        return;
      }
    }
  }
  function step() {
    if (isOn()) { window[GUARD] = location.href; return; }
    tries++;
    if (tries > 40) {
      if (document.body) document.body.classList.add('__lmForce');
      window[GUARD] = location.href;
      return;
    }
    if (container()) {
      var root = document.getElementById('root') || document.body;
      if (root) root.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', keyCode: 89, which: 89, bubbles: true, cancelable: true }));
      if (tries >= 5 && tries % 5 === 0) clickTextButton();
      closeChat();
    }
    setTimeout(step, 1000);
  }
  step();
})();
`;

const DOUYIN_CSS = `
#BottomLayout, #TipsLayout, #GiftEffectLayout, #GiftTrayLayout, #GiftMenuLayout, #LikeLayout,
#LinkMicAnimationLayout, #LinkMicLayout, #LinkMicBackgroundLayout, #EcmoCardLayout,
#ShortTouchLayout, #WaterMarkLayout, #ServiceCenterLayout { display: none !important; }
body.__lmForce #playerWraper { position: fixed !important; inset: 0 !important; z-index: 2147483000 !important; width: 100vw !important; height: 100vh !important; }
`;

export const ENHANCE_JS: Record<Platform, string> = { bilibili: BILI_JS, douyin: DOUYIN_JS };
const ENHANCE_CSS: Record<Platform, string> = { bilibili: BILI_CSS, douyin: DOUYIN_CSS };

export function attachEnhancer(wc: WebContents, platform: Platform): void {
  const js = ENHANCE_JS[platform];
  const css = ENHANCE_CSS[platform];
  const inject = () => {
    if (wc.isDestroyed()) return;
    void wc.insertCSS(css).catch(() => {});
    void wc.executeJavaScript(js, true).catch(() => {});
  };
  wc.on('dom-ready', inject);
  // 站内跳转（如切换直播间）是 SPA 内部导航，需要重新注入
  wc.on('did-navigate-in-page', () => setTimeout(inject, 400));
}
