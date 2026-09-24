import { spawn, type ChildProcess } from 'node:child_process';

// A separate, hidden Node-mode process owns the Harness tree. Its IPC connection is
// closed by the OS even if the desktop is force-terminated during installation.
// Inline bundled code avoids executing an external Node script from inside app.asar.
export const SUPERVISOR_SOURCE = String.raw`
const { spawn } = require('node:child_process');
let child, stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child || !child.pid) return process.exit(0);
  if (process.platform !== 'win32') { child.kill('SIGTERM'); return; }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.once('error', () => process.exit(1));
  killer.once('close', code => process.exit(code === 0 ? 0 : 1));
}
process.on('disconnect', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.once('message', message => {
  if (stopping) return;
  if (!message || message.type !== 'start' || typeof message.command !== 'string' || !Array.isArray(message.args)) return process.exit(1);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  const windows = process.platform === 'win32';
  child = spawn(windows ? '"' + message.command + '"' : message.command, message.args, {
    shell: windows, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { if (!stopping) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { if (!stopping) process.stderr.write(chunk); });
  child.once('error', error => {
    if (!stopping) process.stderr.write('Harness launch failed: ' + (error.code || 'UNKNOWN') + '\n');
    process.exit(1);
  });
  child.once('close', code => { if (!stopping) process.exit(code === null ? 1 : code); });
});
if (!process.connected) process.exit(1);
`;

export function spawnSupervised(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    // Use this app's Node runtime only for the supervisor; Harness still runs via
    // its own npm shim / installed Node.js with the caller's original environment.
    const child = spawn(process.execPath, ['--eval', SUPERVISOR_SOURCE], {
      // Survive a forced parent termination long enough to process IPC disconnect
      // and stop the owned Harness tree. No visible console window is created.
      shell: false, windowsHide: true, detached: process.platform === 'win32', env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.send({ type: 'start', command: cmd, args }, error => {
        if (error) { if (child.connected) child.disconnect(); reject(error); } else resolve(child);
      });
    });
  });
}
