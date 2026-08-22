// Harness 本机会话用量分析。
// 只从 Harness 会话日志提取时间、provider、model 与 usage 元数据；
// 不保存、不返回提示词、回复正文、工具参数、工作目录或凭据。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  DEEPSEEK_PRICES,
  PRICE_VERIFIED_ON,
  PRICING_URL,
  estimateDeepSeekCost,
  normalizePricingRequest,
  type DeepSeekPriceModel,
  type PriceTier,
  type PricingRequest,
  type UnitPrices,
  type UsageTotals,
} from './usage';

export type UsageDateRange = 'today' | '7d' | '30d' | 'custom';

export interface RawUsageRecord extends UsageTotals {
  time: number;
  sessionId: string;
  provider: string;
  model: string;
}

export interface UsageRecord extends RawUsageRecord {
  estimatedCny: number;
}

export interface ParsedSessionLog {
  sessionId: string;
  records: RawUsageRecord[];
}

export interface UsageTrendPoint extends UsageTotals {
  key: string;
  label: string;
  requestCount: number;
  totalTokens: number;
  estimatedCny: number;
}

export interface UsageModelStat extends UsageTotals {
  key: string;
  provider: string;
  model: string;
  requestCount: number;
  totalTokens: number;
  estimatedCny: number;
}

export interface UsageSessionStat extends UsageTotals {
  sessionId: string;
  providers: string[];
  models: string[];
  requestCount: number;
  totalTokens: number;
  estimatedCny: number;
  lastActiveAt: number;
}

export interface UsageAnalyticsRequest {
  range?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  modelFilter?: unknown;
  recentPage?: unknown;
  recentPageSize?: unknown;
  pricing?: PricingRequest | unknown;
}

export interface UsageAnalyticsSummary {
  sourceFound: boolean;
  updatedAt: string | null;
  range: UsageDateRange;
  startDate: string;
  endDate: string;
  modelFilter: string;
  availableModels: Array<{ key: string; provider: string; model: string }>;
  totals: UsageTotals;
  totalTokens: number;
  requestCount: number;
  sessionCount: number;
  cacheHitRate: number;
  estimatedCny: number;
  estimatedBreakdown: { cacheHitCny: number; cacheMissCny: number; outputCny: number };
  priceModel: DeepSeekPriceModel;
  priceLabel: string;
  priceTier: PriceTier;
  priceTierLabel: string;
  prices: UnitPrices;
  variableOfficialPricing: boolean;
  fallbackPriceCount: number;
  trend: UsageTrendPoint[];
  modelStats: UsageModelStat[];
  sessionStats: UsageSessionStat[];
  recentRecords: UsageRecord[];
  recentRecordTotal: number;
  recentPage: number;
  recentPageSize: number;
  recentPageCount: number;
  scannedFileCount: number;
  skippedFileCount: number;
  pricingUrl: string;
  priceVerifiedOn: string;
}

const ZSTD_MAGIC = 4_247_762_216;
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

function safeToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeRecentPageSize(value: unknown): number {
  const requested = positiveInteger(value, 20);
  return [10, 20, 50, 100].includes(requested) ? requested : 20;
}

function totalsFromUsage(value: unknown): UsageTotals | null {
  const usage = asRecord(value);
  if (!usage) return null;
  return {
    uncachedInputTokens: safeToken(usage.inputTokens ?? usage.input_tokens),
    outputTokens: safeToken(usage.outputTokens ?? usage.output_tokens),
    cacheReadTokens: safeToken(usage.cacheReadTokens ?? usage.cache_read_tokens),
    cacheWriteTokens: safeToken(usage.cacheWriteTokens ?? usage.cache_write_tokens),
  };
}

function sameTotals(left: UsageTotals, right: UsageTotals): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.outputTokens === right.outputTokens;
}

/**
 * 定位 Harness 追加写入的独立 Zstandard 帧。最后一个帧正在写入时忽略它，
 * 这样刷新统计不会误报“日志损坏”。
 */
