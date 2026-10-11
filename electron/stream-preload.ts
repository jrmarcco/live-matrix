import { ipcRenderer } from 'electron';
import { ICONS } from './icon-data';

/**
 * 注入到每个内嵌直播视图的 preload（隔离世界，先于页面脚本注册）。
 * 直播画面（WebContentsView）层级高于 UI 页面 DOM，交互只能做进页面里：
 * 1. 捕获阶段拦截真实双击，阻止站点自身的"双击全屏"等响应，上报主进程
 *    完成「副窗口与主窗口互换 / 主窗口铺满」；
 * 2. 在页面右上角挂 关闭（×）与 收藏（☆）两个按钮，右下角挂 刷新（↻）按钮
 *    （图标均为 build/ 下 PNG 的内嵌 data URL，黑色图形由注入样式反色为白）；
 * 3. 本视图处于主窗口槽位时，在刷新按钮上方挂静音按钮（点击切换静音/恢复，
 *    双图标按状态切换）：音量值作用于页内媒体元素，静音由主进程 setAudioMuted 实现。
 * isTrusted 过滤：忽略脚本合成的双击（如进入网页全屏时注入的合成事件）。
 */

const CLOSE_BTN_ID = 'lm-close-x';
const FAV_BTN_ID = 'lm-fav-x';
const REFRESH_BTN_ID = 'lm-refresh-x';
const VOLUME_BOX_ID = 'lm-volume-x';
const STYLE_ID = 'lm-overlay-style';

/** 覆盖层状态（主进程经 lm-state / lm-volume / lm-slot 下发） */
const vol = { isMain: false, volume: 1, muted: false };

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
/* 收藏星标：比其他芯片略大一圈、无背景直接浮在画面上（与 UI 层一致） */
#${FAV_BTN_ID} {
  width: 36px !important;
  height: 36px !important;
  border-radius: 11px !important;
  background: transparent !important;
  backdrop-filter: none !important;
}
#${FAV_BTN_ID} img { width: 20px !important; height: 20px !important; }
#${REFRESH_BTN_ID}:hover { background: rgba(60, 90, 160, 0.85) !important; }
#${CLOSE_BTN_ID}:hover { background: rgba(200, 40, 40, 0.85) !important; }
/* PNG 图标（data URL）：黑色图形反色为白，与 UI 层一致 */
#${CLOSE_BTN_ID} img, #${FAV_BTN_ID} img, #${REFRESH_BTN_ID} img, #${VOLUME_BOX_ID} img {
  width: 16px !important;
  height: 16px !important;
  display: block !important;
  pointer-events: none !important;
  filter: invert(1) !important;
}
/* 主窗口静音按钮：刷新按钮正上方，点击切换静音；双图标按状态切换（喇叭/静音），
   仅主槽位显示（lm-on），与 UI 层同款样式 */
