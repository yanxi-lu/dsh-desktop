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

export interface StartedDsh {
  proc: ChildProcess;
  /** 兼容旧版 Harness 的无令牌服务地址；发现新版启动 URL 后会由入口更新。 */
  url: string;
  /** Harness 0.1.2+ 启动时输出带一次性 token 的 URL，令牌只留在主进程。 */
  launchUrl: Promise<string>;
  diagnostics?: RuntimeDiagnostic[];
}

export interface RuntimeDiagnostic { code: string; message: string; count: number; lastSeen: string }
/** Retain only known error categories, never the raw log (it may contain user text or credentials). */
export function collectRuntimeDiagnostics(chunk: string, reports: RuntimeDiagnostic[]): void {
  const categories: Array<[RegExp, string, string]> = [
    [/EADDRINUSE/i, 'port-in-use', '监听端口已被占用，可在诊断中更换端口'],
    [/ERR_MODULE_NOT_FOUND|Cannot find module/i, 'missing-module', '运行依赖缺失，可重新安装当前版本'],
    [/ENOENT/i, 'missing-path', '服务访问的文件或目录不存在，请检查工作文件夹'],
    [/EACCES|EPERM/i, 'permission', '服务遇到访问权限或文件占用问题'],
    [/plugin[^\r\n]{0,100}(?:failed|error)/i, 'plugin-error', '插件出现错误，请检查插件状态或恢复配置快照'],
  ];
  for (const [pattern, code, message] of categories) if (pattern.test(chunk)) {
    const found = reports.find(r => r.code === code);
    if (found) { found.count++; found.lastSeen = new Date().toISOString(); }
    else reports.push({ code, message, count: 1, lastSeen: new Date().toISOString() });
  }
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number }>;

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

export type CommandExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface DshUpdateProgress {
  message: string;
  downloaded?: number;
  elapsedSeconds?: number;
}

export interface StreamingUpdateOptions {
  whereFn?: (cmd: string) => Promise<string[]>;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
  targetVersion?: string;
  installPrefix?: string;
}

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    // Windows 上 dsh 是 .cmd 脚本,必须 shell:true;
    // 命令整体加引号:shell:true 下仅字符串拼接,路径含空格会被拆断(R21)
    const child = spawn(`"${cmd}"`, args, { ...opts, shell: true, windowsHide: true });
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

/**
 * 执行 Windows 命令 shim(.cmd/.bat)的统一入口。
 * cmd 来自环境变量或 where 的真实路径,参数由本程序固定生成。
 */
const defaultCommandExec: CommandExecFn = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(`"${cmd}"`, args, {
    shell: true,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  });
  return { stdout, stderr };
};

