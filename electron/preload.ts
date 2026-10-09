import { contextBridge, ipcRenderer } from 'electron';
import type {
  DragOverlayEvent,
  InitPayload,
  LayoutItem,
  LoginStatus,
  Platform,
  SavedConfig,
  StreamDeadEvent,
  StreamErrorEvent,
  StreamSlot,
  StreamTitleEvent,
} from './types';

const api = {
  /** 渲染层就绪，请求初始状态（恢复的窗口槽位 + 登录状态） */
  ready: () => ipcRenderer.send('ui:ready'),

  addStream: (url: string, platform: Platform) =>
    ipcRenderer.invoke('stream:add', url, platform) as Promise<StreamSlot | null>,
  closeStream: (id: number) => void ipcRenderer.send('stream:close', id),

  /** 上传全部窗口的位置；主进程据此 setBounds 并按 isMain 控制静音 */
  updateLayout: (items: LayoutItem[]) => void ipcRenderer.send('layout:update', items),

  /** 拖拽开始/结束：主进程显示/隐藏置顶透明覆盖层以接管鼠标 */
  dragBegin: () => void ipcRenderer.send('drag:begin'),
  dragEnd: () => void ipcRenderer.send('drag:end'),

  saveConfig: (cfg: SavedConfig) => void ipcRenderer.send('config:save', cfg),

  /** 无边框窗口控制 */
  winMin: () => void ipcRenderer.send('win:min'),
  winMax: () => void ipcRenderer.send('win:max'),
  winClose: () => void ipcRenderer.send('win:close'),
  onMaximized: (cb: (maximized: boolean) => void) => {
    ipcRenderer.on('win:maximized', (_e, v) => cb(v));
  },

  openLogin: (platform: Platform) => void ipcRenderer.send('login:open', platform),
  logout: (platform: Platform) => ipcRenderer.invoke('login:logout', platform) as Promise<boolean>,
  checkLogin: (platform: Platform) => ipcRenderer.invoke('login:check', platform) as Promise<boolean>,

  onInit: (cb: (payload: InitPayload) => void) => {
    ipcRenderer.on('app:init', (_e, v) => cb(v));
  },
  onLoginStatus: (cb: (s: LoginStatus) => void) => {
    ipcRenderer.on('login:status', (_e, v) => cb(v));
  },
  onStreamTitle: (cb: (v: StreamTitleEvent) => void) => {
    ipcRenderer.on('stream:title', (_e, v) => cb(v));
  },
  onStreamError: (cb: (v: StreamErrorEvent) => void) => {
    ipcRenderer.on('stream:error', (_e, v) => cb(v));
  },
  onStreamDead: (cb: (v: StreamDeadEvent) => void) => {
    ipcRenderer.on('stream:dead', (_e, v) => cb(v));
  },
  onDragOverlay: (cb: (v: DragOverlayEvent) => void) => {
    ipcRenderer.on('drag:overlay', (_e, v) => cb(v));
  },
};

export type LmApi = typeof api;
contextBridge.exposeInMainWorld('lm', api);
