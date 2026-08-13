import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../src/main/config';
import { resolveDshCommand, detectNode, detectDsh, detectAll, startDsh, waitForReady, killTree } from '../src/main/dsh';

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
