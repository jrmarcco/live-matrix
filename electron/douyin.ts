import { WebContentsView } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import { OfflineError } from './types';
import type { StreamMedia } from './types';

/**
 * 抖音直播流直连解析（第二阶段：页面代签 + 响应捕获）。
 *
 * 抖音 Web 接口有 a_bogus/msToken 等签名防护，主进程无法直接构造请求；
 * 这里隐藏加载直播页（0×0 视图），通过 webContents.debugger（CDP）的
 * Network 域捕获页面自身调用房间信息接口（/webcast/room/web/enter/，
 * URL 由页面完成签名鉴权）的响应体，从中取出 FLV / HLS 直连地址，
 * 交给自研播放器播放。
 *
 * 为什么在浏览器进程层捕获而不是注入页面 / 重放接口：
 * - 重放（旧方案）：签名接口重放在当前风控下经常挂起或返回空响应体，
 *   未开播房间尤甚——既拿不到数据，也拖慢判定（空等 15s+ 超时）；
 * - 注入页面读状态：抖音页面加载后主线程长时间繁忙，executeJavaScript
 *   可能一直不返回（实测 75s+ 无响应），轮询不可靠；
 * - CDP Network 在浏览器进程取响应体，与页面繁忙程度无关，实测 enter
 *   响应约 2s 到达、2.4s 即可完成判定（无需等整页加载）。
 *
 * 地址带时效签名（wsSecret/expires），断线后由主进程重新解析。
 */

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

/**
 * 解析捕获到的 enter 响应体：
 * - 未开播（status !== 2 且无任何拉流地址，含轮播/回放房间）→ 抛 OfflineError
 * - 有拉流地址 → 偏好 FLV（延迟最低），组内取画质最高；FLV 缺失回退 HLS
 * - 开播中但无 HTTP 流（如仅 WebRTC）/ 响应结构异常 → 返回 null 继续等待
 */
function parseEnterResponse(raw: string, fallbackTitle: string): StreamMedia | null {
  let j: { data?: { data?: DyEnterRoom[] } };
  try {
    j = JSON.parse(raw) as { data?: { data?: DyEnterRoom[] } };
  } catch {
    return null;
  }
  const room = j?.data?.data?.[0];
  const su = room?.stream_url;
  const flv = su?.flv_pull_url ?? {};
  const flvKeys = Object.keys(flv);
  if (room && room.status !== 2 && !flvKeys.length && !su?.hls_pull_url) {
    throw new OfflineError('直播间未开播');
  }
  const title = (room?.title || fallbackTitle || '').slice(0, 60);
  if (flvKeys.length) {
    const best = flvKeys.toSorted((a, b) => qualityRank(b) - qualityRank(a))[0];
    return { url: flv[best], format: 'flv', title };
  }
  const hlsMap = su?.hls_pull_url_map ?? {};
  const hlsKeys = Object.keys(hlsMap);
  if (hlsKeys.length) {
    const best = hlsKeys.toSorted((a, b) => qualityRank(b) - qualityRank(a))[0];
    return { url: hlsMap[best], format: 'hls', title };
  }
  if (su?.hls_pull_url) return { url: su.hls_pull_url, format: 'hls', title };
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 隐藏加载抖音直播页并捕获其房间信息接口响应，解析直连地址。
 * 未开播抛 OfflineError（调用方落「未开播」占位格）；其余失败（页面崩溃/
 * 登录墙/风控）抛错，由调用方回退内嵌页面模式。
 */
export async function sniffDouyinLive(url: string, ses: Session, win: BrowserWindow): Promise<StreamMedia> {
  let title = '';
  let dead = false;
  /** 捕获到的 enter 响应体（主进程侧变量，轮询无需进渲染进程） */
  let enterBody: string | null = null;

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

  const dbg = view.webContents.debugger;
  let attached = false;
  /** 已看到响应、等待 loadingFinished 取 body 的 enter 请求 */
  const pending = new Set<string>();
  dbg.on('message', (_e, method, params) => {
    if (method === 'Network.responseReceived') {
      const u = String(params?.response?.url ?? '');
      if (u.includes('webcast/room/web/enter')) pending.add(String(params.requestId));
    } else if (method === 'Network.loadingFinished' && pending.delete(String(params.requestId))) {
      void dbg
        .sendCommand('Network.getResponseBody', { requestId: params.requestId })
        .then((b: { body: string; base64Encoded?: boolean }) => {
          enterBody = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        })
        .catch(() => {
          /* 响应体取不到则等页面重试 enter */
        });
    }
  });
  // 与 loadURL 并行启用 Network 捕获（attach 单独 await 实测可能挂起，
  // 且 enter 约在 2s 后才发出、attach 约 0.5s 完成，时序余量充足；
  // attach 失败则无捕获、由超时兜底回退页面模式）
  win.contentView.addChildView(view, 0);
  const attachReady = (async () => {
    dbg.attach('1.3');
    await dbg.sendCommand('Network.enable');
  })();
  // 不 await 整页加载完成：enter 响应在加载中途（约 2s）就会产生，
  // 捕获到即可解析返回，中途销毁视图不影响结果
  void view.webContents.loadURL(url).catch(() => {
    /* 加载失败继续轮询：错误页也可能已触发接口 */
  });
  try {
    await Promise.race([
      attachReady,
      sleep(4000).then(() => {
        throw new Error('debugger attach 超时');
      }),
    ]);
    attached = true;
  } catch {
    /* 未捕获则走超时回退 */
  }

  try {
    const t0 = Date.now();
    const deadline = t0 + 15000;
    let sawResponse = false;
    while (Date.now() < deadline) {
      if (dead) throw new Error('抖音页面渲染进程退出');
      if (enterBody !== null) {
        sawResponse = true;
        let media: StreamMedia | null;
        try {
          media = parseEnterResponse(enterBody, title);
        } catch (err) {
          if (err instanceof OfflineError) {
            console.log(`[douyin] 未开播判定（耗时 ${Date.now() - t0}ms）`);
          }
          throw err;
        }
        if (media) {
          console.log(`[douyin] 直连解析成功: ${media.format} ${media.title}（耗时 ${Date.now() - t0}ms）`);
          return media;
        }
        // 响应已捕获但无可解析流（开播中仅 WebRTC 等）：继续等页面可能的
        // 后续请求（画质切换会重新调用 enter）
      }
      await sleep(150);
    }
    throw new Error(
      sawResponse
        ? '房间开播中但未提供 HTTP 直连流（可能仅 WebRTC 或需登录）'
        : '未捕获到房间信息接口（页面可能要求登录或被风控）',
    );
  } finally {
    if (attached) {
      try {
        dbg.detach();
      } catch {
        /* 可能已随视图销毁 */
      }
    }
    try {
      win.contentView.removeChildView(view);
      view.webContents.close();
    } catch {
      /* 可能已销毁 */
    }
  }
}
