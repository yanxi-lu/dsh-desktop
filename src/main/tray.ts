// 托盘图标与菜单:主窗关闭后驻留后台,「退出」才真正结束。
import { Tray, Menu, nativeImage } from 'electron';

export interface TrayActions {
  /** 点击「打开」/双击托盘图标 */
  onOpen: () => void;
  /** 点击「退出」:清理 dsh 进程树后退出应用 */
  onQuit: () => void;
  /** 正常运行时重启 Harness 服务 */
  onRestartDsh: () => void;
  /** 安装/更新最新版 Harness */
  onUpdateDsh: () => void;
  /** 重启整个桌面应用 */
  onRestartApp: () => void;
  /** 打开用量估价与版本管理 */
  onOpenManagement: () => void;
}

export function createTray(actions: TrayActions, iconPath: string): Tray {
  // 托盘图标 32x32;assets/tray.png 由 scripts/gen-icon.ps1 从高清源图生成,高 DPI 下更清晰
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('dsh-desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 dsh-desktop', click: actions.onOpen },
      { label: '用量与版本管理', click: actions.onOpenManagement },
      { type: 'separator' },
      { label: '更新 DeepSeek Harness', click: actions.onUpdateDsh },
      { label: '重启 DeepSeek Harness', click: actions.onRestartDsh },
      { label: '重启桌面应用', click: actions.onRestartApp },
      { type: 'separator' },
      { label: '退出', click: actions.onQuit },
    ]),
  );
  tray.on('double-click', actions.onOpen);
  return tray;
}