export function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`无效的 Zstandard 帧:byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`无效的 Zstandard 帧头:byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let complete = false;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`无效的 Zstandard 块:byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (!lastBlock) continue;
      if (checksum) {
        if (buffer.length - offset < 4) break;
        offset += 4;
      }
      complete = true;
      break;
    }
    if (!complete) break;
    frames.push({ start, end: offset });
  }
  return frames;
}

function parseSessionLogChunks(chunks: Iterable<string>, fallbackSessionId = 'unknown'): ParsedSessionLog {
  let sessionId = fallbackSessionId;
  let fallbackTime = 0;
  let provider = '未标注';
  let model = '未标注';
  let pending = '';
  let lastSample: { turn: number; step: number; index: number; totals: UsageTotals } | null = null;
  const records: RawUsageRecord[] = [];

  function consumeLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) return;
      event = parsed;
    } catch {
      return;
    }
    if (event.type === 'session') {
      sessionId = safeText(event.id, sessionId);
      fallbackTime = safeToken(event.createdAt);
      return;
    }
    const data = asRecord(event.data);
    if (!data) return;
    if (event.type === 'request/context') {
      provider = safeText(data.provider, provider);
      model = safeText(data.model, model);
      return;
    }
    let usageValue: unknown;
    if (event.type === 'assistant/chunk') {
      const chunk = asRecord(data.chunk);
      if (chunk?.type !== 'usage') return;
      usageValue = chunk.usage;
    } else if (event.type === 'assistant/message') {
      usageValue = data.usage;
    } else {
      return;
    }
    const totals = totalsFromUsage(usageValue);
    if (!totals) return;
    const turn = safeToken(data.turn);
    const step = safeToken(data.step);
    const time = safeToken(event.time) || fallbackTime;
    if (lastSample && lastSample.turn === turn && lastSample.step === step) {
      if (!sameTotals(lastSample.totals, totals)) {
        records[lastSample.index] = { time, sessionId, provider, model, ...totals };
        lastSample.totals = totals;
      }
      return;
    }
    records.push({ time, sessionId, provider, model, ...totals });
    lastSample = { turn, step, index: records.length - 1, totals };
  }

  for (const chunk of chunks) {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
  }
  if (pending.trim()) consumeLine(pending);
  for (const record of records) record.sessionId = sessionId;
  return { sessionId, records };
}

/** 用于明文旧日志与单元测试；压缩日志走逐帧解码。 */
export function parseSessionLogText(text: string, fallbackSessionId?: string): ParsedSessionLog {
  return parseSessionLogChunks([text], fallbackSessionId);
}

function parseSessionLogFile(filePath: string): ParsedSessionLog {
  const fallbackSessionId = basename(dirname(filePath));
  if (!filePath.toLowerCase().endsWith('.zstd')) {
    return parseSessionLogText(readFileSync(filePath, 'utf8'), fallbackSessionId);
  }
  const buffer = readFileSync(filePath);
  const frames = scanZstdFrames(buffer);
  return parseSessionLogChunks(frames.map(({ start, end }) => (
    zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  )), fallbackSessionId);
}

interface CachedSessionLog {
  signature: string;
  parsed: ParsedSessionLog;
}

const sessionLogCache = new Map<string, CachedSessionLog>();

function sessionLogsRoot(env: NodeJS.ProcessEnv): string {
  const dshHome = env.DSH_HOME?.trim() ? resolve(env.DSH_HOME.trim()) : join(homedir(), '.dsh');
  return join(dshHome, 'sessions');
}

function findSessionLogs(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true });
    // 迁移期间同一会话目录可能短暂同时保留明文与压缩文件；优先采用新版压缩日志，
    // 避免一条调用被两个容器重复统计。
    const hasCompressedLog = entries.some((entry) => entry.isFile() && entry.name === 'session.jsonl.zstd');
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && (
        entry.name === 'session.jsonl.zstd'
          || (!hasCompressedLog && entry.name === 'session.jsonl')
      )) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function readAllUsageRecords(root: string): {
  records: RawUsageRecord[];
  scannedFileCount: number;
  skippedFileCount: number;
  updatedAt: string | null;
} {
  const records: RawUsageRecord[] = [];
  let skippedFileCount = 0;
  let updatedMillis = 0;
  let files: string[];
  try {
    files = findSessionLogs(root);
  } catch {
    return { records, scannedFileCount: 0, skippedFileCount: 0, updatedAt: null };
  }
  const currentFiles = new Set(files);
  for (const cachedPath of sessionLogCache.keys()) {
    if (cachedPath.startsWith(root) && !currentFiles.has(cachedPath)) sessionLogCache.delete(cachedPath);
  }
  for (const filePath of files) {
    try {
      const stat = statSync(filePath);
      updatedMillis = Math.max(updatedMillis, stat.mtimeMs);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      let parsed = sessionLogCache.get(filePath);
      if (!parsed || parsed.signature !== signature) {
        parsed = { signature, parsed: parseSessionLogFile(filePath) };
        sessionLogCache.set(filePath, parsed);
      }
      records.push(...parsed.parsed.records);
    } catch {
      skippedFileCount += 1;
    }
  }
  return {
    records,
    scannedFileCount: files.length - skippedFileCount,
    skippedFileCount,
    updatedAt: updatedMillis ? new Date(updatedMillis).toISOString() : null,
  };
}

export function normalizeUsageDateRange(value: unknown): UsageDateRange {
  return value === 'today' || value === '7d' || value === 'custom' ? value : '30d';
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u001f${model}`;
}

