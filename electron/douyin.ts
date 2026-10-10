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

/** 抖音画质档位（URL 参数 biz_quality），index 越大画质越高（实测原画参数为 origin） */
const QUALITY_ORDER = ['ld', 'sd', 'hd', 'uhd', 'od', 'origin'];

function mediaQuality(u: string): number {
  const q = /[?&]biz_quality=(\w+)/.exec(u);
  if (q) {
    const i = QUALITY_ORDER.indexOf(q[1]);
    return i >= 0 ? i : 0;
  }
  const r = /[?&]biz_resolution=(\d+)x(\d+)/.exec(u);
  if (r) return (Number(r[1]) * Number(r[2])) / 100000; // 无档位参数时按分辨率面积兜底
  return 0;
}

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
  // 完全静音时抖音对自动播放只下发低清流（实测 ld/540p）。
  // 改为「未静音但音量 0」：等待循环里持续把页内 video 设为 muted=false + volume=0，
  // 页面判定为有声播放才可能拿到更高画质，且不会真的出声
  view.webContents.setAudioMuted(false);
  const zeroVideoVolume = () => {
    void view.webContents
      .executeJavaScript(
        `document.querySelectorAll('video').forEach((v) => { v.muted = false; v.volume = 0; })`,
      )
      .catch(() => {});
  };
  // 模拟点击播放器画质菜单选最高档（隐藏自动播放默认只有低清流）。
  // 切换成功后页面会重新拉流，嗅探器捕获到更高画质的候选，由选优逻辑自动采用。
  const upgradeQuality = () =>
    view.webContents
      .executeJavaScript(`(() => {
        const byText = (re) => [...document.querySelectorAll('div,button,span,li')]
          .filter((el) => el.childElementCount <= 2 && re.test((el.innerText || '').trim()) && (el.innerText || '').trim().length < 12);
        const trigger = byText(/^(画质|\\d+P|原画|蓝光|超清|高清|标清|流畅)/).pop();
        if (!trigger) return 'no-trigger';
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const order = ['原画', '蓝光10M', '蓝光', '超清', '高清', '标清', '流畅'];
        const items = [...document.querySelectorAll('div,li,span')]
          .filter((el) => el.childElementCount === 0 && order.includes((el.innerText || '').trim()));
        const pick = order.map((q) => items.find((el) => el.innerText.trim() === q)).find(Boolean);
        if (!pick) return 'no-item';
        pick.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        pick.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'clicked:' + pick.innerText.trim();
      })()`)
      .then((r: unknown) => {
        if (typeof r === 'string' && r !== 'no-trigger') console.log(`[douyin] 画质切换: ${r}`);
        return r;
      })
      .catch(() => {});
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
      zeroVideoVolume(); // 播放器可能在任意时刻挂载/重置 video，持续压制音量
      const hits = mediaLog.filter((m) => m.ts >= marker);
      if (hits.length) {
        // 已有低清流在拉：尝试切到最高档，收集窗口 8s 观察新候选
        void (await upgradeQuality());
        await sleep(3000);
        void (await upgradeQuality());
        await sleep(5000);
        const all = mediaLog.filter((m) => m.ts >= marker);
        const pickFrom = all.length ? all : hits;
        console.log(
          `[douyin] 候选 ${pickFrom.length} 条: ` +
            pickFrom
              .map((m) => `${m.format}/${mediaQuality(m.url)}(${m.url.match(/[?&]biz_quality=(\w+)/)?.[1] ?? '?'})`)
              .join(' '),
        );
        // 组内取画质最高，整体偏好 flv（延迟最低）
        const flv = pickFrom.filter((m) => m.format === 'flv');
        const pool = flv.length ? flv : pickFrom;
        const best = pool.reduce((a, b) => (mediaQuality(b.url) > mediaQuality(a.url) ? b : a));
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
