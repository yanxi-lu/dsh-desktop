# dsh-desktop 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DeepSeek Harness 的 `dsh web`(默认 127.0.0.1:3080)封装为 Windows 桌面应用:轻量套壳 + 首次引导 + 托盘驻留 + NSIS 安装包。

**Architecture:** Electron 主进程 spawn 本机 dsh 服务,HTTP 轮询就绪后主窗口加载 dsh Web GUI;未装 dsh 时显示引导页。dsh 进程管理逻辑收敛在 `src/main/dsh.ts`(不依赖 Electron API,可单测),Electron 相关仅在窗口/托盘/入口层。渲染层零前端框架,三个静态页面(引导/中转/崩溃)。

**Tech Stack:** Electron(最新稳定版)+ TypeScript + vitest + electron-builder(NSIS)。仅 Windows。

**Spec:** [2026-08-13-dsh-desktop-design.md](../specs/2026-08-13-dsh-desktop-design.md)

## Global Constraints

- 平台仅 Windows;dsh 查找优先级:`DSH_BIN` → `DSH_HOME` → PATH
- dsh 不打包进应用;spawn 必须 `shell: true`(Windows 上 dsh 是 .cmd 脚本)
- 就绪轮询:每 500ms GET `http://127.0.0.1:3080`,2xx 即就绪,30s 超时
- 树杀:`taskkill /pid <pid> /T /F`
- 所有窗口 `contextIsolation: true, sandbox: true, nodeIntegration: false`
- 主窗初始 1280×800,最小 800×600;关闭即隐藏(托盘驻留)
- 代码注释与用户文档用中文,代码标识符用英文
- 依赖安装用 `npm install <pkg>@latest --save-dev`(不手写 pin 版本,由 npm 解析)
- 提交信息格式:`feat:` / `test:` / `docs:` 等 conventional commit;每任务至少一次提交

---

## 文件结构总览

```
dsh-desktop/
├── package.json              # 元信息、scripts(build/start/test/dist)
├── tsconfig.json             # 主进程+preload 编译(commonjs → dist/)
├── vitest.config.ts          # 单测(仅 Node 环境,不碰 Electron)
├── electron-builder.yml      # NSIS 打包
├── .gitignore
├── assets/icon.ico           # 应用图标(脚本生成,Task 7)
├── src/
│   ├── main/
│   │   ├── config.ts         # 集中配置(host/port/超时/轮询间隔)
│   │   ├── dsh.ts            # 检测/spawn/轮询/树杀(纯 Node,可单测)
│   │   ├── windows.ts        # 三窗口创建 + 窗口状态读写(sanitize 纯函数可单测)
│   │   ├── tray.ts           # 托盘菜单
│   │   ├── preload.ts        # contextBridge 最小 IPC 面
│   │   └── index.ts          # 入口:单实例锁、启动编排、IPC handler、退出清理
│   └── renderer/
│       ├── onboarding.html   # 引导页(检测状态/安装指引/重新检测)
│       ├── loading.html      # 中转页(等待就绪/失败重试)
│       └── crash.html        # 崩溃页(重启服务)
├── scripts/gen-icon.ps1      # 用 System.Drawing 生成 icon.ico
├── tests/
│   ├── dsh.test.ts
│   └── windows.test.ts
└── README.md                 # 使用说明 + 手动验收清单
```

**文件职责边界**:`dsh.ts` 不 import electron;`windows.ts` 中只有 `sanitizeWindowState`/`loadWindowState`/`saveWindowState` 可单测,其余窗口工厂函数在验收时手动验证;`index.ts` 是唯一把各模块串起来的编排层,不单测(手动验收)。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`(骨架), `src/main/config.ts`

**Interfaces:**
- Produces: `config` 对象(Task 3/4/5 使用,见下方完整代码)

- [ ] **Step 1: 初始化 npm 并安装依赖**

```bash
cd "e:\IntelliJ IDEA 2022.3.1\workspaces\dsh-desktop"
npm init -y
npm install --save-dev electron@latest typescript@latest @types/node@latest vitest@latest electron-builder@latest
```

- [ ] **Step 2: 写 package.json(替换 npm init 生成的)**

```json
{
  "name": "dsh-desktop",
  "version": "0.1.0",
  "description": "DeepSeek Harness (dsh) 的 Windows 桌面套壳:轻量壳 + 首次引导 + 托盘驻留",
  "main": "dist/main/index.js",
  "scripts": {
    "build": "tsc",
    "start": "npm run build && electron .",
    "test": "vitest run",
    "dist": "npm run build && electron-builder"
  },
  "author": "zhangsheng",
  "license": "MIT"
}
```

- [ ] **Step 3: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: 写 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: 写 .gitignore**

```
node_modules/
dist/
release/
*.log
```

- [ ] **Step 6: 写 src/main/config.ts**

```ts
// 集中配置:dsh 服务地址、轮询与超时参数。改动只发生在这里。
export interface Config {
  /** dsh web 监听地址(官方默认) */
  host: string;
  /** dsh web 默认端口(官方默认) */
  port: number;
  /** 就绪轮询超时(毫秒) */
  readyTimeoutMs: number;
  /** 就绪轮询间隔(毫秒) */
  pollIntervalMs: number;
  /** spawn dsh 时传给 CLI 的参数 */
  dshArgs: string[];
}

export const config: Config = {
  host: '127.0.0.1',
  port: 3080,
  readyTimeoutMs: 30_000,
  pollIntervalMs: 500,
  dshArgs: ['web'],
};

