import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { state, type Cell } from './state';
import { setState } from './stage';

/* ---------------- 直连播放器（hls.js / mpegts.js）：挂载、销毁、断线重排 + 播放看门狗 ---------------- */

interface PlayerHandle {
  destroy: () => void;
  /** 看门狗检测播放进度用的视频元素引用 */
  video: HTMLVideoElement;
}

const players = new Map<number, PlayerHandle>();
const refreshTimers = new Map<number, number>();

export function destroyPlayer(id: number): void {
  const t = refreshTimers.get(id);
  if (t) {
    window.clearTimeout(t);
    refreshTimers.delete(id);
  }
  watchdog.delete(id);
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
      video,
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
    players.set(c.id, { video, destroy: () => hls.destroy() });
  } else {
    // 原生回退：直接给 <video> 赋源
    console.warn('[lm-player] native fallback, format=', c.media.format);
    video.src = c.media.url;
    players.set(c.id, {
      video,
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

/* ---------------- 播放看门狗 ----------------
 * 播放器自身的 ERROR 事件只覆盖「显式报错」的断线；另一类故障是画面静默卡住
 * （CDN 停止喂数 / 流悄悄断开 / 主播下播停在最后一帧），没有任何错误回调。
 * 看门狗周期检查每个 <video> 的 currentTime 是否仍在推进，停滞足够久或已 ended
 * 时自动走 scheduleRefresh → 主进程重新解析 → stream:media 重建播放器，
 * 全程无需手动点击。 */

interface WatchEntry {
  /** 上次检测时的播放位置（<0 表示尚无基线） */
  lastTime: number;
  /** 连续未推进的检测次数 */
  stalledChecks: number;
  /** 上次自动刷新触发时间（冷却防抖） */
  lastTrigger: number;
}

const watchdog = new Map<number, WatchEntry>();
/** 检测周期 */
const WATCHDOG_INTERVAL_MS = 5000;
/** 连续 N 次检测 currentTime 未推进（约 10s）判定卡住；取 2 避免短暂缓冲误报 */
const STALL_CONFIRM_TICKS = 2;
/** 同一格子两次自动刷新的最小间隔（也决定主播下播后的重连节奏） */
const AUTO_REFRESH_COOLDOWN_MS = 30_000;

function triggerAutoRefresh(id: number, entry: WatchEntry, text: string): void {
  entry.lastTrigger = Date.now();
  entry.stalledChecks = 0;
  entry.lastTime = -1; // 丢弃旧基线，等重建后的下一轮重新采样
  setState(id, text);
  scheduleRefresh(id);
  console.log(`[lm-player] 看门狗自动刷新: id=${id} ${text}`);
}

window.setInterval(() => {
  const now = Date.now();
  for (const [id, p] of players) {
    const v = p.video;
    // 尚未装载或处于暂停（如自动播放被拒等待用户点击）的不监测
    if (!v || v.readyState === 0 || v.paused) {
      watchdog.delete(id);
      continue;
    }
    let entry = watchdog.get(id);
    if (!entry) {
      entry = { lastTime: -1, stalledChecks: 0, lastTrigger: 0 };
      watchdog.set(id, entry);
    }
    if (v.ended) {
      // 流正常结束（主播下播）：周期自动重连，主播重播后即恢复播放
      if (now - entry.lastTrigger >= AUTO_REFRESH_COOLDOWN_MS) {
        triggerAutoRefresh(id, entry, '直播结束，自动重连…');
      }
      entry.lastTime = v.currentTime;
      continue;
    }
    if (entry.lastTime >= 0 && v.currentTime - entry.lastTime < 0.3) {
      entry.stalledChecks++;
      if (entry.stalledChecks >= STALL_CONFIRM_TICKS && now - entry.lastTrigger >= AUTO_REFRESH_COOLDOWN_MS) {
        triggerAutoRefresh(id, entry, '画面卡住，自动刷新…');
        continue;
      }
    } else {
      entry.stalledChecks = 0;
    }
    entry.lastTime = v.currentTime;
  }
  // 仅删除当前遍历到的键（Map 迭代中删除已访问键是安全的）
  for (const id of watchdog.keys()) {
    if (!players.has(id)) watchdog.delete(id);
  }
}, WATCHDOG_INTERVAL_MS);
