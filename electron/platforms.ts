import type { Platform } from './types';

export const PLATFORMS: Platform[] = ['bilibili', 'douyin'];

export const PLATFORM_LABEL: Record<Platform, string> = {
  bilibili: '哔哩哔哩',
  douyin: '抖音',
};

/** 各平台独立登录页（在对应分区的 session 中打开，扫码后 Cookie 自动持久化） */
export const LOGIN_URL: Record<Platform, string> = {
  bilibili: 'https://passport.bilibili.com/login',
  douyin: 'https://sso.douyin.com/login?service=https%3A%2F%2Fwww.douyin.com&aid=6383',
};

/** 每个平台使用独立的持久化 session 分区，登录状态互不干扰且重启后保留 */
export function partitionFor(p: Platform): string {
  return `persist:live-${p}`;
}

/** 补全协议并校验为合法 http(s) 地址，非法返回 null */
export function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 根据地址识别直播平台，仅支持 bilibili.com / douyin.com 及其子域 */
export function detectPlatform(raw: string): Platform | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  const host = new URL(normalized).hostname.toLowerCase();
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  if (host === 'douyin.com' || host.endsWith('.douyin.com')) return 'douyin';
  return null;
}
