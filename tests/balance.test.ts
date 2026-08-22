import { describe, expect, it, vi } from 'vitest';
import { DEEPSEEK_BALANCE_URL, getDeepSeekBalance } from '../src/main/balance';

describe('DeepSeek 官方余额查询', () => {
  it('使用 Bearer Key 查询并规范化多币种余额且不回传密钥', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '2.50', granted_balance: '0.50', topped_up_balance: '2.00' },
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await getDeepSeekBalance('sk-test-secret', {}, fetchFn, Date.parse('2026-08-22T12:00:00+08:00'));
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][0]).toBe(DEEPSEEK_BALANCE_URL);
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer sk-test-secret' });
    expect(result).toMatchObject({
      ok: true,
      isAvailable: true,
      keySource: 'input',
      balanceInfos: [
        { currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' },
        { currency: 'USD', totalBalance: '2.50' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('sk-test-secret');
  });

  it('没有输入时使用环境变量，完全没有 Key 时不发请求', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ is_available: false, balance_infos: [] }), { status: 200 }));
    const fromEnvironment = await getDeepSeekBalance(undefined, { DEEPSEEK_API_KEY: 'sk-env' }, fetchFn);
    expect(fromEnvironment).toMatchObject({ ok: true, keySource: 'environment', isAvailable: false });
    const missingFetch = vi.fn<typeof fetch>();
    const missing = await getDeepSeekBalance(undefined, {}, missingFetch);
    expect(missing).toEqual({ ok: false, code: 'missing-key', error: '请输入 DeepSeek API Key 后查询余额' });
    expect(missingFetch).not.toHaveBeenCalled();
  });

  it('将认证失败和异常响应转换为可读错误', async () => {
    const unauthorized = await getDeepSeekBalance('bad-key', {}, async () => new Response('', { status: 401 }));
    expect(unauthorized).toEqual({ ok: false, code: 'invalid-key', error: 'API Key 无效或已失效' });
    const invalid = await getDeepSeekBalance('sk-test', {}, async () => new Response('{"unexpected":true}', { status: 200 }));
    expect(invalid).toEqual({ ok: false, code: 'invalid-response', error: '余额接口返回格式无法识别' });
  });
});
