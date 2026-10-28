# LiveMatrix 项目约定

## 0. 定点治理决策记录（2026-10，重构分支 refactor/spot-governance）

本文档早前版本描述的是「React 18 + TanStack Query + Zustand + Feature-first 目录 + 双 TS 工具链」的目标架构。经评估，该套配置面向多页面、HTTP 服务端状态的中大型 Web 应用，与本项目现实（约 3k 行 TS 的单窗口 Electron 工具、全部"服务端状态"为主进程 IPC 推送的三个小对象、单人维护）不匹配，故按「定点治理」落地：**只修真实痛点，不做技术栈迁移**。已完成：主进程/渲染层模块化拆分、跨进程 shared 收口、重复代码去重、轻量工具链、纯逻辑单测。

**明确不采用（及理由，除非下述触发条件出现）**：

| 不采用 | 理由 | 重评触发条件 |
| --- | --- | --- |
| React / TanStack Query / Zustand / 前端路由 | 单页面 + IPC 推送为主，无 HTTP 服务端状态可缓存；现有 vanilla 模块化足够 | UI 复杂度显著增长（如多面板设置页、复杂浏览页交互） |
| eslint + typescript-eslint | typescript-eslint 8.x 硬性拒绝 TS 7.0（仅跟踪 ≥7.1 支持） | typescript-eslint 发布 TS ≥7.1 支持后可重评 |
| 双 TS 别名（@typescript/native + typescript6）+ tsgolint 三层工具链 | 为大项目设计的复杂度；单 tsc（TS7 原生）typecheck 已覆盖 | 多人协作或 CI 需要类型感知 lint 时 |
| msw | 渲染层无 HTTP 客户端（全走 IPC），主进程 fetch 用 vi.mock 覆盖 | 出现真正的 HTTP 客户端层 |
| CI workflow | 仓库无 CI 基础设施；husky pre-commit + smoke 门禁已覆盖 | 开放协作或多分支并行时 |

**行为不变重构的门禁**：`pnpm lint && pnpm typecheck && pnpm build && pnpm smoke`；涉及添加/槽位/收藏主流程时加跑 `LM_E2E=1 pnpm smoke`（真实添加直播间的端到端断言，收藏数据自动快照还原）。

## 1. 技术栈与环境

- **语言**: TypeScript（strict: true，tsc 为 TS 7 原生版）
- **桌面运行时**: Electron ≥ 44.8.0
- **Node 运行时**: ≥ 22.12.0
- **前端构建**: Vite；渲染层为 vanilla TS（无框架），多页能力由 Electron 多视图承担
- **质量**: oxlint + prettier + husky（pre-commit：lint + format:check + typecheck）；测试 vitest

## 2. 目录结构

```
src/                        # 渲染层（vite 打包，扁平模块，无嵌套框架）
├── main.ts                 # 入口（index.html 直接引用）：窗口控制接线 + Escape 链 + 启动
├── state.ts                # StageCell 类型 + 跨模块可变状态单例（cells/focusMode/音量/收藏镜像）
├── dom.ts                  # index.html 静态骨架的 DOM 引用
├── stage.ts                # 舞台：四态格子工厂/槽位操作（删/互换/双击/焦点模式）
├── player.ts               # hls.js/mpegts.js 挂载、销毁与断线重排
├── layout.ts               # 布局上报（DOM 矩形 → 主进程视图 bounds）与音量同步
├── add-dialog.ts           # 添加直播对话框（URL 校验 → 占位格 → beginAddStream）
├── favorites.ts            # 收藏面板/拖拽排序/别名弹窗
├── login-chips.ts          # 工具栏登录芯片
├── events.ts               # 主进程 IPC 推送订阅（副作用注册，入口最先导入）
├── ui.css                  # 全部样式（单文件分区，与 DOM 模块无组件化绑定）
└── shared/                 # 跨进程共享（被渲染层 vite 与主进程 tsc 双轨编译）
    ├── types/ipc.ts        # IPC 契约类型（唯一类型源；勿放运行时逻辑）
    └── lib/                # platforms（URL/平台识别）、icons（生成文件，勿手改）、json-file（Node 侧持久化助手）

electron/                   # 主进程（tsc 编译为 CJS，入口 dist/electron/main.js 不变）
├── main.ts                 # 仅 app 生命周期 + 装配
├── windows.ts              # 主窗口装配（16:9/CDN header 注入）+ getWin 单一窗口引用源
├── login.ts                # session 分区/登录态轮询/登录子窗口
├── ipc/                    # IPC 按命名空间分文件（stream/layout/volume/favorites/login/win），index.ts 装配
├── services/
│   ├── slot-registry.ts    # 三类槽位（内嵌视图/直连视频/未开播）唯一状态源 + 增删改查/布局落位
│   ├── stream-resolver.ts  # 平台解析策略注册表（新增平台在此登记，调用方无平台分支）
│   ├── favorites-store.ts  # 收藏 CRUD（去重/截断/重排规则）+ 持久化
│   └── settings-store.ts   # 音量持久化（防抖落盘 + will-quit 兜底）
├── e2e/probe.ts            # 冒烟/E2E 探针（--lm-smoke 触发）
├── lib/async.ts            # withTimeout
├── bilibili.ts / douyin.ts # 平台直连解析器（resolver 的实现）
├── enhance.ts / stream-preload.ts / preload.ts
└── types.ts                # OfflineError（仅主进程内部使用，非跨进程契约）
```

