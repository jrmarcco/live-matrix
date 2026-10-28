import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { state, type Cell } from './state';
import { setState } from './stage';

/* ---------------- 直连播放器（hls.js / mpegts.js）的挂载、销毁与断线重排 ---------------- */

interface PlayerHandle {
  destroy: () => void;
}

const players = new Map<number, PlayerHandle>();
const refreshTimers = new Map<number, number>();

export function destroyPlayer(id: number): void {
  const t = refreshTimers.get(id);
  if (t) {
    window.clearTimeout(t);
    refreshTimers.delete(id);
  }
  const p = players.get(id);
  players.delete(id);
  try {
    p?.destroy();
  } catch {
    /* 可能已销毁 */
  }
}

/** 清掉待触发的自动刷新（手动刷新前调用，避免刷新后又被重复解析一次） */
export function cancelRefreshTimer(id: number): void {
  const t = refreshTimers.get(id);
  if (t) {
    window.clearTimeout(t);
    refreshTimers.delete(id);
  }
}

/** render() 重建格子后销毁已移除槽位的播放器用 */
export function getPlayerIds(): number[] {
  return [...players.keys()];
}

export function attachPlayer(cellEl: HTMLElement, c: Cell): void {
  destroyPlayer(c.id);
  const video = cellEl.querySelector('video');
  if (!video || !c.media) return;
  setState(c.id, '载入中…');
  video.addEventListener(
    'playing',
    () => {
      setState(c.id, '');
    },
    { once: true },
  );

  if (c.media.format === 'flv' && mpegts.getFeatureList().mseLivePlayback) {
    console.log('[lm-player] flv via mpegts.js', c.media.url.slice(0, 70));
    // HTTP-FLV：延迟最低，mpegts.js（B站自家维护）
    const player = mpegts.createPlayer(
      { type: 'flv', url: c.media.url, isLive: true, cors: true },
      {
        enableStashBuffer: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 6,
        lazyLoad: false,
      },
    );
    player.on(mpegts.Events.ERROR, () => {
      destroyPlayer(c.id);
      scheduleRefresh(c.id);
    });
    player.attachMediaElement(video);
    player.load();
    players.set(c.id, {
      destroy: () => {
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          /* 可能已销毁 */
        }
      },
    });
  } else if (c.media.format === 'hls' && Hls.isSupported()) {
    console.log('[lm-player] hls via hls.js');
    const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, maxBufferLength: 12 });
    hls.loadSource(c.media.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      destroyPlayer(c.id);
      scheduleRefresh(c.id);
    });
    players.set(c.id, { destroy: () => hls.destroy() });
  } else {
    // 原生回退：直接给 <video> 赋源
    console.warn('[lm-player] native fallback, format=', c.media.format);
    video.src = c.media.url;
    players.set(c.id, {
      destroy: () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      },
    });
  }
  void video.play().catch(() => {
    /* 自动播放被拒时等用户点击 */
  });
}

/** 流地址过期/断线：节流后请主进程重新解析 */
export function scheduleRefresh(id: number): void {
  if (refreshTimers.has(id)) return;
  refreshTimers.set(
    id,
    window.setTimeout(() => {
      refreshTimers.delete(id);
      const c = state.cells.find((x) => x.id === id);
      if (!c || c.kind !== 'video') return;
      setState(id, '线路刷新中…');
      window.lm.refreshStream(id);
    }, 3000),
  );
}