function startOfRange(range: Exclude<UsageDateRange, 'custom'>, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === '7d') start.setDate(start.getDate() - 6);
  if (range === '30d') start.setDate(start.getDate() - 29);
  return start.getTime();
}

function parseLocalDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  parsed.setHours(0, 0, 0, 0);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
    ? parsed
    : null;
}

function resolveDateBounds(
  range: UsageDateRange,
  request: Record<string, unknown>,
  now: number,
): { start: number; end: number; startDate: string; endDate: string } {
  if (range !== 'custom') {
    const start = startOfRange(range, now);
    return { start, end: now, startDate: dateKey(start), endDate: dateKey(now) };
  }
  const start = parseLocalDate(request.startDate);
  const endDay = parseLocalDate(request.endDate);
  if (!start || !endDay) throw new Error('请选择有效的自定义开始日期和结束日期');
  if (start.getTime() > endDay.getTime()) throw new Error('开始日期不能晚于结束日期');
  const today = parseLocalDate(dateKey(now))!;
  if (endDay.getTime() > today.getTime()) throw new Error('结束日期不能晚于今天');
  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + 10);
  if (endDay.getTime() >= limit.getTime()) throw new Error('自定义时间范围不能超过 10 年');
  const end = new Date(endDay);
  end.setHours(23, 59, 59, 999);
  return {
    start: start.getTime(),
    end: Math.min(end.getTime(), now),
    startDate: dateKey(start.getTime()),
    endDate: dateKey(endDay.getTime()),
  };
}

function recognizedPriceModel(model: string): DeepSeekPriceModel | null {
  const normalized = model.toLowerCase();
  if (normalized.includes('v4-pro') || normalized.includes('v4_pro')) return 'deepseek-v4-pro';
  if (normalized.includes('vision')) return 'deepseek-v4-flash-vision-exp';
  if (normalized.includes('deepseek') || normalized.includes('v4-flash') || normalized.includes('v4_flash')) {
    return 'deepseek-v4-flash';
  }
  return null;
}

