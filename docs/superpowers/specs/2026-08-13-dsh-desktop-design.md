# DeepSeek Harness 桌面套壳(dsh-desktop)设计规格

日期:2026-08-13
状态:已批准(用户选择方案 C:轻量套壳 + 首次引导)

## 1. 背景与目标

DeepSeek Harness(dsh)是 DeepSeek AI 开源的智能体框架,官方仅提供 CLI
(`dsh web` / `headless` / `tui` 三种 profile),无桌面版。本项目的目标是
把 `dsh web`(Web GUI,默认监听 `127.0.0.1:3080`)封装为 Windows 桌面应用,
提供开箱即用的桌面体验。

**目标用户**:作者本人日常使用;兼顾未来分发给同事。

**非目标**:
- 不打包/不 fork dsh 运行时,Harness 升级自动跟随
- 不深度改造 dsh Web GUI(方案 B 被否决,维护成本不可控)
- 不做 macOS / Linux 版(仅 Windows)

## 2. 总体架构

```
┌─────────────────────────────────────────────┐
│              Electron 主进程                  │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  │
│  │ dsh 管理 │  │ 窗口管理  │  │  托盘      │  │
│  │ 检测/拉起│  │ 引导页/主窗│  │ 驻留/退出  │  │
│  │ 就绪轮询 │  └──────────┘  └────────────┘  │
│  │ 树杀清理 │                                │
│  └────┬────┘                                │
└───────┼─────────────────────────────────────┘
        │ spawn dsh web (127.0.0.1:3080)
        ▼
  本机 dsh 服务(不打包,随 Harness 升级自动跟随)
```

### 项目结构

```
dsh-desktop/
├── package.json          # electron + electron-builder + vitest,无前端框架
├── src/
│   ├── main/
│   │   ├── index.ts      # 入口:单实例锁、启动编排
│   │   ├── dsh.ts        # 核心:dsh 检测、spawn、就绪轮询、树杀
│   │   ├── tray.ts       # 托盘菜单
│   │   ├── windows.ts    # 引导窗 / 主窗 / 错误页
│   │   └── config.ts     # 端口、超时、环境变量等集中配置
│   └── renderer/
│       ├── onboarding.html   # 首次引导页(纯 HTML+少量 JS)
│       └── loading.html      # 启动中转页(等待就绪 / 失败重试)
├── assets/icon.ico
├── tests/                # vitest 单测(dsh 生命周期逻辑)
└── electron-builder.yml  # NSIS 打包配置
```

### 关键决策

1. **渲染层零前端框架**:只有引导页与中转页两个静态页面;主窗口直接
   `loadURL("http://127.0.0.1:3080")` 加载 dsh Web GUI。
2. **dsh 进程管理收敛于 [src/main/dsh.ts](src/main/dsh.ts) 单模块**,不依赖
   Electron API,便于单测;Electron 相关仅在窗口/托盘层。
3. **TypeScript**:主进程逻辑类型安全,构建加一道 tsc。
4. **查找 dsh 的优先级**:`DSH_BIN` 环境变量 → `DSH_HOME` → PATH 中的
   `dsh`(参考社区 dsh-desktop-electron 的做法)。

## 3. 核心流程

### 3.1 启动编排(index.ts)

```
app 启动
  → 单实例锁(requestSingleInstanceLock;拿不到则聚焦已有窗口并退出)
  → 检测 Node.js 与 dsh 是否可用(见 3.2)
  → 不可用 → 打开引导窗(onboarding.html)
  → 可用   → spawn dsh web → 打开中转窗(loading.html)
           → 就绪轮询成功 → 关中转窗,打开主窗加载 dsh Web GUI
           → 轮询超时/失败 → 中转窗显示错误与重试按钮
```

### 3.2 检测逻辑(dsh.ts)

- Node.js:执行 `node --version`,成功即视为已安装
- dsh:`DSH_BIN` 存在则直接使用;否则执行 `dsh -V` 探测(经 PATH 解析)
- 检测结果通过 IPC 推送给引导页展示(三项状态:Node / dsh / 综合结论)

### 3.3 引导页(onboarding.html)

