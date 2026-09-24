// Run after build. Boots ONLY an isolated empty DSH_HOME, sends no model requests.
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { availablePort } = require('../dist/main/diagnostics');
const { HarnessBridge } = require('../dist/main/harness-bridge');
const { killTree } = require('../dist/main/dsh');
const electron = process.versions.electron ? require('electron') : null;
if (electron) { electron.app.setPath('userData', mkdtempSync(join(tmpdir(), 'dsh-electron-bridge-profile-'))); electron.app.on('window-all-closed', () => {}); }

async function run() {
  const bin = process.argv[2]; if (!bin || !require('node:fs').existsSync(bin)) throw new Error('Pass installed official lib/bin.js path');
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-official-bridge-'));
  const home = join(temporary, 'home'), workspace = join(temporary, 'workspace'); mkdirSync(home); mkdirSync(workspace);
  const port = await availablePort();
  const env = { DSH_HOME: home };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(electron ? process.argv[3] : process.execPath, [resolve(bin), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const launch = await new Promise((resolveLaunch, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Isolated Harness startup exceeded 120s')), 120000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated Harness exited ${code}`)); });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        buffer = (buffer + chunk.toString()).slice(-10000);
        const found = buffer.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s\\x1b]+`));
        if (found) { clearTimeout(timer); resolveLaunch(found[0]); }
      });
    });
    const fetcher = electron ? (url, options) => electron.session.defaultSession.fetch(url, options) : fetch;
    let cookies;
    if (electron) {
      const view = new electron.BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      await view.loadURL(launch);
      cookies = (await electron.session.defaultSession.cookies.get({ url: `http://127.0.0.1:${port}` })).map(c => `${c.name}=${c.value}`).join('; ');
      view.destroy();
    } else {
      const auth = await fetcher(launch, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      cookies = auth.headers.getSetCookie().map(line => line.split(';')[0]).join('; ');
    }
    assert.ok(cookies, 'official launch-token exchange produced auth cookie');
    const authenticatedFetch = electron ? fetcher : (url, options) => fetch(url, { ...options, headers: { ...options.headers, cookie: cookies } });
    if (electron) assert.ok((await electron.session.defaultSession.cookies.get({ url: `http://127.0.0.1:${port}` })).length > 0, 'Electron auth cookie persisted');
    const bridge = new HarnessBridge(() => `http://127.0.0.1:${port}`, authenticatedFetch);
    const sessions = await bridge.sessions(); assert.ok(Array.isArray(sessions));
    const plugins = await bridge.plugins(); assert.ok(plugins.length > 0, 'official plugin inventory');
    await bridge.createWorkspace(workspace);
    // Create a blank fixture session via the documented contract: no prompt, no paid call.
    const method = 'session/create'; const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method, payload: { args: { request: { cwd: workspace } } } }) });
    const created = await response.json(); assert.equal(created.result.ok, true, 'official blank session');
    const id = created.result.value.sessionId;
    await bridge.archive(id, true); await bridge.archive(id, false);
    console.log(JSON.stringify({ verified: true, electron: !!electron, isolated: true, plugins: plugins.length, sessionList: true, createWorkspace: true, archiveRestore: true, paidModelCalls: 0 }));
  } finally { if (child.pid) await killTree(child.pid); }
}
(electron ? electron.app.whenReady().then(run) : run()).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => electron?.app.exit(process.exitCode || 0));
