// 入口编排:单实例 → 环境检测 → dsh 生命周期 → 桌面控制栏/托盘 → 自动更新。
import { app, BrowserWindow, ipcMain as electronIpcMain, shell, dialog, session, Notification, clipboard } from 'electron';
import type { Tray } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { PreferencesStore } from './preferences';
import { HarnessBridge, redact } from './harness-bridge';
import { ManagedInstall, snapshotTree, type Installation } from './managed-install';
import { diagnose, availablePort, assertPortAvailable, safeDiagnosticReport } from './diagnostics';
import { getReleaseCatalog, RELEASES_URL } from './releases';
import { searchPlugins, pluginUpdates } from './plugin-catalog';
import { AlertLedger, budgetAlerts, type DesktopAlert } from './notifications';
import {
  detectAll,
  startDsh,
  waitForReady,
  killTree,
  getDshVersion,
  getLatestDshVersion,
  normalizeDshTargetVersion,
  isNewerVersion,
  startupExitMessage,
} from './dsh';
import type { StartedDsh } from './dsh';
import type { RuntimeDiagnostic } from './dsh';
import { installNodeLtsWithProgress } from './node-installer';
import { PRICING_URL } from './usage';
import { UsageAnalyticsService } from './usage-service';
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
  let dshProc: StartedDsh | null = null;
  let quitting = false;
  let exitCleanup: Promise<void> | null = null;
  let exitCleanupDone = false;
  let tray: Tray | null = null;
  let exitWatchCleanup: (() => void) | null = null;
  let launching = false;
  let dshUpdateAbortController: AbortController | null = null;

  const stateFile = join(app.getPath('userData'), 'window-state.json');
  const preloadPath = join(__dirname, 'preload.js');
  const trayIconPath = join(app.getAppPath(), 'assets', 'tray.png');
  const preferences = new PreferencesStore(join(app.getPath('userData'), 'preferences.json'));
  const managed = new ManagedInstall(join(app.getPath('userData'), 'harness-runtime'), process.env);
  const ledger = new AlertLedger(join(app.getPath('userData'), 'notification-ledger.json'));
  const bridge = new HarnessBridge(() => dshProc?.url ?? null, (url, options) => session.defaultSession.fetch(url instanceof URL ? url.toString() : url, options));
  const createUsageService = (): UsageAnalyticsService => new UsageAnalyticsService({ env: managed.env(), cacheDirectory: join(app.getPath('userData'), 'usage-cache') });
  let usageService = createUsageService();
  let queuedUpdate: string | null = null;
  let lastDiagnostics: unknown = null;
  let runtimeDiagnostics: RuntimeDiagnostic[] = [];
  let backgroundBusy = false;
  let lastBudget: unknown = null;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let taskWatchStarted = Date.now();
  let pluginBusy = false;
  const trustedPages = new Set(['management.html', 'shell.html', 'onboarding.html', 'loading.html', 'crash.html']
    .map(name => resolve(app.getAppPath(), 'src', 'renderer', name).toLowerCase()));
  const ipcMain = { handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void {
    electronIpcMain.handle(channel, async (event, ...args) => {
      // Official Harness/third-party plugins never receive our privileged desktop bridge.
      let trusted = false;
      try { trusted = trustedPages.has(resolve(fileURLToPath(event.senderFrame!.url)).toLowerCase()); } catch { /* not a local bundled page */ }
      if (!allWindows().some(win => win && !win.isDestroyed() && win.webContents.id === event.sender.id)
        || event.senderFrame?.parent || !trusted) throw new Error('不允许此页面调用桌面管理接口');
      try { return await listener(event, ...args); } catch (error) { throw new Error(redact(error instanceof Error ? error.message : String(error))); }
    });
  } };

  function configureRuntime(): void {
    config.port = managed.info().port;
    config.dshArgs = config.port === 3080 ? ['web', '--no-open'] : ['web', '--no-open', '--port', String(config.port)];
  }
  configureRuntime();
  function renewUsage(): void { usageService.dispose(); usageService = createUsageService(); }
  function usageRequest(value: any = {}): any { return { ...value, priceRules: preferences.get().priceRules }; }
  function notifyAlerts(alerts: DesktopAlert[]): void {
    const settings = preferences.get().notifications;
    for (const alert of ledger.take(alerts, settings)) {
      if (!Notification.isSupported()) continue;
      const notification = new Notification({ title: alert.title, body: alert.body });
      notification.on('click', () => { if (alert.sessionId) { clipboard.writeText(alert.sessionId); showCurrentWindow(); } else openManagement(); });
      notification.show();
    }
  }
  async function refreshBudget(): Promise<unknown> {
    const now = new Date(), day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const [today, month] = await Promise.all([
      usageService.get(usageRequest({ range: 'today', pricing: { tier: 'official-auto' } })),
      usageService.get(usageRequest({ range: 'custom', startDate: `${day.slice(0, 7)}-01`, endDate: day, pricing: { tier: 'official-auto' } })),
    ]);
    const prefs = preferences.get();
    lastBudget = { today: today.estimatedCny, month: month.estimatedCny, tokensToday: today.totalTokens,
      budgets: prefs.budgets, unpricedCount: month.unpricedCount, completeness: month.completeness, updatedAt: new Date().toISOString(),
      topSessions: [...month.sessionStats].sort((a, b) => b.estimatedCny - a.estimatedCny).slice(0, 5) };
    const alerts = budgetAlerts(today.estimatedCny, month.estimatedCny, prefs.budgets, now);
    if (prefs.budgets.highSession) for (const row of month.sessionStats) if (row.estimatedCny >= prefs.budgets.highSession) alerts.push({ id: `session-budget:${day.slice(0, 7)}:${row.sessionId}:${prefs.budgets.highSession}`,
      title: '会话费用提醒', body: `有会话本月预估费用达到 ¥${row.estimatedCny.toFixed(2)}。点击复制会话 ID 并返回 Harness。`, sessionId: row.sessionId });
    notifyAlerts(alerts); return lastBudget;
  }
  async function backgroundTick(): Promise<void> {
    if (backgroundBusy || launching || quitting) return;
    backgroundBusy = true;
    try {
      if (queuedUpdate && dshProc) {
        const running = (await bridge.sessions()).some(s => s.running);
        if (!running) { const target = queuedUpdate; queuedUpdate = null; await updateDshVersion(target); return; }
      }
      const prefs = preferences.get();
      if (prefs.notifications.enabled) {
        await refreshBudget();
        if (prefs.budgets.lowBalance) await queryBalance();
        if (prefs.notifications.tasks && dshProc) {
          const summary = await usageService.get(usageRequest({ range: 'today', pricing: { tier: 'official-auto' } }));
          const alerts: DesktopAlert[] = summary.taskEvents.filter(e => e.time >= taskWatchStarted && ['completed', 'error', 'attention'].includes(e.kind)).map(e => ({
            id: `task:${e.sessionId}:${e.seq}:${e.time}:${e.kind}`, title: e.kind === 'completed' ? 'Harness 任务完成' : e.kind === 'error' ? 'Harness 任务失败' : 'Harness 需要你处理',
            body: '来自官方会话事件；点击复制会话 ID 并返回 Harness。不展示提示词或回答。', sessionId: e.sessionId,
          }));
          notifyAlerts(alerts);
        }
      }
    } catch { /* network/legacy capability failures must not stop the desktop */ }
    finally { backgroundBusy = false; }
  }
  async function queryBalance(): Promise<Awaited<ReturnType<typeof getDeepSeekBalance>>> {
    const result = await getDeepSeekBalance(managed.env());
    const threshold = preferences.get().budgets.lowBalance;
    if (result.ok && threshold) {
      const cny = result.balanceInfos?.find(b => b.currency === 'CNY');
      if (cny && Number.isFinite(Number(cny.totalBalance)) && Number(cny.totalBalance) < threshold) notifyAlerts([{ id: `balance:${new Date().toLocaleDateString()}:${threshold}`,
        title: 'DeepSeek 余额提醒', body: `官方账户余额低于设置的 ¥${threshold}。点击查看查询时间及余额。` }]);
    }
    return result;
  }

  app.on('second-instance', () => showCurrentWindow());

  function allWindows(): Array<BrowserWindow | null> {
    return [mainWindow, onboardingWindow, loadingWindow, crashWindow, managementWindow];
  }

  function broadcast(channel: string, payload: unknown): void {
    for (const win of allWindows()) {
      if (!win || win.isDestroyed()) continue;
      const send = (): void => { if (!win.isDestroyed()) win.webContents.send(channel, payload); };
      if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send);
      else send();
    }
  }

  function reportOperation(
    message: string,
    kind: 'busy' | 'ok' | 'error' = 'busy',
    dshVersion?: string,
  ): void {
    broadcast('dsh:operation-status', { message: redact(message), kind, dshVersion, canCancelInstall: !!dshUpdateAbortController });
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
    const status = await detectAll(managed.env());
    if (!status.node || !status.dsh) {
      openOnboarding();
      return;
    }
    await startAndShowMain();
  }

  async function startService(onProgress?: (message: string) => void): Promise<void> {
    await assertPortAvailable(config.port, config.host);
    const started = await startDsh(managed.env());
    runtimeDiagnostics = started.diagnostics ?? [];
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
        reject(new Error(startupExitMessage(code, runtimeDiagnostics)));
      };
      started.proc.once('exit', onEarlyExit);
    });
    try {
      const readiness = (async (): Promise<void> => {
        // Harness 0.1.2+ 用一次性 token 保护 Web UI；只在主进程内等待并使用该 URL。
        const launchUrl = await started.launchUrl;
        started.url = launchUrl;
        await waitForReady(launchUrl);
      })();
      await Promise.race([readiness, earlyExit]);
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
    if (launching || pluginBusy) return { ok: false, error: '已有启动或维护操作进行中' };
    launching = true;
    try {
      closeWindow(loadingWindow);
      loadingWindow = createLoadingWindow(preloadPath);
      await startService((message) => reportOperation(message));
      closeWindow(loadingWindow);
      closeWindow(onboardingWindow);
      openMainWindow();
      const cleanup = await managed.confirm();
      if (cleanup.warning) reportOperation(cleanup.warning, 'error');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      broadcast('dsh:error', redact(message));
      reportOperation(`Harness 启动失败:${message}`, 'error');
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
      await reloadDshView(mainWindow, dshProc?.url);
      mainWindow.show();
      mainWindow.focus();
    } else {
      openMainWindow();
    }
  }

  /** 正常运行、崩溃页和托盘共用的一键重启逻辑。 */
  async function restartDshService(): Promise<{ ok: boolean; error?: string }> {
    if (launching || pluginBusy) return { ok: false, error: '已有启动或维护操作进行中' };
    launching = true;
    try { return await restartServiceNow(); }
    finally { launching = false; }
  }

  /** Caller must already own the maintenance lock. */
  async function restartServiceNow(): Promise<{ ok: boolean; error?: string }> {
    try {
      reportOperation('正在停止 Harness 服务…');
      await stopService();
      reportOperation('正在启动 Harness 服务…');
      await startService((message) => reportOperation(message));
      await showRunningMain();
      reportOperation('Harness 已启动，正在检查旧的托管安装…');
      const cleanup = await managed.confirm();
      reportOperation(`Harness 服务重启成功${cleanup.warning ? `；${cleanup.warning}` : ''}`, cleanup.warning ? 'error' : 'ok');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportOperation(`Harness 重启失败:${message}`, 'error');
      return { ok: false, error: message };
    }
  }

  /** 先下载校验，再停止服务切换；启动成功后只保留当前托管安装。 */
  async function updateDshVersion(targetValue: unknown = 'latest'): Promise<{ ok: boolean; version?: string; error?: string }> {
    let targetVersion: string;
    try {
      targetVersion = normalizeDshTargetVersion(targetValue);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (launching || pluginBusy) return { ok: false, error: '已有启动或维护操作进行中' };
    launching = true;
    const abortController = new AbortController();
    dshUpdateAbortController = abortController;
    const hadRunningService = Boolean(dshProc?.proc.pid);
    let activated = false;
    let staged: Installation | undefined;
    let manualIdleConfirmed = false;
    try {
      if (dshProc) {
        try {
          const running = (await bridge.sessions()).filter(s => s.running);
          if (running.length) { queuedUpdate = targetVersion; reportOperation(`有 ${running.length} 个会话运行中，已排队，任务结束后更新`); return { ok: false, error: '已加入更新队列；任务结束后自动执行，可在更新中心取消' }; }
        } catch {
          const choice = await dialog.showMessageBox({ type: 'warning', buttons: ['取消', '确认无运行任务，继续'], defaultId: 0, cancelId: 0,
            message: '当前版本无法查询任务状态', detail: '升级会停止 Harness。请确认没有正在执行的任务，下载期间不要启动新任务。不再自动创建升级快照；重要数据请先自行备份。' });
          if (choice.response !== 1) return { ok: false, error: '已取消升级' };
          manualIdleConfirmed = true;
        }
      }
      if (abortController.signal.aborted) throw new Error('安装已取消，未切换服务');
      const oldVersion = await getDshVersion(managed.env());
      const selectedVersion = targetVersion === 'latest' ? (await getReleaseCatalog()).tags.latest : targetVersion;
      if (!selectedVersion) throw new Error('官方 npm 没有返回 latest 目标版本，请刷新版本列表');
      if (oldVersion && isNewerVersion(oldVersion, selectedVersion)) {
        const choice = await dialog.showMessageBox({ type: 'warning', buttons: ['取消', '重新安装此版本'], defaultId: 0, cancelId: 0,
          message: `即将从 ${oldVersion} 切换到较旧版本 ${selectedVersion}`,
          detail: 'npm latest 只是分发标签，可能比当前预发布版旧。将重新下载安装并继续使用现有数据目录。旧版本未必兼容新版数据；不会自动备份或回滚数据，请先自行备份重要数据。' });
        if (choice.response !== 1) return { ok: false, error: '已取消版本回退' };
      }
      reportOperation('正在独立目录准备新版本，当前服务继续运行…');
      const next = staged = await managed.stage(selectedVersion, abortController.signal, message => reportOperation(message));
      if (abortController.signal.aborted) throw new Error('安装已取消，未切换服务');
      if (dshProc) {
        let sessions;
        try { sessions = await bridge.sessions(); }
        catch { if (!manualIdleConfirmed) throw new Error('下载完成，但无法复查运行任务；未停止服务，请重试'); }
        if (sessions?.some(s => s.running)) throw new Error('下载期间有新任务开始，未停止服务；任务结束后请重试');
      }
      if (abortController.signal.aborted) throw new Error('安装已取消，未切换服务');
      // Cancellation is safe only before switching; do not abandon a half-started new installation.
      dshUpdateAbortController = null;
      reportOperation('下载和版本校验完成，正在停止服务并切换安装…');
      await stopService();
      await managed.activate(next); activated = true;
      renewUsage();
      const version = next.version;
      reportOperation(`Harness ${version} 已安装,正在启动服务…`, 'busy', version);
      await startService((message) => reportOperation(message));
      await showRunningMain();
      reportOperation(`Harness ${version} 已启动，正在清理旧的托管安装…`, 'busy', version);
      const cleanup = await managed.confirm();
      reportOperation(`Harness 已更新到 ${version}；${cleanup.warning || '仅保留当前托管安装'}`, cleanup.warning ? 'error' : 'ok', version);
      return { ok: true, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (staged && !activated) await managed.discard(staged);
      // Before activation the old data/runtime are unchanged. After activation never silently
      // run an older binary against potentially migrated data; let the user reinstall explicitly.
      if (!activated && hadRunningService && !dshProc) {
        try {
          await startService((progress) => reportOperation(progress));
          await showRunningMain();
        } catch {
          // 原服务也无法恢复时保留原始更新错误,用户仍可从控制栏再次重试。
        }
      }
      reportOperation(`Harness 更新失败:${message}${activated ? '；可从版本列表重新安装所需版本，会话数据未删除' : ''}`, 'error');
      return { ok: false, error: message };
    } finally {
      if (dshUpdateAbortController === abortController) dshUpdateAbortController = null;
      launching = false;
    }
  }

  /** 无 Node.js 环境时通过 Windows Package Manager 一键安装官方 LTS。 */
  async function installNodeLts(): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (launching || pluginBusy) return { ok: false, error: '已有启动或维护操作进行中' };
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
    mainWindow = createMainWindow(state, preloadPath, dshProc?.url);
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
    if (launching || pluginBusy) { reportOperation('请先完成或取消当前维护操作，再重启应用', 'error'); return; }
    quitting = true;
    reportOperation('正在重启桌面应用…');
    await stopService();
    app.relaunch();
    app.exit(0);
  }

  // ---- IPC ----
  ipcMain.handle('dsh:info', async () => {
    const [dshVersion, latestDshVersion] = await Promise.all([
      getDshVersion(managed.env()),
      getLatestDshVersion(managed.env()),
    ]);
    return { appVersion: app.getVersion(), dshVersion, latestDshVersion,
      updateAvailable: !!dshVersion && !!latestDshVersion && isNewerVersion(latestDshVersion, dshVersion) };
  });
  ipcMain.handle('dsh:status', () => detectAll(managed.env()));
  ipcMain.handle('node:install', () => installNodeLts());
  ipcMain.handle('dsh:recheck', async () => {
    const status = await detectAll(managed.env());
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
    const [current, catalog] = await Promise.all([getDshVersion(managed.env()), getReleaseCatalog()]);
    return { current, latest: catalog.tags.latest ?? null, versions: catalog.versions.map(v => v.version), catalog };
  });
  ipcMain.handle('dsh:update', (_event, targetVersion?: unknown) => updateDshVersion(targetVersion));
  ipcMain.handle('dsh:update-cancel', () => {
    if (!dshUpdateAbortController) return { ok: false, error: launching ? '当前已进入服务切换或启动阶段，请等待完成' : '当前没有正在执行的 Harness 安装' };
    dshUpdateAbortController.abort();
    return { ok: true };
  });
  ipcMain.handle('app:restart', () => restartApp());
  ipcMain.handle('management:open', () => { openManagement(); return { ok: true }; });
  ipcMain.handle('usage:get', (_event, request?: unknown) => usageService.get(usageRequest(request)));
  ipcMain.handle('balance:get', () => queryBalance());
  ipcMain.handle('usage:open-pricing', async () => {
    await shell.openExternal(PRICING_URL);
    return { ok: true };
  });
  ipcMain.handle('desktop:settings-get', () => preferences.get());
  ipcMain.handle('desktop:settings-save', (_e, value) => {
    const before = preferences.get();
    const saved = preferences.set(value);
    if ((!before.notifications.tasks || !before.notifications.enabled) && saved.notifications.tasks && saved.notifications.enabled) taskWatchStarted = Date.now();
    return saved;
  });
  ipcMain.handle('desktop:overview', () => ({ appVersion: app.getVersion(), running: !!dshProc, busy: launching,
    runtime: managed.info(), queuedUpdate, budget: lastBudget }));
  ipcMain.handle('desktop:budget', () => refreshBudget());
  ipcMain.handle('desktop:queue-cancel', () => { queuedUpdate = null; return { ok: true }; });
  ipcMain.handle('desktop:open-harness', (_e, id?: unknown) => {
    if (typeof id === 'string' && /^[\w-]{1,180}$/.test(id)) clipboard.writeText(id);
    showCurrentWindow(); return { ok: true };
  });
  ipcMain.handle('desktop:sessions', () => { if (!preferences.get().metadataEnabled) throw new Error('请先在设置中允许加载会话名称'); return bridge.sessions(); });
  ipcMain.handle('desktop:archive', async (_e, id: string, archived: boolean) => {
    if (typeof archived !== 'boolean') throw new Error('归档状态无效');
    const confirmation = await dialog.showMessageBox({ type: 'question', buttons: ['取消', archived ? '归档' : '恢复'], defaultId: 0, cancelId: 0,
      message: `${archived ? '归档' : '恢复'}选中的会话？`, detail: `会话 ID：${String(id).slice(0, 180)}。通过官方接口操作，不删除会话日志；运行中的任务不会被强制终止。` });
    if (confirmation.response !== 1) return { ok: false, cancelled: true };
    await bridge.archive(id, archived); return { ok: true };
  });
  ipcMain.handle('desktop:plugins', () => bridge.plugins());
  ipcMain.handle('desktop:plugin-search', (_e, query) => searchPlugins(query));
  ipcMain.handle('desktop:plugin-updates', async () => pluginUpdates(await bridge.plugins()));
  ipcMain.handle('desktop:plugin-inspect', (_e, spec: string) => bridge.inspect(spec));
  ipcMain.handle('desktop:plugin-change', async (_e, action: 'install' | 'enable' | 'disable' | 'remove', spec: string) => {
    if (!['install', 'enable', 'disable', 'remove'].includes(action)) throw new Error('不支持的插件操作');
    bridge.validateSpec(spec);
    if (pluginBusy || launching) throw new Error('正在进行维护操作，请稍后重试');
    pluginBusy = true;
    try {
      const confirmation = await dialog.showMessageBox({ type: 'warning', buttons: ['取消', '确认执行'], defaultId: 0, cancelId: 0,
        message: `插件操作：${action} · ${spec}`, detail: '插件可以执行本机代码，请确认来源可信。将使用官方兼容性检查，不自动批准依赖构建脚本。操作前备份 profiles 到本机应用数据目录（可能包含配置凭据，不会导出或上传）。' });
      if (confirmation.response !== 1) return { cancelled: true };
      const backupRoot = join(app.getPath('userData'), 'plugin-backups'); await mkdir(backupRoot, { recursive: true });
      await snapshotTree(join(managed.home(), 'profiles'), join(backupRoot, randomUUID()));
      return await bridge.changePlugin(action, spec);
    } finally { pluginBusy = false; }
  });
  ipcMain.handle('desktop:diagnose', async () => {
    const report = await diagnose(managed.env(), managed.home(), config.port, dshProc?.proc.pid);
    for (const item of runtimeDiagnostics) report.items.push({ name: `运行日志分类：${item.code}`, status: 'warning', detail: `${item.message} · ${item.count} 次 · ${item.lastSeen}`, action: '仅保留已识别错误分类，不收集原始日志正文' });
    lastDiagnostics = report; return lastDiagnostics;
  });
  ipcMain.handle('desktop:diagnostic-export', async () => {
    if (!lastDiagnostics) throw new Error('请先运行诊断');
    return saveArtifact('dsh-diagnostics.json', safeDiagnosticReport(lastDiagnostics));
  });
  ipcMain.handle('desktop:port-change', async () => {
    if (launching || pluginBusy) throw new Error('正在进行维护操作');
    launching = true;
    try {
      if (dshProc && (await bridge.sessions()).some(s => s.running)) throw new Error('请等待运行中的会话结束再更换端口');
      const newPort = await availablePort();
      const choice = await dialog.showMessageBox({ type: 'question', buttons: ['取消', '更换并重启'], defaultId: 0, cancelId: 0,
        message: `将 Harness 端口从 ${config.port} 改为 ${newPort}？`, detail: '不会结束其他应用的进程。' });
      if (choice.response !== 1) return { ok: false, cancelled: true };
      if (dshProc && (await bridge.sessions()).some(s => s.running)) throw new Error('确认期间有任务开始，请稍后重试');
      const oldPort = config.port;
      await managed.setPort(newPort); configureRuntime();
      const result = await restartServiceNow();
      if (!result.ok) { await managed.setPort(oldPort); configureRuntime(); await restartServiceNow(); }
      return result;
    } finally { launching = false; }
  });
  ipcMain.handle('desktop:workspace-pick', async () => {
    const selected = await dialog.showOpenDialog({ title: '选择有效的本机工作文件夹', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
    const path = selected.filePaths[0]; if (!(await stat(path)).isDirectory()) throw new Error('选择的路径不是文件夹');
    await bridge.createWorkspace(path); showCurrentWindow(); return { ok: true };
  });
  ipcMain.handle('desktop:cleanup-versions', async () => {
    if (launching || pluginBusy) throw new Error('已有维护操作进行中');
    launching = true;
    try {
      if (!managed.info().managed || managed.info().pending) throw new Error('请先成功启动当前安装，再清理旧安装');
      const choice = await dialog.showMessageBox({ type: 'question', buttons: ['取消', '重试清理'], defaultId: 0, cancelId: 0,
        message: '重新尝试清理旧的托管安装？', detail: '请先解除文件占用或修复目录权限。只清理桌面壳创建的非当前安装，不删除会话、配置、历史数据备份或系统全局 npm 安装。失败时立即停止，不强制删除。' });
      if (choice.response !== 1) return { ok: false, cancelled: true };
      const result = await managed.cleanup(true);
      return { ok: !result.warning, ...result };
    }
    finally { launching = false; }
  });
  ipcMain.handle('desktop:release-notes', async (_e, version: unknown) => {
    const normalized = normalizeDshTargetVersion(version);
    await shell.openExternal(normalized === 'latest' ? RELEASES_URL : `${RELEASES_URL}/tag/dsh-v${encodeURIComponent(normalized)}`); return { ok: true };
  });
  ipcMain.handle('usage:rebuild', (_e, request) => usageService.rebuild(usageRequest(request)));
  ipcMain.handle('usage:export', async (_e, request, format, section) => {
    if (!['csv', 'json'].includes(format) || !['calls', 'sessions', 'models', 'overview'].includes(section)) throw new Error('导出选项无效');
    const content = await usageService.export(usageRequest(request), format, section);
    return saveArtifact(`dsh-usage-${section}.${format}`, content);
  });
  ipcMain.handle('desktop:settings-export', () => saveArtifact('dsh-desktop-preferences.json', JSON.stringify(preferences.get(), null, 2)));
  ipcMain.handle('desktop:settings-import', async () => {
    const selected = await dialog.showOpenDialog({ title: '恢复桌面设置（不包含 API Key）', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    if ((await stat(selected.filePaths[0])).size > 2 * 1024 * 1024) throw new Error('设置文件过大');
    const raw = JSON.parse(await readFile(selected.filePaths[0], 'utf8'));
    const choice = await dialog.showMessageBox({ type: 'question', buttons: ['取消', '替换桌面设置'], defaultId: 0, cancelId: 0,
      message: '恢复此设置备份？', detail: '将替换主题、预算、自定义价格、会话标签和收藏，不改动 Harness 的凭据、会话和插件。' });
    return choice.response === 1 ? preferences.set(raw) : null;
  });
  async function saveArtifact(defaultPath: string, content: string): Promise<{ ok: boolean; path?: string }> {
    const selected = await dialog.showSaveDialog({ defaultPath, title: '保存到本机' });
    if (selected.canceled || !selected.filePath) return { ok: false };
    await writeFile(selected.filePath, content, { mode: 0o600 }); return { ok: true, path: selected.filePath };
  }

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

    try { await launch(); }
    catch (error) {
      closeWindow(loadingWindow);
      openCrash();
      const message = `启动失败：${redact(error instanceof Error ? error.message : String(error))}。请打开诊断检查，或从版本列表重新安装；会话数据未删除。`;
      crashWindow?.webContents.once('did-finish-load', () => reportOperation(message, 'error'));
    }
    monitor = setInterval(() => { void backgroundTick(); }, 60_000);
    // 后台检查官方 npm 最新版;只提示,不在用户不知情时替换正在使用的版本。
    setTimeout(async () => {
      const [installed, latest] = await Promise.all([
        getDshVersion(managed.env()),
        getLatestDshVersion(managed.env()),
      ]);
      if (dshProc && installed && latest && isNewerVersion(latest, installed)) {
        reportOperation(`官方 Harness ${latest} 可更新(当前 ${installed})`, 'busy');
      }
    }, 3_000);
  });

  app.on('window-all-closed', () => {
    // 托盘驻留:窗口全部关闭时应用继续运行。
  });
  app.on('before-quit', event => {
    quitting = true;
    if (monitor) clearInterval(monitor);
    usageService.dispose();
    if (exitCleanupDone) return;
    event.preventDefault();
    if (!exitCleanup) {
      dshUpdateAbortController?.abort();
      exitCleanup = stopService().finally(() => { exitCleanupDone = true; app.quit(); });
    }
  });
}
