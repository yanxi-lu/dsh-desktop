# dsh-desktop

DeepSeek Harness(`dsh`)的 Windows 桌面套壳:轻量壳 + 首次引导 + 托盘驻留。

## 功能

- 一键启动:自动拉起本机 `dsh web`(127.0.0.1:3080)并在桌面窗口中使用
- 首次引导:未装 dsh/Node 时显示引导页与安装命令,装好后点「重新检测」即可
- 托盘驻留:关闭窗口后服务在后台运行,托盘可重新打开;「退出」会连同 dsh 进程树一起结束
- 单实例:重复启动只会聚焦已有窗口
- 崩溃恢复:dsh 意外退出时弹窗提示,可一键重启服务

## 安装

1. 安装 Node.js(https://nodejs.org)
2. 安装 dsh:`npm install -g @deepseek-ai/dsh`
3. 下载 `release/dsh-desktop-setup-x.y.z.exe` 安装

> 安装包未做代码签名,SmartScreen 提示时选「仍要运行」。

## 开发

```bash
npm install
npm test        # 单元测试(vitest)
npm start       # 开发运行
npm run icon    # 重新生成图标
npm run dist    # 打 NSIS 安装包
```

## 手动验收清单

- [ ] 未装 dsh → 引导页,状态显示正确,复制命令可用
- [ ] 装好 dsh 点「重新检测」→ 自动进入主窗
- [ ] 主窗关闭 → 托盘驻留,dsh 进程仍在
- [ ] 托盘「退出」→ node/dsh 进程树被杀净
- [ ] 二次启动 → 聚焦已有窗口
- [ ] 安装包安装/卸载正常

## 常见问题

- **端口 3080 被占用**:若被其他程序占用,轮询可能误判就绪;先释放端口再启动
- **主窗空白**:dsh 服务正常时按 Ctrl+Shift+I 打开开发者工具查看报错(开发模式)
- **DSH_BIN/DSH_HOME**:可用环境变量显式指定 dsh 位置,优先级高于 PATH
