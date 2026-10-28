/**
 * 直播间未开播（解析器抛出；主进程据此创建 offline 占位格，不回退内嵌页面——
 * 未开播页面常有轮播视频/登录浮层盖住注入的控制按钮，导致窗口关不掉）。
 * 仅主进程内部使用，不属于跨进程契约，故留在 electron/ 侧（契约见 src/shared/types/ipc.ts）。
 */
export class OfflineError extends Error {
  constructor(message = '直播间未开播') {
    super(message);
    this.name = 'OfflineError';
  }
}
