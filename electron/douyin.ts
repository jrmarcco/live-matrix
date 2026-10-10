import { WebContentsView } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import type { StreamMedia } from './types';

/**
 * 抖音直播流直连解析（第二阶段：接口重放）。
 *
 * 抖音 Web 接口有 a_bogus/msToken 等签名防护，主进程无法直接构造请求；
 * 这里走「页面代签 + 主进程重放」路线：隐藏加载直播页（0×0 视图），
 * 让页面自身完成签名与鉴权，从网络层捕获它调用的房间信息接口
 * （/webcast/room/web/enter/，URL 自带全部签名参数），随后主进程用同一
 * session 重放该请求，从响应 JSON（data.data[0].stream_url）中取出
 * FLV / HLS 直连地址，交给自研播放器播放。
 *
 * 注：抖音网页播放器已改用 WebRTC 取流（不再发起 HTTP 拉流请求），
 * 旧版「嗅探拉流请求」方案已失效；但 enter 接口仍会返回 HTTP 直连地址。
 * 地址带时效签名（wsSecret/expires），断线后由主进程重新解析。
 */

/** 页面最近调用的 enter 接口地址（带签名参数，保留最近若干条供重放） */
const enterLog: { url: string; ts: number }[] = [];

/** 在抖音分区上挂常驻观察器（只记录、放行，不修改任何请求） */
export function attachDouyinSniffer(ses: Session): void {
  ses.webRequest.onBeforeRequest({ urls: ['*://*.douyin.com/webcast/room/web/enter/*'] }, (details, callback) => {
    enterLog.push({ url: details.url, ts: Date.now() });
    if (enterLog.length > 12) enterLog.splice(0, enterLog.length - 12);
    callback({});
  });
}

/** 抖音画质档位（flv_pull_url / hls_pull_url_map 的 key），index 越大画质越高 */
const QUALITY_ORDER = ['SD2', 'SD1', 'HD1', 'FULL_HD1', 'FULL_HD2', 'UHD', 'ORIGIN', 'ORIGION'];

function qualityRank(key: string): number {
  const i = QUALITY_ORDER.indexOf(key.toUpperCase());
  return i >= 0 ? i : -1; // 未知档位（如新档名）视为最低
}

interface DyEnterRoom {
  status?: number;
  title?: string;
  stream_url?: {
    flv_pull_url?: Record<string, string>;
    hls_pull_url_map?: Record<string, string>;
    hls_pull_url?: string;
  };
}

/** 重放 enter 接口并解析直连地址；接口未就绪/房间未开播返回 null */
async function replayEnter(enterUrl: string, referer: string, ses: Session): Promise<StreamMedia | null> {
  const res = await withTimeout(
    ses.fetch(enterUrl, {
      credentials: 'include',
      headers: { Referer: referer },
    }),
    8000,
  );
  if (!res.ok) throw new Error(`enter 接口 HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { data?: DyEnterRoom[] } };
  const room = j?.data?.data?.[0];
  const su = room?.stream_url;
  const flv = su?.flv_pull_url ?? {};
  const flvKeys = Object.keys(flv);
  if (room && room.status !== 2 && !flvKeys.length && !su?.hls_pull_url) {
    throw new Error('直播间未开播');
  }
  const title = (room?.title || '').slice(0, 60);
  // 偏好 FLV（延迟最低）；组内取画质最高；FLV 缺失时回退 HLS（同样按档位选优）
  if (flvKeys.length) {
    const best = flvKeys.sort((a, b) => qualityRank(b) - qualityRank(a))[0];
    return { url: flv[best], format: 'flv', title };
  }
  const hlsMap = su?.hls_pull_url_map ?? {};
  const hlsKeys = Object.keys(hlsMap);
  if (hlsKeys.length) {
    const best = hlsKeys.sort((a, b) => qualityRank(b) - qualityRank(a))[0];
    return { url: hlsMap[best], format: 'hls', title };
  }
  if (su?.hls_pull_url) return { url: su.hls_pull_url, format: 'hls', title };
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 限时包装：超时抛错，避免个别挂起的请求拖住整个解析流程 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('请求超时')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * 隐藏加载抖音直播页并解析直连地址。
 * 失败（超时/页面崩溃/未开播）时抛错，由调用方回退内嵌页面模式。
 */
export async function sniffDouyinLive(
  url: string,
  ses: Session,
  win: BrowserWindow,
): Promise<StreamMedia> {
  let title = '';
  let dead = false;

  const view = new WebContentsView({ webPreferences: { session: ses } });
  view.setBackgroundColor('#000000');
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.webContents.setAudioMuted(true); // 只为触发接口，无需出声
  view.webContents.on('page-title-updated', (_e, t) => {
    title = t;
  });
  view.webContents.on('render-process-gone', () => {
    dead = true;
  });
  win.contentView.addChildView(view, 0);
  // marker 必须在 loadURL 之前取：enter 请求在页面加载期间就会发出
  const marker = Date.now();
  try {
    await view.webContents.loadURL(url);
  } catch {
    /* loadURL 失败继续等：错误页也可能已触发 enter */
  }

  try {
    // 页面加载后即调用 enter 接口；轮询捕获并重放解析。
    // 并发嗅探多个房间时按房间号过滤，避免把别家的直连地址错配过来
    const roomId = /live\.douyin\.com\/(\d+)/.exec(url)?.[1] ?? '';
    const deadline = Date.now() + 15000;
    let lastTried = '';
    let lastTryAt = 0;
    while (Date.now() < deadline) {
      if (dead) throw new Error('抖音页面渲染进程退出');
      const recent = enterLog.filter((h) => h.ts >= marker);
      const matched = roomId
        ? recent.filter((h) => h.url.includes(`web_rid=${roomId}`) || h.url.includes(`room_id=${roomId}`))
        : recent;
      // 房间号没匹配上时兜底取最近一条（参数命名变化时不至于完全失效）
      const hit = matched[matched.length - 1] ?? (deadline - Date.now() < 7000 ? recent[recent.length - 1] : undefined);
      if (hit && (hit.url !== lastTried || Date.now() - lastTryAt > 3000)) {
        lastTried = hit.url;
        lastTryAt = Date.now();
        const media = await replayEnter(hit.url, url, ses).catch((err: unknown) => {
          console.warn(`[douyin] enter 重放失败: ${String(err)}`);
          return null;
        });
        if (media) {
          console.log(`[douyin] 直连解析成功: ${media.format} ${media.title}`);
          return media.title ? media : { ...media, title: title.slice(0, 60) };
        }
      }
      await sleep(600);
    }
    throw new Error('未解析到拉流地址（页面可能要求登录或未开播）');
  } finally {
    try {
      win.contentView.removeChildView(view);
      view.webContents.close();
    } catch {
      /* 可能已销毁 */
    }
  }
}