/** 从命令输出中提取可展示的版本号,同时兼容 `0.1.0` 与 `dsh/0.1.0`。 */
export function parseVersionOutput(stdout: string, stderr = ''): string | null {
  const output = `${stdout}\n${stderr}`.trim();
  if (!output) return null;
  const semver = output.match(/\bv?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return semver?.[1] ?? output.split(/\r?\n/, 1)[0].trim();
}

/** 获取本机 dsh 版本;未安装或探测失败时返回 null。 */
export async function getDshVersion(
  env: NodeJS.ProcessEnv,
  whereFn?: (cmd: string) => Promise<string[]>,
  execFn: CommandExecFn = defaultCommandExec,
): Promise<string | null> {
  const cmd = await resolveDshCommand(env, whereFn);
  if (!cmd) return null;
  try {
    const result = await execFn(cmd, ['-V']);
    return parseVersionOutput(result.stdout, result.stderr);
  } catch {
    return null;
  }
}

/** 解析 npm.cmd,用于一键安装/更新 DeepSeek Harness。 */
export async function resolveNpmCommand(
  env: NodeJS.ProcessEnv,
  whereFn: (cmd: string) => Promise<string[]> = defaultWhere,
): Promise<string | null> {
  if (env.NPM_BIN) return env.NPM_BIN;
  const hits = await whereFn('npm');
  const executable = hits.find((h) => /\.(cmd|exe|bat|com)$/i.test(h.trim()));
  return executable ?? hits[0] ?? null;
}

const DSH_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 只允许 latest 或完整语义版本,禁止把任意参数拼进 npm 包规格。 */
export function normalizeDshTargetVersion(value: unknown): string {
  if (value === undefined || value === null || value === '' || value === 'latest') return 'latest';
  if (typeof value !== 'string' || !DSH_VERSION_PATTERN.test(value)) {
    throw new Error('Harness 目标版本格式无效');
  }
  return value;
}

function compareSemverDescending(left: string, right: string): number {
  const parse = (value: string): { core: number[]; pre: string[] } => {
    const withoutBuild = value.split('+', 1)[0];
    const [core, prerelease = ''] = withoutBuild.split('-', 2);
    return { core: core.split('.').map(Number), pre: prerelease ? prerelease.split('.') : [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return b.core[i] - a.core[i];
  }
  if (a.pre.length === 0 && b.pre.length > 0) return -1;
  if (b.pre.length === 0 && a.pre.length > 0) return 1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    if (a.pre[i] === undefined) return 1;
    if (b.pre[i] === undefined) return -1;
    if (a.pre[i] === b.pre[i]) continue;
    const aNumber = /^\d+$/.test(a.pre[i]) ? Number(a.pre[i]) : null;
    const bNumber = /^\d+$/.test(b.pre[i]) ? Number(b.pre[i]) : null;
    if (aNumber !== null && bNumber !== null) return bNumber - aNumber;
    if (aNumber !== null) return 1;
    if (bNumber !== null) return -1;
    return b.pre[i].localeCompare(a.pre[i], 'en');
  }
  return 0;
}

/** 解析 npm versions JSON,过滤异常值、去重并按新到旧排列。 */
export function parsePublishedDshVersions(output: string): string[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(
      (value): value is string => typeof value === 'string' && DSH_VERSION_PATTERN.test(value),
    ))].sort(compareSemverDescending);
  } catch {
    return [];
  }
}

export function isNewerVersion(candidate: string, installed: string): boolean {
  const versions = parsePublishedDshVersions(JSON.stringify([candidate, installed]));
  return versions.length === 2 && versions[0] === candidate;
}

/** 查询 DeepSeek 官方 npm 包的 latest 版本。网络不可用时返回 null。 */
export async function getLatestDshVersion(
  env: NodeJS.ProcessEnv,
  whereFn?: (cmd: string) => Promise<string[]>,
  execFn: CommandExecFn = defaultCommandExec,
): Promise<string | null> {
  const npmCmd = await resolveNpmCommand(env, whereFn);
  if (!npmCmd) return null;
  try {
    const result = await execFn(npmCmd, ['view', '@deepseek-ai/dsh@latest', 'version', '--json']);
    return parseVersionOutput(result.stdout, result.stderr);
  } catch {
    return null;
  }
}

/** 查询官方 npm 包所有已发布版本,用于安装指定版本或回退。 */
export async function getDshVersions(
  env: NodeJS.ProcessEnv,
  whereFn?: (cmd: string) => Promise<string[]>,
  execFn: CommandExecFn = defaultCommandExec,
): Promise<string[]> {
  const npmCmd = await resolveNpmCommand(env, whereFn);
  if (!npmCmd) return [];
  try {
    const result = await execFn(npmCmd, ['view', '@deepseek-ai/dsh', 'versions', '--json']);
    return parsePublishedDshVersions(result.stdout);
  } catch {
    return [];
  }
}

/** 将 npm 流式日志转换成不会泄露路径、适合直接展示的中文进度。 */
export function describeNpmProgressLine(
  line: string,
  downloaded: number,
): { message: string; downloaded: number } | null {
  if (/\bhttp fetch\b/i.test(line)) {
    const next = downloaded + 1;
    return { message: `正在下载官方 Harness 组件…已完成 ${next} 项`, downloaded: next };
  }
  if (/\b(info run|postinstall|preinstall|install script)\b/i.test(line)) {
    return { message: '组件已下载,正在执行本地安装脚本…', downloaded };
  }
  const added = line.match(/\badded\s+(\d+)\s+packages?\b/i);
  if (added) {
    return { message: `依赖安装完成,共处理 ${added[1]} 个包`, downloaded };
  }
  return null;
}

/**
 * 流式执行官方 Harness npm 安装。持续上报心跳和下载数量,支持取消与超时,
 * 避免 execFile 把全部输出缓存到结束后才返回而让界面看起来“卡死”。
 */
