import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  resolveDshCommand,
  resolveNpmCommand,
  parseVersionOutput,
  getDshVersion,
  getLatestDshVersion,
  getDshVersions,
  parsePublishedDshVersions,
  normalizeDshTargetVersion,
  describeNpmProgressLine,
  updateDsh,
  detectNode,
  detectDsh,
  detectAll,
  parseDshLaunchUrl,
  startDsh,
  waitForReady,
  killTree,
} from '../src/main/dsh';

// R20 真机回归:mock node:child_process,锁定默认探测的 shell 行为与命令引号化。
// execFile 需按回调约定在最后一个参数回调成功,供 promisify 解析。
const cpMocks = vi.hoisted(() => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    return {};
  }),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: cpMocks.execFile,
  spawn: cpMocks.spawn,
}));

describe('resolveDshCommand', () => {
  it('DSH_BIN 优先:直接返回其值', async () => {
    const r = await resolveDshCommand(
      { DSH_BIN: 'C:\\tools\\dsh.cmd', PATH: 'C:\\Windows' },
      async () => [],
    );
    expect(r).toBe('C:\\tools\\dsh.cmd');
  });

  it('DSH_HOME 次之:其下存在 dsh.cmd 时返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    try {
      writeFileSync(join(dir, 'dsh.cmd'), '');
      const r = await resolveDshCommand(
        { DSH_HOME: dir, PATH: 'C:\\Windows' },
        async () => [],
      );
      expect(r).toBe(join(dir, 'dsh.cmd'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DSH_HOME 下无 dsh.cmd 时回退 PATH(where dsh)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-home-empty-'));
    try {
      const whereFn = vi.fn(async (cmd: string) =>
        cmd === 'dsh' ? ['C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd'] : [],
      );
      const r = await resolveDshCommand({ DSH_HOME: dir }, whereFn);
      expect(r).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd');
      expect(whereFn).toHaveBeenCalledWith('dsh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('PATH 命中优先选择可执行扩展名:跳过无扩展名 sh shim 与 .ps1(R19)', async () => {
    const whereFn = vi.fn(async (cmd: string) =>
      cmd === 'dsh'
        ? ['E:\\nodejs\\dsh', 'E:\\nodejs\\dsh.cmd', 'E:\\nodejs\\dsh.ps1']
        : [],
    );
    const r = await resolveDshCommand({ PATH: 'C:\\Windows' }, whereFn);
    expect(r).toBe('E:\\nodejs\\dsh.cmd');
  });

  it('PATH 命中无任何可执行扩展名时退回首个命中(保持旧行为)', async () => {
    const whereFn = vi.fn(async (cmd: string) =>
      cmd === 'dsh' ? ['E:\\nodejs\\dsh'] : [],
    );
    const r = await resolveDshCommand({ PATH: 'C:\\Windows' }, whereFn);
    expect(r).toBe('E:\\nodejs\\dsh');
  });
});

describe('detectNode', () => {
  it('nodeCheckFn 成功返回 true,抛错返回 false', async () => {
    expect(await detectNode(async () => {})).toBe(true);
    expect(await detectNode(async () => { throw new Error('no node'); })).toBe(false);
  });
});

describe('detectDsh', () => {
  it('解析成功且执行探测成功时返回 true', async () => {
    const r = await detectDsh(
      { DSH_BIN: 'C:\\tools\\dsh.cmd' },
      async () => [],
      async () => {},
    );
    expect(r).toBe(true);
  });

  it('执行探测抛错时返回 false(损坏的 dsh 判定为未安装)', async () => {
    const r = await detectDsh(
      { DSH_BIN: 'C:\\tools\\dsh.cmd' },
      async () => [],
      async () => { throw new Error('dsh broken'); },
    );
    expect(r).toBe(false);
  });
});

describe('defaultDshCheck(默认探测,R20)', () => {
  beforeEach(() => cpMocks.execFile.mockClear());

  it('以 shell:true 执行探测(.cmd 无法被 execFile 直接执行,EINVAL)', async () => {
    const r = await detectDsh({ DSH_BIN: 'C:\\tools\\dsh.cmd' });
    expect(r).toBe(true);
    const [cmdArg, argsArg, optsArg] = cpMocks.execFile.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(cmdArg).toBe('"C:\\tools\\dsh.cmd"');
    expect(argsArg).toEqual(['-V']);
    expect(optsArg).toMatchObject({ shell: true });
  });

  it('路径含空格时命令整体带引号,防止被 shell 拼接拆断', async () => {
    await detectDsh({ DSH_BIN: 'C:\\Program Files\\dsh\\dsh.cmd' });
    const [cmdArg, , optsArg] = cpMocks.execFile.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(cmdArg).toBe('"C:\\Program Files\\dsh\\dsh.cmd"');
    expect(optsArg).toMatchObject({ shell: true });
  });
});

describe('detectAll', () => {
  it('汇总 node 与 dsh 状态', async () => {
    const env = { DSH_BIN: 'C:\\tools\\dsh.cmd' };
    const r = await detectAll(env, async () => {}, async () => [], async () => {});
    expect(r).toEqual({ node: true, dsh: true });
  });
});

describe('版本读取与一键更新', () => {
  it('从常见 dsh -V 输出中提取语义版本', () => {
    expect(parseVersionOutput('0.1.0-rc.7\n')).toBe('0.1.0-rc.7');
    expect(parseVersionOutput('dsh/1.2.3 win32-x64')).toBe('1.2.3');
    expect(parseVersionOutput('', 'dsh version unknown')).toBe('dsh version unknown');
    expect(parseVersionOutput('')).toBeNull();
  });

  it('getDshVersion 使用解析到的命令执行 -V', async () => {
    const execFn = vi.fn(async () => ({ stdout: 'dsh/0.1.0-rc.7\n', stderr: '' }));
    const version = await getDshVersion(
      {},
      async () => ['C:\\tools\\dsh.cmd'],
      execFn,
    );
    expect(version).toBe('0.1.0-rc.7');
    expect(execFn).toHaveBeenCalledWith('C:\\tools\\dsh.cmd', ['-V']);
  });

  it('npm 解析优先使用 .cmd,更新后返回实际 dsh 版本', async () => {
    const whereFn = vi.fn(async (cmd: string) => (
      cmd === 'npm'
        ? ['E:\\nodejs\\npm', 'E:\\nodejs\\npm.cmd']
        : ['E:\\nodejs\\dsh.cmd']
    ));
    expect(await resolveNpmCommand({}, whereFn)).toBe('E:\\nodejs\\npm.cmd');

    const execFn = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd.endsWith('dsh.cmd') && args[0] === '-V') {
        return { stdout: '0.1.0-rc.7', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const version = await updateDsh({}, whereFn, execFn);
    expect(version).toBe('0.1.0-rc.7');
    expect(execFn).toHaveBeenCalledWith(
      'E:\\nodejs\\npm.cmd',
      ['install', '-g', '@deepseek-ai/dsh@latest'],
    );
  });

  it('从官方 npm latest dist-tag 查询最新版', async () => {
    const execFn = vi.fn(async () => ({ stdout: '"0.2.0-rc.1"\n', stderr: '' }));
    const latest = await getLatestDshVersion(
      {},
      async () => ['E:\\nodejs\\npm.cmd'],
      execFn,
    );
    expect(latest).toBe('0.2.0-rc.1');
    expect(execFn).toHaveBeenCalledWith(
      'E:\\nodejs\\npm.cmd',
      ['view', '@deepseek-ai/dsh@latest', 'version', '--json'],
    );
  });

  it('解析、过滤并按新到旧展示官方版本列表', async () => {
    const output = JSON.stringify([
      '0.1.0-rc.7', 'bad --flag', '0.1.1-rc.2', '0.1.0-rc.10', '0.1.0-rc.7',
    ]);
    expect(parsePublishedDshVersions(output)).toEqual([
      '0.1.1-rc.2', '0.1.0-rc.10', '0.1.0-rc.7',
    ]);
    const execFn = vi.fn(async () => ({ stdout: output, stderr: '' }));
    expect(await getDshVersions({}, async () => ['E:\\nodejs\\npm.cmd'], execFn))
      .toEqual(['0.1.1-rc.2', '0.1.0-rc.10', '0.1.0-rc.7']);
    expect(execFn).toHaveBeenCalledWith(
      'E:\\nodejs\\npm.cmd',
      ['view', '@deepseek-ai/dsh', 'versions', '--json'],
    );
  });

  it('目标版本只接受 latest 或完整语义版本', () => {
    expect(normalizeDshTargetVersion(undefined)).toBe('latest');
    expect(normalizeDshTargetVersion('0.1.1-rc.2')).toBe('0.1.1-rc.2');
    expect(() => normalizeDshTargetVersion('--registry=https://bad.example')).toThrow(/版本格式/);
  });

  it('找不到 npm 时给出明确错误', async () => {
    await expect(updateDsh({}, async () => [], async () => ({ stdout: '', stderr: '' })))
      .rejects.toThrow(/npm/i);
  });

  it('把 npm 流式日志转换为可见安装进度', () => {
    expect(describeNpmProgressLine('npm http fetch GET 200 https://registry.example/pkg', 9))
      .toEqual({ message: '正在下载官方 Harness 组件…已完成 10 项', downloaded: 10 });
    expect(describeNpmProgressLine('npm info run node-pty@1.0.0 install', 10))
      .toEqual({ message: '组件已下载,正在执行本地安装脚本…', downloaded: 10 });
    expect(describeNpmProgressLine('added 123 packages in 2m', 10))
      .toEqual({ message: '依赖安装完成,共处理 123 个包', downloaded: 10 });
    expect(describeNpmProgressLine('npm warn deprecated old-package', 10)).toBeNull();
  });
});

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
    expect(spawnFn).toHaveBeenCalledWith('C:\\tools\\dsh.cmd', ['web', '--no-open'], { shell: true, windowsHide: true, env });
    expect(r.url).toBe('http://127.0.0.1:3080');
    await expect(r.launchUrl).resolves.toBe('http://127.0.0.1:3080');
    expect(r.proc.pid).toBe(4242);
  });

  it('只接收本机 Harness 输出的一次性 token URL', async () => {
    expect(parseDshLaunchUrl(
      'dsh web: http://127.0.0.1:3080/?token=test-token_123',
    )).toBe('http://127.0.0.1:3080/?token=test-token_123');
    expect(parseDshLaunchUrl(
      'open https://evil.example/?token=stolen',
    )).toBeNull();
    expect(parseDshLaunchUrl(
      'dsh web: http://127.0.0.1:3080/?redirect=https://evil.example',
    )).toBeNull();
  });

  it('从新版 Harness 子进程日志捕获启动 URL', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(fakeProc(), { stdout, stderr });
    const spawnFn = vi.fn(async () => proc);
    const started = await startDsh({ DSH_BIN: 'C:\\tools\\dsh.cmd' }, spawnFn);
    stdout.write('initializing...\n');
    stdout.write('dsh web: http://127.0.0.1:3080/?token=temporary-token\n');
    await expect(started.launchUrl).resolves.toBe(
      'http://127.0.0.1:3080/?token=temporary-token',
    );
    proc.emit('exit', 0);
  });

  it('未安装 dsh 时抛错', async () => {
    await expect(startDsh({}, async () => { throw new Error('never'); }, async () => []))
      .rejects.toThrow(/dsh/i);
  });
});

