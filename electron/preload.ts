import { contextBridge, ipcRenderer } from 'electron';
import type {
  InitPayload,
  LayoutItem,
  LoginStatus,
  Platform,
  StreamDeadEvent,
  StreamDblClickEvent,
  StreamErrorEvent,
  StreamMediaEvent,
  StreamSlot,
  StreamTitleEvent,
} from './types';

const api = {
  /** 渲染层就绪，请求初始状态（登录状态） */
  ready: () => ipcRenderer.send('ui:ready'),

  addStream: (url: string, platform: Platform) =>
    ipcRenderer.invoke('stream:add', url, platform) as Promise<StreamSlot | null>,
  closeStream: (id: number) => void ipcRenderer.send('stream:close', id),
  /** 直连流断线/过期：请求主进程重新解析拉流地址 */
  refreshStream: (id: number) => void ipcRenderer.send('stream:refresh', id),

  /** 上传全部窗口的位置；主进程据此 setBounds 并按 isMain 控制静音 */
  updateLayout: (items: LayoutItem[]) => void ipcRenderer.send('layout:update', items),

  /** 地址对话框可见性：打开期间主进程隐藏全部直播视图，避免画面盖住对话框 */
  setModalVisible: (v: boolean) => void ipcRenderer.send('modal:visible', v),

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
  /** 直播视图内双击：副窗口与主窗口互换 / 主窗口铺满还原 */
  onStreamDblClick: (cb: (v: StreamDblClickEvent) => void) => {
    ipcRenderer.on('stream:dblclick', (_e, v) => cb(v));
  },
  /** 直连流地址刷新（主进程重新解析后下发） */
  onStreamMedia: (cb: (v: StreamMediaEvent) => void) => {
    ipcRenderer.on('stream:media', (_e, v) => cb(v));
  },
};

export type LmApi = typeof api;
contextBridge.exposeInMainWorld('lm', api);
