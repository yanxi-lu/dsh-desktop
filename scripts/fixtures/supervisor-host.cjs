// Fake desktop parent: the test kills only this process, not its children.
const { spawnSupervised } = require('../../dist/main/service-supervisor');
spawnSupervised(process.env.DSH_TEST_NODE, ['scripts/fixtures/supervisor-service.cjs'], process.env).then(child => {
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.includes('\n')) process.send({ supervisorPid: child.pid, ...JSON.parse(buffer.trim()) });
  });
  child.stderr.resume();
  child.once('exit', code => process.exit(code || 0));
}).catch(() => process.exit(1));
