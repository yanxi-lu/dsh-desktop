import { mkdir, readdir, lstat, copyFile, readFile, writeFile, rename, readlink, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeDshTargetVersion, resolveDshCommand, updateDshWithProgress } from './dsh';

interface Installation { bin: string; home: string; version: string }
interface InstallState { active?: Installation; previous?: Installation; backup?: string; pending?: boolean; port?: number; changedAt?: string }
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
  private state: InstallState = {};
  private readonly file: string;
  constructor(private readonly root: string, private readonly baseEnv: NodeJS.ProcessEnv) {
    this.file = join(root, 'state.json');
    try { this.state = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* first launch */ }
  }
  env(): NodeJS.ProcessEnv { return { ...this.baseEnv, ...(this.state.active ? { DSH_BIN: this.state.active.bin, DSH_HOME: this.state.active.home } : {}) }; }
  home(): string { return this.env().DSH_HOME?.trim() || join(homedir(), '.dsh'); }
  info(): { managed: boolean; version: string | null; previousVersion: string | null; backupAvailable: boolean; pending: boolean; port: number } {
    return { managed: !!this.state.active, version: this.state.active?.version ?? null, previousVersion: this.state.previous?.version ?? null,
      backupAvailable: !!this.state.backup && !!this.state.previous?.bin, pending: this.state.pending === true, port: this.state.port ?? 3080 };
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
    const version = await updateDshWithProgress(this.env(), p => progress(p.message), { targetVersion: target, signal, installPrefix: slot });
    // npm integrity verification and an executable version check must both succeed before stopping the old service.
    const bin = join(slot, 'dsh.cmd');
    const installed = JSON.parse(await readFile(join(slot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    if (installed.version !== version || (target !== 'latest' && version !== target)) throw new Error('安装后的版本校验不一致，未切换');
    return { bin, home: this.home(), version };
  }
  async activate(next: Installation, currentVersion: string | null, progress: (message: string) => void): Promise<void> {
    const previous = this.state.active ?? { bin: await resolveDshCommand(this.baseEnv) ?? '', home: this.home(), version: currentVersion ?? '未知' };
    const backup = join(this.root, 'backups', randomUUID());
    await mkdir(join(this.root, 'backups'), { recursive: true });
    progress('正在备份完整 Harness 数据（包含本机凭据，仅保留在本机，不会上传）…');
    await snapshotTree(previous.home, backup);
    await this.commit({ ...this.state, previous, backup, active: next, pending: true, changedAt: new Date().toISOString() });
  }
  async confirm(): Promise<void> { await this.commit({ ...this.state, pending: false }); }
  async restore(progress: (message: string) => void): Promise<void> {
    if (!this.state.previous?.bin || !this.state.backup) throw new Error('没有可恢复的已备份版本');
    // Missing data is acceptable on first installation, never for a saved backup.
    const backupStat = await lstat(this.state.backup);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error('升级前快照不是有效的普通目录，未切换数据');
    const restored = join(this.root, 'restored-data', randomUUID());
    await mkdir(join(this.root, 'restored-data'), { recursive: true });
    progress('正在从升级前快照恢复独立数据副本；新版数据原样保留…');
    await snapshotTree(this.state.backup, restored);
    await this.commit({ ...this.state, active: { ...this.state.previous, home: restored }, pending: false, changedAt: new Date().toISOString() });
  }
}
