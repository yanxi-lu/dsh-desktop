// 窗口创建与窗口状态持久化。sanitize/读写为纯逻辑,可单测;
// 工厂函数依赖 Electron API,由手动验收覆盖。
// 注意:不能在模块顶层 import 'electron' —— electron 包(43.x)的 index.js
// 在 dist 二进制缺失时会同步触发下载并挂起,纯 Node(vitest)环境下加载会卡死。
// 因此仅在工厂函数体内延迟 require(此时必运行在 Electron 主进程中),
// 类型则通过 import type 获取(编译期擦除,不产生运行时依赖)。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshUrl } from './config';
import type { BrowserWindow } from 'electron';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export const DEFAULT_STATE: WindowState = { width: 1280, height: 800 };
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

type ElectronApi = typeof import('electron');

let electronApi: ElectronApi | undefined;

/** 延迟加载 electron API(见文件头注释) */
function electron(): ElectronApi {
  return (electronApi ??= require('electron'));
}

/** 校验并修正窗口状态:非法字段丢弃,尺寸 clamp 到最小值 */
export function sanitizeWindowState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STATE };
  const o = raw as Record<string, unknown>;
  const out: WindowState = { ...DEFAULT_STATE };
  if (typeof o.x === 'number') out.x = o.x;
  if (typeof o.y === 'number') out.y = o.y;
  if (typeof o.width === 'number') out.width = Math.max(o.width, MIN_WIDTH);
  if (typeof o.height === 'number') out.height = Math.max(o.height, MIN_HEIGHT);
  return out;
}

/** 读取窗口状态文件;缺失/损坏时返回默认值 */
export function loadWindowState(file: string): WindowState {
  try {
    if (!existsSync(file)) return { ...DEFAULT_STATE };
    return sanitizeWindowState(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** 写入窗口状态文件(自动创建目录) */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), 'utf-8');
  } catch {
    // 状态保存失败不影响主流程
  }
}

/** 主窗关闭时记录位置与尺寸,供下次启动恢复 */
export function installWindowStateHooks(win: BrowserWindow, file: string): void {
  win.on('close', () => {
    saveWindowState(file, win.getBounds());
  });
}

/** 窗口基础安全配置:所有窗口统一 */
function baseOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

function attachPreload(
  opts: Electron.BrowserWindowConstructorOptions,
  preloadPath: string,
): Electron.BrowserWindowConstructorOptions {
  return {
    ...opts,
    webPreferences: { ...opts.webPreferences, preload: preloadPath },
  };
}

/** renderer 页面绝对路径(app 根目录下的 src/renderer) */
function rendererPath(app: Electron.App, name: string): string {
  return join(app.getAppPath(), 'src/renderer', name);
}

/** 引导窗:未安装 dsh/Node 时展示 */
export function createOnboardingWindow(preloadPath: string): BrowserWindow {
  const { BrowserWindow, app } = electron();
  const win = new BrowserWindow(
    attachPreload({ ...baseOptions(), width: 720, height: 640, resizable: false }, preloadPath),
  );
  win.loadFile(rendererPath(app, 'onboarding.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

/** 中转窗:spawn 后等待就绪 */
export function createLoadingWindow(preloadPath: string): BrowserWindow {
  const { BrowserWindow, app } = electron();
  const win = new BrowserWindow(
    attachPreload({ ...baseOptions(), width: 480, height: 300, resizable: false }, preloadPath),
  );
  win.loadFile(rendererPath(app, 'loading.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

/** 崩溃窗:dsh 运行中退出时展示 */
export function createCrashWindow(preloadPath: string): BrowserWindow {
  const { BrowserWindow, app } = electron();
  const win = new BrowserWindow(
    attachPreload({ ...baseOptions(), width: 480, height: 300, resizable: false }, preloadPath),
  );
  win.loadFile(rendererPath(app, 'crash.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

/** 坐标是否落在任一显示器工作区内(带 64px 容差,标题栏仍可拖回) */
function isPositionVisible(screen: Electron.Screen, x: number, y: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x >= a.x - 64 && y >= a.y - 64 && x < a.x + a.width && y < a.y + a.height;
  });
}

/** 主窗:加载 dsh Web GUI,恢复上次位置/尺寸,关闭即隐藏 */
export function createMainWindow(state: WindowState, preloadPath: string): BrowserWindow {
  const { BrowserWindow, app, screen } = electron();
  const opts = attachPreload(
    {
      ...baseOptions(),
      width: state.width,
      height: state.height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
    },
    preloadPath,
  );
  // 坐标在任一显示器内才带上,否则不传 x/y,交给系统默认位置(R3)
  if (state.x !== undefined && state.y !== undefined && isPositionVisible(screen, state.x, state.y)) {
    opts.x = state.x;
    opts.y = state.y;
  }
  const win = new BrowserWindow(opts);
  win.loadURL(dshUrl());
  win.once('ready-to-show', () => win.show());
  return win;
}
