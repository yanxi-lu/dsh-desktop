import { lstat, readdir, readFile, realpath, unlink, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const INSTALL_MARKER = '.dsh-desktop-install.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalized = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const within = (parent: string, child: string): boolean => {
  const part = relative(resolve(parent), resolve(child));
  return part === '' || (!part.startsWith('..') && !isAbsolute(part));
};
async function canonicalIfPresent(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error: any) { if (error.code === 'ENOENT') return resolve(path); throw error; }
}
async function ordinaryRoot(root: string): Promise<string> {
  // Windows TEMP may contain an 8.3 alias (ZHANGS~1). Canonicalize it, but inspect
  // every ancestor first so a junction is never mistaken for an ordinary alias.
  let folder = resolve(root);
  for (;;) {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('安装根目录包含链接，未清理');
    const parent = dirname(folder); if (parent === folder) break; folder = parent;
  }
  return realpath(root);
}

/** Only app-owned UUID installation slots are eligible; never data homes or global npm. */
export async function removeInstallSlot(root: string, slot: string, activeBin: string | undefined, dataHomes: string[]): Promise<number> {
  const requested = resolve(slot);
  if (normalized(dirname(requested)) !== normalized(resolve(root, 'versions')) || !UUID.test(basename(requested))) throw new Error('拒绝清理非托管版本目录');
  const versions = join(await ordinaryRoot(root), 'versions'), target = join(versions, basename(requested));
  if (activeBin && (within(requested, activeBin) || within(target, await canonicalIfPresent(activeBin)))) throw new Error('不能清理当前使用的安装');
  for (const home of dataHomes) {
    const canonical = await canonicalIfPresent(home);
    if ([home, canonical].some(path => [requested, target].some(install => within(install, path) || within(path, install)))) throw new Error('安装目录与会话数据目录重叠，未清理');
  }
  for (const folder of [versions, target]) {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || normalized(await realpath(folder)) !== normalized(folder)) throw new Error('安装目录包含链接，未清理');
  }
  let owned = false;
  const marker = join(target, INSTALL_MARKER);
  try {
    const info = await lstat(marker);
    if (info.isFile() && !info.isSymbolicLink()) {
      const value = JSON.parse(await readFile(marker, 'utf8'));
      owned = value.app === 'dsh-desktop' && value.kind === 'harness-install' && value.id === basename(target);
    }
  } catch { /* v0.5.0 installations had no marker */ }
  // Recognize old app-created slots, but not arbitrary directories below userData.
  if (!owned) {
    const files = await readdir(target);
    if (files.some(name => !['node_modules', 'dsh', 'dsh.cmd', 'dsh.ps1'].includes(name))) throw new Error('安装目录含未识别文件，未自动清理');
    try {
      const manifest = join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      for (const path of [join(target, 'node_modules'), join(target, 'node_modules', '@deepseek-ai'), dirname(manifest), manifest, join(target, 'dsh.cmd')]) {
        if ((await lstat(path)).isSymbolicLink()) throw new Error('linked install');
      }
      owned = JSON.parse(await readFile(manifest, 'utf8')).name === '@deepseek-ai/dsh';
    } catch { /* ownership is not established */ }
  }
  if (!owned) throw new Error('无法确认此目录是桌面壳创建的 Harness 安装，未清理');

  const files: string[] = [], directories: string[] = [];
  async function inspect(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('旧安装中存在链接，已停止自动清理');
    if (info.isDirectory()) {
      directories.push(path);
      for (const name of await readdir(path)) await inspect(join(path, name));
    } else if (info.isFile()) files.push(path);
    else throw new Error('旧安装中存在非普通文件，已停止自动清理');
    if (files.length + directories.length > 100_000) throw new Error('旧安装文件数量异常，已停止自动清理');
  }
  // Complete dry enumeration before the first unlink. No recursive delete or link traversal.
  await inspect(target);
  if (!files.includes(marker)) {
    // Legacy slots receive an ownership marker after full inspection so a partial cleanup
    // can be explicitly retried even if package.json has already been removed.
    await writeFile(marker, JSON.stringify({ app: 'dsh-desktop', kind: 'harness-install', id: basename(target) }), { flag: 'wx' });
  }
  for (const file of files.filter(file => file !== marker)) {
    if (normalized(await realpath(file)) !== normalized(file) || !(await lstat(file)).isFile()) throw new Error('清理期间文件类型发生变化，已停止');
    await unlink(file);
  }
  for (const directory of directories.reverse()) {
    if (directory === target) continue;
    if (normalized(await realpath(directory)) !== normalized(directory) || (await lstat(directory)).isSymbolicLink()) throw new Error('清理期间目录发生变化，已停止');
    await rmdir(directory); // empty directories only; a locked file stops the operation, never force-retried
  }
  if (normalized(await realpath(target)) !== normalized(target) || (await lstat(marker)).isSymbolicLink()) throw new Error('清理期间目录发生变化，已停止');
  await unlink(marker);
  await rmdir(target);
  return files.length;
}

export async function installSlots(root: string): Promise<string[]> {
  try {
    const versions = join(await ordinaryRoot(root), 'versions');
    const info = await lstat(versions);
    if (!info.isDirectory() || info.isSymbolicLink() || normalized(await realpath(versions)) !== normalized(versions)) throw new Error('托管安装根目录不是普通目录，未清理');
    return (await readdir(versions)).filter(name => UUID.test(name)).map(name => resolve(root, 'versions', name));
  } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}
