// 入口编排:单实例 → 环境检测 → dsh 生命周期 → 桌面控制栏/托盘 → 自动更新。
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { Tray } from 'electron';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  detectAll,
  startDsh,
  waitForReady,
  killTree,
  getDshVersion,
  getLatestDshVersion,
  getDshVersions,
  normalizeDshTargetVersion,
  updateDshWithProgress,
} from './dsh';
import { installNodeLtsWithProgress } from './node-installer';
import { PRICING_URL } from './usage';
import { getUsageAnalytics } from './usage-analytics';
import { getDeepSeekBalance } from './balance';
import {
  createOnboardingWindow,
  createLoadingWindow,
  createCrashWindow,
  createMainWindow,
  createManagementWindow,
  reloadDshView,
  loadWindowState,
  installWindowStateHooks,
} from './windows';
import { createTray } from './tray';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let loadingWindow: BrowserWindow | null = null;
  let onboardingWindow: BrowserWindow | null = null;
  let crashWindow: BrowserWindow | null = null;
  let managementWindow: BrowserWindow | null = null;
  let dshProc: { proc: ChildProcess; url: string } | null = null;
  let quitting = false;
  let tray: Tray | null = null;
  let exitWatchCleanup: (() => void) | null = null;
  let launching = false;
  let dshUpdateAbortController: AbortController | null = null;

  const stateFile = join(app.getPath('userData'), 'window-state.json');
  const preloadPath = join(__dirname, 'preload.js');
  const trayIconPath = join(app.getAppPath(), 'assets', 'tray.png');

  app.on('second-instance', () => showCurrentWindow());

  function allWindows(): Array<BrowserWindow | null> {
    return [mainWindow, onboardingWindow, loadingWindow, crashWindow, managementWindow];
  }

  function broadcast(channel: string, payload: unknown): void {
    for (const win of allWindows()) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  function reportOperation(
    message: string,
    kind: 'busy' | 'ok' | 'error' = 'busy',
    dshVersion?: string,
  ): void {
    broadcast('dsh:operation-status', { message, kind, dshVersion });
  }

  function showCurrentWindow(): void {
    const candidates = [mainWindow, onboardingWindow, loadingWindow, crashWindow, managementWindow];
    const win = candidates.find((item) => item && !item.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  }

  /** 完整启动流程:检测 → spawn → 就绪 → 主窗。 */
  async function launch(): Promise<void> {
    const status = await detectAll(process.env);
    if (!status.node || !status.dsh) {
      openOnboarding();
      return;
    }
    await startAndShowMain();
  }

  async function startService(onProgress?: (message: string) => void): Promise<void> {
    const started = await startDsh(process.env);
    dshProc = started;
    const readyStartedAt = Date.now();
    const readyHeartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - readyStartedAt) / 1000);
      onProgress?.(`Harness 正在初始化并等待服务就绪…已用时 ${elapsedSeconds} 秒`);
    }, 5_000);
    let onEarlyExit: ((code: number | null) => void) | null = null;
    const earlyExit = new Promise<never>((_resolve, reject) => {
      onEarlyExit = (code: number | null): void => {
        if (dshProc?.proc === started.proc) dshProc = null;
        reject(new Error(`dsh 服务启动过程中退出(exit code ${code ?? 'unknown'})`));
      };
      started.proc.once('exit', onEarlyExit);
    });
    try {
      await Promise.race([waitForReady(started.url), earlyExit]);
    } catch (error) {
      if (dshProc?.proc === started.proc) dshProc = null;
      if (started.proc.pid) await killTree(started.proc.pid);
      throw error;
    } finally {
      clearInterval(readyHeartbeat);
      if (onEarlyExit) started.proc.removeListener('exit', onEarlyExit);
    }
    installExitWatch();
  }

  /** 首次启动用:显示中转窗,成功后创建主窗。 */
  async function startAndShowMain(): Promise<{ ok: boolean; error?: string }> {
    if (launching) return { ok: false, error: '已有启动或维护操作进行中' };
    launching = true;
    try {
      closeWindow(loadingWindow);
      loadingWindow = createLoadingWindow(preloadPath);
      await startService((message) => reportOperation(message));
      closeWindow(loadingWindow);
      closeWindow(onboardingWindow);
      openMainWindow();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        loadingWindow.webContents.send('dsh:error', message);
      }
      return { ok: false, error: message };
    } finally {
      launching = false;
    }
  }

  async function stopService(): Promise<void> {
    exitWatchCleanup?.();
    exitWatchCleanup = null;
    const child = dshProc?.proc;
    dshProc = null;
    if (child?.pid) await killTree(child.pid);
  }

  async function showRunningMain(): Promise<void> {
    closeWindow(loadingWindow);
    closeWindow(onboardingWindow);
    closeWindow(crashWindow);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await reloadDshView(mainWindow);
      mainWindow.show();
      mainWindow.focus();
    } else {
      openMainWindow();
    }
  }

  /** 正常运行、崩溃页和托盘共用的一键重启逻辑。 */
  async function restartDshService(): Promise<{ ok: boolean; error?: string }> {
    if (launching) return { ok: false, error: '已有启动或维护操作进行中' };
    launching = true;
    try {
      reportOperation('正在停止 Harness 服务…');
      await stopService();
      reportOperation('正在启动 Harness 服务…');
      await startService((message) => reportOperation(message));
      await showRunningMain();
      reportOperation('Harness 服务重启成功', 'ok');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportOperation(`Harness 重启失败:${message}`, 'error');
      return { ok: false, error: message };
    } finally {
      launching = false;
    }
  }

  /** 一键安装最新版 dsh;更新前停服务,更新后自动恢复。 */
  async function updateDshVersion(targetValue: unknown = 'latest'): Promise<{ ok: boolean; version?: string; error?: string }> {
    let targetVersion: string;
    try {
      targetVersion = normalizeDshTargetVersion(targetValue);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (launching) return { ok: false, error: '已有启动或维护操作进行中' };
    launching = true;
    const abortController = new AbortController();
    dshUpdateAbortController = abortController;
    const hadRunningService = Boolean(dshProc?.proc.pid);
    try {
      reportOperation('正在停止 Harness 服务…');
      await stopService();
      reportOperation(targetVersion === 'latest'
        ? '正在安装 DeepSeek 官方 Harness 最新版…'
        : `正在安装 DeepSeek 官方 Harness ${targetVersion}…`);
      const version = await updateDshWithProgress(
        process.env,
        (progress) => reportOperation(progress.message),
        { signal: abortController.signal, targetVersion },
      );
      reportOperation(`Harness ${version} 已安装,正在启动服务…`, 'busy', version);
      await startService((message) => reportOperation(message));
      await showRunningMain();
      reportOperation(`Harness 已更新到 ${version}`, 'ok', version);
      return { ok: true, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // npm 失败时尽量恢复原服务,避免一次更新让正在使用的桌面壳停摆。
      if (hadRunningService && !dshProc) {
        try {
          await startService((progress) => reportOperation(progress));
          await showRunningMain();
        } catch {
          // 原服务也无法恢复时保留原始更新错误,用户仍可从控制栏再次重试。
        }
      }
      reportOperation(`Harness 更新失败:${message}`, 'error');
      return { ok: false, error: message };
    } finally {
      if (dshUpdateAbortController === abortController) dshUpdateAbortController = null;
      launching = false;
    }
  }

  /** 无 Node.js 环境时通过 Windows Package Manager 一键安装官方 LTS。 */
  async function installNodeLts(): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (launching) return { ok: false, error: '已有启动或维护操作进行中' };
    launching = true;
    try {
      const version = await installNodeLtsWithProgress(
        process.env,
        (progress) => reportOperation(progress.message),
      );
      reportOperation(`Node.js ${version} 已安装,现在可以安装 Harness`, 'ok');
      return { ok: true, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportOperation(`Node.js 安装失败:${message}`, 'error');
      return { ok: false, error: message };
    } finally {
      launching = false;
    }
  }

  function openMainWindow(): void {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    const state = loadWindowState(stateFile);
    mainWindow = createMainWindow(state, preloadPath);
    installWindowStateHooks(mainWindow, stateFile);
    mainWindow.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
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

  function openManagement(): void {
    if (managementWindow && !managementWindow.isDestroyed()) {
      if (managementWindow.isMinimized()) managementWindow.restore();
      managementWindow.show();
      managementWindow.focus();
      return;
    }
    managementWindow = createManagementWindow(preloadPath);
    managementWindow.on('closed', () => { managementWindow = null; });
  }

  function installExitWatch(): void {
    exitWatchCleanup?.();
    exitWatchCleanup = null;
    const child = dshProc?.proc;
    if (!child?.pid) return;
    const onExit = (): void => {
      dshProc = null;
      if (quitting) return;
      closeWindow(loadingWindow);
      openCrash();
    };
    child.once('exit', onExit);
    exitWatchCleanup = () => child.removeListener('exit', onExit);
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

  async function quit(): Promise<void> {
    quitting = true;
    await stopService();
    app.quit();
  }

  async function restartApp(): Promise<void> {
    quitting = true;
    reportOperation('正在重启桌面应用…');
    await stopService();
    app.relaunch();
    app.exit(0);
  }

  // ---- IPC ----
  ipcMain.handle('dsh:info', async () => {
    const [dshVersion, latestDshVersion] = await Promise.all([
      getDshVersion(process.env),
      getLatestDshVersion(process.env),
    ]);
    return { appVersion: app.getVersion(), dshVersion, latestDshVersion };
  });
  ipcMain.handle('dsh:status', () => detectAll(process.env));
  ipcMain.handle('node:install', () => installNodeLts());
  ipcMain.handle('dsh:recheck', async () => {
    const status = await detectAll(process.env);
    if (status.node && status.dsh) {
      closeWindow(onboardingWindow);
      const result = await startAndShowMain();
      return { ...status, ...result };
    }
    return { ok: false, ...status };
  });
  ipcMain.handle('dsh:retry', () => restartDshService());
  ipcMain.handle('dsh:restart', () => restartDshService());
  ipcMain.handle('dsh:versions', async () => {
    const [current, latest, versions] = await Promise.all([
      getDshVersion(process.env),
      getLatestDshVersion(process.env),
      getDshVersions(process.env),
    ]);
    return { current, latest, versions };
  });
  ipcMain.handle('dsh:update', (_event, targetVersion?: unknown) => updateDshVersion(targetVersion));
  ipcMain.handle('dsh:update-cancel', () => {
    if (!dshUpdateAbortController) return { ok: false, error: '当前没有正在执行的 Harness 安装' };
    dshUpdateAbortController.abort();
    return { ok: true };
  });
  ipcMain.handle('app:restart', () => restartApp());
  ipcMain.handle('management:open', () => { openManagement(); return { ok: true }; });
  ipcMain.handle('usage:get', (_event, request?: unknown) => getUsageAnalytics(process.env, request));
  ipcMain.handle('balance:get', (_event, apiKey?: unknown) => getDeepSeekBalance(apiKey, process.env));
  ipcMain.handle('usage:open-pricing', async () => {
    await shell.openExternal(PRICING_URL);
    return { ok: true };
  });

  // ---- 生命周期 ----
  app.whenReady().then(async () => {
    tray = createTray(
      {
        onOpen: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          } else if (onboardingWindow && !onboardingWindow.isDestroyed()) {
            onboardingWindow.show();
          } else if (dshProc?.proc.pid && dshProc.proc.exitCode === null) {
            openMainWindow();
          } else {
            openCrash();
          }
        },
        onUpdateDsh: () => { void updateDshVersion(); },
        onOpenManagement: () => openManagement(),
        onRestartDsh: () => { void restartDshService(); },
        onRestartApp: () => { void restartApp(); },
        onQuit: () => { void quit(); },
      },
      trayIconPath,
    );

    await launch();
    // 后台检查官方 npm 最新版;只提示,不在用户不知情时替换正在使用的版本。
    setTimeout(async () => {
      const [installed, latest] = await Promise.all([
        getDshVersion(process.env),
        getLatestDshVersion(process.env),
      ]);
      if (installed && latest && installed !== latest) {
        reportOperation(`官方 Harness ${latest} 可更新(当前 ${installed})`, 'busy');
      }
    }, 3_000);
  });

  app.on('window-all-closed', () => {
    // 托盘驻留:窗口全部关闭时应用继续运行。
  });
  app.on('before-quit', () => { quitting = true; });
}