export async function updateDshWithProgress(
  env: NodeJS.ProcessEnv,
  onProgress: (progress: DshUpdateProgress) => void,
  options: StreamingUpdateOptions = {},
): Promise<string> {
  const npmCmd = await resolveNpmCommand(env, options.whereFn);
  if (!npmCmd) throw new Error('未找到 npm,请先安装 Node.js');
  const spawnFn = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const targetVersion = normalizeDshTargetVersion(options.targetVersion);
  const packageSpec = `@deepseek-ai/dsh@${targetVersion}`;
  const startedAt = Date.now();
  let downloaded = 0;
  let lastReportAt = 0;
  let lastLines: string[] = [];
  let timedOut = false;
  let cancelled = false;

  onProgress({ message: '正在准备官方 Harness 安装…', downloaded: 0, elapsedSeconds: 0 });
  const child = spawnFn(
    `"${npmCmd}"`,
    ['install', '-g', packageSpec, '--no-audit', '--no-fund', '--loglevel=http'],
    {
      shell: true,
      windowsHide: true,
      env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1', ...(options.installPrefix ? { NPM_CONFIG_PREFIX: options.installPrefix } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    lastLines = [...lastLines.slice(-7), trimmed];
    const described = describeNpmProgressLine(trimmed, downloaded);
    if (!described) return;
    downloaded = described.downloaded;
    const now = Date.now();
    if (now - lastReportAt >= 500) {
      lastReportAt = now;
      onProgress({
        ...described,
        elapsedSeconds: Math.floor((now - startedAt) / 1000),
      });
    }
  };

  function streamLines(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    let remainder = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = `${remainder}${chunk}`.split(/\r?\n/);
      remainder = parts.pop() ?? '';
      for (const line of parts) handleLine(line);
    });
    stream.on('end', () => { if (remainder) handleLine(remainder); });
  }

  streamLines(child.stdout);
  streamLines(child.stderr);

  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const suffix = downloaded > 0 ? `,已完成 ${downloaded} 项` : '';
    onProgress({
      message: `官方 Harness 仍在安装中…已用时 ${elapsedSeconds} 秒${suffix}`,
      downloaded,
      elapsedSeconds,
    });
  }, 5_000);

  const terminateChild = (): void => {
    if (child.pid) void killTree(child.pid);
    else child.kill();
  };
  const onAbort = (): void => {
    cancelled = true;
    onProgress({ message: '正在取消 Harness 安装…', downloaded });
    terminateChild();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    onProgress({ message: '安装超时,正在结束 npm 进程…', downloaded });
    terminateChild();
  }, timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (cancelled) reject(new Error('Harness 安装已取消'));
        else if (timedOut) reject(new Error(`Harness 安装超过 ${Math.round(timeoutMs / 60_000)} 分钟,已自动停止`));
        else if (code === 0) resolve();
        else {
          const detail = lastLines.slice(-4).join(' | ').slice(-600);
          reject(new Error(`npm 安装失败(exit code ${code ?? 'unknown'})${detail ? `:${detail}` : ''}`));
        }
      });
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  onProgress({
    message: '官方 Harness 安装完成,正在读取版本…',
    downloaded,
    elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
  const version = await getDshVersion(options.installPrefix ? { ...env, DSH_BIN: join(options.installPrefix, 'dsh.cmd') } : env, options.whereFn);
  if (!version) throw new Error('安装完成,但未能读取 dsh 版本;请点击“重新检测”');
  return version;
}

/**
 * 通过 DeepSeek 官方 npm 包全局安装最新版 dsh。既支持首次安装,也支持覆盖升级。
 * 返回安装完成后的实际版本,方便界面给出明确结果。
 */
export async function updateDsh(
  env: NodeJS.ProcessEnv,
  whereFn?: (cmd: string) => Promise<string[]>,
  execFn: CommandExecFn = defaultCommandExec,
  targetVersion: string = 'latest',
): Promise<string> {
  const npmCmd = await resolveNpmCommand(env, whereFn);
  if (!npmCmd) throw new Error('未找到 npm,请先安装 Node.js');
  const normalizedVersion = normalizeDshTargetVersion(targetVersion);
  await execFn(npmCmd, ['install', '-g', `@deepseek-ai/dsh@${normalizedVersion}`]);
  const version = await getDshVersion(env, whereFn, execFn);
  if (!version) throw new Error('安装完成,但未能读取 dsh 版本;请重新打开应用检测');
  return version;
}

/**
 * 只接受当前本机 Harness origin 的启动 URL，避免把子进程输出中的任意链接载入桌面视图。
 * 0.1.2+ 会返回 `/?token=...`；旧版无查询参数时统一回退到既有裸地址。
 */
export function parseDshLaunchUrl(output: string, expectedBaseUrl: string = dshUrl()): string | null {
  let expected: URL;
  try {
    expected = new URL(expectedBaseUrl);
  } catch {
    return null;
  }
  const candidates = output.match(/https?:\/\/[^\s\x1b"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    const raw = candidate.replace(/[\])},;.!]+$/, '');
    try {
      const parsed = new URL(raw);
      if (parsed.origin !== expected.origin || parsed.pathname !== '/') continue;
      if (parsed.username || parsed.password || parsed.hash) continue;
      if (!parsed.search) return expectedBaseUrl;
      const keys = [...parsed.searchParams.keys()];
      const token = parsed.searchParams.get('token');
      if (keys.some((key) => key !== 'token') || !token) continue;
      if (token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) continue;
      return parsed.toString();
    } catch {
      // 忽略普通日志中的非 URL 片段，继续寻找受信任的本机启动地址。
    }
  }
  return null;
}

/** 持续读取并丢弃子进程日志，只把受信任的本机启动 URL 交回主进程。 */
function captureDshLaunchUrl(
  proc: ChildProcess,
  fallbackUrl: string,
  timeoutMs: number = config.readyTimeoutMs,
  diagnostics: RuntimeDiagnostic[] = [],
): Promise<string> {
  const streams: Array<NonNullable<ChildProcess['stdout']>> = [];
  if (proc.stdout) streams.push(proc.stdout);
  if (proc.stderr) streams.push(proc.stderr);
  if (streams.length === 0) return Promise.resolve(fallbackUrl);

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(fallbackUrl), timeoutMs);

    const finish = (url: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      buffer = '';
      resolve(url);
    };
    const onData = (chunk: string | Buffer): void => {
      collectRuntimeDiagnostics(chunk.toString(), diagnostics);
      // 即使已解析出 URL 也继续消费日志，避免长时间运行的子进程因管道写满而阻塞。
      if (settled) return;
      buffer = `${buffer}${chunk.toString()}`.slice(-16_384);
      const launchUrl = parseDshLaunchUrl(buffer, fallbackUrl);
      if (launchUrl) finish(launchUrl);
    };
    const onExit = (code: number | null): void => {
      for (const stream of streams) stream.removeListener('data', onData);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`dsh 服务输出启动地址前退出(exit code ${code ?? 'unknown'})`));
    };

    for (const stream of streams) stream.on('data', onData);
    proc.once('exit', onExit);
  });
}

