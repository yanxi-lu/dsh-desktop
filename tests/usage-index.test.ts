import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { getUsageAnalytics, UsageLogIndex } from '../src/main/usage-analytics';

const roots: string[] = [];
const at = new Date(2026, 8, 24, 12).getTime();
const line = (value: unknown): string => JSON.stringify(value) + '\n';
const header = line({ type: 'session', id: 'test-session', createdAt: at })
  + line({ type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-pro' } });
const usage = (input: number, turn = 1): string => line({
  type: 'assistant/message', time: at, data: { turn, step: 0, usage: { inputTokens: input, outputTokens: 2 } },
});

function fixture(compressed = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-index-test-'));
  roots.push(root);
  const sessions = join(root, 'sessions');
  mkdirSync(join(sessions, 'test'), { recursive: true });
  return { root: sessions, cache: join(root, 'cache'), file: join(sessions, 'test', compressed ? 'session.jsonl.zstd' : 'session.jsonl') };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('用量增量索引', () => {
  it('只读追加数据并跨刷新修正同一 turn/step 的最终用量', () => {
    const f = fixture();
    writeFileSync(f.file, header + line({ type: 'user/message', data: { text: '私密正文'.repeat(30000) } }) + usage(10));
    const index = new UsageLogIndex();
    const first = index.read(f.root);
    const coldBytes = index.lastRead.bytesRead;
    expect(first.records).toHaveLength(1);
    appendFileSync(f.file, usage(20) + usage(30, 2));
    const second = index.read(f.root);
    expect(second.records.map(r => r.uncachedInputTokens)).toEqual([20, 30]);
    expect(first.records[0].uncachedInputTokens).toBe(10);
    expect(index.lastRead.incrementalFiles).toBe(1);
    expect(index.lastRead.bytesRead).toBeLessThan(coldBytes / 5);
    index.read(f.root);
    expect(index.lastRead).toMatchObject({ parsedFiles: 0, bytesRead: 0, reusedFiles: 1 });
  });

  it('压缩日志末尾半帧写完后继续读取，且不重复计数', () => {
    const f = fixture(true);
    const firstFrame = zstdCompressSync(Buffer.from(header + usage(10)));
    const nextFrame = zstdCompressSync(Buffer.from(usage(40) + usage(50, 2)));
    const partial = Math.floor(nextFrame.length / 2);
    writeFileSync(f.file, Buffer.concat([firstFrame, nextFrame.subarray(0, partial)]));
    const index = new UsageLogIndex();
    expect(index.read(f.root).records.map(r => r.uncachedInputTokens)).toEqual([10]);
    appendFileSync(f.file, nextFrame.subarray(partial));
    expect(index.read(f.root).records.map(r => r.uncachedInputTokens)).toEqual([40, 50]);
    expect(index.lastRead.incrementalFiles).toBe(1);
  });

  it('JSON 行和 UTF-8 字符跨压缩帧时保持正确', () => {
    const f = fixture(true);
    const raw = Buffer.from(header + line({ type: 'request/context', data: { provider: '中文提供方', model: 'deepseek-v4-pro' } }) + usage(12));
    const split = raw.indexOf(Buffer.from('中文')) + 1;
    const a = zstdCompressSync(raw.subarray(0, split));
    const b = zstdCompressSync(raw.subarray(split));
    writeFileSync(f.file, a);
    const index = new UsageLogIndex();
    expect(index.read(f.root).records).toHaveLength(0);
    appendFileSync(f.file, b);
    expect(index.read(f.root).records[0]).toMatchObject({ provider: '中文提供方', uncachedInputTokens: 12 });
  });

  it('超过读取块大小的压缩帧正确拼接，追加时不重新解压大帧', () => {
    const f = fixture(true);
    const large = zstdCompressSync(Buffer.from(header + line({
      type: 'user/message', data: { text: randomBytes(400_000).toString('base64') },
    }) + usage(13)));
    expect(large.length).toBeGreaterThan(256 * 1024);
    writeFileSync(f.file, large);
    const index = new UsageLogIndex();
    expect(index.read(f.root).records[0].uncachedInputTokens).toBe(13);
    appendFileSync(f.file, zstdCompressSync(Buffer.from(usage(14, 2))));
    expect(index.read(f.root).records.map(r => r.uncachedInputTokens)).toEqual([13, 14]);
    expect(index.lastRead.bytesRead).toBeLessThan(large.length / 5);
    expect(index.lastRead.incrementalFiles).toBe(1);
  });

  it('重启后复用磁盘索引且不保存正文、工具参数或源路径', () => {
    const f = fixture(true);
    const privateEvent = line({ type: 'assistant/message', time: at, data: {
      turn: 1, step: 0, usage: { inputTokens: 33 }, text: 'PRIVATE_MESSAGE_SENTINEL',
      toolArguments: 'PRIVATE_TOOL_SENTINEL', apiKey: 'PRIVATE_KEY_SENTINEL',
    } });
    writeFileSync(f.file, zstdCompressSync(Buffer.from(header + privateEvent)));
    const first = new UsageLogIndex(f.cache).read(f.root);
    const persisted = readFileSync(join(f.cache, readdirSync(f.cache)[0]), 'utf8');
    expect(persisted).not.toContain('PRIVATE_');
    expect(persisted).not.toContain(f.root);
    const restored = new UsageLogIndex(f.cache);
    expect(restored.read(f.root)).toEqual(first);
    expect(restored.lastRead).toMatchObject({ bytesRead: 0, parsedFiles: 0, reusedFiles: 1 });
    appendFileSync(f.file, zstdCompressSync(Buffer.from(usage(44))));
    expect(restored.read(f.root).records[0].uncachedInputTokens).toBe(44);
    expect(restored.lastRead.incrementalFiles).toBe(1);
    const cacheFile = join(f.cache, readdirSync(f.cache).find(name => name.endsWith('.json'))!);
    appendFileSync(cacheFile, 'corrupted');
    const rebuilt = new UsageLogIndex(f.cache);
    expect(rebuilt.read(f.root).records[0].uncachedInputTokens).toBe(44);
    expect(rebuilt.lastRead.parsedFiles).toBe(1);
  });

  it('日志变大但头部重写或被截断时重新建立索引', () => {
    const f = fixture();
    const original = header + usage(11);
    writeFileSync(f.file, original);
    const index = new UsageLogIndex();
    index.read(f.root);
    writeFileSync(f.file, header + usage(66) + usage(77, 2));
    expect(index.read(f.root).records.map(r => r.uncachedInputTokens)).toEqual([66, 77]);
    expect(index.lastRead.incrementalFiles).toBe(0);
    writeFileSync(f.file, header + usage(5));
    expect(index.read(f.root).records.map(r => r.uncachedInputTokens)).toEqual([5]);
    expect(index.lastRead.incrementalFiles).toBe(0);
    rmSync(f.file);
    expect(index.read(f.root).records).toHaveLength(0);
  });

  it('旧版无换行尾行、后续追加换行和压缩迁移均不会漏算或重复', () => {
    const f = fixture();
    writeFileSync(f.file, header + usage(10).trimEnd());
    const index = new UsageLogIndex();
    expect(index.read(f.root).records).toHaveLength(1);
    appendFileSync(f.file, '\n' + usage(20, 2));
    const expected = index.read(f.root).records;
    expect(expected).toHaveLength(2);
    writeFileSync(f.file + '.zstd', zstdCompressSync(readFileSync(f.file)));
    expect(index.read(f.root).records).toEqual(expected);
  });

  it('筛选、分页、价格改变后使用相同元数据重新计算而非沿用旧汇总', () => {
    const f = fixture();
    writeFileSync(f.file, header + Array.from({ length: 25 }, (_, i) => usage(100, i + 1)).join(''));
    const index = new UsageLogIndex(f.cache);
    const first = getUsageAnalytics({}, { range: 'today', recentPageSize: 10 }, f.root, at, index);
    const second = getUsageAnalytics({}, { range: 'today', recentPageSize: 10, recentPage: 3,
      pricing: { tier: 'custom', customPrices: { cacheHitPerMillionCny: 0, cacheMissPerMillionCny: 100, outputPerMillionCny: 0 } },
    }, f.root, at, index);
    expect(second.totalTokens).toBe(first.totalTokens);
    expect(second.recentRecords).toHaveLength(5);
    expect(second.estimatedCny).toBeCloseTo(0.25);
    expect(index.lastRead.parsedFiles).toBe(0);
    const nextDay = getUsageAnalytics({}, { range: 'today' }, f.root, at + 86400_000, index);
    expect(nextDay.requestCount).toBe(0);
  });
});