/** DeepSeek 官方高峰：北京时间 09:00–12:00、14:00–18:00。 */
export function isDeepSeekPeakTime(time: number): boolean {
  const beijingHour = new Date(time + 8 * 60 * 60 * 1000).getUTCHours();
  return (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
}

function pricesForRecord(
  record: RawUsageRecord,
  pricing: ReturnType<typeof normalizePricingRequest>,
): { prices: UnitPrices; fallback: boolean } {
  if (pricing.tier === 'custom') return { prices: pricing.prices, fallback: false };
  const recognized = recognizedPriceModel(record.model);
  const model = recognized ?? pricing.model;
  const officialTier = pricing.tier === 'official-auto'
    ? (isDeepSeekPeakTime(record.time) ? 'peak' : 'offpeak')
    : pricing.tier === 'official-offpeak' ? 'offpeak' : 'peak';
  return { prices: { ...DEEPSEEK_PRICES[model][officialTier] }, fallback: recognized === null };
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.outputTokens += source.outputTokens;
}

function totalTokens(totals: UsageTotals): number {
  return totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;
}

function dateKey(time: number): string {
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyTrend(range: UsageDateRange, now: number, rangeStart: number, rangeEnd: number): UsageTrendPoint[] {
  const points: UsageTrendPoint[] = [];
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    for (let hour = 0; hour < 24; hour += 1) {
      points.push({
        key: `${dateKey(start.getTime())} ${String(hour).padStart(2, '0')}`,
        label: `${String(hour).padStart(2, '0')}:00`,
        requestCount: 0,
        totalTokens: 0,
        estimatedCny: 0,
        ...ZERO_TOTALS,
      });
    }
    return points;
  }
  const start = new Date(range === 'custom' ? rangeStart : now);
  start.setHours(0, 0, 0, 0);
  if (range !== 'custom') start.setDate(start.getDate() - (range === '7d' ? 7 : 30) + 1);
  const end = new Date(range === 'custom' ? rangeEnd : now);
  end.setHours(0, 0, 0, 0);
  const spansYears = start.getFullYear() !== end.getFullYear();
  for (let index = 0; ; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    if (day.getTime() > end.getTime()) break;
    points.push({
      key: dateKey(day.getTime()),
      label: spansYears
        ? `${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`
        : `${day.getMonth() + 1}/${day.getDate()}`,
      requestCount: 0,
      totalTokens: 0,
      estimatedCny: 0,
      ...ZERO_TOTALS,
    });
  }
  return points;
}

export function getUsageAnalytics(
  env: NodeJS.ProcessEnv,
  requestValue: unknown,
  root: string = sessionLogsRoot(env),
  now: number = Date.now(),
): UsageAnalyticsSummary {
  const request = asRecord(requestValue) ?? {};
  const range = normalizeUsageDateRange(request.range);
  const bounds = resolveDateBounds(range, request, now);
  const requestedFilter = typeof request.modelFilter === 'string' ? request.modelFilter : 'all';
  const requestedRecentPage = positiveInteger(request.recentPage, 1);
  const recentPageSize = normalizeRecentPageSize(request.recentPageSize);
  const pricing = normalizePricingRequest(request.pricing);
  const source = readAllUsageRecords(root);
  const availableModelMap = new Map<string, { key: string; provider: string; model: string }>();
  for (const record of source.records) {
    const key = modelKey(record.provider, record.model);
    availableModelMap.set(key, { key, provider: record.provider, model: record.model });
  }
  const availableModels = [...availableModelMap.values()].sort((a, b) => (
    `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`, 'zh-CN')
  ));
  const modelFilter = requestedFilter === 'all' || availableModelMap.has(requestedFilter)
    ? requestedFilter
    : 'all';
  const selected = source.records.filter((record) => (
    record.time >= bounds.start
      && record.time <= bounds.end
      && (modelFilter === 'all' || modelKey(record.provider, record.model) === modelFilter)
  ));

  const totals = { ...ZERO_TOTALS };
  const breakdown = { cacheHitCny: 0, cacheMissCny: 0, outputCny: 0 };
  const records: UsageRecord[] = [];
  let fallbackPriceCount = 0;
  for (const record of selected) {
    addTotals(totals, record);
    const resolved = pricesForRecord(record, pricing);
    if (resolved.fallback) fallbackPriceCount += 1;
    const estimate = estimateDeepSeekCost(record, resolved.prices);
    breakdown.cacheHitCny += estimate.cacheHitCny;
    breakdown.cacheMissCny += estimate.cacheMissCny;
    breakdown.outputCny += estimate.outputCny;
    records.push({ ...record, estimatedCny: estimate.totalCny });
  }
  const estimatedCny = breakdown.cacheHitCny + breakdown.cacheMissCny + breakdown.outputCny;
  const trend = emptyTrend(range, now, bounds.start, bounds.end);
  const trendMap = new Map(trend.map((point) => [point.key, point]));
  const modelStatMap = new Map<string, UsageModelStat>();
  const sessionStatMap = new Map<string, UsageSessionStat>();
  for (const record of records) {
    const date = new Date(record.time);
    const key = range === 'today'
      ? `${dateKey(record.time)} ${String(date.getHours()).padStart(2, '0')}`
      : dateKey(record.time);
    const point = trendMap.get(key);
    if (point) {
      addTotals(point, record);
      point.requestCount += 1;
      point.totalTokens += totalTokens(record);
      point.estimatedCny += record.estimatedCny;
    }
    const groupKey = modelKey(record.provider, record.model);
    let stat = modelStatMap.get(groupKey);
    if (!stat) {
      stat = {
        key: groupKey,
        provider: record.provider,
        model: record.model,
        requestCount: 0,
        totalTokens: 0,
        estimatedCny: 0,
        ...ZERO_TOTALS,
      };
      modelStatMap.set(groupKey, stat);
    }
    addTotals(stat, record);
    stat.requestCount += 1;
    stat.totalTokens += totalTokens(record);
    stat.estimatedCny += record.estimatedCny;

    let sessionStat = sessionStatMap.get(record.sessionId);
    if (!sessionStat) {
      sessionStat = {
        sessionId: record.sessionId,
        providers: [],
        models: [],
        requestCount: 0,
        totalTokens: 0,
        estimatedCny: 0,
        lastActiveAt: 0,
        ...ZERO_TOTALS,
      };
      sessionStatMap.set(record.sessionId, sessionStat);
    }
    if (!sessionStat.providers.includes(record.provider)) sessionStat.providers.push(record.provider);
    if (!sessionStat.models.includes(record.model)) sessionStat.models.push(record.model);
    addTotals(sessionStat, record);
    sessionStat.requestCount += 1;
    sessionStat.totalTokens += totalTokens(record);
    sessionStat.estimatedCny += record.estimatedCny;
    sessionStat.lastActiveAt = Math.max(sessionStat.lastActiveAt, record.time);
  }
  const promptTokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const modelStats = [...modelStatMap.values()].sort((a, b) => b.estimatedCny - a.estimatedCny);
  const sessionStats = [...sessionStatMap.values()].sort((a, b) => (
    b.totalTokens - a.totalTokens || b.lastActiveAt - a.lastActiveAt
  ));
  const sortedRecentRecords = [...records].sort((a, b) => b.time - a.time);
  const recentRecordTotal = sortedRecentRecords.length;
  const recentPageCount = Math.max(1, Math.ceil(recentRecordTotal / recentPageSize));
  const recentPage = Math.min(requestedRecentPage, recentPageCount);
  const recentOffset = (recentPage - 1) * recentPageSize;
  return {
    sourceFound: source.scannedFileCount > 0,
    updatedAt: source.updatedAt,
    range,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    modelFilter,
    availableModels,
    totals,
    totalTokens: totalTokens(totals),
    requestCount: records.length,
    sessionCount: new Set(records.map((record) => record.sessionId)).size,
    cacheHitRate: promptTokens > 0 ? totals.cacheReadTokens / promptTokens : 0,
    estimatedCny,
    estimatedBreakdown: breakdown,
    priceModel: pricing.model,
    priceLabel: DEEPSEEK_PRICES[pricing.model].label,
    priceTier: pricing.tier,
    priceTierLabel: pricing.tierLabel,
    prices: pricing.prices,
    variableOfficialPricing: pricing.tier !== 'custom',
    fallbackPriceCount,
    trend,
    modelStats,
    sessionStats,
    recentRecords: sortedRecentRecords.slice(recentOffset, recentOffset + recentPageSize),
    recentRecordTotal,
    recentPage,
    recentPageSize,
    recentPageCount,
    scannedFileCount: source.scannedFileCount,
    skippedFileCount: source.skippedFileCount,
    pricingUrl: PRICING_URL,
    priceVerifiedOn: PRICE_VERIFIED_ON,
  };
}
