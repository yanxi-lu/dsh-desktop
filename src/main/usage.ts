// Harness 用量汇总与 DeepSeek 官方价格估算。
// 只读取本机 tokenUsage 投影缓存,不读取提示词、回复正文或凭据。
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const PRICE_VERIFIED_ON = '2026-08-22';

export const DEEPSEEK_PRICES = {
  'deepseek-v4-flash': {
    label: 'DeepSeek-V4-Flash-0731',
    offpeak: { cacheHitPerMillionCny: 0.05, cacheMissPerMillionCny: 1.5, outputPerMillionCny: 4.5 },
    peak: { cacheHitPerMillionCny: 0.1, cacheMissPerMillionCny: 3, outputPerMillionCny: 9 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek-V4-Pro-0813',
    offpeak: { cacheHitPerMillionCny: 0.15, cacheMissPerMillionCny: 4.5, outputPerMillionCny: 13.5 },
    peak: { cacheHitPerMillionCny: 0.3, cacheMissPerMillionCny: 9, outputPerMillionCny: 27 },
  },
  'deepseek-v4-flash-vision-exp': {
    label: 'DeepSeek-V4-Flash-Vision-Exp',
    offpeak: { cacheHitPerMillionCny: 0.05, cacheMissPerMillionCny: 1.5, outputPerMillionCny: 4.5 },
    peak: { cacheHitPerMillionCny: 0.1, cacheMissPerMillionCny: 3, outputPerMillionCny: 9 },
  },
} as const;

export type DeepSeekPriceModel = keyof typeof DEEPSEEK_PRICES;
export type PriceTier = 'official-auto' | 'official-offpeak' | 'official-peak' | 'custom';

export interface UnitPrices {
  cacheHitPerMillionCny: number;
  cacheMissPerMillionCny: number;
  outputPerMillionCny: number;
}

export interface PricingRequest {
  model?: unknown;
  tier?: unknown;
  customPrices?: unknown;
}

export interface UsageTotals {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface ParsedUsageCache {
  totals: UsageTotals;
  sessionCount: number;
}

export interface UsageSummary extends ParsedUsageCache {
  sourceFound: boolean;
  updatedAt: string | null;
  priceModel: DeepSeekPriceModel;
  priceLabel: string;
  priceTier: PriceTier;
  priceTierLabel: string;
  prices: UnitPrices;
  estimatedCny: number;
  estimatedBreakdown: {
    cacheHitCny: number;
    cacheMissCny: number;
    outputCny: number;
  };
  pricingUrl: string;
  priceVerifiedOn: string;
}

const ZERO_TOTALS: UsageTotals = {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** 汇总 session_projcache 中每个会话的官方 tokenUsage 投影。 */
export function parseUsageProjectionCache(raw: string): ParsedUsageCache {
  const totals = { ...ZERO_TOTALS };
  let sessionCount = 0;
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return { totals, sessionCount };
  }
  const sessions = asRecord(asRecord(asRecord(root)?.tables)?.sessions);
  if (!sessions) return { totals, sessionCount };

  for (const session of Object.values(sessions)) {
    const rows = asRecord(asRecord(session)?.rows);
    const usageRow = asRecord(rows?.tokenUsage);
    const value = asRecord(usageRow?.val);
    const sessionTotals = asRecord(value?.totals);
    if (!sessionTotals) continue;
    sessionCount += 1;
    totals.uncachedInputTokens += tokenCount(sessionTotals.uncachedInputTokens);
    totals.cacheReadTokens += tokenCount(sessionTotals.cacheReadTokens);
    totals.cacheWriteTokens += tokenCount(sessionTotals.cacheWriteTokens);
    totals.outputTokens += tokenCount(sessionTotals.outputTokens);
  }
  return { totals, sessionCount };
}

export function normalizePriceModel(value: unknown): DeepSeekPriceModel {
  if (value === 'deepseek-v4-pro' || value === 'deepseek-v4-flash-vision-exp') return value;
  return 'deepseek-v4-flash';
}

function normalizeCustomPrice(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${label}必须是 0 至 1000000 之间的数字`);
  }
  return value;
}

export function normalizePricingRequest(value: unknown): {
  model: DeepSeekPriceModel;
  tier: PriceTier;
  tierLabel: string;
  prices: UnitPrices;
} {
  const request = asRecord(value) ?? { model: value };
  const model = normalizePriceModel(request.model);
  const tier: PriceTier = request.tier === 'official-auto'
    ? 'official-auto'
    : request.tier === 'official-offpeak'
      ? 'official-offpeak'
      : request.tier === 'custom' ? 'custom' : 'official-peak';
  if (tier === 'custom') {
    const custom = asRecord(request.customPrices);
    return {
      model,
      tier,
      tierLabel: '自定义价格',
      prices: {
        cacheHitPerMillionCny: normalizeCustomPrice(custom?.cacheHitPerMillionCny, '缓存命中单价'),
        cacheMissPerMillionCny: normalizeCustomPrice(custom?.cacheMissPerMillionCny, '缓存未命中单价'),
        outputPerMillionCny: normalizeCustomPrice(custom?.outputPerMillionCny, '输出单价'),
      },
    };
  }
  // 单一汇总无法还原每次调用发生的时刻；auto 在这里保守回退到高峰价。
  // 带时间明细的用量统计会在 usage-analytics.ts 中逐次选择真实时段。
  const officialTier = tier === 'official-offpeak' ? 'offpeak' : 'peak';
  return {
    model,
    tier,
    tierLabel: tier === 'official-auto'
      ? '官方按调用时间自动'
      : tier === 'official-offpeak' ? '官方空闲时段' : '官方高峰时段',
    prices: { ...DEEPSEEK_PRICES[model][officialTier] },
  };
}

/** 缓存写入按未命中输入估价;DeepSeek 官方适配器通常不会上报该桶。 */
export function estimateDeepSeekCost(
  totals: UsageTotals,
  prices: UnitPrices,
): UsageSummary['estimatedBreakdown'] & { totalCny: number } {
  const cacheHitCny = totals.cacheReadTokens / 1_000_000 * prices.cacheHitPerMillionCny;
  const cacheMissCny = (totals.uncachedInputTokens + totals.cacheWriteTokens)
    / 1_000_000 * prices.cacheMissPerMillionCny;
  const outputCny = totals.outputTokens / 1_000_000 * prices.outputPerMillionCny;
  return { cacheHitCny, cacheMissCny, outputCny, totalCny: cacheHitCny + cacheMissCny + outputCny };
}

export function usageCachePath(env: NodeJS.ProcessEnv): string {
  const dshHome = env.DSH_HOME?.trim()
    ? resolve(env.DSH_HOME.trim())
    : join(homedir(), '.dsh');
  return join(dshHome, 'storages', 'session_projcache.json');
}

/** 读取本机 Harness 投影缓存并按所选 DeepSeek 模型估价。 */
export function getUsageSummary(
  env: NodeJS.ProcessEnv,
  pricingValue: unknown,
  filePath: string = usageCachePath(env),
): UsageSummary {
  const pricing = normalizePricingRequest(pricingValue);
  let parsed: ParsedUsageCache = { totals: { ...ZERO_TOTALS }, sessionCount: 0 };
  let sourceFound = false;
  let updatedAt: string | null = null;
  try {
    parsed = parseUsageProjectionCache(readFileSync(filePath, 'utf8'));
    sourceFound = true;
    updatedAt = statSync(filePath).mtime.toISOString();
  } catch {
    // 老版本 Harness 可能还没有投影缓存;返回零值并由界面明确提示。
  }
  const estimate = estimateDeepSeekCost(parsed.totals, pricing.prices);
  return {
    ...parsed,
    sourceFound,
    updatedAt,
    priceModel: pricing.model,
    priceLabel: DEEPSEEK_PRICES[pricing.model].label,
    priceTier: pricing.tier,
    priceTierLabel: pricing.tierLabel,
    prices: pricing.prices,
    estimatedCny: estimate.totalCny,
    estimatedBreakdown: {
      cacheHitCny: estimate.cacheHitCny,
      cacheMissCny: estimate.cacheMissCny,
      outputCny: estimate.outputCny,
    },
    pricingUrl: PRICING_URL,
    priceVerifiedOn: PRICE_VERIFIED_ON,
  };
}
