import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, rmSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagedInstall } from '../src/main/managed-install';
import { INSTALL_MARKER, removeInstallSlot } from '../src/main/install-cleanup';
import type { updateDshWithProgress } from '../src/main/dsh';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-cleanup-test-')); roots.push(root);
  const runtime = join(root, 'runtime'), home = join(root, 'home'); mkdirSync(runtime); mkdirSync(home);
  writeFileSync(join(home, 'session.jsonl'), 'keep sessions');
  return { root, runtime, home };
}
function mark(slot: string) {
  writeFileSync(join(slot, INSTALL_MARKER), JSON.stringify({ app: 'dsh-desktop', kind: 'harness-install', id: basename(slot) }));
}
function slot(runtime: string, version = '0.1.7-rc.1', marker = true) {
  const path = join(runtime, 'versions', randomUUID());
  const pkg = join(path, 'node_modules', '@deepseek-ai', 'dsh'); mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  writeFileSync(join(path, 'dsh.cmd'), 'fixture');
  if (marker) mark(path);
  return path;
}
function assertOrdinaryTree(path: string): void {
  const info = lstatSync(path); if (info.isSymbolicLink()) throw new Error('Fixture cleanup refuses links');
  if (info.isDirectory()) for (const name of readdirSync(path)) assertOrdinaryTree(join(path, name));
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-install-cleanup-test-')) throw new Error('Unsafe fixture path');
    assertOrdinaryTree(root); rmSync(root, { recursive: true });
  }
});

describe('只保留当前托管安装', () => {
  it('Windows 短路径与完整路径混用时仍正确跳过当前安装', async () => {
    const { runtime, home } = fixture(), current = slot(runtime), old = slot(runtime);
    const manager = new ManagedInstall(realpathSync(runtime), { DSH_HOME: home });
    await manager.activate({ bin: join(current, 'dsh.cmd'), home, version: '0.1.7-rc.1' });
    expect(await manager.confirm()).toEqual({ removed: 1, warning: '' });
    expect(existsSync(current)).toBe(true); expect(existsSync(old)).toBe(false);
  });
  it('就绪确认前不清理；成功后删除旧安装，不创建快照、不动数据或全局安装', async () => {
    const { root, runtime, home } = fixture();
    const old = slot(runtime), next = slot(runtime, '0.1.8-rc.1');
    const globalBin = join(root, 'global-dsh.cmd'); writeFileSync(globalBin, 'global');
    const manager = new ManagedInstall(runtime, { DSH_HOME: home, DSH_BIN: globalBin });
    await manager.activate({ bin: join(next, 'dsh.cmd'), home, version: '0.1.8-rc.1' });
    expect(await manager.cleanup()).toEqual({ removed: 0, warning: '' });
    expect(existsSync(old)).toBe(true);
    expect(await manager.confirm()).toEqual({ removed: 1, warning: '' });
    expect(existsSync(old)).toBe(false); expect(existsSync(next)).toBe(true);
    expect(readFileSync(globalBin, 'utf8')).toBe('global');
    expect(readFileSync(join(home, 'session.jsonl'), 'utf8')).toBe('keep sessions');
    expect(existsSync(join(runtime, 'backups'))).toBe(false);
    const state = JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'));
    expect(state.schema).toBe(2); expect(state.previous).toBeUndefined(); expect(state.backup).toBeUndefined();
    expect(new ManagedInstall(runtime, {}).env().DSH_BIN).toBe(join(next, 'dsh.cmd'));
  });
  it('识别 0.5.0 的无标记旧安装，保留原有数据备份和 restored-data', async () => {
    const { runtime, home } = fixture(), old = slot(runtime, '0.1.5-rc.3', false), next = slot(runtime);
    const legacy = join(runtime, 'backups', randomUUID()); mkdirSync(legacy, { recursive: true }); writeFileSync(join(legacy, 'keep'), 'backup');
    const restored = join(runtime, 'restored-data', randomUUID()); mkdirSync(restored, { recursive: true }); writeFileSync(join(restored, 'keep'), 'active data');
    const installation = { bin: join(next, 'dsh.cmd'), home: restored, version: '0.1.7-rc.1' };
    writeFileSync(join(runtime, 'state.json'), JSON.stringify({ active: installation, previous: { bin: join(old, 'dsh.cmd'), home }, backup: legacy, pending: true }));
    const manager = new ManagedInstall(runtime, { DSH_HOME: home });
    expect(await manager.confirm()).toEqual({ removed: 1, warning: '' });
    expect(manager.home()).toBe(restored); expect(existsSync(legacy)).toBe(true); expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(restored, 'keep'), 'utf8')).toBe('active data');
  });
  it('下载失败或取消只清理本次临时安装', async () => {
    const { runtime, home } = fixture(), active = slot(runtime);
    const installer: typeof updateDshWithProgress = async (_env, _progress, options = {}) => {
      writeFileSync(join(options.installPrefix!, 'partial-download'), 'partial'); throw new Error('cancelled');
    };
    const manager = new ManagedInstall(runtime, { DSH_HOME: home }, installer);
    await manager.activate({ bin: join(active, 'dsh.cmd'), home, version: '0.1.7-rc.1' }); await manager.confirm();
    await expect(manager.stage('0.1.8-rc.1', new AbortController().signal, () => {})).rejects.toThrow('cancelled');
    expect(readdirSync(join(runtime, 'versions'))).toEqual([basename(active)]);
    expect(manager.env().DSH_BIN).toBe(join(active, 'dsh.cmd'));
  });
  it('选择旧版本也会重新下载，不复用磁盘里已有的旧版本', async () => {
    const { runtime, home } = fixture(), current = slot(runtime), old = slot(runtime, '0.1.5-rc.3');
    const installer = vi.fn<typeof updateDshWithProgress>(async (_env, _progress, options = {}) => {
      const pkg = join(options.installPrefix!, 'node_modules', '@deepseek-ai', 'dsh'); mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: options.targetVersion }));
      writeFileSync(join(options.installPrefix!, 'dsh.cmd'), 'fixture'); return options.targetVersion!;
    });
    const manager = new ManagedInstall(runtime, { DSH_HOME: home }, installer);
    await manager.activate({ bin: join(current, 'dsh.cmd'), home, version: '0.1.7-rc.1' });
    const next = await manager.stage('0.1.5-rc.3', new AbortController().signal, () => {});
    expect(installer).toHaveBeenCalledOnce(); expect(dirname(next.bin)).not.toBe(old);
    await manager.activate(next); expect((await manager.confirm()).removed).toBe(2);
    expect(readdirSync(join(runtime, 'versions'))).toEqual([basename(dirname(next.bin))]);
    expect(manager.home()).toBe(home);
  });
  it('异常目录只提示并停止，不自动重试；显式重试后才能继续', async () => {
    const { runtime, home } = fixture(), active = slot(runtime), unknown = join(runtime, 'versions', randomUUID());
    mkdirSync(unknown); writeFileSync(join(unknown, 'unknown.txt'), 'keep');
    const manager = new ManagedInstall(runtime, { DSH_HOME: home });
    await manager.activate({ bin: join(active, 'dsh.cmd'), home, version: '0.1.7-rc.1' });
    expect((await manager.confirm()).warning).toContain('停止自动重试');
    mark(unknown); // A repaired, now explicitly owned fixture.
    expect((await new ManagedInstall(runtime, {}).cleanup()).removed).toBe(0); expect(existsSync(unknown)).toBe(true);
    expect(await manager.cleanup(true)).toEqual({ removed: 1, warning: '' });
  });
});

