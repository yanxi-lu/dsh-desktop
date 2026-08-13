import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveDshCommand, detectNode, detectDsh, detectAll, startDsh, waitForReady, killTree } from '../src/main/dsh';

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
    await expect(startDsh({}, async () => { throw new Error('never'); }, async () => []))
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