describe('defaultSpawn(默认 spawn,R21)', () => {
  beforeEach(() => cpMocks.spawn.mockClear());

  it('命令带引号且 shell:true(路径含空格不拆断)', async () => {
    // spawn 替身:返回假进程并异步触发 'spawn',供 defaultSpawn resolve
    cpMocks.spawn.mockImplementationOnce(() => {
      const proc = fakeProc();
      setImmediate(() => proc.emit('spawn'));
      return proc;
    });
    const r = await startDsh({ DSH_BIN: 'C:\\Program Files\\dsh\\dsh.cmd' });
    expect(r.url).toBe('http://127.0.0.1:3080');
    const [cmdArg, argsArg, optsArg] = cpMocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean; windowsHide: boolean },
    ];
    expect(cmdArg).toBe('"C:\\Program Files\\dsh\\dsh.cmd"');
    expect(argsArg).toEqual(['web', '--no-open']);
    expect(optsArg).toMatchObject({ shell: true, windowsHide: true });
  });

  it('命令无空格时同样带引号(行为一致)', async () => {
    cpMocks.spawn.mockImplementationOnce(() => {
      const proc = fakeProc();
      setImmediate(() => proc.emit('spawn'));
      return proc;
    });
    await startDsh({ DSH_BIN: 'E:\\nodejs\\dsh.cmd' });
    const [cmdArg, argsArg, optsArg] = cpMocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean; windowsHide: boolean },
    ];
    expect(cmdArg).toBe('"E:\\nodejs\\dsh.cmd"');
    expect(argsArg).toEqual(['web', '--no-open']);
    expect(optsArg).toMatchObject({ shell: true, windowsHide: true });
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

  it('新版 token URL 用裸 origin 的 401 判断受保护服务已就绪', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await waitForReady('http://127.0.0.1:3080/?token=temporary-token', {
      timeoutMs: 5000,
      pollIntervalMs: 10,
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:3080');
  });
});

describe('killTree', () => {
  it('用 taskkill /T /F 树杀', async () => {
    const execFn = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await killTree(4242, execFn);
    expect(execFn).toHaveBeenCalledWith('taskkill /pid 4242 /T /F');
  });
});
