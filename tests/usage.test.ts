import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimateDeepSeekCost,
  getUsageSummary,
  normalizePriceModel,
  normalizePricingRequest,
  parseUsageProjectionCache,
} from '../src/main/usage';

const sample = JSON.stringify({
  tables: {
    sessions: {
      one: { rows: { tokenUsage: { val: { totals: {
        uncachedInputTokens: 1_000_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 100_000,
        outputTokens: 500_000,
      } } } } },
      two: { rows: { tokenUsage: { val: { totals: {
        uncachedInputTokens: 50,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
        outputTokens: 70,
      } } } } },
      noUsage: { rows: { title: { val: 'empty' } } },
    },
  },
});

describe('Harness 用量与价格估算', () => {
  it('汇总每个会话的 tokenUsage 投影', () => {
    expect(parseUsageProjectionCache(sample)).toEqual({
      sessionCount: 2,
      totals: {
        uncachedInputTokens: 1_000_050,
        cacheReadTokens: 2_000_060,
        cacheWriteTokens: 100_000,
        outputTokens: 500_070,
      },
    });
    expect(parseUsageProjectionCache('not json').sessionCount).toBe(0);
  });

  it('按官方缓存命中、未命中与输出单价分别估算', () => {
    const estimate = estimateDeepSeekCost({
      uncachedInputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 100_000,
      outputTokens: 500_000,
    }, { cacheHitPerMillionCny: 0.1, cacheMissPerMillionCny: 3, outputPerMillionCny: 9 });
    expect(estimate.cacheHitCny).toBeCloseTo(0.2);
    expect(estimate.cacheMissCny).toBeCloseTo(3.3);
    expect(estimate.outputCny).toBeCloseTo(4.5);
    expect(estimate.totalCny).toBeCloseTo(8);
  });

  it('读取缓存文件并为未知模型安全回退 Flash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-'));
    const file = join(dir, 'session_projcache.json');
    try {
      writeFileSync(file, sample);
      const summary = getUsageSummary({}, 'unknown-model', file);
      expect(summary.sourceFound).toBe(true);
      expect(summary.priceModel).toBe('deepseek-v4-flash');
      expect(summary.priceTier).toBe('official-peak');
      expect(summary.prices).toEqual({
        cacheHitPerMillionCny: 0.04,
        cacheMissPerMillionCny: 2,
        outputPerMillionCny: 8,
      });
      expect(summary.sessionCount).toBe(2);
      expect(summary.estimatedCny).toBeGreaterThan(0);
      expect(normalizePriceModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('支持官方空闲时段、视觉模型与自定义价格', () => {
    expect(normalizePricingRequest({
      model: 'deepseek-v4-flash-vision-exp',
      tier: 'official-offpeak',
    })).toMatchObject({
      model: 'deepseek-v4-flash-vision-exp',
      tier: 'official-offpeak',
      prices: { cacheHitPerMillionCny: 0.02, cacheMissPerMillionCny: 1, outputPerMillionCny: 4 },
    });
    expect(normalizePricingRequest({
      model: 'deepseek-v4-pro',
      tier: 'custom',
      customPrices: { cacheHitPerMillionCny: 2, cacheMissPerMillionCny: 4, outputPerMillionCny: 6 },
    })).toMatchObject({
      tier: 'custom',
      prices: { cacheHitPerMillionCny: 2, cacheMissPerMillionCny: 4, outputPerMillionCny: 6 },
    });
    expect(() => normalizePricingRequest({ tier: 'custom', customPrices: { cacheHitPerMillionCny: -1 } }))
      .toThrow(/自定义|单价/);
  });
});
