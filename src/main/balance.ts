// DeepSeek 官方账户余额查询。API Key 只存在于本次请求内，不写入磁盘或日志。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

export interface DeepSeekBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export type DeepSeekCredentialSource = 'environment' | 'credentials-file' | 'project-env' | 'user-env';

export interface CredentialResolutionOptions {
  homeDir?: string;
  cwd?: string;
}

export type DeepSeekBalanceResult = {
  ok: true;
  isAvailable: boolean;
  balanceInfos: DeepSeekBalanceInfo[];
  queriedAt: string;
  keySource: DeepSeekCredentialSource;
} | {
  ok: false;
  code: 'missing-key' | 'invalid-key' | 'insufficient-balance' | 'rate-limited' | 'timeout' | 'network' | 'invalid-response' | 'http-error';
  error: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function usableApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 && /^[\x21-\x7e]+$/.test(normalized) ? normalized : null;
}

function yamlScalar(rawValue: string): string | null {
  const raw = rawValue.trim();
  if (!raw) return null;
  if (raw.startsWith('"')) {
    try {
      return usableApiKey(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) return null;
    return usableApiKey(raw.slice(1, -1).replace(/''/g, "'"));
  }
  return usableApiKey(raw.replace(/\s+#.*$/, ''));
}

/** 兼容当前简单 mapping 与早期 `{ version, refs }` 凭据文档。 */
function apiKeyFromCredentialsDocument(text: string): string | null {
  let direct: string | null = null;
  let legacy: string | null = null;
  let refsIndent: number | null = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3];
    if (indent === 0) {
      refsIndent = key === 'refs' && !rawValue.trim() ? indent : null;
      if (key === 'DEEPSEEK_API_KEY') direct = yamlScalar(rawValue);
      continue;
    }
    if (refsIndent !== null && indent > refsIndent && key === 'DEEPSEEK_API_KEY') {
      legacy = yamlScalar(rawValue);
    }
  }
  return direct ?? legacy;
}

function apiKeyFromEnvDocument(text: string): string | null {
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (match) return yamlScalar(match[1]);
  }
  return null;
}

function readCredential(path: string, parser: (text: string) => string | null): string | null {
  try {
    return parser(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 与 Harness credentials-local 的有效 Key 优先级保持一致，值永不返回给 renderer。 */
export function resolveExistingDeepSeekApiKey(
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialResolutionOptions = {},
): { apiKey: string; source: DeepSeekCredentialSource } | null {
  const environmentKey = usableApiKey(env.DEEPSEEK_API_KEY);
  if (environmentKey) return { apiKey: environmentKey, source: 'environment' };

  const dshHome = env.DSH_HOME?.trim()
    ? resolve(env.DSH_HOME.trim())
    : join(options.homeDir ?? homedir(), '.dsh');
  const managedKey = readCredential(join(dshHome, '.credentials.yaml'), apiKeyFromCredentialsDocument);
  if (managedKey) return { apiKey: managedKey, source: 'credentials-file' };

  const invocationCwd = options.cwd ?? process.cwd();
  const projectEnvPath = join(invocationCwd, '.env');
  const projectKey = readCredential(projectEnvPath, apiKeyFromEnvDocument);
  if (projectKey) return { apiKey: projectKey, source: 'project-env' };

  const userEnvPath = join(dshHome, '.env');
  if (resolve(userEnvPath) !== resolve(projectEnvPath)) {
    const userKey = readCredential(userEnvPath, apiKeyFromEnvDocument);
    if (userKey) return { apiKey: userKey, source: 'user-env' };
  }
  return null;
}

function balanceAmount(value: unknown): string {
  if (typeof value !== 'string') return '0';
  const normalized = value.trim();
  return normalized && /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : '0';
}

function balanceInfo(value: unknown): DeepSeekBalanceInfo | null {
  const info = asRecord(value);
  if (!info || typeof info.currency !== 'string') return null;
  const currency = info.currency.trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) return null;
  return {
    currency,
    totalBalance: balanceAmount(info.total_balance),
    grantedBalance: balanceAmount(info.granted_balance),
    toppedUpBalance: balanceAmount(info.topped_up_balance),
  };
}

export async function getDeepSeekBalance(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = globalThis.fetch,
  now: number = Date.now(),
  credentialOptions: CredentialResolutionOptions = {},
): Promise<DeepSeekBalanceResult> {
  const credential = resolveExistingDeepSeekApiKey(env, credentialOptions);
  if (!credential) return { ok: false, code: 'missing-key', error: 'Harness 尚未配置 DeepSeek API Key' };
  const { apiKey, source: keySource } = credential;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchFn(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      if (response.status === 401) return { ok: false, code: 'invalid-key', error: 'API Key 无效或已失效' };
      if (response.status === 402) return { ok: false, code: 'insufficient-balance', error: '账户余额不足' };
      if (response.status === 429) return { ok: false, code: 'rate-limited', error: '余额查询过于频繁，请稍后重试' };
      return { ok: false, code: 'http-error', error: `余额接口请求失败（HTTP ${response.status}）` };
    }
    const text = await response.text();
    if (text.length > 1_000_000) {
      return { ok: false, code: 'invalid-response', error: '余额接口返回数据异常' };
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(text));
    } catch {
      // 统一走下方的响应格式提示，不回显服务端内容。
    }
    if (!parsed || typeof parsed.is_available !== 'boolean' || !Array.isArray(parsed.balance_infos)) {
      return { ok: false, code: 'invalid-response', error: '余额接口返回格式无法识别' };
    }
    const balanceInfos = parsed.balance_infos
      .map(balanceInfo)
      .filter((info): info is DeepSeekBalanceInfo => info !== null)
      .sort((left, right) => left.currency === 'CNY' ? -1 : right.currency === 'CNY' ? 1 : left.currency.localeCompare(right.currency));
    return {
      ok: true,
      isAvailable: parsed.is_available,
      balanceInfos,
      queriedAt: new Date(now).toISOString(),
      keySource,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, code: 'timeout', error: '余额查询超时，请检查网络后重试' };
    }
    return { ok: false, code: 'network', error: '无法连接 DeepSeek 官方余额接口' };
  } finally {
    clearTimeout(timeout);
  }
}
