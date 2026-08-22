// DeepSeek 官方账户余额查询。API Key 只存在于本次请求内，不写入磁盘或日志。

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

export interface DeepSeekBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export type DeepSeekBalanceResult = {
  ok: true;
  isAvailable: boolean;
  balanceInfos: DeepSeekBalanceInfo[];
  queriedAt: string;
  keySource: 'input' | 'environment';
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
  apiKeyValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<DeepSeekBalanceResult> {
  const inputKey = typeof apiKeyValue === 'string' ? apiKeyValue.trim() : '';
  const environmentKey = env.DEEPSEEK_API_KEY?.trim() ?? '';
  const apiKey = inputKey || environmentKey;
  const keySource = inputKey ? 'input' : 'environment';
  if (!apiKey) {
    return { ok: false, code: 'missing-key', error: '请输入 DeepSeek API Key 后查询余额' };
  }
  if (apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
    return { ok: false, code: 'invalid-key', error: 'API Key 格式无效' };
  }

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