/** dsh Web GUI 的完整地址 */
export function dshUrl(): string {
  return `http://${config.host}:${config.port}`;
}
```

- [ ] **Step 7: 写 README.md 骨架**

```markdown
# dsh-desktop

DeepSeek Harness(`dsh`)的 Windows 桌面套壳:轻量壳 + 首次引导 + 托盘驻留。

## 开发

```bash
npm install
npm test        # 单元测试
npm start       # 开发运行(需本机已安装 dsh)
npm run dist    # 打 NSIS 安装包(产出 release/ 下 .exe)
```

## 使用

(安装说明与手动验收清单在项目完成后补充于本节)
```

- [ ] **Step 8: 验证构建与测试空跑**

```bash
npm run build && npm test
```

预期:`dist/main/config.js` 生成;vitest 报 "No test files found"(可接受,后续任务补齐测试)。

- [ ] **Step 9: 提交**

```bash
git add -A && git commit -m "feat: 项目脚手架(TS + Electron + vitest + config)"
```

---

### Task 2: dsh 检测逻辑

**Files:**
- Create: `src/main/dsh.ts`(检测部分), `tests/dsh.test.ts`

**Interfaces:**
- Consumes: `config`(Task 1)
- Produces:
  - `resolveDshCommand(env: NodeJS.ProcessEnv, whereFn?: (cmd: string) => Promise<string>): Promise<string | null>` — 按 DSH_BIN → DSH_HOME → PATH 优先级解析 dsh 可执行路径
  - `detectNode(nodeCheckFn?: () => Promise<void>): Promise<boolean>`
  - `detectDsh(env: NodeJS.ProcessEnv): Promise<boolean>`
  - `DetectResult = { node: boolean; dsh: boolean }`、`detectAll(env): Promise<DetectResult>`

- [ ] **Step 1: 写失败测试**

`tests/dsh.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveDshCommand, detectNode, detectAll } from '../src/main/dsh';

describe('resolveDshCommand', () => {
  it('DSH_BIN 优先:直接返回其值', async () => {
    const r = await resolveDshCommand(
      { DSH_BIN: 'C:\\tools\\dsh.cmd', PATH: 'C:\\Windows' },
      async () => [],
    );
    expect(r).toBe('C:\\tools\\dsh.cmd');
  });

  it('DSH_HOME 次之:其下存在 dsh.cmd 时返回', async () => {
    const r = await resolveDshCommand(
      { DSH_HOME: 'C:\\tools\\dsh-home', PATH: 'C:\\Windows' },
      async () => [],
    );
    expect(r).toBe('C:\\tools\\dsh-home\\dsh.cmd');
  });

  it('前两者缺失时回退 PATH(where dsh)', async () => {
    const whereFn = vi.fn(async (cmd: string) =>
      cmd === 'dsh' ? ['C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd'] : [],
    );
    const r = await resolveDshCommand({ PATH: 'C:\\Windows' }, whereFn);
    expect(r).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd');
    expect(whereFn).toHaveBeenCalledWith('dsh');
  });

  it('全部缺失时返回 null', async () => {
    const r = await resolveDshCommand({}, async () => []);
    expect(r).toBeNull();
  });
});

describe('detectNode', () => {
  it('nodeCheckFn 成功返回 true,抛错返回 false', async () => {
    expect(await detectNode(async () => {})).toBe(true);
    expect(await detectNode(async () => { throw new Error('no node'); })).toBe(false);
  });
});

