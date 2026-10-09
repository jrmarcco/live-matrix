# LiveMatrix — 同屏多直播

跨平台桌面应用（Windows / macOS）：**一个主窗口 + 最多 7 个副窗口**同屏观看不同直播，仅主窗口播放声音，支持哔哩哔哩、抖音两个平台的扫码登录（登录状态自动记忆）。

![layout](https://img.shields.io/badge/layout-1%20%E4%B8%BB%20%2B%207%E5%89%AF-blue) ![platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-B%E7%AB%99%20%C2%B7%20%E6%8A%96%E9%9F%B3-pink)

## 功能特性

- **16:9 观影布局**：主窗口以 16:9 打开并保持该比例缩放；界面为 4×4 网格，主窗口占左上 3×3，副窗口最多 7 个，**均匀分布在主窗口右侧（3 格）与下方（4 格）**——16:9 窗口下每个画面都近似 16:9。
- **自动网页全屏 + 纯净模式**：打开直播间后自动触发平台自带的「网页全屏」，并隐藏礼物栏、聊天区、活动浮层等非视频元素，尽量只保留视频流；若平台改版导致自动全屏失败，会自动降级为「播放器强制铺满」。
- **只有主窗口有声**：副窗口始终静音；把某个副窗口换到主窗口槽位后，声音自动切换到它，画面**不刷新、不中断**。
- **添加直播**：工具栏「＋ 添加直播」按钮弹出对话框，粘贴直播间地址即可（自动识别平台）。副窗口达到 7 个上限后按钮自动禁用，计数 `N/7` 实时显示。
- **拖拽置换**：按住任意窗口的标题栏（⠿ 处）拖到另一个窗口上松开，两者互换位置；把副窗口拖到主窗口（或点标题栏「主」按钮）即接管声音。
- **平台登录**：工具栏提供哔哩哔哩 / 抖音登录入口，扫码登录后 Cookie 持久化保存，重启不丢失；随时可退出登录。
- **无边框简约深色界面**：无系统标题栏与菜单栏，工具栏左侧区域可拖动移动窗口（双击可最大化/还原），右上角为自绘的最小化 / 最大化 / 关闭按钮。
- **状态记忆**：直播窗口列表与排列顺序自动保存，下次启动自动恢复。

## 技术选型：Electron

在 Tauri 与 Electron 之间选择了 **Electron**，核心理由：

| 需求 | Electron 能力 | Tauri 的局限 |
| --- | --- | --- |
| 单窗口静音/有声切换 | `webContents.setAudioMuted()` 跨平台可靠 | 系统 WebView（macOS WKWebView）无统一静音 API |
| B 站 / 抖音页面兼容 | 内置 Chromium，内核行为与主流浏览器一致 | WKWebView / WebView2 对抖音登录、播放器兼容风险高 |
| 按平台隔离并持久化登录 | `session.fromPartition('persist:…')` 开箱即用 | 多 WebView 共享 Cookie 存储，隔离不便 |

架构：主进程用一个 `BrowserWindow` 承载 UI 层（网格、对话框、工具栏），每个直播间是一个独立的 `WebContentsView` 叠放在对应网格格子上；渲染层把每格的坐标通过 IPC（`layout:update`）上报给主进程 `setBounds`，并附带 `isMain` 标志用于静音控制。拖拽期间主进程在顶层显示透明覆盖视图接管鼠标事件，实现跨视图命中与置换——置换只改 bounds，不重载页面。直播间打开后由主进程注入平台专属脚本（`electron/enhance.ts`）自动进入网页全屏并净化界面：B 站模拟双击 `#live-player` 并以 `body.player-full-win` 确认；抖音派发 `y` 热键并以 `__fullScreenOrTheaterOn` 确认，两者均带约 40 秒重试与 CSS 兜底。

## 环境要求

- 开发：Node.js ≥ 20.10，npm ≥ 10
- 运行：Windows 10+（x64）或 macOS 12+（x64 / Apple Silicon）
- 打包 macOS 安装包必须在 macOS 上执行（系统限制）

## 快速开始

```bash
npm install        # 安装依赖（国内网络可先执行：export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）

npm run dev        # 开发模式（Vite 热更新 + Electron）

npm run build      # 编译主进程 + 打包渲染层到 dist/
npm start          # 构建并以生产模式运行
```

## 打包脚本

| 命令 | 产物 | 说明 |
| --- | --- | --- |
| `npm run dist:win` | `release/LiveMatrix-Setup-1.0.0.exe` | Windows NSIS 安装器（x64），可选安装目录、创建桌面快捷方式 |
| `npm run dist:mac` | `release/LiveMatrix-1.0.0-arm64.dmg` / `-x64.dmg` | macOS 双架构 DMG，需在 macOS 上执行 |
| `npm run dist:all` | 以上全部 | — |

打包环境说明：在 **Windows** 上打 NSIS 安装包开箱即用；在 **Linux**（CI 交叉打包）需要 wine（`sudo apt-get install -y wine`）；macOS 的 DMG 只能在 macOS 上生成（系统限制）。

自定义图标：把 `icon.ico`（Windows）和 `icon.icns`（macOS）放到 `build/` 目录后重新打包即可；未提供时使用默认图标。当前 DMG 未做签名（`mac.identity: null`），分发给他人时 macOS 首次打开需在「系统设置 → 隐私与安全性」中允许；正式分发建议配置 Apple 开发者证书签名。

## 使用说明

1. **首次使用先登录**（可选，但抖音多数直播间要求登录才能观看）：
   点击工具栏的「哔哩哔哩 未登录」或「抖音 未登录」标签，在弹出的窗口中扫码登录。登录成功后窗口自动关闭，标签变为绿色「已登录」。登录状态保存在本机，重启无需重复登录；点击「已登录」标签可退出登录。
2. **添加直播**：点击右上角「＋ 添加直播」，粘贴直播间地址，例如：
   - 哔哩哔哩：`https://live.bilibili.com/21452505`
   - 抖音：`https://live.douyin.com/745969462470`
   确认提示「已识别：哔哩哔哩/抖音」后点「添加」。第一个添加的直播进入主窗口（左上角，有声），之后添加的依次填入主窗口右侧与下方的副窗口格（静音）。直播间加载后会自动进入网页全屏并隐藏礼物栏、聊天区等界面元素。
3. **置换窗口**：按住窗口标题栏左侧的 ⠿ 拖动，目标窗口出现蓝色描边后松开即完成互换。副窗口拖到主窗口位置（或点副窗口标题栏的「主」按钮）后成为主窗口并接管声音，原主窗口变为静音。直播画面在置换过程中不会重新加载。
4. **关闭窗口**：点窗口标题栏右侧 ×。关闭主窗口后，第一个副窗口自动升为主窗口。
5. **窗口布局与列表自动记忆**，下次启动原样恢复。

## 常见问题

- **抖音直播间黑屏 / 提示登录**：抖音直播通常要求登录，请先完成抖音扫码登录。
- **添加后一直「载入中」**：检查地址是否正确、直播间是否正在直播；也可能是网络问题，可关闭该窗口后重新添加。
- **画面与格子错位**：应用内禁用了页面缩放（Ctrl/Cmd + ±），请勿通过系统辅助功能强制缩放；正常缩放主窗口不会错位。
- **最多能开多少个**：1 个主窗口 + 7 个副窗口，共 8 路；达到上限后添加按钮与占位格均提示禁用。
- **如何在开发区分平台登录数据**：分别存放在 `persist:live-bilibili` 与 `persist:live-douyin` 两个 session 分区（位于系统用户数据目录），互不干扰。
- **在 WSL/WSLg 中运行出现中文方块（豆腐块）**：系统缺少中文字体，执行 `sudo apt-get install -y fonts-noto-cjk` 后重启应用即可；Windows / macOS 无此问题。

## 目录结构

```
live-matrix/
├── electron/               # 主进程（TypeScript → dist/electron）
│   ├── main.ts             # 窗口/视图管理、布局与静音、登录、配置持久化、拖拽覆盖层
│   ├── preload.ts          # contextBridge 暴露的安全 IPC API
│   ├── overlay-preload.ts  # 拖拽覆盖层页面的 IPC 转发
│   ├── platforms.ts        # 平台识别、登录页地址、session 分区（纯逻辑，渲染层共用）
│   └── types.ts            # 共享类型
├── src/                    # 渲染层 UI（Vite → dist/renderer）
│   ├── main.ts             # 网格布局、添加对话框、拖拽置换、登录标签
│   ├── overlay.ts          # 拖拽覆盖层页面逻辑（接管鼠标并回传）
│   ├── ui.css
│   └── lm.d.ts
├── index.html              # 主界面
├── overlay.html            # 拖拽覆盖层页面
├── electron-builder.yml    # Windows/macOS 打包配置
└── package.json            # dev / build / dist:win / dist:mac 脚本
```

## 许可

MIT
