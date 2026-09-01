import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_BALANCE_URL,
  getDeepSeekBalance,
  resolveExistingDeepSeekApiKey,
} from '../src/main/balance';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-balance-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DeepSeek 官方余额查询', () => {
  it('自动读取 Harness 凭据，查询并规范化多币种余额且不回传密钥', async () => {
    const root = temporaryRoot();
    const dshHome = join(root, '.dsh');
    mkdirSync(dshHome);
    writeFileSync(
      join(dshHome, '.credentials.yaml'),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test-secret\n',
      'utf8',
    );
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '2.50', granted_balance: '0.50', topped_up_balance: '2.00' },
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await getDeepSeekBalance(
      {},
      fetchFn,
      Date.parse('2026-08-22T12:00:00+08:00'),
      { homeDir: root, cwd: root },
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][0]).toBe(DEEPSEEK_BALANCE_URL);
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer sk-test-secret' });
    expect(result).toMatchObject({
      ok: true,
      isAvailable: true,
      keySource: 'credentials-file',
      balanceInfos: [
        { currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' },
        { currency: 'USD', totalBalance: '2.50' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('sk-test-secret');
  });

  it('按照 Harness 优先级读取环境、凭据文件、项目与用户 .env', () => {
    const root = temporaryRoot();
    const dshHome = join(root, '.dsh');
    const project = join(root, 'project');
    mkdirSync(dshHome);
    mkdirSync(project);
    const credentialsPath = join(dshHome, '.credentials.yaml');
    const projectEnvPath = join(project, '.env');
    const userEnvPath = join(dshHome, '.env');
    writeFileSync(credentialsPath, 'DEEPSEEK_API_KEY: "sk-managed"\n', 'utf8');
    writeFileSync(projectEnvPath, 'DEEPSEEK_API_KEY=sk-project\n', 'utf8');
    writeFileSync(userEnvPath, 'export DEEPSEEK_API_KEY="sk-user"\n', 'utf8');

    expect(resolveExistingDeepSeekApiKey(
      { DEEPSEEK_API_KEY: 'sk-environment' },
      { homeDir: root, cwd: project },
    )).toEqual({ apiKey: 'sk-environment', source: 'environment' });
    expect(resolveExistingDeepSeekApiKey({}, { homeDir: root, cwd: project }))
      .toEqual({ apiKey: 'sk-managed', source: 'credentials-file' });

    writeFileSync(credentialsPath, 'version: 1\nrefs: {}\n', 'utf8');
    expect(resolveExistingDeepSeekApiKey({}, { homeDir: root, cwd: project }))
      .toEqual({ apiKey: 'sk-project', source: 'project-env' });

    rmSync(projectEnvPath);
    expect(resolveExistingDeepSeekApiKey({}, { homeDir: root, cwd: project }))
      .toEqual({ apiKey: 'sk-user', source: 'user-env' });
  });

  it('完全没有 Key 时不发请求', async () => {
    const root = temporaryRoot();
    const missingFetch = vi.fn<typeof fetch>();
    const missing = await getDeepSeekBalance(
      {},
      missingFetch,
      Date.now(),
      { homeDir: root, cwd: root },
    );
    expect(missing).toEqual({ ok: false, code: 'missing-key', error: 'Harness 尚未配置 DeepSeek API Key' });
    expect(missingFetch).not.toHaveBeenCalled();
  });

  it('将认证失败和异常响应转换为可读错误', async () => {
    const unauthorized = await getDeepSeekBalance(
      { DEEPSEEK_API_KEY: 'bad-key' },
      async () => new Response('', { status: 401 }),
    );
    expect(unauthorized).toEqual({ ok: false, code: 'invalid-key', error: 'API Key 无效或已失效' });
    const invalid = await getDeepSeekBalance(
      { DEEPSEEK_API_KEY: 'sk-test' },
      async () => new Response('{"unexpected":true}', { status: 200 }),
    );
    expect(invalid).toEqual({ ok: false, code: 'invalid-response', error: '余额接口返回格式无法识别' });
  });
});