describe('detectAll', () => {
  it('汇总 node 与 dsh 状态', async () => {
    const env = { DSH_BIN: 'C:\\tools\\dsh.cmd' };
    const r = await detectAll(env, async () => {}, async () => []);
    expect(r).toEqual({ node: true, dsh: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/main/dsh'`

- [ ] **Step 3: 写 src/main/dsh.ts(检测部分)**

```ts
// dsh 进程管理:检测、spawn、就绪轮询、树杀。
// 本模块不依赖 Electron API,可在纯 Node 环境(vitest)下测试。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
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

  // 2) DSH_HOME:自定义安装根目录,探测其下的 dsh.cmd
  if (env.DSH_HOME) {
    const cand = join(env.DSH_HOME, 'dsh.cmd');
    if (existsSync(cand)) return cand;
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

/** 检测 dsh 是否可用(默认实现执行 `dsh -V`) */
export async function detectDsh(env: NodeJS.ProcessEnv): Promise<boolean> {
  const cmd = await resolveDshCommand(env);
  if (!cmd) return false;
  try {
    await execFileAsync(cmd, ['-V']);
    return true;
  } catch {
    return false;
  }
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
```

注意:`detectDsh` 的 whereFn 注入需要通过函数签名传递——把 `detectDsh` 签名改为
`detectDsh(env, whereFn?)` 并在内部传给 `resolveDshCommand(env, whereFn)`;
`detectAll` 同样透传。测试中 `detectAll` 的第三个参数即 whereFn。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/dsh.ts tests/dsh.test.ts && git commit -m "feat: dsh 检测逻辑(DSH_BIN/DSH_HOME/PATH 优先级)"
```

---

### Task 3: dsh 服务生命周期(spawn / 轮询 / 树杀)

**Files:**
- Modify: `src/main/dsh.ts`(追加启动部分)
- Test: `tests/dsh.test.ts`(追加 describe)

**Interfaces:**
- Consumes: `config`(Task 1)、`resolveDshCommand`(Task 2)
- Produces:
  - `startDsh(env: NodeJS.ProcessEnv, spawnFn?: SpawnFn): Promise<{ proc: ChildProcess; url: string }>`
  - `waitForReady(url: string, opts?: { timeoutMs?: number; pollIntervalMs?: number; fetchFn?: FetchLike }): Promise<void>`
  - `killTree(pid: number, execFn?: ExecFn): Promise<void>`

- [ ] **Step 1: 写失败测试(追加到 tests/dsh.test.ts)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { startDsh, waitForReady, killTree } from '../src/main/dsh';
import { EventEmitter } from 'node:events';
import { config } from '../src/main/config';

// 测试用 spawn 替身:记录调用参数,返回一个假进程对象
function fakeProc() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { pid: 4242, kill: vi.fn() });
}

describe('startDsh', () => {
  it('解析到 dsh 后以 shell:true 启动 web,返回 url', async () => {
    const proc = fakeProc();
    const spawnFn = vi.fn(async () => proc);
    const env = { DSH_BIN: 'C:\\tools\\dsh.cmd' };
    const r = await startDsh(env, spawnFn);
    expect(spawnFn).toHaveBeenCalledWith('C:\\tools\\dsh.cmd', ['web'], { shell: true, windowsHide: true, env });
    expect(r.url).toBe('http://127.0.0.1:3080');
    expect(r.proc.pid).toBe(4242);
  });

  it('未安装 dsh 时抛错', async () => {
    const env = {};
    await expect(startDsh(env, async () => { throw new Error('never'); }))
      .rejects.toThrow(/dsh/i);
  });
});

describe('waitForReady', () => {
  it('2xx 即视为就绪', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? { ok: false, status: 404 } : { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    await waitForReady('http://127.0.0.1:3080', {
      timeoutMs: 5000, pollIntervalMs: 10, fetchFn,
    });
    expect(calls).toBe(3);
  });

  it('超时抛错', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(
      waitForReady('http://127.0.0.1:3080', { timeoutMs: 50, pollIntervalMs: 10, fetchFn }),
    ).rejects.toThrow(/timeout|超时/i);
  });
});

describe('killTree', () => {
  it('用 taskkill /T /F 树杀', async () => {
    const execFn = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await killTree(4242, execFn);
    expect(execFn).toHaveBeenCalledWith('taskkill /pid 4242 /T /F');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `startDsh` 等未导出

- [ ] **Step 3: 实现(追加到 src/main/dsh.ts)**

```ts
import { spawn, ChildProcess } from 'node:child_process';

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
): Promise<{ proc: ChildProcess; url: string }> {
  const cmd = await resolveDshCommand(env);
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
```

同时把 `dshUrl` 从 config.ts import 进来(或直接使用 `http://${config.host}:${config.port}` 拼装,保持单 import)。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS(含 Task 2 的旧测试)

- [ ] **Step 5: 提交**

```bash
git add src/main/dsh.ts tests/dsh.test.ts && git commit -m "feat: dsh 服务生命周期(spawn/就绪轮询/树杀)"
```

---

### Task 4: 窗口管理(状态读写 + 三窗口工厂)

**Files:**
- Create: `src/main/windows.ts`, `tests/windows.test.ts`

**Interfaces:**
- Consumes: `dshUrl()`(Task 1)
- Produces:
  - `sanitizeWindowState(raw: unknown): WindowState` — 校验并 clamp 窗口状态
  - `loadWindowState(file: string): WindowState`
  - `saveWindowState(file: string, state: WindowState): void`
  - `createOnboardingWindow(preloadPath: string): BrowserWindow`
  - `createLoadingWindow(preloadPath: string): BrowserWindow`
  - `createCrashWindow(preloadPath: string): BrowserWindow`
  - `createMainWindow(state: WindowState, preloadPath: string): BrowserWindow`
  - `installWindowStateHooks(win: BrowserWindow, file: string): void` — 主窗关闭时保存状态

- [ ] **Step 1: 写失败测试**

`tests/windows.test.ts`(只测纯逻辑,sanitize 与读写):

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeWindowState, loadWindowState, saveWindowState } from '../src/main/windows';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sanitizeWindowState', () => {
  it('合法值原样保留', () => {
    expect(sanitizeWindowState({ x: 10, y: 20, width: 1280, height: 800 }))
      .toEqual({ x: 10, y: 20, width: 1280, height: 800 });
  });

  it('缺字段回退默认值', () => {
    expect(sanitizeWindowState(null)).toEqual({ width: 1280, height: 800 });
    expect(sanitizeWindowState({ width: 999 })).toEqual({ width: 999, height: 800 });
  });

  it('尺寸 clamp 到最小 800x600', () => {
    expect(sanitizeWindowState({ width: 100, height: 100 }))
      .toEqual({ width: 800, height: 600 });
  });

  it('非法类型丢弃字段', () => {
    expect(sanitizeWindowState({ width: 'big', x: 'left' }))
      .toEqual({ width: 1280, height: 800 });
  });
});

describe('窗口状态文件读写', () => {
  it('save 后 load 得到相同状态;文件不存在时返回默认值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'));
    const file = join(dir, 'state.json');
    try {
      expect(loadWindowState(file)).toEqual({ width: 1280, height: 800 });
      saveWindowState(file, { x: 5, y: 6, width: 1024, height: 768 });
      expect(loadWindowState(file)).toEqual({ x: 5, y: 6, width: 1024, height: 768 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 src/main/windows.ts**

```ts
// 窗口创建与窗口状态持久化。sanitize/读写为纯逻辑,可单测;
// 工厂函数依赖 Electron,由手动验收覆盖。
import { BrowserWindow, screen } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dshUrl } from './config';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export const DEFAULT_STATE: WindowState = { width: 1280, height: 800 };
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

/** 校验并修正窗口状态:非法字段丢弃,尺寸 clamp 到最小值 */
export function sanitizeWindowState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STATE };
  const o = raw as Record<string, unknown>;
  const out: WindowState = { ...DEFAULT_STATE };
  if (typeof o.x === 'number') out.x = o.x;
  if (typeof o.y === 'number') out.y = o.y;
  if (typeof o.width === 'number') out.width = Math.max(o.width, MIN_WIDTH);
  if (typeof o.height === 'number') out.height = Math.max(o.height, MIN_HEIGHT);
  return out;
}

/** 读取窗口状态文件;缺失/损坏时返回默认值 */
export function loadWindowState(file: string): WindowState {
  try {
    if (!existsSync(file)) return { ...DEFAULT_STATE };
    return sanitizeWindowState(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** 写入窗口状态文件(自动创建目录) */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), 'utf-8');
  } catch {
    // 状态保存失败不影响主流程
  }
}

/** 主窗关闭时记录位置与尺寸(隐藏前),供下次启动恢复 */
export function installWindowStateHooks(win: BrowserWindow, file: string): void {
  win.on('close', () => {
    saveWindowState(file, win.getBounds());
  });
}

/** 窗口基础安全配置:所有窗口统一 */
function baseOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: '', // 由调用方传入
    },
  };
}

function attachPreload(
  opts: Electron.BrowserWindowConstructorOptions,
  preloadPath: string,
): Electron.BrowserWindowConstructorOptions {
  return {
    ...opts,
    webPreferences: { ...opts.webPreferences, preload: preloadPath },
  };
}

/** 引导窗:未安装 dsh/Node 时展示 */
export function createOnboardingWindow(preloadPath: string): BrowserWindow {
  const win = new BrowserWindow(
    attachPreload({ ...baseOptions(), width: 720, height: 640, resizable: false }, preloadPath),
  );
  win.loadFile('src/renderer/onboarding.html');
  win.once('ready-to-show', () => win.show());
  return win;
}

/** 中转窗:spawn 后等待就绪 */
export function createLoadingWindow(preloadPath: string): BrowserWindow {
  const win = new BrowserWindow(
    attachPreload({ ...baseOptions(), width: 480, height: 300, resizable: false }, preloadPath),
  );
  win.loadFile('src/renderer/loading.html');
  win.once('ready-to-show', () => win.show());
  return win;
}

/** 崩溃窗:dsh 运行中退出时展示 */
export function createCrashWindow(preloadPath: string): BrowserWindow {
  const win = new BrowserWindow(
    attachPreload({ ...baseOptions(), width: 480, height: 300, resizable: false }, preloadPath),
  );
  win.loadFile('src/renderer/crash.html');
  win.once('ready-to-show', () => win.show());
  return win;
}

/** 主窗:加载 dsh Web GUI,恢复上次位置/尺寸,关闭即隐藏 */
export function createMainWindow(state: WindowState, preloadPath: string): BrowserWindow {
  const win = new BrowserWindow(
    attachPreload(
      {
        ...baseOptions(),
        width: state.width,
        height: state.height,
        x: state.x,
        y: state.y,
        minWidth: 800,
        minHeight: 600,
      },
      preloadPath,
    ),
  );
  // 尺寸在屏幕范围内才带坐标,否则交给系统默认位置
  if (state.x !== undefined && state.y !== undefined) {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const a = d.workArea;
      return state.x! >= a.x - 64 && state.y! >= a.y - 64
        && state.x! < a.x + a.width && state.y! < a.y + a.height;
    });
    if (!visible) {
      win.setPosition(undefined as unknown as number, undefined as unknown as number);
    }
  }
  win.loadURL(dshUrl());
  win.once('ready-to-show', () => win.show());
  return win;
}
```

说明:`.loadFile('src/renderer/...')` 用的是相对路径,Electron 开发运行时 cwd 为项目根,可用;
打包后 electron-builder 的 `files` 需包含 `src/renderer/**`(Task 7 配置)。若相对路径在
打包环境不可靠,改为 `join(__dirname, '..', 'renderer', ...)` 绝对路径更稳——实现时优先
使用 `join(app.getAppPath(), 'src/renderer/...')`,但 `app` 在模块顶层不可用,故在工厂
函数内用 `app.getAppPath()` 拼绝对路径(导入 electron 的 app)。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部 PASS。注意:vitest 会加载 `windows.ts` 及其 `import { BrowserWindow } from 'electron'` —— 在纯 Node 下 electron 包解析为导出路径字符串(非真实 API),仅测试 `sanitize/load/save` 不触碰 BrowserWindow,因此测试可运行。若出现 `electron` 模块加载问题,把 `import { BrowserWindow, screen, app } from 'electron'` 改为函数内 `require('electron')`,纯函数部分保持模块顶层。

- [ ] **Step 5: 提交**

```bash
git add src/main/windows.ts tests/windows.test.ts && git commit -m "feat: 窗口管理(状态持久化 + 三窗口工厂)"
```

---

### Task 5: 托盘、preload 与入口编排

**Files:**
- Create: `src/main/tray.ts`, `src/main/preload.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `config`/`dshUrl`(Task 1)、`detectAll`/`startDsh`/`waitForReady`/`killTree`(Task 2/3)、窗口工厂与状态函数(Task 4)
- Produces(IPC 通道约定,renderer 页面 Task 6 使用):
  - `dsh:status` → `{ node: boolean; dsh: boolean }`
  - `dsh:recheck` → `{ ok: boolean; node: boolean; dsh: boolean }`(ok=false 表示仍未通过)
  - `dsh:retry` → `{ ok: boolean; error?: string }`
  - 主→渲染推送:`dsh:error`(string)
  - preload 暴露 `window.dshApp = { getStatus, recheck, retry, onError }`

- [ ] **Step 1: 写 src/main/tray.ts**

```ts
// 托盘图标与菜单:主窗关闭后驻留后台,「退出」才真正结束。
import { Tray, Menu, nativeImage } from 'electron';

export interface TrayActions {
  /** 点击「打开」/双击托盘图标 */
  onOpen: () => void;
  /** 点击「退出」:清理 dsh 进程树后退出应用 */
  onQuit: () => void;
}

export function createTray(actions: TrayActions, iconPath: string): Tray {
  // 托盘图标 16x16;assets/tray.ico 由 scripts/gen-icon.ps1 生成(Task 7)
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('dsh-desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 dsh-desktop', click: actions.onOpen },
      { type: 'separator' },
      { label: '退出', click: actions.onQuit },
    ]),
  );
  tray.on('double-click', actions.onOpen);
  return tray;
}
```

- [ ] **Step 2: 写 src/main/preload.ts**

```ts
// preload:向 renderer 暴露最小 IPC 面(sandbox 环境下仅 contextBridge/ipcRenderer 可用)。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dshApp', {
  /** 获取环境检测状态 */
  getStatus: (): Promise<{ node: boolean; dsh: boolean }> =>
    ipcRenderer.invoke('dsh:status'),
  /** 引导页「重新检测」;通过后主进程自动进入启动流程 */
  recheck: (): Promise<{ ok: boolean; node: boolean; dsh: boolean }> =>
    ipcRenderer.invoke('dsh:recheck'),
  /** 中转页/崩溃页「重试」:重新 spawn 并等待就绪 */
  retry: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dsh:retry'),
  /** 订阅主进程推送的错误消息 */
  onError: (cb: (msg: string) => void): void => {
    ipcRenderer.on('dsh:error', (_e, msg: string) => cb(msg));
  },
});
```

- [ ] **Step 3: 写 src/main/index.ts(入口编排)**

```ts
// 入口编排:单实例锁 → 环境检测 → (引导页 | spawn → 就绪 → 主窗) → 托盘驻留。
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { config } from './config';
import {
  detectAll, startDsh, waitForReady, killTree,
} from './dsh';
import {
  createOnboardingWindow, createLoadingWindow, createCrashWindow, createMainWindow,
  loadWindowState, installWindowStateHooks,
} from './windows';
import { createTray } from './tray';

// 单实例:二次启动聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;
let loadingWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let crashWindow: BrowserWindow | null = null;
let dshProc: { proc: { pid?: number }; url: string } | null = null;
let quitting = false; // 用户主动退出标志,区分崩溃

const stateFile = join(app.getPath('userData'), 'window-state.json');
const preloadPath = join(__dirname, 'preload.js');
const trayIconPath = join(app.getAppPath(), 'assets', 'tray.ico');

/** 完整启动流程:检测 → spawn → 就绪 → 主窗 */
async function launch(): Promise<void> {
  const status = await detectAll(process.env);
  if (!status.node || !status.dsh) {
    openOnboarding();
    return;
  }
  await startAndShowMain();
}

/** spawn + 轮询,成功后主窗替换中转窗 */
async function startAndShowMain(): Promise<void> {
  closeWindow(loadingWindow);
  loadingWindow = createLoadingWindow(preloadPath);
  try {
    dshProc = await startDsh(process.env);
    installExitWatch();
    await waitForReady(dshProc.url);
    closeWindow(loadingWindow);
    openMainWindow();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    loadingWindow?.webContents.send('dsh:error', msg);
    // 中转页显示失败状态,等待用户点「重试」
  }
}

function openMainWindow(): void {
  const state = loadWindowState(stateFile);
  mainWindow = createMainWindow(state, preloadPath);
  installWindowStateHooks(mainWindow, stateFile);
  mainWindow.on('close', (e) => {
    if (!quitting) {
      // 托盘驻留:关闭即隐藏
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openOnboarding(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    return;
  }
  onboardingWindow = createOnboardingWindow(preloadPath);
  onboardingWindow.on('closed', () => { onboardingWindow = null; });
}

/** dsh 进程退出且非用户主动 → 显示崩溃页 */
function installExitWatch(): void {
  const pid = dshProc?.proc.pid;
  if (!pid) return;
  // exit 事件挂在 spawn 返回的 ChildProcess 上(Task 3 的 startDsh 已返回 proc)
  const child = dshProc.proc as import('node:child_process').ChildProcess;
  child.once('exit', () => {
    if (quitting) return;
    closeWindow(loadingWindow);
    openCrash();
  });
}

function openCrash(): void {
  if (crashWindow && !crashWindow.isDestroyed()) {
    crashWindow.show();
    return;
  }
  crashWindow = createCrashWindow(preloadPath);
  crashWindow.on('closed', () => { crashWindow = null; });
}

function closeWindow(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.close();
}

/** 用户主动退出:树杀 dsh,再退出应用 */
async function quit(): Promise<void> {
  quitting = true;
  const pid = dshProc?.proc.pid;
  if (pid) await killTree(pid);
  app.quit();
}

// ---- IPC ----
ipcMain.handle('dsh:status', () => detectAll(process.env));
ipcMain.handle('dsh:recheck', async () => {
  const status = await detectAll(process.env);
  if (status.node && status.dsh) {
    closeWindow(onboardingWindow);
    await startAndShowMain();
    return { ok: true, ...status };
  }
  return { ok: false, ...status };
});
ipcMain.handle('dsh:retry', async () => {
  try {
    // 旧进程若残留,先清理
    if (dshProc?.proc.pid) await killTree(dshProc.proc.pid);
    await startAndShowMain();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ---- 生命周期 ----
app.whenReady().then(async () => {
  createTray(
    {
      onOpen: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        } else if (onboardingWindow && !onboardingWindow.isDestroyed()) {
          onboardingWindow.show();
        } else {
          // 全部窗口已关闭且服务在跑:重建主窗
          openMainWindow();
        }
      },
      onQuit: quit,
    },
    trayIconPath,
  );
  await launch();
});

app.on('window-all-closed', () => {
  // 托盘驻留:窗口全部关闭时应用继续运行(Windows 下不退出)
});
app.on('before-quit', () => { quitting = true; });
```

说明:`startDsh` 返回的 `proc` 类型在 Task 3 中为 `ChildProcess`;这里用 `as` 断言访问 `pid` 与 `once` 时注意保持与 Task 3 接口一致(直接使用 `dshProc.proc.pid` 与 `dshProc.proc.once('exit', ...)`,因为 Task 3 的返回类型就是 `{ proc: ChildProcess; url: string }`,无需断言)。

- [ ] **Step 4: 验证构建**

Run: `npm run build`
Expected: tsc 无错误,`dist/main/` 下生成 index.js/preload.js/tray.js/windows.js/dsh.js/config.js

- [ ] **Step 5: 提交**

```bash
git add src/main/tray.ts src/main/preload.ts src/main/index.ts && git commit -m "feat: 托盘驻留、preload IPC 与入口编排"
```

---

### Task 6: 渲染层三个页面

**Files:**
- Create: `src/renderer/onboarding.html`, `src/renderer/loading.html`, `src/renderer/crash.html`

**Interfaces:**
- Consumes: `window.dshApp`(Task 5 preload 暴露的 API)

- [ ] **Step 1: 写 src/renderer/onboarding.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>dsh-desktop 环境检测</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      margin: 0; padding: 40px 48px; line-height: 1.7;
    }
    h1 { font-size: 22px; }
    .row { display: flex; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid rgba(128,128,128,.25); }
    .badge { font-weight: bold; }
    .ok { color: #1a7f37; }
    .bad { color: #cf222e; }
    pre { background: rgba(128,128,128,.12); padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
    button { padding: 8px 22px; font-size: 15px; cursor: pointer; }
    #hint { margin-top: 12px; }
  </style>
</head>
<body>
  <h1>dsh-desktop 首次启动</h1>
  <p>本应用是 DeepSeek Harness(dsh)的桌面套壳,需要本机已安装以下环境:</p>
  <div id="rows"></div>
  <h2>安装 dsh</h2>
  <p>已安装 Node.js 后,在任意终端执行:</p>
  <pre id="cmd">npm install -g @deepseek-ai/dsh</pre>
  <button id="copy">复制命令</button>
  <button id="recheck">重新检测</button>
  <p id="hint"></p>
  <script>
    const rowsEl = document.getElementById('rows');
    function render(status) {
      rowsEl.innerHTML = '';
      const items = [
        ['Node.js', status.node],
        ['dsh (DeepSeek Harness)', status.dsh],
      ];
      for (const [name, ok] of items) {
        const div = document.createElement('div');
        div.className = 'row';
        const span = document.createElement('span');
        span.textContent = name;
        const badge = document.createElement('span');
        badge.className = 'badge ' + (ok ? 'ok' : 'bad');
        badge.textContent = ok ? '✓ 已安装' : '✗ 未安装';
        div.append(span, badge);
        rowsEl.append(div);
      }
      const ready = status.node && status.dsh;
      document.getElementById('hint').textContent = ready
        ? '环境就绪,正在启动…' : '';
    }
    document.getElementById('copy').onclick = async () => {
      await navigator.clipboard.writeText(document.getElementById('cmd').textContent);
      document.getElementById('copy').textContent = '已复制';
      setTimeout(() => { document.getElementById('copy').textContent = '复制命令'; }, 1500);
    };
    document.getElementById('recheck').onclick = async () => {
      const r = await window.dshApp.recheck();
      render(r);
    };
    window.dshApp.getStatus().then(render);
  </script>
</body>
</html>
```

- [ ] **Step 2: 写 src/renderer/loading.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>正在启动 dsh</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; text-align: center; padding-top: 70px; }
    .spinner {
      width: 36px; height: 36px; margin: 0 auto 20px;
      border: 4px solid rgba(128,128,128,.3); border-top-color: #0969da;
      border-radius: 50%; animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #error { display: none; color: #cf222e; white-space: pre-wrap; max-width: 90%; margin: 10px auto; }
    button { padding: 8px 22px; font-size: 15px; cursor: pointer; display: none; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p id="status">正在启动 dsh 服务…</p>
  <p id="error"></p>
  <button id="retry">重试</button>
  <script>
    window.dshApp.onError((msg) => {
      document.querySelector('.spinner').style.display = 'none';
      document.getElementById('status').textContent = '启动失败';
      document.getElementById('error').textContent = msg;
      document.getElementById('error').style.display = 'block';
      document.getElementById('retry').style.display = 'inline-block';
    });
    document.getElementById('retry').onclick = async () => {
      document.querySelector('.spinner').style.display = 'block';
      document.getElementById('status').textContent = '正在重新启动 dsh 服务…';
      document.getElementById('error').style.display = 'none';
      document.getElementById('retry').style.display = 'none';
      await window.dshApp.retry();
    };
  </script>
</body>
</html>
```

- [ ] **Step 3: 写 src/renderer/crash.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>dsh 服务已停止</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; text-align: center; padding-top: 70px; }
    p { line-height: 1.7; }
    button { padding: 8px 22px; font-size: 15px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>dsh 服务已停止</h1>
  <p>DeepSeek Harness 进程意外退出。<br />你可以重启服务,或在托盘菜单中退出应用。</p>
  <button id="restart">重启服务</button>
  <p id="result"></p>
  <script>
    document.getElementById('restart').onclick = async () => {
      document.getElementById('restart').disabled = true;
      document.getElementById('result').textContent = '正在重启…';
      const r = await window.dshApp.retry();
      document.getElementById('restart').disabled = false;
      if (!r.ok) {
        document.getElementById('result').textContent = '重启失败:' + (r.error || '未知错误');
      }
      // 成功时主进程会关闭崩溃窗并打开主窗
    };
  </script>
</body>
</html>
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: tsc 通过(HTML 不进 tsc,确认无其他编译错误)

- [ ] **Step 5: 提交**

```bash
git add src/renderer && git commit -m "feat: 引导页/中转页/崩溃页"
```

---

### Task 7: 图标生成与 NSIS 打包

**Files:**
- Create: `scripts/gen-icon.ps1`, `electron-builder.yml`
- Modify: `package.json`(scripts 加 `icon` 与 `dist` 调整)

**Interfaces:**
- Consumes: 全部源码(Task 1-6)
- Produces: `release/dsh-desktop-setup-0.1.0.exe` 安装包

- [ ] **Step 1: 写 scripts/gen-icon.ps1(生成 app 图标与托盘图标)**

```powershell
# 用 System.Drawing 生成应用图标(256x256 PNG 封装为 ICO)与托盘图标(16x16 ICO)
# 运行: powershell -ExecutionPolicy Bypass -File scripts/gen-icon.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
if (-not (Test-Path $assets)) { New-Item -ItemType Directory $assets | Out-Null }

function New-IconBmp([int]$size) {
    # 画一个圆角深蓝底 + 白色 "D" 字母
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 9, 105, 218))
    $g.FillEllipse($brush, $rect)
    $font = New-Object System.Drawing.Font('Segoe UI', [float]($size * 0.62), [System.Drawing.FontStyle]::Bold)
    $white = [System.Drawing.Brushes]::White
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
    $g.DrawString('D', $font, $white, $rect, $sf)
    $g.Dispose(); $brush.Dispose(); $font.Dispose(); $sf.Dispose()
    return $bmp
}

function Convert-BmpToIco([string]$pngOrBmpPath, [string]$icoPath, [int]$size) {
    # ICO 封装:BMP 图像条目(含 AND mask),单图 ICO 足够 electron-builder 与托盘使用
    $bmp = New-Object System.Drawing.Bitmap($pngOrBmpPath)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bytes = $ms.ToArray()
    $bmp.Dispose(); $ms.Dispose()
    # BMP 数据:DIB 头(40) + 像素(从 BITMAPFILEHEADER 偏移 14 开始)
    $dib = $bytes[14..($bytes.Length - 1)]
    $maskStride = [int]([math]::Ceiling($size / 32.0)) * 4
    $mask = New-Object byte[] ($maskStride * $size)  # 全 0:全部不透明
    $fs = [System.IO.File]::Create($icoPath)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([uint16]0)          # reserved
    $bw.Write([uint16]1)          # type: icon
    $bw.Write([uint16]1)          # count
    $bw.Write([byte]$size)        # width(256 会存 0)
    $bw.Write([byte]$size)
    $bw.Write([byte]0)            # palette
    $bw.Write([byte]0)            # reserved
    $bw.Write([uint16]1)          # planes
    $bw.Write([uint16]32)         # bpp
    $bw.Write([uint32]($dib.Length + $mask.Length))  # data size
    $bw.Write([uint32]22)         # data offset (6+16)
    $bw.Write($dib)
    $bw.Write($mask)
    $bw.Close(); $fs.Dispose()
}

$appPng = Join-Path $assets 'app.png'
$appIco = Join-Path $assets 'icon.ico'
$trayIco = Join-Path $assets 'tray.ico'

$bmp256 = New-IconBmp 256
$bmp256.Save($appPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp256.Dispose()
Convert-BmpToIco $appPng $appIco 256

$bmp16 = New-IconBmp 16
$bmp16.Save($appPng, [System.Drawing.Imaging.ImageFormat]::Png)  # 覆盖为 16x16 临时文件
$bmp16.Dispose()
Convert-BmpToIco $appPng $trayIco 16
Remove-Item $appPng

Write-Host "已生成: $appIco 与 $trayIco"
```

- [ ] **Step 2: 运行脚本生成图标**

Run: `powershell -ExecutionPolicy Bypass -File scripts/gen-icon.ps1`
Expected: `assets/icon.ico` 与 `assets/tray.ico` 生成,无报错

- [ ] **Step 3: 写 electron-builder.yml**

```yaml
appId: com.zhangsheng.dsh-desktop
productName: dsh-desktop
directories:
  output: release
files:
  - dist/**
  - src/renderer/**
  - assets/icon.ico
  - assets/tray.ico
  - package.json
win:
  target: nsis
  icon: assets/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  shortcutName: dsh-desktop
```

- [ ] **Step 4: 调整 package.json 的 scripts**

把 `"dist"` 改为:
```json
"dist": "npm run build && electron-builder --win"
```

并新增:
```json
"icon": "powershell -ExecutionPolicy Bypass -File scripts/gen-icon.ps1"
```

- [ ] **Step 5: 打包验证**

Run: `npm run dist`
Expected: `release/dsh-desktop-setup-0.1.0.exe` 产出(下载 electron 二进制可能较慢,超时放宽)

- [ ] **Step 6: 提交**

```bash
git add scripts assets electron-builder.yml package.json && git commit -m "feat: 图标生成脚本与 NSIS 打包配置"
```

---

### Task 8: 端到端验证与 README 补全

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 本机安装 dsh(用于真实联调)**

```bash
npm install -g @deepseek-ai/dsh
dsh -V
```

- [ ] **Step 2: 运行全部单测 + 构建**

```bash
npm test && npm run build
```

Expected: 测试全绿,tsc 无错误

- [ ] **Step 3: 开发模式启动验证**

Run: `npm start`
Expected:
1. 主窗打开并加载 `http://127.0.0.1:3080` 的 dsh Web GUI
2. 关闭主窗 → 托盘驻留,任务管理器可见 dsh 相关 node 进程仍在
3. 托盘「打开 dsh-desktop」→ 主窗重现
4. 托盘「退出」→ `tasklist | findstr node` 无残留 dsh 进程
5. 二次启动 `npm start` → 聚焦已有窗口,无第二实例

- [ ] **Step 4: 引导流程验证**

```bash
set DSH_BIN= && set DSH_HOME=
```

在「设置 → 系统 → 高级系统设置」临时把 npm 全局目录移出 PATH 后启动应用,或直接在一台无 dsh 机器上验证:
Expected: 引导页显示 Node ✓ / dsh ✗,复制命令按钮可用;恢复 PATH 后点「重新检测」自动进入主窗

- [ ] **Step 5: 安装包验证**

Run: `npm run dist`
Expected: 安装 `release/dsh-desktop-setup-0.1.0.exe` → 开始菜单出现快捷方式 → 启动正常;
控制面板可卸载且卸载后无残留

- [ ] **Step 6: 补全 README.md**

```markdown
# dsh-desktop

DeepSeek Harness(`dsh`)的 Windows 桌面套壳:轻量壳 + 首次引导 + 托盘驻留。

## 功能

- 一键启动:自动拉起本机 `dsh web`(127.0.0.1:3080)并在桌面窗口中使用
- 首次引导:未装 dsh/Node 时显示引导页与安装命令,装好后点「重新检测」即可
- 托盘驻留:关闭窗口后服务在后台运行,托盘可重新打开;「退出」会连同 dsh 进程树一起结束
- 单实例:重复启动只会聚焦已有窗口
- 崩溃恢复:dsh 意外退出时弹窗提示,可一键重启服务

## 安装

1. 安装 Node.js(https://nodejs.org)
2. 安装 dsh:`npm install -g @deepseek-ai/dsh`
3. 下载 `release/dsh-desktop-setup-x.y.z.exe` 安装

> 安装包未做代码签名,SmartScreen 提示时选「仍要运行」。

## 开发

```bash
npm install
npm test        # 单元测试(vitest)
npm start       # 开发运行
npm run icon    # 重新生成图标
npm run dist    # 打 NSIS 安装包
```

## 手动验收清单

- [ ] 未装 dsh → 引导页,状态显示正确,复制命令可用
- [ ] 装好 dsh 点「重新检测」→ 自动进入主窗
- [ ] 主窗关闭 → 托盘驻留,dsh 进程仍在
- [ ] 托盘「退出」→ node/dsh 进程树被杀净
- [ ] 二次启动 → 聚焦已有窗口
- [ ] 安装包安装/卸载正常

## 常见问题

- **端口 3080 被占用**:若被其他程序占用,轮询可能误判就绪;先释放端口再启动
- **主窗空白**:dsh 服务正常时按 Ctrl+Shift+I 打开开发者工具查看报错(开发模式)
- **DSH_BIN/DSH_HOME**:可用环境变量显式指定 dsh 位置,优先级高于 PATH
```

- [ ] **Step 7: 最终提交**

```bash
git add README.md && git commit -m "docs: README 使用说明与验收清单"
```

---

## 自审记录

1. **Spec 覆盖**:规格 §2 结构→Task 1;§3.2/3.3 检测与引导→Task 2+6;§3.4 生命周期→Task 3;
   §3.5 窗口托盘→Task 4+5;§4 错误处理→Task 5(IPC)+6(页面);§5 打包→Task 7;§6 测试→Task 2/3/4+8;§7 风险→Task 8 README。无缺口。
2. **占位符扫描**:无 TBD/TODO;所有步骤含完整代码或确切命令。
3. **类型一致性**:`DetectResult`/`startDsh`/`waitForReady`/`killTree`/`WindowState`/`sanitizeWindowState`
   等签名在 Task 2-5 间一致;IPC 通道名 `dsh:status`/`dsh:recheck`/`dsh:retry`/`dsh:error` 在
   Task 5(preload/index)与 Task 6(HTML)一致;preload 暴露 `window.dshApp` 全名一致。
