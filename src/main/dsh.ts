// dsh 进程管理:检测、spawn、就绪轮询、树杀。
// 本模块不依赖 Electron API,可在纯 Node 环境(vitest)下测试。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

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

  // 2) DSH_HOME:自定义安装根目录,取其下的 dsh.cmd
  if (env.DSH_HOME) {
    return join(env.DSH_HOME, 'dsh.cmd');
  }

  // 3) PATH:交给 where 解析(等价于 shell 的 where dsh)
  const hits = await whereFn('dsh');
  return hits[0] ?? null;
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

/** 检测 dsh 是否可用(解析到可执行路径即为可用) */
export async function detectDsh(
  env: NodeJS.ProcessEnv,
  whereFn?: (cmd: string) => Promise<string[]>,
): Promise<boolean> {
  const cmd = await resolveDshCommand(env, whereFn);
  return cmd !== null;
}

/** 汇总检测结果,供引导页展示 */
export async function detectAll(
  env: NodeJS.ProcessEnv,
  nodeCheckFn?: () => Promise<void>,
  whereFn?: (cmd: string) => Promise<string[]>,
): Promise<DetectResult> {
  const [node, dsh] = await Promise.all([
    detectNode(nodeCheckFn),
    detectDsh(env, whereFn),
  ]);
  return { node, dsh };
}
