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
