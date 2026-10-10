import { WebContentsView } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import type { StreamMedia } from './types';

/**
 * 抖音直播流嗅探直连（第二阶段）。
 *
 * 抖音 Web 接口有 a_bogus/msToken 等签名防护，逆向成本高且随版本失效；
 * 这里走「页面嗅探」路线：隐藏加载直播页（0×0 视图、静音），让页面自身
 * 完成全部签名与鉴权，从网络层观察它发出的拉流请求（FLV / HLS），
 * 拿到带 token 的地址后销毁页面，交给自研播放器播放。
 *
 * 拉流地址带时效 token，断线后由主进程重新嗅探（再次隐藏加载页面）。
 */

interface MediaHit {
  url: string;
  format: 'flv' | 'hls';
  ts: number;
}

/** 最近嗅探到的拉流地址（保留最近 60 条，供并发嗅探按时间过滤） */
const mediaLog: MediaHit[] = [];

const DOUYIN_MEDIA_URLS = [
  '*://*.douyincdn.com/*',
  '*://*.bytecdn.cn/*',
  '*://*.douyin.com/*',
];

function isMediaUrl(u: string): 'flv' | 'hls' | null {
  // 抖音拉流 URL 形如 https://webcast3-flv.douyincdn.com/webcast/room/stream_xxx.flv?...expires=...
  // 或 https://pull-hls-xx.douyincdn.com/.../playlist.m3u8?...
  if (/\.flv(\?|$)/i.test(u) || /\/stream_[^/?]+\.flv/i.test(u)) return 'flv';
  if (/\.m3u8(\?|$)/i.test(u)) return 'hls';
  return null;
}

/** 在抖音分区上挂常驻观察器（只记录、放行，不修改任何请求） */
export function attachDouyinSniffer(ses: Session): void {
  ses.webRequest.onBeforeRequest({ urls: DOUYIN_MEDIA_URLS }, (details, callback) => {
    const kind = isMediaUrl(details.url);
    if (kind) {
      mediaLog.push({ url: details.url, format: kind, ts: Date.now() });
      if (mediaLog.length > 60) mediaLog.splice(0, mediaLog.length - 60);
    }
    callback({});
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 隐藏加载抖音直播页并嗅探拉流地址。
 * 失败（超时/页面崩溃/未拉流）时抛错，由调用方回退内嵌页面模式。
 */
export async function sniffDouyinLive(
  url: string,
  ses: Session,
  win: BrowserWindow,
): Promise<StreamMedia> {
  const marker = Date.now();
  let title = '';
  let dead = false;

  const view = new WebContentsView({ webPreferences: { session: ses } });
  view.setBackgroundColor('#000000');
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.webContents.setAudioMuted(true); // 嗅探期间页面自动播放不能出声
  view.webContents.on('page-title-updated', (_e, t) => {
    title = t;
  });
  view.webContents.on('render-process-gone', () => {
    dead = true;
  });
  win.contentView.addChildView(view, 0);
  try {
    await view.webContents.loadURL(url);
  } catch {
    /* loadURL 失败继续等：部分错误页也会触发拉流重试 */
  }

  try {
    // 页面加载后由播放器发起拉流；轮询观察器结果
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (dead) throw new Error('抖音页面渲染进程退出');
      const hits = mediaLog.filter((m) => m.ts >= marker);
      if (hits.length) {
        // 再等一小会儿收集更优候选（页面可能先试探低清晰度再正式拉流）
        await sleep(2500);
        const all = mediaLog.filter((m) => m.ts >= marker);
        const pickFrom = all.length ? all : hits;
        const flv = pickFrom.filter((m) => m.format === 'flv');
        const best = flv.length ? flv[flv.length - 1] : pickFrom[pickFrom.length - 1];
        return { url: best.url, format: best.format, title: title.slice(0, 60) };
      }
      await sleep(500);
    }
    throw new Error('未嗅探到拉流地址（页面可能要求登录或未开播）');
  } finally {
    try {
      win.contentView.removeChildView(view);
      view.webContents.close();
    } catch {
      /* 可能已销毁 */
    }
  }
}
