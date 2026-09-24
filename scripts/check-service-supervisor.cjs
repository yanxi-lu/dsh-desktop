// Verify forced desktop exit cleanup using only newly spawned fixture processes.
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolve } = require('node:path');
const { assertPortAvailable } = require('../dist/main/diagnostics');
const run = promisify(execFile);
const runtime = process.argv[2] ? resolve(process.argv[2]) : process.execPath;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function verify() {
  const host = spawn(runtime, [resolve(__dirname, 'fixtures/supervisor-host.cjs')], {
    cwd: resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TEST_NODE: process.execPath },
  });
  host.stdout.resume(); host.stderr.resume();
  let ready;
  try {
    ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Supervisor fixture startup timed out')), 15000);
      host.once('message', message => { clearTimeout(timer); resolveReady(message); });
      host.once('error', error => { clearTimeout(timer); reject(error); });
      host.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture parent exited ${code}`)); });
    });
    assert.ok(ready.root.nodeModeRemoved && ready.leaf.nodeModeRemoved, 'Supervisor flags do not leak into Harness');
    assert.ok(ready.root.ipcRemoved && ready.leaf.ipcRemoved, 'Harness does not inherit supervisor IPC');
    console.log(JSON.stringify({ fixtureReady: ready, hostPid: host.pid }));
    host.kill(); // Force this test parent to exit, intentionally without taskkill /T.
    const deadline = Date.now() + 15000;
    while ([ready.supervisorPid, ready.root.pid, ready.leaf.pid].some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    for (const [role, pid] of [['supervisor', ready.supervisorPid], ['service', ready.root.pid], ['grandchild', ready.leaf.pid]]) assert.equal(alive(pid), false, `Fixture ${role} process ${pid} leaked`);
    await assertPortAvailable(ready.root.port); await assertPortAvailable(ready.leaf.port);
    console.log(JSON.stringify({ verified: true, runtime, forcedParentExit: true, supervisorExited: true, serviceAndGrandchildExited: true, portsReleased: true, noUserProcessesTouched: true }));
  } finally {
    // Only handles/PIDs received from these freshly created fixtures are eligible.
    if (host.exitCode === null && host.signalCode === null) await run('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    for (const pid of ready ? [ready.supervisorPid, ready.root.pid, ready.leaf.pid] : []) if (alive(pid)) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  }
}
verify().catch(error => { console.error(error.message); process.exitCode = 1; });
