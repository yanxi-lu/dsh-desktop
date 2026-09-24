// An isolated TCP fixture, never Harness and never user data.
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const server = createServer(socket => socket.end());
server.listen(0, '127.0.0.1', () => {
  const own = { pid: process.pid, port: server.address().port, nodeModeRemoved: !process.env.ELECTRON_RUN_AS_NODE, ipcRemoved: !process.connected };
  if (process.argv.includes('--leaf')) return console.log(JSON.stringify(own));
  const leaf = spawn(process.execPath, [__filename, '--leaf'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  leaf.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.includes('\n')) console.log(JSON.stringify({ root: own, leaf: JSON.parse(buffer.trim()) }));
  });
});