/** 启动 dsh web 服务,返回子进程、兼容地址和实际启动 URL。 */
export async function startDsh(
  env: NodeJS.ProcessEnv,
  spawnFn: SpawnFn = defaultSpawn,
  whereFn?: (cmd: string) => Promise<string[]>,
): Promise<StartedDsh> {
  const cmd = await resolveDshCommand(env, whereFn);
  if (!cmd) {
    throw new Error('未找到 dsh,请先执行 npm install -g @deepseek-ai/dsh');
  }
  const proc = await spawnFn(cmd, config.dshArgs, { shell: true, windowsHide: true, env });
  const url = dshUrl();
  const diagnostics: RuntimeDiagnostic[] = [];
  return { proc, url, launchUrl: captureDshLaunchUrl(proc, url, config.readyTimeoutMs, diagnostics), diagnostics };
}

/** 轮询直到服务就绪(2xx),超时抛错 */
export async function waitForReady(
  url: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number; fetchFn?: FetchLike } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? config.readyTimeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? config.pollIntervalMs;
  const fetchFn = opts.fetchFn ?? defaultFetch;
  let readinessUrl = url;
  let tokenProtected = false;
  try {
    const parsed = new URL(url);
    tokenProtected = Boolean(parsed.searchParams.get('token'));
    // 不消费启动 token，也不依赖 Node fetch 保存 303 响应建立的浏览器 Cookie。
    if (tokenProtected) readinessUrl = parsed.origin;
  } catch {
    // 非 URL 输入沿用原行为并由 fetch 失败/超时给出统一诊断。
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(readinessUrl);
      if (res.ok || (tokenProtected && res.status === 401)) return;
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