describe('清理路径保护', () => {
  it('拒绝当前安装、任意目录、数据重叠目录', async () => {
    const { root, runtime, home } = fixture(), target = slot(runtime);
    await expect(removeInstallSlot(runtime, target, join(target, 'dsh.cmd'), [home])).rejects.toThrow('当前');
    await expect(removeInstallSlot(runtime, root, undefined, [home])).rejects.toThrow('非托管');
    await expect(removeInstallSlot(runtime, target, undefined, [target])).rejects.toThrow('重叠');
    expect(existsSync(join(target, 'dsh.cmd'))).toBe(true);
  });
  it('完整枚举遇到链接便停止，链接目标和此前的文件都不会被删', async () => {
    const { runtime, home } = fixture(), target = slot(runtime), link = join(target, 'linked-home');
    symlinkSync(home, link, 'junction');
    try {
      await expect(removeInstallSlot(runtime, target, undefined, [home])).rejects.toThrow('链接');
      expect(existsSync(join(target, 'dsh.cmd'))).toBe(true);
      expect(readFileSync(join(home, 'session.jsonl'), 'utf8')).toBe('keep sessions');
    } finally { unlinkSync(link); }
  });
  it('会话目录经链接指向安装内时也拒绝清理', async () => {
    const { root, runtime } = fixture(), target = slot(runtime), alias = join(root, 'data-alias');
    symlinkSync(target, alias, 'junction');
    try { await expect(removeInstallSlot(runtime, target, undefined, [alias])).rejects.toThrow('重叠'); }
    finally { unlinkSync(alias); }
    expect(existsSync(join(target, 'dsh.cmd'))).toBe(true);
  });
  it('拒绝将整个 versions 重定向到其他目录', async () => {
    const { root, runtime, home } = fixture(), other = join(root, 'other'); mkdirSync(other);
    const target = slot(other), link = join(runtime, 'versions'); symlinkSync(join(other, 'versions'), link, 'junction');
    try { await expect(removeInstallSlot(runtime, join(link, basename(target)), undefined, [home])).rejects.toThrow('链接'); }
    finally { unlinkSync(link); }
    expect(existsSync(target)).toBe(true);
  });
});
