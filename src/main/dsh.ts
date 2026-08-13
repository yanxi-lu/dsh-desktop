// dsh 进程管理:检测、spawn、就绪轮询、树杀。
// 本模块不依赖 Electron API,可在纯 Node 环境(vitest)下测试。
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, dshUrl } from './config';

const execFileAsync = promisify(execFile);

export interface DetectResult {
  node: boolean;
  dsh: boolean;
}

/**
 * 解析 dsh 可执行文件路径,优先级:DSH_BIN → DSH_HOME → PATH。
 * @param env 进程环境变量(测试注入)
 * @param whereFn where 命令的注入实现(Windows 下 `where dsh` 解析 PATH)
 */
export async function resolveDshCommand(
  env: NodeJS.ProcessEnv,
  whereFn: (cmd: string) => Promise<string[]> = defaultWhere,
): Promise<string | null> {
  // 1) DSH_BIN:显式指定,直接使用
  if (env.DSH_BIN) return env.DSH_BIN;

  // 2) DSH_HOME:自定义安装根目录,探测其下的 dsh.cmd
  if (env.DSH_HOME) {
    const cand = join(env.DSH_HOME, 'dsh.cmd');
    if (existsSync(cand)) return cand;
  }

  // 3) PATH:交给 where 解析(等价于 shell 的 where dsh)
  const hits = await whereFn('dsh');
  // Windows 下 npm 全局安装会同时生成无扩展名 sh shim(dsh)与 dsh.cmd/dsh.ps1,
  // 而 `where dsh` 会把无法直接执行的无扩展名 shim 排在首位(实测 ENOENT)。
  // 优先选择 Windows 可直接执行的扩展名,否则退回首个命中。
  const executable = hits.find((h) => /\.(cmd|exe|bat|com)$/i.test(h.trim()));
  return executable ?? hits[0] ?? null;
}

async function defaultWhere(cmd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('where', [cmd]);
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 检测 Node.js 是否可用(默认实现执行 `node --version`) */
export async function detectNode(
  nodeCheckFn: () => Promise<void> = defaultNodeCheck,
): Promise<boolean> {
  try {
    await nodeCheckFn();
    return true;
  } catch {
    return false;
  }
}

async function defaultNodeCheck(): Promise<void> {
  await execFileAsync('node', ['--version']);
}

/** 检测 dsh 是否可用(解析出候选路径后真实执行 `dsh -V` 探测) */
export async function detectDsh(
  env: NodeJS.ProcessEnv,
  whereFn?: (cmd: string) => Promise<string[]>,
  execFn: (cmd: string) => Promise<void> = defaultDshCheck,
): Promise<boolean> {
  const cmd = await resolveDshCommand(env, whereFn);
  if (!cmd) return false;
  try {
    await execFn(cmd);
    return true;
  } catch {
    return false;
  }
}

/** 默认 dsh 探测:执行 `dsh -V`,成功返回、失败抛错 */
async function defaultDshCheck(cmd: string): Promise<void> {
  // .cmd 脚本无法被 execFile 直接执行(实测 EINVAL),必须 shell:true;
  // shell:true 下命令仅按字符串拼接,路径含空格(如 C:\Program Files\dsh\dsh.cmd)
  // 会被拆断(实测报「不是内部或外部命令」),故命令整体显式加引号(R20)。
  await execFileAsync(`"${cmd}"`, ['-V'], { shell: true });
}

/** 汇总检测结果,供引导页展示 */
export async function detectAll(
  env: NodeJS.ProcessEnv,
  nodeCheckFn?: () => Promise<void>,
  whereFn?: (cmd: string) => Promise<string[]>,
  execFn?: (cmd: string) => Promise<void>,
): Promise<DetectResult> {
  const [node, dsh] = await Promise.all([
    detectNode(nodeCheckFn),
    detectDsh(env, whereFn, execFn),
  ]);
  return { node, dsh };
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { shell: boolean; windowsHide: boolean; env?: NodeJS.ProcessEnv },
) => Promise<ChildProcess>;

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number }>;

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    // Windows 上 dsh 是 .cmd 脚本,必须 shell:true
    const child = spawn(cmd, args, { ...opts, shell: true, windowsHide: true });
    child.once('error', reject);   // spawn 失败(如 ENOENT)在此捕获
    child.once('spawn', () => resolve(child));
  });

const defaultFetch: FetchLike = async (url) => {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status };
};

const defaultExec: ExecFn = async (cmd) => {
  const { stdout, stderr } = await execFileAsync(cmd, { shell: true });
  return { stdout, stderr };
};

/** 启动 dsh web 服务,返回子进程与目标地址 */
export async function startDsh(
  env: NodeJS.ProcessEnv,
  spawnFn: SpawnFn = defaultSpawn,
  whereFn?: (cmd: string) => Promise<string[]>,
): Promise<{ proc: ChildProcess; url: string }> {
  const cmd = await resolveDshCommand(env, whereFn);
  if (!cmd) {
    throw new Error('未找到 dsh,请先执行 npm install -g @deepseek-ai/dsh');
  }
  const proc = await spawnFn(cmd, config.dshArgs, { shell: true, windowsHide: true, env });
  return { proc, url: dshUrl() };
}

/** 轮询直到服务就绪(2xx),超时抛错 */
export async function waitForReady(
  url: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number; fetchFn?: FetchLike } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? config.readyTimeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? config.pollIntervalMs;
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(url);
      if (res.ok) return;
    } catch {
      // 服务尚未监听,继续轮询
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`dsh 服务 ${timeoutMs}ms 内未就绪(timeout),请手动运行 dsh web 排查`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 树杀 dsh 进程树,不留孤儿进程 */
export async function killTree(pid: number, execFn: ExecFn = defaultExec): Promise<void> {
  try {
    await execFn(`taskkill /pid ${pid} /T /F`);
  } catch {
    // 进程可能已自行退出,忽略
  }
}
