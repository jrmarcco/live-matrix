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
  /** video = 自研播放器直连拉流（B站）；view = 内嵌平台页面（抖音 / B站解析失败回退） */
  kind: 'video' | 'view';
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

export interface StreamDeadEvent {
  id: number;
}

/** 直播视图内双击（stream-preload 捕获，主进程中继回 UI 层） */
export interface StreamDblClickEvent {
  id: number;
}

/** 直连流地址刷新（流过期/断线后主进程重新解析下发） */
export interface StreamMediaEvent {
  id: number;
  media: StreamMedia;
}

/** 收藏的直播间（userData/favorites.json，跨启动保留） */
export interface Favorite {
  url: string;
  platform: Platform;
  alias: string;
}

/** 收藏保存请求（按 url 去重，存在即改名） */
export interface FavoriteSaveRequest {
  url: string;
  platform: Platform;
  alias: string;
}

/** 内嵌格页内星标按钮点击（主进程中继回 UI 层） */
export interface StreamFavoriteEvent {
  id: number;
}

/** 收藏列表全量更新事件 */
export interface FavoritesUpdateEvent {
  items: Favorite[];
}