- 展示检测状态与安装指引:`npm install -g @deepseek-ai/dsh`(一键复制按钮)
- 「重新检测」按钮触发主进程重新检测;检测通过后自动进入正常启动流程
- 页面为纯静态 HTML + 少量原生 JS,通过 preload 暴露的最小 IPC 与主进程通信
  (contextIsolation: true, sandbox: true)

### 3.4 服务生命周期(dsh.ts)

- **spawn**:`spawn('dsh', ['web'], { shell: true, windowsHide: true })`,
  Windows 上 `dsh` 为 npm 全局脚本(.cmd),必须 `shell: true`
- **就绪轮询**:每 500ms 向 `http://127.0.0.1:3080` 发 HTTP GET,2xx 视为就绪;
  超时 30 秒判失败
- **环境变量透传**:继承用户环境(含 `DSH_HOME`、`DEEPSEEK_BASE_URL` 等
  dsh 自有变量);`DSH_PERMISSION_MODE` 在实现阶段用 `dsh --help` 验证后决定
  是否显式设置(社区提示 Windows 无权限隔离后端,默认回退 danger-full-access)
- **树杀清理**:退出时 `taskkill /pid <pid> /T /F` 杀掉 dsh 进程树,不留孤儿

### 3.5 窗口与托盘

- **主窗**:无菜单栏,16:10 初始尺寸(1280×800),最小 800×600,记录并恢复
  上次窗口位置与大小(userData 下 JSON)
- **托盘驻留**:主窗关闭事件 preventDefault → hide;托盘图标右键菜单
  「打开 dsh-desktop」/「退出」;「退出」才执行树杀 + app.quit
- **单实例**:二次启动时 focus 已有主窗(若已隐藏则 show)

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| dsh 未安装 | 引导页,给出安装命令 |
| Node 未安装 | 引导页,给出 Node 官网指引 |
| spawn 失败 | 中转页显示错误 + 最近日志尾部 + 「重试」按钮 |
| 就绪轮询超时(30s) | 同上,提示可手动运行 `dsh web` 排查 |
| 端口 3080 被占 | 轮询会误判就绪(他进程),不处理此边缘场景;文档注明 |
| dsh 运行中崩溃 | 主窗显示崩溃提示页,提供「重启服务」按钮 |
| 引导页安装后重检 | 主进程重新执行检测,通过则无缝进入正常流程 |

## 5. 打包(NSIS)

- electron-builder + NSIS:产出 `dsh-desktop-setup-x.y.z.exe`
- 安装目标 `perMachine: false`(当前用户),创建开始菜单快捷方式,含卸载器
- 图标:`assets/icon.ico`(实现阶段用脚本生成简单占位图标,后续可替换)
- electron 二进制与依赖打进安装包;dsh 本身不打包
- 未做代码签名(自用场景,SmartScreen 提示属预期)

## 6. 测试策略

- **单元测试(vitest)**:`dsh.ts` 的检测分支(DSH_BIN/DSH_HOME/PATH 优先级)、
  就绪轮询(成功/超时/服务端非 2xx)、树杀命令拼装;spawn 与网络用 mock
- **手动验收清单**(写入 README):
  1. 未装 dsh 环境 → 启动显示引导页,安装指引正确
  2. 装好 dsh → 点「重新检测」→ 自动进入主窗
  3. 主窗关闭 → 托盘驻留,`dsh web` 进程仍在;托盘「退出」→ 进程树被杀净
  4. 二次启动 → 聚焦已有窗口,无重复实例
  5. 安装包安装/卸载正常

## 7. 已知风险与验证点

1. dsh 处于 Developer Preview,CLI 参数可能变动。检测逻辑只用稳定接口
   (`dsh -V`、默认端口 3080),端口若未来可配置,收敛在 config.ts 一处
2. `--port` 参数与 `DSH_PERMISSION_MODE` 取值官方文档未明示:实现阶段
   安装 dsh 后以 `dsh --help` 实测为准,无法确认时保持透传用户环境
3. Windows SmartScreen 未签名警告:自用可接受,README 注明绕过方式
