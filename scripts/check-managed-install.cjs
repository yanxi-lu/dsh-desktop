// Network integration test: installs the official package into a NEW temporary prefix only.
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { ManagedInstall } = require('../dist/main/managed-install');
const { getDshVersion } = require('../dist/main/dsh');
const { redact } = require('../dist/main/harness-bridge');
async function run() {
  const version = process.argv[2]; if (!version) throw new Error('Pass an explicit official version');
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-managed-install-test-'));
  const home = join(temporary, 'home'); mkdirSync(home); writeFileSync(join(home, 'fixture.txt'), 'before');
  const env = { DSH_HOME: home };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  const before = await getDshVersion(env);
  const managed = new ManagedInstall(join(temporary, 'runtime'), env);
  let last = 0;
  const next = await managed.stage(version, new AbortController().signal, () => { if (Date.now() - last > 30000) { last = Date.now(); console.log('Isolated official package installation in progress'); } });
  assert.equal(next.version, version); assert.equal(await getDshVersion(env), before, 'global installation is unchanged');
  await managed.activate(next, before, () => {});
  assert.equal(await getDshVersion(managed.env()), version);
  const output = await promisify(execFile)(process.execPath, [resolve(__dirname, 'check-official-bridge.cjs'), join(next.bin, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')], { windowsHide: true, timeout: 160000 });
  assert.match(output.stdout, /"verified":true/);
  writeFileSync(join(home, 'fixture.txt'), 'after-migration');
  await managed.restore(() => {});
  assert.equal(readFileSync(join(managed.home(), 'fixture.txt'), 'utf8'), 'before');
  assert.equal(readFileSync(join(home, 'fixture.txt'), 'utf8'), 'after-migration');
  console.log(JSON.stringify({ verified: true, isolatedInstall: version, globalUnchanged: true, installedRuntimeBoot: true, archiveRestore: true, snapshotRestored: true, migratedDataPreserved: true }));
}
run().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
