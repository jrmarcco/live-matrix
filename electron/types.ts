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
}

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

/** 启动恢复时主进程下发给渲染层的初始状态 */
export interface InitPayload {
  slots: StreamSlot[];
  logins: LoginStatus[];
}

/** 持久化到 userData/config.json 的内容，slots 顺序即槽位顺序（第一个为主窗口） */
export interface SavedConfig {
  version: 1;
  slots: SlotDesc[];
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

/** 拖拽覆盖层回传的鼠标事件（坐标为窗口内容区坐标） */
export type DragOverlayEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'up'; x: number; y: number }
  | { type: 'cancel' };
