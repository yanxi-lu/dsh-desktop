import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  getUsageAnalytics,
  isDeepSeekPeakTime,
  parseSessionLogText,
  scanZstdFrames,
} from '../src/main/usage-analytics';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function usageEvent(
  type: 'assistant/chunk' | 'assistant/message',
  time: number,
  turn: number,
  step: number,
  usage: Record<string, number>,
): Record<string, unknown> {
  return type === 'assistant/chunk'
    ? { type, time, data: { turn, step, chunk: { type: 'usage', usage } } }
    : { type, time, data: { turn, step, usage } };
}

describe('Harness 会话日志用量分析', () => {
  it('同一 turn/step 的流式样本与最终消息只计最终值', () => {
    const at = Date.parse('2026-08-22T10:30:00+08:00');
    const raw = [
      { type: 'session', id: 'session-a', createdAt: at },
      { type: 'request/context', time: at, data: { provider: 'deepseek', model: 'DeepSeek-V4-Pro-0813' } },
      usageEvent('assistant/chunk', at, 1, 0, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 }),
      usageEvent('assistant/message', at + 100, 1, 0, { inputTokens: 120, outputTokens: 30, cacheReadTokens: 60 }),
      usageEvent('assistant/message', at + 200, 1, 1, { inputTokens: 200, outputTokens: 40, cacheWriteTokens: 10 }),
    ].map(line).join('');
    const parsed = parseSessionLogText(raw);
    expect(parsed.sessionId).toBe('session-a');
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      provider: 'deepseek',
      model: 'DeepSeek-V4-Pro-0813',
      uncachedInputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 60,
    });
  });

  it('识别拼接 Zstandard 帧并忽略未写完的末尾帧', () => {
    const one = zstdCompressSync(Buffer.from(line({ type: 'session', id: 'one' })));
    const two = zstdCompressSync(Buffer.from(line({ type: 'assistant/message', data: { turn: 0, step: 0, usage: { inputTokens: 1, outputTokens: 2 } } })));
    const joined = Buffer.concat([one, two, Buffer.from([0x28, 0xb5])]);
    expect(scanZstdFrames(joined)).toEqual([
      { start: 0, end: one.length },
      { start: one.length, end: one.length + two.length },
    ]);
  });

  it('按时间范围、模型和实际高峰时段汇总并估价', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-analytics-'));
    const sessionDir = join(root, 'project', 'session-a');
    mkdirSync(sessionDir, { recursive: true });
    const peak = Date.parse('2026-08-22T10:30:00+08:00');
    const offpeak = Date.parse('2026-08-21T20:30:00+08:00');
    const old = Date.parse('2026-07-01T10:30:00+08:00');
    const raw = [
      { type: 'session', id: 'session-a', createdAt: peak },
      { type: 'request/context', time: peak, data: { provider: 'deepseek', model: 'DeepSeek-V4-Pro-0813' } },
      usageEvent('assistant/message', peak, 1, 0, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
      usageEvent('assistant/message', offpeak, 2, 0, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
      usageEvent('assistant/message', old, 3, 0, { inputTokens: 9_000_000, outputTokens: 9_000_000 }),
    ].map(line).join('');
    writeFileSync(join(sessionDir, 'session.jsonl'), raw);
    try {
      const summary = getUsageAnalytics({}, {
        range: '7d',
        pricing: { model: 'deepseek-v4-flash', tier: 'official-auto' },
      }, root, Date.parse('2026-08-22T23:00:00+08:00'));
      expect(summary.requestCount).toBe(2);
      expect(summary.sessionCount).toBe(1);
      expect(summary.totalTokens).toBe(6_000_000);
      expect(summary.cacheHitRate).toBeCloseTo(0.5);
      // Pro 高峰 0.3 + 9 + 27；空闲 0.15 + 4.5 + 13.5。
      expect(summary.estimatedCny).toBeCloseTo(54.45);
      expect(summary.modelStats).toHaveLength(1);
      expect(summary.sessionStats).toHaveLength(1);
      expect(summary.sessionStats[0]).toMatchObject({
        sessionId: 'session-a',
        requestCount: 2,
        totalTokens: 6_000_000,
        models: ['DeepSeek-V4-Pro-0813'],
      });
      expect(summary.trend.reduce((sum, point) => sum + point.requestCount, 0)).toBe(2);
      expect(summary.fallbackPriceCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('按北京时间判断官方高峰', () => {
    expect(isDeepSeekPeakTime(Date.parse('2026-08-22T09:00:00+08:00'))).toBe(true);
    expect(isDeepSeekPeakTime(Date.parse('2026-08-22T12:00:00+08:00'))).toBe(false);
    expect(isDeepSeekPeakTime(Date.parse('2026-08-22T14:00:00+08:00'))).toBe(true);
    expect(isDeepSeekPeakTime(Date.parse('2026-08-22T18:00:00+08:00'))).toBe(false);
  });

  it('按自定义起止日期包含首尾当天并同步生成每日趋势', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-custom-range-'));
    const sessionDir = join(root, 'project', 'session-custom');
    mkdirSync(sessionDir, { recursive: true });
    const raw = [
      { type: 'session', id: 'session-custom', createdAt: Date.parse('2026-08-19T23:59:59+08:00') },
      usageEvent('assistant/message', Date.parse('2026-08-19T23:59:59+08:00'), 1, 0, { inputTokens: 9 }),
      usageEvent('assistant/message', Date.parse('2026-08-20T00:00:00+08:00'), 2, 0, { inputTokens: 10 }),
      usageEvent('assistant/message', Date.parse('2026-08-21T23:59:59+08:00'), 3, 0, { outputTokens: 20 }),
      usageEvent('assistant/message', Date.parse('2026-08-22T00:00:00+08:00'), 4, 0, { outputTokens: 99 }),
    ].map(line).join('');
    writeFileSync(join(sessionDir, 'session.jsonl'), raw);
    try {
      const summary = getUsageAnalytics({}, {
        range: 'custom',
        startDate: '2026-08-20',
        endDate: '2026-08-21',
      }, root, Date.parse('2026-08-22T12:00:00+08:00'));
      expect(summary.startDate).toBe('2026-08-20');
      expect(summary.endDate).toBe('2026-08-21');
      expect(summary.requestCount).toBe(2);
      expect(summary.totalTokens).toBe(30);
      expect(summary.trend).toHaveLength(2);
      expect(summary.trend.map((point) => point.requestCount)).toEqual([1, 1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('最近调用按页查询且多次查询之间不重复', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-recent-page-'));
    const sessionDir = join(root, 'project', 'session-page');
    mkdirSync(sessionDir, { recursive: true });
    const base = Date.parse('2026-08-22T08:00:00+08:00');
    const raw = [
      { type: 'session', id: 'session-page', createdAt: base },
      ...Array.from({ length: 25 }, (_, index) => usageEvent(
        'assistant/message',
        base + index * 60_000,
        index + 1,
        0,
        { inputTokens: index + 1 },
      )),
    ].map(line).join('');
    writeFileSync(join(sessionDir, 'session.jsonl'), raw);
    try {
      const first = getUsageAnalytics({}, {
        range: 'today', recentPage: 1, recentPageSize: 10,
      }, root, Date.parse('2026-08-22T12:00:00+08:00'));
      const second = getUsageAnalytics({}, {
        range: 'today', recentPage: 2, recentPageSize: 10,
      }, root, Date.parse('2026-08-22T12:00:00+08:00'));
      const last = getUsageAnalytics({}, {
        range: 'today', recentPage: 3, recentPageSize: 10,
      }, root, Date.parse('2026-08-22T12:00:00+08:00'));
      expect(first.recentRecordTotal).toBe(25);
      expect(first.recentPageCount).toBe(3);
      expect(first.recentRecords).toHaveLength(10);
      expect(second.recentRecords).toHaveLength(10);
      expect(last.recentRecords).toHaveLength(5);
      expect(new Set([
        ...first.recentRecords,
        ...second.recentRecords,
        ...last.recentRecords,
      ].map((record) => record.time)).size).toBe(25);
      expect(first.recentRecords[0].time).toBeGreaterThan(first.recentRecords[9].time);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
