import type { FavEntry, Platform, StreamMedia } from './shared/types/ipc';

/** 1 主 + 7 副 = 8 个槽位；右侧副窗口网格为 2 列 × 4 行 */
export const MAX_CELLS = 8;

export interface Cell {
  id: number;
  url: string;
  platform: Platform;
  /** video = 自研播放器直连拉流（B站/抖音）；view = 内嵌平台页面；offline = 未开播占位格 */
  kind: 'video' | 'view' | 'offline';
  media?: StreamMedia;
  title?: string;
  error?: string;
}

/** 加载中的占位格（id 为负数，不与主进程分配的正数 id 冲突） */
export interface PendingCell {
  id: number;
  url: string;
  platform: Platform;
  kind: 'pending';
}

export type StageCell = Cell | PendingCell;

/** 渲染层跨模块共享的可变状态（模块单例；主进程为权威源的数据经 IPC 事件回写此处） */
export const state = {
  /** index 0 为主窗口槽位（左上角大画面，有声） */
  cells: [] as StageCell[],
  /** 加载占位格的负数 id 序列 */
  pendingSeq: -1,
  /** 双击主窗口进入：主画面铺满舞台，副窗口隐藏；再双击还原 */
  focusMode: false,
  loginState: { bilibili: false, douyin: false } as Record<Platform, boolean>,
  /** 主窗口音量（0..1 + 静音）：主进程持久化，内嵌页控件变更时经 volume:changed 回推 */
  mainVolume: 1,
  mainMuted: false,
  favorites: [] as FavEntry[],
};
