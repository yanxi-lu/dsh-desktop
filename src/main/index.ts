// 入口编排:单实例锁 → 环境检测 → (引导页 | spawn → 就绪 → 主窗) → 托盘驻留。
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  detectAll, startDsh, waitForReady, killTree,
} from './dsh';
import {
  createOnboardingWindow, createLoadingWindow, createCrashWindow, createMainWindow,
  loadWindowState, installWindowStateHooks,
} from './windows';
import { createTray } from './tray';

// 单实例:二次启动聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;
let loadingWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let crashWindow: BrowserWindow | null = null;
let dshProc: { proc: ChildProcess; url: string } | null = null;
let quitting = false; // 用户主动退出标志,区分崩溃

const stateFile = join(app.getPath('userData'), 'window-state.json');
const preloadPath = join(__dirname, 'preload.js');
const trayIconPath = join(app.getAppPath(), 'assets', 'tray.png');

/** 完整启动流程:检测 → spawn → 就绪 → 主窗 */
async function launch(): Promise<void> {
  const status = await detectAll(process.env);
  if (!status.node || !status.dsh) {
    openOnboarding();
    return;
  }
  await startAndShowMain();
}

/** spawn + 轮询,成功后主窗替换中转窗;结果供 retry 如实上报(R12) */
async function startAndShowMain(): Promise<{ ok: boolean; error?: string }> {
  closeWindow(loadingWindow);
  loadingWindow = createLoadingWindow(preloadPath);
  try {
    dshProc = await startDsh(process.env);
    installExitWatch();
    await waitForReady(dshProc.url);
    closeWindow(loadingWindow);
    openMainWindow();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    loadingWindow?.webContents.send('dsh:error', msg);
    // 中转页显示失败状态,等待用户点「重试」
    return { ok: false, error: msg };
  }
}

function openMainWindow(): void {
  // 崩溃恢复路径:旧主窗(死页面)直接销毁,避免双主窗与不可达窗口(R13)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  const state = loadWindowState(stateFile);
  mainWindow = createMainWindow(state, preloadPath);
  installWindowStateHooks(mainWindow, stateFile);
  mainWindow.on('close', (e) => {
    if (!quitting) {
      // 托盘驻留:关闭即隐藏
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openOnboarding(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    return;
  }
  onboardingWindow = createOnboardingWindow(preloadPath);
  onboardingWindow.on('closed', () => { onboardingWindow = null; });
}

/** dsh 进程退出且非用户主动 → 显示崩溃页 */
function installExitWatch(): void {
  // exit 事件挂在 spawn 返回的 ChildProcess 上(Task 3 的 startDsh 已返回 proc)
  const child = dshProc?.proc;
  if (!child?.pid) return;
  child.once('exit', () => {
    if (quitting) return;
    closeWindow(loadingWindow);
    openCrash();
  });
}

function openCrash(): void {
  if (crashWindow && !crashWindow.isDestroyed()) {
    crashWindow.show();
    return;
  }
  crashWindow = createCrashWindow(preloadPath);
  crashWindow.on('closed', () => { crashWindow = null; });
}

function closeWindow(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.close();
}

/** 用户主动退出:树杀 dsh,再退出应用 */
async function quit(): Promise<void> {
  quitting = true;
  const pid = dshProc?.proc.pid;
  if (pid) await killTree(pid);
  app.quit();
}

// ---- IPC ----
ipcMain.handle('dsh:status', () => detectAll(process.env));
ipcMain.handle('dsh:recheck', async () => {
  const status = await detectAll(process.env);
  if (status.node && status.dsh) {
    closeWindow(onboardingWindow);
    await startAndShowMain();
    return { ok: true, ...status };
  }
  return { ok: false, ...status };
});
ipcMain.handle('dsh:retry', async () => {
  try {
    // 重试前先关掉崩溃页/中转页(crash.html 承诺「重启成功时主进程会关闭崩溃窗」)
    closeWindow(crashWindow);
    closeWindow(loadingWindow);
    // 旧进程若残留,先清理
    if (dshProc?.proc.pid) await killTree(dshProc.proc.pid);
    return await startAndShowMain();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ---- 生命周期 ----
app.whenReady().then(async () => {
  createTray(
    {
      onOpen: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        } else if (onboardingWindow && !onboardingWindow.isDestroyed()) {
          onboardingWindow.show();
        } else {
          // 全部窗口已关闭且服务在跑:重建主窗
          openMainWindow();
        }
      },
      onQuit: quit,
    },
    trayIconPath,
  );
  await launch();
});

app.on('window-all-closed', () => {
  // 托盘驻留:窗口全部关闭时应用继续运行(Windows 下不退出)
});
app.on('before-quit', () => { quitting = true; });