#${VOLUME_BOX_ID} {
  position: fixed !important;
  bottom: 46px !important;
  right: 8px !important;
  display: none !important;
  width: 30px !important;
  height: 30px !important;
  padding: 0 !important;
  border: none !important;
  border-radius: 9px !important;
  background: rgba(10, 13, 20, 0.42) !important;
  backdrop-filter: blur(6px) !important;
  cursor: pointer !important;
  z-index: 2147483647 !important;
  opacity: 0.4 !important;
  transition: opacity 0.18s, background 0.18s, transform 0.18s !important;
}
#${VOLUME_BOX_ID}.lm-on { display: grid !important; }
#${VOLUME_BOX_ID}:hover {
  opacity: 1 !important;
  transform: translateY(-1px) !important;
  background: rgba(24, 30, 44, 0.78) !important;
}
#${VOLUME_BOX_ID} .lm-ic-off { display: none !important; }
#${VOLUME_BOX_ID}.lm-muted .lm-ic-off { display: block !important; }
#${VOLUME_BOX_ID}.lm-muted .lm-ic-on { display: none !important; }
`;
    document.head.appendChild(style);
  }
  const close = document.createElement('button');
  close.id = CLOSE_BTN_ID;
  close.type = 'button';
  close.title = '关闭此直播窗口';
  close.innerHTML = `<img src="${ICONS.close}" alt="" draggable="false" />`;
  close.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:close-self');
  });
  const fav = document.createElement('button');
  fav.id = FAV_BTN_ID;
  fav.type = 'button';
  fav.title = '收藏此直播';
  fav.innerHTML = `<img src="${ICONS.favoriteDark}" alt="" draggable="false" />`;
  fav.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:favorite');
  });
  const refresh = document.createElement('button');
  refresh.id = REFRESH_BTN_ID;
  refresh.type = 'button';
  refresh.title = '刷新直播';
  refresh.innerHTML = `<img src="${ICONS.refresh}" alt="" draggable="false" />`;
  refresh.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:refresh-self');
  });
  if (!document.getElementById(CLOSE_BTN_ID)) document.body.appendChild(close);
  if (!document.getElementById(FAV_BTN_ID)) document.body.appendChild(fav);
  if (!document.getElementById(REFRESH_BTN_ID)) document.body.appendChild(refresh);
  mountVolumeControl();
}

/** 主窗口静音按钮：点击切换静音/恢复，双图标按状态切换，状态由主进程下发 */
function mountVolumeControl(): void {
  if (document.getElementById(VOLUME_BOX_ID)) return;
  const btn = document.createElement('button');
  btn.id = VOLUME_BOX_ID;
  btn.type = 'button';
  btn.title = '静音 / 取消静音';
  btn.innerHTML = `<img class="lm-ic-on" src="${ICONS.volume}" alt="" draggable="false" /><img class="lm-ic-off" src="${ICONS.mute}" alt="" draggable="false" />`;
  btn.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    // 静音态点击 → 恢复（音量为 0 时给个默认值）；有声态点击 → 静音
    const silent = vol.muted || vol.volume === 0;
    ipcRenderer.send(
      'stream:volume-self',
      silent ? (vol.volume > 0 ? vol.volume : 0.6) : vol.volume,
      !silent,
    );
  });
  document.body.appendChild(btn);
  paintOverlayState();
}

/** 按当前状态刷新静音按钮的显隐与图标（DOM 可能被站点重建，随时可重画） */
function paintOverlayState(): void {
  const btn = document.getElementById(VOLUME_BOX_ID);
  if (!btn) return;
  btn.classList.toggle('lm-on', vol.isMain);
  btn.classList.toggle('lm-muted', vol.muted || vol.volume === 0);
}

/** 把音量写到页内媒体元素（站点 SPA 可能重建 <video>，由定时器周期性重刷）；
 *  静音由主进程 setAudioMuted 负责，这里不碰元素 muted */
function applyPageVolume(): void {
  if (!vol.isMain || vol.muted) return;
  document.querySelectorAll('video, audio').forEach((el) => {
    const m = el as HTMLMediaElement;
    if (Math.abs(m.volume - vol.volume) > 0.001) m.volume = vol.volume;
  });
}

ipcRenderer.on(
  'lm-state',
  (_e, s: { isMain?: unknown; volume?: unknown; muted?: unknown }) => {
    if (typeof s?.volume === 'number') vol.volume = s.volume;
    if (typeof s?.muted === 'boolean') vol.muted = s.muted;
    vol.isMain = !!s?.isMain;
    paintOverlayState();
    applyPageVolume();
  },
);
ipcRenderer.on('lm-volume', (_e, s: { volume?: unknown; muted?: unknown }) => {
  if (typeof s?.volume === 'number') vol.volume = s.volume;
  if (typeof s?.muted === 'boolean') vol.muted = s.muted;
  paintOverlayState();
  applyPageVolume();
});

if (document.body) {
  mountButtons();
} else {
  document.addEventListener('DOMContentLoaded', mountButtons, { once: true });
}
// 站点 SPA 跳转可能清理 DOM，定期确保按钮仍在；顺带重刷音量（媒体元素可能被重建）
setInterval(() => {
  if (
    !document.getElementById(CLOSE_BTN_ID) ||
    !document.getElementById(FAV_BTN_ID) ||
    !document.getElementById(REFRESH_BTN_ID) ||
    !document.getElementById(VOLUME_BOX_ID)
  ) {
    mountButtons();
  }
  applyPageVolume();
}, 2000);

// 挂载即向主进程要一次当前状态（槽位 + 音量）；页面整页 reload 后 preload 重跑也会再要
ipcRenderer.send('stream:overlay-ready');

document.addEventListener(
  'dblclick',
  (e) => {
    if (!e.isTrusted) return;
    const t = e.target as Element | null;
    // 覆盖层按钮/音量控件内（含 IMG 子元素）的双击不触发互换/铺满
    if (t?.closest?.(`#${CLOSE_BTN_ID}, #${FAV_BTN_ID}, #${REFRESH_BTN_ID}, #${VOLUME_BOX_ID}`)) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    ipcRenderer.send('stream:dblclick');
  },
  true,
);
