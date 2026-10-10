import type { Session } from 'electron';
import type { StreamMedia } from './types';

/**
 * 哔哩哔哩直播流直连解析（第一阶段：绕开直播页，自研播放器播放）。
 *
 * 使用两个无签名的公开接口（社区文档 bilibili-API-collect）：
 * 1. room/v1/Room/get_info        —— 短号换真实房间号、直播状态、标题
 * 2. xlive/web-room/v2/.../getRoomPlayInfo —— 拉流地址（FLV / fMP4-HLS / TS-HLS）
 *
 * 请求携带 persist:live-bilibili 分区的登录 Cookie（session.fetch），
 * 登录后可解锁更高清晰度。拉流地址由 CDN 鉴权（Referer 校验 + 时效签名），
 * 播放侧需注入 Referer（见主进程 webRequest），过期后需重新解析。
 */

interface BiliEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

interface GetInfoData {
  room_id: number;
  live_status: number; // 1 = 直播中
  title: string;
}

interface PlayUrlData {
  live_status: number;
  playurl_info?: {
    playurl?: {
      stream?: {
        protocol_name: string; // http_stream | http_hls
        format?: {
          format_name: string; // flv | fmp4 | ts
          codec?: {
            codec_name: string;
            current_qn: number;
            accept_qn?: number[];
            base_url: string; // 以 "?" 结尾
            url_info?: { host: string; extra?: string }[];
          }[];
        }[];
      }[];
    };
  };
}

const API_HEADERS = {
  Referer: 'https://live.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
};

function parseRoomId(url: string): number | null {
  const m = /live\.bilibili\.com\/(\d+)/.exec(url);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function biliApi<T>(ses: Session, url: string): Promise<T> {
  const res = await ses.fetch(url, {
    headers: API_HEADERS,
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as BiliEnvelope<T>;
  if (j.code !== 0) throw new Error(j.message || `接口返回 code=${j.code}`);
  return j.data;
}

/** 按播放器能力挑流：HTTP-FLV（mpegts.js，延迟最低）> fMP4-HLS > TS-HLS（hls.js） */
function pickStreams(play: PlayUrlData, title: string, roomId: number): StreamMedia[] {
  const out: StreamMedia[] = [];
  for (const s of play.playurl_info?.playurl?.stream ?? []) {
    for (const f of s.format ?? []) {
      for (const c of f.codec ?? []) {
        const u = c.url_info?.[0];
        if (!u?.host || !c.base_url) continue;
        if (s.protocol_name === 'http_stream' && f.format_name === 'flv') {
          out.push({ url: u.host + c.base_url + (u.extra ?? ''), format: 'flv', qn: c.current_qn, title, roomId });
        } else if (s.protocol_name === 'http_hls' && (f.format_name === 'fmp4' || f.format_name === 'ts')) {
          out.push({ url: u.host + c.base_url + (u.extra ?? ''), format: 'hls', qn: c.current_qn, title, roomId });
        }
      }
    }
  }
  const rank = (m: StreamMedia): number => {
    if (m.format === 'flv') return 0;
    return m.url.includes('fmp4') || m.url.includes('index.m3u8') ? 1 : 2;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

export async function resolveBiliLive(url: string, ses: Session): Promise<StreamMedia> {
  const roomId = parseRoomId(url);
  if (!roomId) throw new Error('无法从地址解析房间号');
  const info = await biliApi<GetInfoData>(
    ses,
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`,
  );
  const realId = info.room_id || roomId;
  const fetchPlay = (qn: number) =>
    biliApi<PlayUrlData>(
      ses,
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo` +
      `?room_id=${realId}&protocol=0,1&format=0,1,2&codec=0,1&qn=${qn}&platform=web&ptype=8`,
    );
  let play = await fetchPlay(0);
  // qn=0 为「默认画质」，实测通常即最高档；若返回档位低于可选最高档，显式用最高档重取
  const codecs = (play.playurl_info?.playurl?.stream ?? []).flatMap((s) =>
    (s.format ?? []).flatMap((f) => f.codec ?? []),
  );
  const accept = Math.max(0, ...codecs.flatMap((c) => c.accept_qn ?? []));
  const current = Math.max(0, ...codecs.map((c) => c.current_qn ?? 0));
  if (accept > current) {
    play = await fetchPlay(accept);
  }
  if (info.live_status !== 1 || play.live_status !== 1) throw new Error('直播间未开播');
  const candidates = pickStreams(play, info.title, realId);
  if (!candidates.length) throw new Error('接口未返回可用流');
  return candidates[0];
}
