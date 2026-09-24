// Exercise actual main-process IPC and lifecycle with a real official Harness.
// Every write uses a new temporary profile/home; no user credentials or paid calls.
const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog, webContents } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const childProcess = require('node:child_process');
const root = resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const failedRecovery = process.argv.includes('--failed-recovery');
const appRoot = packaged ? join(root, 'release', 'win-unpacked', 'resources', 'app.asar') : root;
const bin = process.argv.find(arg => /dsh\.cmd$/i.test(arg));
assert.ok(bin && existsSync(bin), 'Pass an existing official dsh.cmd path');
const temporary = mkdtempSync(join(tmpdir(), 'dsh-main-smoke-'));
const profile = join(temporary, 'desktop'), home = join(temporary, 'home');
mkdirSync(profile); mkdirSync(home);
const osEnv = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) if (process.env[key]) osEnv[key] = process.env[key];
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, osEnv, { DSH_BIN: resolve(bin), DSH_HOME: home, USERPROFILE: temporary, HOME: temporary, APPDATA: profile, LOCALAPPDATA: profile });
process.chdir(temporary);
app.setPath('userData', profile);
app.getAppPath = () => appRoot;
app.getVersion = () => JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version;
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
const children = new Set();
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...args) { const child = originalSpawn.apply(this, args); children.add(child); child.once('exit', () => children.delete(child)); return child; };
const { availablePort } = require(join(appRoot, 'dist/main/diagnostics'));
const { killTree } = require(join(appRoot, 'dist/main/dsh'));
const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(check) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error('Main-process smoke test timed out');
}

async function run() {
  const port = await availablePort();
  mkdirSync(join(profile, 'harness-runtime'));
  const installation = { bin: resolve(bin), home, version: '0.1.7-rc.1' };
  writeFileSync(join(profile, 'harness-runtime', 'state.json'), JSON.stringify({ port,
    ...(failedRecovery ? { active: installation, previous: installation, pending: true, backup: join(temporary, 'missing-backup') } : {}) }));
  require(join(appRoot, 'dist/main/index'));
  if (failedRecovery) {
    const crash = await until(() => BrowserWindow.getAllWindows().find(w => /crash\.html$/.test(w.webContents.getURL()) && !w.webContents.isLoading()));
    await until(() => crash.webContents.executeJavaScript('document.getElementById("result").textContent.includes("恢复失败")'));
    await crash.webContents.executeJavaScript('window.dshApp.openManagement()');
    const management = await until(() => BrowserWindow.getAllWindows().find(w => /management\.html$/.test(w.webContents.getURL()) && !w.webContents.isLoading()));
    assert.equal((await management.webContents.executeJavaScript('dshWorkbench.overview()')).running, false);
    assert.equal(JSON.parse(readFileSync(join(profile, 'harness-runtime', 'state.json'), 'utf8')).active.home, home);
    console.log(JSON.stringify({ verified: true, packaged, missingBackupRefused: true, crashExplained: true, diagnosticsAccessible: true, dataSelectionUnchanged: true }));
    return;
  }
  const shell = await until(() => BrowserWindow.getAllWindows().find(w => /shell\.html$/.test(w.webContents.getURL()) && !w.webContents.isLoading()));
  const executeShell = source => shell.webContents.executeJavaScript(source);
  const status = await executeShell('window.dshApp.getStatus()');
  assert.ok(status.node && status.dsh);
  await until(() => webContents.getAllWebContents().some(w => w.getURL().startsWith(`http://127.0.0.1:${port}`) && !w.isLoading()));
  await executeShell('window.dshApp.openManagement()');
  const management = await until(() => BrowserWindow.getAllWindows().find(w => /management\.html$/.test(w.webContents.getURL()) && !w.webContents.isLoading()));
  const execute = source => management.webContents.executeJavaScript(source);
  await until(() => execute('!!window.lastUsageSummary'));
  assert.equal((await execute('window.dshWorkbench.overview()')).running, true);
  await execute('(async()=>{const p=await dshWorkbench.settings();return dshWorkbench.saveSettings({...p,theme:"dark",budgets:{...p.budgets,daily:37}})})()');
  assert.equal(JSON.parse(readFileSync(join(profile, 'preferences.json'), 'utf8')).budgets.daily, 37);
  const plugins = await execute('window.dshWorkbench.plugins()');
  assert.ok(plugins.length > 0);
  const stats = await execute('window.dshApp.getUsage({range:"today"})');
  assert.equal(stats.requestCount, 0);

  // The same bundled page loaded by an unregistered window must not gain IPC access.
  const rogue = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: join(appRoot, 'dist/main/preload.js') } });
  await rogue.loadURL('about:blank');
  const denied = await rogue.webContents.executeJavaScript('dshWorkbench.settings().then(()=>false,()=>true)');
  assert.equal(denied, true); rogue.destroy();

  // A maintenance operation owns its lock even while the native prompt is open.
  let dismiss;
  dialog.showMessageBox = () => new Promise(resolveDialog => { dismiss = resolveDialog; });
  const pendingPort = execute('window.dshWorkbench.changePort()');
  await until(() => dismiss);
  assert.equal(await execute('dshWorkbench.changePlugin("install","@fixture/not-installed").then(()=>false,e=>e.message.includes("维护"))'), true);
  dismiss({ response: 0 });
  assert.equal((await pendingPort).cancelled, true);
  assert.equal((await execute('window.dshWorkbench.overview()')).runtime.port, port);

  dialog.showMessageBox = async () => ({ response: 1 });
  const restart = await execute('window.dshWorkbench.changePort()');
  assert.equal(restart.ok, true);
  const changed = await execute('window.dshWorkbench.overview()');
  assert.notEqual(changed.runtime.port, port);
  assert.equal(changed.running, true);
  assert.ok((await execute('window.dshWorkbench.plugins()')).length > 0, 'real RPC survives restart and auth-cookie renewal');
  console.log(JSON.stringify({ verified: true, packaged, appVersion: app.getVersion(), isolated: true, realHarnessBoot: true,
    realPluginCount: plugins.length, actualIpc: true, unauthorizedIpcRejected: true, settingsPersisted: true,
    maintenanceLock: true, portSwitchRestart: true, paidModelCalls: 0 }));
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  for (const child of [...children]) if (child.pid && child.exitCode === null) await killTree(child.pid);
  app.exit(process.exitCode || 0);
});
