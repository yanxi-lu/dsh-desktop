// 托盘图标与菜单:主窗关闭后驻留后台,「退出」才真正结束。
import { Tray, Menu, nativeImage } from 'electron';

export interface TrayActions {
  /** 点击「打开」/双击托盘图标 */
  onOpen: () => void;
  /** 点击「退出」:清理 dsh 进程树后退出应用 */
  onQuit: () => void;
}

export function createTray(actions: TrayActions, iconPath: string): Tray {
  // 托盘图标 16x16;assets/tray.png 由 Task 7 生成(R6)
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('dsh-desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 dsh-desktop', click: actions.onOpen },
      { type: 'separator' },
      { label: '退出', click: actions.onQuit },
    ]),
  );
  tray.on('double-click', actions.onOpen);
  return tray;
}
