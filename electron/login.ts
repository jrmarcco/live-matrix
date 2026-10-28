import { app, BrowserWindow, session } from 'electron';
import type { Session } from 'electron';
import { LOGIN_URL, PLATFORM_LABEL, partitionFor } from '../src/shared/lib/platforms';
import type { LoginStatus, Platform } from '../src/shared/types/ipc';
import { getWin } from './windows';

/* ---------------- 平台登录态（独立 session 分区 + 登录子窗口 + Cookie 轮询） ---------------- */

const loginWindows = new Map<Platform, BrowserWindow>();
const loginCheckTimers = new Map<Platform, NodeJS.Timeout>();
const preparedSessions = new Set<Platform>();

export function sessionFor(p: Platform): Session {
  const ses = session.fromPartition(partitionFor(p));
  if (!preparedSessions.has(p)) {
    preparedSessions.add(p);
    // 去掉 UA 中的 Electron/App 标识，降低直播站点对内嵌浏览器的风控概率
    const ua = ses
      .getUserAgent()
      .replace(/\s*Electron\/[\d.]+/gi, '')
      .replace(new RegExp(`\\s*${app.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[\\d.]+`, 'i'), '');
    ses.setUserAgent(ua);
    // 观看直播不需要任何设备权限，一律拒绝
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.cookies.on('changed', () => scheduleLoginCheck(p));
  }
  return ses;
}

/** 判断 cookie 列表中是否存在指定域名后缀的 cookie */
function matchDomain(list: Electron.Cookie[], domain: string): boolean {
  return list.some((c) => (c.domain ?? '').endsWith(domain));
}

export async function isLoggedIn(p: Platform): Promise<boolean> {
  const ses = session.fromPartition(partitionFor(p));
  if (p === 'bilibili') {
    return matchDomain(await ses.cookies.get({ name: 'SESSDATA' }), 'bilibili.com');
  }
  if (matchDomain(await ses.cookies.get({ name: 'sessionid_ss' }), 'douyin.com')) return true;
  return matchDomain(await ses.cookies.get({ name: 'sessionid' }), 'douyin.com');
}

export async function pushLogin(p: Platform): Promise<void> {
  const loggedIn = await isLoggedIn(p);
  const status: LoginStatus = { platform: p, loggedIn };
  getWin()?.webContents.send('login:status', status);
  // 登录成功后自动关闭登录窗口
  const lw = loginWindows.get(p);
  if (loggedIn && lw && !lw.isDestroyed()) {
    setTimeout(() => {
      if (!lw.isDestroyed()) lw.close();
    }, 1500);
  }
}

function scheduleLoginCheck(p: Platform): void {
  const prev = loginCheckTimers.get(p);
  if (prev) clearTimeout(prev);
  loginCheckTimers.set(
    p,
    setTimeout(() => void pushLogin(p), 700),
  );
}

export function openLogin(p: Platform): void {
  const existing = loginWindows.get(p);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const win = getWin();
  if (!win) return;
  const lw = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 380,
    minHeight: 520,
    parent: win,
    title: `登录${PLATFORM_LABEL[p]}`,
    backgroundColor: '#ffffff',
    webPreferences: { session: sessionFor(p) },
  });
  loginWindows.set(p, lw);
  lw.on('closed', () => {
    loginWindows.delete(p);
    scheduleLoginCheck(p);
  });
  void lw.loadURL(LOGIN_URL[p]).catch(() => {});
}

/** 关闭并清理指定平台的登录窗口（退出登录时调用） */
export function closeLoginWindow(p: Platform): void {
  const lw = loginWindows.get(p);
  if (lw && !lw.isDestroyed()) lw.destroy();
  loginWindows.delete(p);
}

/** 主窗口已关：登录子窗口一并带走，否则 window-all-closed 会等它们而进程驻留 */
export function closeAllLoginWindows(): void {
  for (const lw of loginWindows.values()) {
    if (!lw.isDestroyed()) lw.destroy();
  }
  loginWindows.clear();
}