**双轨编译要点**：`tsconfig.electron.json` include 含 `src/shared/**`，rootDir 为项目根、outDir 为 `dist`（主进程入口仍为 `dist/electron/main.js`）；测试文件从该配置排除（node16 解析不允许 vitest 的无扩展名导入）。`electron/` 内 `__dirname` 相对路径随目录深度变化，services/ 子目录引用 `stream-preload.js` 时需补 `..`。

## 3. 工具链

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | tsc（TS7）全项目类型检查（权威） |
| `pnpm lint` | oxlint（correctness=error，suspicious/perf=warn，~10ms/46 文件） |
| `pnpm format` / `pnpm format:check` | prettier（对齐 .editorconfig：2 空格/单引号/行宽 120/LF） |
| `pnpm test` | vitest 单测（纯逻辑：platforms/json-file/favorites-store） |
| `pnpm build` / `pnpm smoke` | 构建 / 冒烟 E2E（`LM_E2E=1 pnpm smoke` 为深度模式） |

`.oxlintrc.json` 约定：全局关闭 `no-await-in-loop`（E2E 探针与 CDP 嗅探均为刻意的顺序语义）；`*.d.ts` 豁免 `require-module-specifiers`（`export {}` 为全局声明文件的模块标记惯用法）。生成文件（`src/shared/lib/icons.ts`）在 lint/prettier 中均忽略。

## 4. 浏览页预留接缝（计划中功能，本轮未实现）

双平台直播浏览页（从浏览页一键添加直播到舞台窗口），两条技术路线**均汇入渲染层现有 `beginAddStream` 流程**（占位格 → 主进程解析 → 直连/未开播，MAX_CELLS 上限与焦点模式退出自动生效）：

- **B站（自绘面板）**：主进程新增 `services/browse-bilibili.ts`（公开分区/房间列表 API，`session.fetch` 复用 `persist:live-bilibili` 登录分区，分区缓存 + 房间列表短 TTL）+ `ipc/browse.ts`（`browse:areas` / `browse:rooms`，在 `ipc/index.ts` 挂载）+ 渲染层 `browse-panel.ts` 模块（全屏遮罩面板复用 `modal:visible` 机制，卡片网格/分区 tab）。封面图防盗链若被拦，在 windows.ts 的 webRequest 注入处加 referer 规则。
- **抖音（内嵌目录页 + 注入）**：无公开目录 API（现有支持即靠 CDP 嗅探，逆向签名接口不可靠）。独立浏览 BrowserWindow（复用 `persist:live-douyin` 分区，参照 `login.ts` 的 openLogin 生命周期）加载 live.douyin.com 频道页，新增 `browse-preload.ts`（参照 stream-preload 模式）向房间卡片注入「添加到舞台」按钮，选择器集中管理，点击经 IPC 回主进程走现有 `addStream`。

## 5. 补充

- Windows 环境下，Power shell 找不到 Node 环境时，可以使用命令 `fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression` 设置环境。
- 碰到网络问题可以使用代理 `http://127.0.0.1:7890`。
