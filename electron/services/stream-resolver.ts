import type { BrowserWindow, Session } from 'electron';
import { resolveBiliLive } from '../bilibili';
import { sniffDouyinLive } from '../douyin';
import type { Platform, StreamMedia } from '../../src/shared/types/ipc';

export interface StreamResolver {
  /** 解析直播间直连地址；未开播抛 OfflineError（调用方落占位格），其余失败抛普通错误（回退内嵌页） */
  resolve(url: string, ses: Session, win: BrowserWindow): Promise<StreamMedia>;
}

/** 平台解析策略注册表：新增平台在此登记，调用方不再感知平台分支（浏览页能力未来按同模式扩展） */
const resolvers: Record<Platform, StreamResolver> = {
  bilibili: { resolve: (url, ses) => resolveBiliLive(url, ses) },
  douyin: { resolve: (url, ses, win) => sniffDouyinLive(url, ses, win) },
};

export function resolveStream(platform: Platform, url: string, ses: Session, win: BrowserWindow): Promise<StreamMedia> {
  return resolvers[platform].resolve(url, ses, win);
}
