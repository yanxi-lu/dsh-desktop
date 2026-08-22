// Windows Node.js LTS 一键安装。使用系统自带 winget 的 OpenJS 官方包,
// 安装完成后刷新当前桌面壳进程 PATH,无需注销或重启电脑。
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { killTree } from './dsh';

const execFileAsync = promisify(execFile);

export interface NodeInstallProgress {
  message: string;
  elapsedSeconds?: number;
}

export interface NodeInstallOptions {
  whereFn?: (cmd: string) => Promise<string[]>;
  spawnFn?: typeof spawn;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function defaultWhere(cmd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('where', [cmd]);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function parseNodeVersion(output: string): string | null {
  return output.trim().match(/^v?(\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

export async function resolveWingetCommand(
  whereFn: (cmd: string) => Promise<string[]> = defaultWhere,
): Promise<string | null> {
  const hits = await whereFn('winget');
  return hits.find((path) => /\.exe$/i.test(path)) ?? hits[0] ?? null;
}

function commonNodeCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    env.ProgramFiles ? join(env.ProgramFiles, 'nodejs', 'node.exe') : '',
    env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'nodejs', 'node.exe') : '',
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
  ].filter(Boolean);
}

export async function findNodeExecutable(
  env: NodeJS.ProcessEnv,
  whereFn: (cmd: string) => Promise<string[]> = defaultWhere,
): Promise<string | null> {
  const hits = await whereFn('node');
  const executable = hits.find((path) => /\.exe$/i.test(path) && existsSync(path));
  if (executable) return executable;
  return commonNodeCandidates(env).find((path) => existsSync(path)) ?? null;
}

/** 将新安装的 node/npm 目录加入当前 Electron 进程 PATH。 */
export function refreshNodePath(env: NodeJS.ProcessEnv, nodeExecutable: string): void {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  const current = env[pathKey] ?? '';
  const additions = [
    dirname(nodeExecutable),
    env.APPDATA ? join(env.APPDATA, 'npm') : '',
  ].filter(Boolean);
  const segments = current.split(';').filter(Boolean);
  for (const addition of additions.reverse()) {
    if (!segments.some((segment) => segment.toLowerCase() === addition.toLowerCase())) {
      segments.unshift(addition);
    }
  }
  env[pathKey] = segments.join(';');
}

function streamOutput(
  child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null },
  onLine: (line: string) => void,
): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding('utf8');
    let remainder = '';
    stream.on('data', (chunk: string) => {
      const parts = `${remainder}${chunk}`.split(/[\r\n]+/);
      remainder = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) onLine(line.trim());
    });
    stream.on('end', () => { if (remainder.trim()) onLine(remainder.trim()); });
  }
}

export async function installNodeLtsWithProgress(
  env: NodeJS.ProcessEnv,
  onProgress: (progress: NodeInstallProgress) => void,
  options: NodeInstallOptions = {},
): Promise<string> {
  const winget = await resolveWingetCommand(options.whereFn);
  if (!winget) {
    throw new Error('未找到 Windows 程序包管理器 winget;请先从 Microsoft Store 安装“应用安装程序”,或前往 nodejs.org 安装 Node.js LTS');
  }
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const startedAt = Date.now();
  let cancelled = false;
  let timedOut = false;
  let lastLines: string[] = [];
  onProgress({ message: '正在通过 Windows 程序包管理器安装 Node.js LTS…', elapsedSeconds: 0 });

  const child = (options.spawnFn ?? spawn)(winget, [
    'install',
    '--id', 'OpenJS.NodeJS.LTS',
    '--exact',
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--silent',
    '--disable-interactivity',
  ], {
    shell: false,
    windowsHide: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  streamOutput(child, (line) => {
    lastLines = [...lastLines.slice(-7), line];
    if (/downloading|正在下载/i.test(line)) onProgress({ message: '正在下载 Node.js LTS 官方安装包…' });
    if (/installing|正在安装/i.test(line)) onProgress({ message: '正在安装 Node.js LTS,系统可能显示权限确认…' });
  });

  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    onProgress({ message: `Node.js LTS 仍在安装中…已用时 ${elapsedSeconds} 秒`, elapsedSeconds });
  }, 5_000);
  const terminate = (): void => {
    if (child.pid) void killTree(child.pid);
    else child.kill();
  };
  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  try {
    await new Promise<void>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (cancelled) reject(new Error('Node.js 安装已取消'));
        else if (timedOut) reject(new Error('Node.js 安装超过 15 分钟,已自动停止'));
        else if (code === 0) resolvePromise();
        else {
          const detail = lastLines.slice(-3).join(' | ').slice(-500);
          reject(new Error(`Node.js 安装失败(exit code ${code ?? 'unknown'})${detail ? `:${detail}` : ''}`));
        }
      });
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  let nodeExecutable: string | null = null;
  for (let attempt = 0; attempt < 5 && !nodeExecutable; attempt += 1) {
    nodeExecutable = await findNodeExecutable(env, options.whereFn);
    if (!nodeExecutable) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  if (!nodeExecutable) throw new Error('Node.js 安装完成,但未找到 node.exe;请重启桌面应用后重新检测');
  refreshNodePath(env, nodeExecutable);
  const { stdout } = await execFileAsync(nodeExecutable, ['--version'], { windowsHide: true });
  const version = parseNodeVersion(stdout);
  if (!version) throw new Error('Node.js 安装完成,但版本检测失败;请重启桌面应用');
  onProgress({ message: `Node.js ${version} 安装成功`, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
  return version;
}
