import { mkdir, readdir, lstat, copyFile, readFile, writeFile, rename, readlink, symlink, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeDshTargetVersion, updateDshWithProgress } from './dsh';
import { INSTALL_MARKER, installSlots, removeInstallSlot } from './install-cleanup';

export interface Installation { bin: string; home: string; version: string }
interface InstallState { schema: 2; active?: Installation; pending?: boolean; port?: number; changedAt?: string; cleanupWarning?: string }
export interface CleanupResult { removed: number; warning: string }
/** Copy a stopped data tree without traversing links. Internal pnpm junctions are rebased into the copy; external links are refused. */
export async function snapshotTree(source: string, destination: string): Promise<void> {
  const src = resolve(source), dest = resolve(destination);
  if (!source.trim() || !destination.trim() || src === parse(src).root || dest === parse(dest).root) throw new Error('拒绝备份空路径或磁盘根目录');
  if (src === dest || (!relative(src, dest).startsWith('..') && !isAbsolute(relative(src, dest)))) throw new Error('备份目录不能位于原数据目录中');
  const links: Array<{ from: string; target: string }> = [];
  async function copy(from: string, to: string): Promise<void> {
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(from), await readlink(from));
      const targetRelative = relative(src, target), ancestorRelative = relative(target, from);
      if (!targetRelative || targetRelative.startsWith('..') || isAbsolute(targetRelative) || (!ancestorRelative.startsWith('..') && !isAbsolute(ancestorRelative))) throw new Error('数据目录包含外部或循环链接，已取消备份；请先通过官方工具导出该环境');
      const targetStat = await lstat(target);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('备份遇到文件链接或链接链，已安全取消');
      links.push({ from: to, target: join(dest, targetRelative) }); return;
    }
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: false });
      for (const entry of await readdir(from)) await copy(join(from, entry), join(to, entry));
    } else if (stat.isFile()) await copyFile(from, to, 1);
  }
  try { await lstat(src); } catch (e: any) { if (e.code === 'ENOENT') { await mkdir(dest); return; } throw e; }
  await copy(src, dest);
  // All targets now belong to the new copy. None points back to original user data.
  for (const link of links) await symlink(link.target, link.from, process.platform === 'win32' ? 'junction' : 'dir');
}

export class ManagedInstall {
  private state: InstallState = { schema: 2 };
  private readonly file: string;
  constructor(private readonly root: string, private readonly baseEnv: NodeJS.ProcessEnv, private readonly installer = updateDshWithProgress) {
    this.file = join(root, 'state.json');
    try {
      const old = JSON.parse(readFileSync(this.file, 'utf8'));
      // Keep the selected data home (including legacy restored-data), but stop retaining old-version pointers.
      this.state = { schema: 2, active: old.active, port: old.port, pending: old.pending === true,
        changedAt: old.changedAt, cleanupWarning: typeof old.cleanupWarning === 'string' ? old.cleanupWarning : undefined };
    } catch { /* first launch */ }
  }
  env(): NodeJS.ProcessEnv { return { ...this.baseEnv, ...(this.state.active ? { DSH_BIN: this.state.active.bin, DSH_HOME: this.state.active.home } : {}) }; }
  home(): string { return this.env().DSH_HOME?.trim() || join(homedir(), '.dsh'); }
  info(): { managed: boolean; version: string | null; pending: boolean; port: number; cleanupWarning: string } {
    return { managed: !!this.state.active, version: this.state.active?.version ?? null,
      pending: this.state.pending === true, port: this.state.port ?? 3080, cleanupWarning: this.state.cleanupWarning || '' };
  }
  private async save(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }
  private async commit(next: InstallState): Promise<void> {
    const before = this.state;
    this.state = next;
    try { await this.save(); } catch (error) { this.state = before; throw error; }
  }
  async setPort(port: number): Promise<void> { if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效'); await this.commit({ ...this.state, port }); }
  async stage(target: string, signal: AbortSignal, progress: (message: string) => void): Promise<Installation> {
    normalizeDshTargetVersion(target);
    const slot = join(this.root, 'versions', randomUUID());
    await mkdir(slot, { recursive: true });
    await writeFile(join(slot, INSTALL_MARKER), JSON.stringify({ app: 'dsh-desktop', kind: 'harness-install', id: parse(slot).base }), { flag: 'wx' });
    try {
      const version = await this.installer(this.env(), p => progress(p.message), { targetVersion: target, signal, installPrefix: slot });
      // npm integrity verification and an executable version check must both succeed before stopping the old service.
      const bin = join(slot, 'dsh.cmd');
      const installed = JSON.parse(await readFile(join(slot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
      if (installed.version !== version || (target !== 'latest' && version !== target)) throw new Error('安装后的版本校验不一致，未切换');
      return { bin, home: this.home(), version };
    } catch (error) { await this.discard({ bin: join(slot, 'dsh.cmd'), home: this.home(), version: target }); throw error; }
  }
  async activate(next: Installation): Promise<void> {
    await this.commit({ ...this.state, active: next, pending: true, changedAt: new Date().toISOString() });
  }
  async confirm(): Promise<CleanupResult> {
    await this.commit({ ...this.state, pending: false });
    return this.cleanup();
  }
  private dataHomes(): string[] { return [...new Set([this.home(), this.baseEnv.DSH_HOME?.trim()].filter((path): path is string => !!path))]; }
  private async warn(): Promise<string> {
    const warning = '旧安装清理未完成，已停止自动重试。请检查文件占用、目录权限或链接，再点击重试清理；会话数据未删除。';
    await this.commit({ ...this.state, cleanupWarning: warning }); return warning;
  }
  async discard(installation: Installation): Promise<void> {
    try { await removeInstallSlot(this.root, dirname(installation.bin), this.state.active?.bin, this.dataHomes()); }
    catch { await this.warn(); }
  }
  async cleanup(retry = false): Promise<CleanupResult> {
    if (this.state.cleanupWarning && !retry) return { removed: 0, warning: this.state.cleanupWarning };
    if (!this.state.active || this.state.pending) return { removed: 0, warning: '' };
    let removed = 0;
    try {
      let activeBin = resolve(this.state.active.bin);
      try { activeBin = await realpath(activeBin); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      for (const slot of await installSlots(this.root)) {
        const part = relative(await realpath(slot), activeBin);
        if (part === '' || (!part.startsWith('..') && !isAbsolute(part))) continue;
        await removeInstallSlot(this.root, slot, this.state.active.bin, this.dataHomes()); removed++;
      }
      if (this.state.cleanupWarning) await this.commit({ ...this.state, cleanupWarning: undefined });
      return { removed, warning: '' };
    } catch { return { removed, warning: await this.warn() }; }
  }
}
