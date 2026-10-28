import { app, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { registerIpc } from './ipc';
import { flushSettings } from './services/settings-store';
import { createWindow, getWin } from './windows';

/* ---------------- 应用生命周期装配（窗口/IPC/服务的实现见各自模块） ---------------- */

/** 极简菜单：仅保留编辑能力（macOS 上维持 Cmd+C/V 等快捷键），无边框下不显示菜单栏 */
function installMenu(): void {
  const edit: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ],
  };
  // macOS：首个菜单即应用程序菜单，补上退出项（Cmd+Q）——自定义菜单会整体
  // 覆盖默认菜单，不提供的话应用没有任何键盘退出入口
  const template: MenuItemConstructorOptions[] =
    process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'quit', label: '退出' }] }, edit] : [edit];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function bootstrap(): void {
  // 直连 <video> 允许无手势自动播放（含主窗口的有声播放）
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  registerIpc();
  app.whenReady().then(() => {
    installMenu();
    // 每次启动都是全新布局：不恢复上次的直播窗口（登录态在 session 分区中，仍然保留）
    createWindow();
  });
  // 单主窗口应用：关窗即退出，所有平台一致。macOS 不按驻留惯例处理——本应用
  // 无边框窗口关掉后没有任何再入口/退出入口，驻留表现为「点关闭按钮不退出」
  app.on('window-all-closed', () => app.quit());
  // 防抖中的音量保存兜底：刚调完音量就关窗也不丢
  app.on('will-quit', () => flushSettings());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getWin();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  bootstrap();
}
