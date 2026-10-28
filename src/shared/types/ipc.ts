/**
 * 跨进程 IPC 契约类型：主进程（electron/）与渲染层（src/）共用，
 * 被 tsconfig.electron.json 与 vite 双轨编译——只放类型与纯数据形状，
 * 不要放主进程专属的运行时逻辑。
 */

/** 直播平台标识（当前支持哔哩哔哩、抖音） */
export type Platform = 'bilibili' | 'douyin';

/** 配置文件/新增窗口时使用的描述（尚无运行时 id） */
export interface SlotDesc {
  url: string;
  platform: Platform;
}

/** 主进程创建成功后带回 id 的窗口槽位 */
export interface StreamSlot extends SlotDesc {
  id: number;
  /** video = 自研播放器直连拉流；view = 内嵌平台页面（风控/接口变动等解析失败回退）；
   *  offline = 直播间未开播占位格（纯 DOM，不加载页面） */
  kind: 'video' | 'view' | 'offline';
  media?: StreamMedia;
  title?: string;
}

/** 直连播放的拉流信息（B站） */
export interface StreamMedia {
  url: string;
  format: StreamFormat;
  qn?: number;
  title?: string;
  roomId?: number;
}

export type StreamFormat = 'flv' | 'hls';

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 渲染层上报的单个直播窗口布局：位置 + 是否处于主窗口槽位 */
export interface LayoutItem {
  id: number;
  rect: ViewRect;
  isMain: boolean;
}

export interface LoginStatus {
  platform: Platform;
  loggedIn: boolean;
}

/** 启动时主进程下发给渲染层的初始状态（不恢复直播窗口，仅登录态与音量） */
export interface InitPayload {
  slots: StreamSlot[];
  logins: LoginStatus[];
  volume: number;
  muted: boolean;
}

/** 主窗口音量状态（0..1 + 静音；主进程持久化，内嵌页控件变更时回推 UI 层） */
export interface VolumeState {
  volume: number;
  muted: boolean;
}

export interface StreamTitleEvent {
  id: number;
  title: string;
}

export interface StreamErrorEvent {
  id: number;
  message: string;
}

/** 仅携带流 id 的事件载体（下列三个事件形状相同，别名保留各自语义） */
export interface StreamIdEvent {
  id: number;
}

/** 直播流结束（视图销毁后通知渲染层移除格子） */
export type StreamDeadEvent = StreamIdEvent;

/** 直播视图内双击（stream-preload 捕获，主进程中继回 UI 层） */
export type StreamDblClickEvent = StreamIdEvent;

/** 内嵌格页内星标按钮点击（主进程中继回 UI 层） */
export type StreamFavoriteEvent = StreamIdEvent;

/** 直连流地址刷新（流过期/断线后主进程重新解析下发） */
export interface StreamMediaEvent {
  id: number;
  media: StreamMedia;
}

/** 收藏分组（与收藏项在收藏列表中平级混排；收起状态跨启动保留） */
export interface FavGroup {
  kind: 'group';
  id: string;
  name: string;
  collapsed: boolean;
}

/** 收藏的直播间（userData/favorites.json v2，跨启动保留） */
export interface Favorite {
  kind: 'item';
  url: string;
  platform: Platform;
  alias: string;
  /** 所属分组 id（缺省为未分组的平级项） */
  groupId?: string;
}

/** 收藏列表条目：分组与收藏项平级混排在同一有序数组中 */
export type FavEntry = FavGroup | Favorite;

/** 收藏保存请求（按 url 去重，存在即改名；不改变已有条目的分组归属） */
export interface FavoriteSaveRequest {
  url: string;
  platform: Platform;
  alias: string;
}

/** 拖拽排序后的全量顺序上报：按界面顺序列出分组与收藏项，item 的 groupId 为拖放后的归属分组 */
export type FavoritesReorderRequest = Array<
  { kind: 'group'; id: string } | { kind: 'item'; url: string; groupId?: string }
>;

/** 收藏列表全量更新事件 */
export interface FavoritesUpdateEvent {
  entries: FavEntry[];
}

/** 收藏导入结果（ok 为 false 时：canceled=用户取消 / badfile=文件格式不识别） */
export type FavoritesImportResult =
  | { ok: true; addedItems: number; addedGroups: number; skipped: number }
  | { ok: false; reason: 'canceled' | 'badfile' };
