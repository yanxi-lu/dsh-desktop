# 0.5.2 启动与退出修复

日期：2026-09-24。桌面壳版本 0.5.2，安装包通过 [GitHub Releases](https://github.com/yanxi-lu/dsh-desktop/releases/tag/v0.5.2) 交付。

本次同时包含未单独发布的 [0.5.1 改进](release-0.5.1.md)：侧栏文字保持单行；新版本启动成功后仅保留当前托管安装，切换旧版时重新下载；不再自动创建升级数据快照。现有会话、配置、历史数据快照及系统全局 npm 安装不会被清理。

## 问题与修复

升级后旧 Harness 服务可能在桌面主进程结束后继续运行，占用 3080。新壳再次启动相同端口时服务退出，而旧的重试页面只展示 exit code 1，且进度事件的失败状态不会停止转圈。

- 启动前检查目标端口。遇到占用明确提示原因与诊断入口，不自动结束未知进程，也不静默连接未知服务或在其他端口并行打开同一数据目录。
- 正常退出先等待本应用的服务进程树结束。
- 增加独立隐藏的服务监护进程：通过 IPC 检测桌面父进程消失，仅结束自己启动的服务树。Windows 下独立创建，确保能在父进程被强制结束后完成清理；不显示控制台。
- Harness 仍使用原 npm 命令与安装的 Node.js。监护进程的 Node 模式、IPC 环境不传入 Harness。
- 失败页停止转圈，恢复重试按钮，增加“打开工作台与诊断”；错误在页面尚未加载完时也会延迟送达。
- 对已知的端口占用、缺失模块、目录或权限问题给出具体说明，不记录或回传原始服务日志。

此版不删除会话、配置、Key 或历史数据快照。强制关闭保护仅覆盖由本版启动的服务，不追杀旧版遗留的、没有运行归属记录的进程。

## 升级方法

从 0.5.1 或更早版本更新时，先在托盘选择“退出”，不要仅关闭主窗口，然后运行新安装包。若旧服务已遗留，确认没有运行任务后再处理明确识别的旧进程；不要批量结束所有 Node.js 进程。

## 已执行验证

- TypeScript 编译和 100 项单元测试通过。
- 隔离 TCP 服务：强制终止模拟桌面父进程后，监护进程、服务和服务子进程均退出，两个端口释放；原生 Node 与桌面 EXE 的 Node 模式均验证通过。
- 真实官方 Harness、隔离空数据目录：端口占用失败页、连续重试、诊断入口、保留未知监听者、释放端口后重新启动、官方插件 RPC、换端口重启、旧状态兼容和正常退出后释放端口通过。
- 全部隔离测试不读取用户 Key，不发起付费模型请求，不结束用户其他应用的进程。

- 最终 ASAR 主进程的端口占用、错误页重试与诊断、真实服务启动、重启、正常退出回归通过；最终 EXE 的强制父进程退出清理回归通过。
- 包内用量工作台回归通过：80 个合成会话、2400 次调用、9 种侧栏宽度/缩放组合，首次加载 564 ms。不是用户实际账单性能承诺。
- 58 个包内源文件/构建文件与本地逐字节一致，包内版本 0.5.2。最终安装包未在另一台电脑安装验收。

## 安装包

- 文件：`release/dsh-desktop-setup-0.5.2.exe`，103,399,438 字节，Windows x64，未签名。
- SHA-256：`52a3afd05925054c6c47f9705a2c1ce4f879e5dd64b934622b2d6f420daa7051`。
- 校验文件：`release/SHA256SUMS-0.5.2.txt`。
- 同时提供 `dsh-desktop-setup-0.5.2.exe.blockmap`。发布操作不会覆盖本机正在运行的安装目录，需自行退出旧程序并运行安装包。

复验命令：

```text
npm test
npm run dist
node scripts/check-service-supervisor.cjs release/win-unpacked/dsh-desktop.exe
electron scripts/smoke-desktop-main.cjs <official-dsh.cmd> --packaged --legacy-state --occupied-port
electron scripts/smoke-usage-ui.cjs --packaged
```

实现依据：[Electron Node 模式](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)、[Node 子进程与 IPC](https://nodejs.org/api/child_process.html)。本机测试覆盖强制结束桌面父进程的场景，不代表监护进程被单独强杀、操作系统故障等所有异常均能执行清理。
