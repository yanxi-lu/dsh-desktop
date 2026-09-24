// Harness 本机会话用量分析。
// 只从 Harness 会话日志提取时间、provider、model 与 usage 元数据；
// 不保存、不返回提示词、回复正文、工具参数、工作目录或凭据。
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { zstdDecompressSync } from 'node:zlib';
import { resolveRecordPrice, validatePriceRules, RULE_VERSION, type CustomPriceRule } from './pricing-catalog';
export { isDeepSeekPeakTime } from './pricing-catalog';
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
  priceRule: string;
  unpriced: boolean;
}

export interface ParsedSessionLog {
  sessionId: string;
  records: RawUsageRecord[];
  formatVersion?: number;
  invalidLines?: number;
  taskState?: { kind: 'running' | 'completed' | 'error' | 'attention' | 'stopped'; time: number; seq: number };
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
  unpricedCount: number;
}

export interface UsageSessionStat extends UsageTotals {
  sessionId: string;
  providers: string[];
  models: string[];
  requestCount: number;
  totalTokens: number;
  estimatedCny: number;
  unpricedCount: number;
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
  sessionFilter?: unknown;
  priceRules?: unknown;
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
  ruleVersion: string;
  customPriceRules: CustomPriceRule[];
  sessionFilter: string;
  unpricedCount: number;
  warnings: string[];
  completeness: 'complete' | 'partial' | 'empty';
  taskEvents: Array<{ sessionId: string; kind: string; time: number; seq: number }>;
  priceSimulation: boolean;
  comparison: { start: string; end: string; requestCount: number; totalTokens: number; estimatedCny: number; unpricedCount: number; cacheHitRate: number; tokenChangeRatio: number | null; costChangeRatio: number | null; cacheHitChangePoints: number };
  indexStatus: { durationMs: number; bytesRead: number; parsedFiles: number; reusedFiles: number; incrementalFiles: number; cacheBytes: number; unsupportedFiles: number; invalidLines: number; formats: number[] };
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

interface SessionParserState extends ParsedSessionLog {
  fallbackTime: number;
  provider: string;
  model: string;
  lastSample: { turn: number; step: number; index: number; totals: UsageTotals } | null;
  inheriting?: boolean;
}

function parseSessionLogChunks(
  chunks: Iterable<string>,
  fallbackSessionId = 'unknown',
  previous?: SessionParserState,
): { state: SessionParserState; resumable: boolean } {
  let sessionId = previous?.sessionId ?? fallbackSessionId;
  let fallbackTime = previous?.fallbackTime ?? 0;
  let provider = previous?.provider ?? '未标注';
  let model = previous?.model ?? '未标注';
  let pending = '';
  let lastSample = previous?.lastSample ? { ...previous.lastSample } : null;
  let formatVersion = previous?.formatVersion ?? 0;
  let invalidLines = previous?.invalidLines ?? 0;
  let taskState = previous?.taskState;
  let inheriting = previous?.inheriting ?? false;
  const records: RawUsageRecord[] = previous ? previous.records.slice() : [];

  function consumeLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) return;
      event = parsed;
    } catch {
      invalidLines++;
      return;
    }
    if (event.type === 'session') {
      sessionId = safeText(event.id, sessionId);
      fallbackTime = safeToken(event.createdAt);
      formatVersion = safeToken(event.version);
      inheriting = event.isSeeded === true;
      return;
    }
    if (formatVersion > 4) return;
    const data = asRecord(event.data);
    if (!data) return;
    // Fork seeds repeat the parent's history, not new billable requests.
    if (inheriting && event.type === 'session/end-seed' && data.inherited === true) { inheriting = false; lastSample = null; return; }
    if (inheriting) {
      if (event.type === 'request/context') { provider = safeText(data.provider, provider); model = safeText(data.model, model); }
      return;
    }
    if (['turn/start', 'turn/end', 'approval/asked', 'approval/decided'].includes(String(event.type))) {
      const reason = asRecord(data.reason)?.kind ?? data.reason;
      const kind = event.type === 'turn/start' || event.type === 'approval/decided' ? 'running'
        : event.type === 'approval/asked' ? 'attention' : reason === 'completed' ? 'completed' : reason === 'error' ? 'error'
          : reason === 'blocked' ? 'attention' : 'stopped';
      taskState = { kind, time: safeToken(event.time), seq: safeToken(event.seq) };
    }
    if (event.type === 'llm/retry-started') {
      if (lastSample?.turn === data.turn && lastSample?.step === data.step) lastSample = null;
      return;
    }
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
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      usageValue = data.usage;
      // V2–V4 durable settlements carry the last reported usage in stream chunks.
      if (!usageValue && Array.isArray(data.stream)) {
        for (let i = data.stream.length - 1; i >= 0; i--) {
          const item = asRecord(data.stream[i]);
          const chunk = item?.type === 'chunk' ? asRecord(item.chunk) : item;
          if (chunk?.type === 'usage') { usageValue = chunk.usage; break; }
        }
      }
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
  // 未结束的 JSON 行不进入缓存；下次从头读取这种少见的跨帧/半行日志。
  const resumable = pending.length === 0;
  if (pending.trim()) consumeLine(pending);
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].sessionId !== sessionId) records[i] = { ...records[i], sessionId };
  }
  return { state: { sessionId, records, fallbackTime, provider, model, lastSample, formatVersion, invalidLines, taskState, inheriting }, resumable };
}

/** 用于明文旧日志与单元测试；压缩日志走逐帧解码。 */
export function parseSessionLogText(text: string, fallbackSessionId?: string): ParsedSessionLog {
  const { state } = parseSessionLogChunks([text], fallbackSessionId);
  return { sessionId: state.sessionId, records: state.records, formatVersion: state.formatVersion, invalidLines: state.invalidLines };
}

interface CachedSessionLog {
  signature: string;
  identity: string;
  size: number;
  offset: number;
  guard: string;
  resumable: boolean;
  state: SessionParserState;
}

export function sessionLogsRoot(env: NodeJS.ProcessEnv): string {
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
    const candidates = entries.filter(entry => entry.isFile() && /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(entry.name))
      .sort((a, b) => Number(b.name.match(/\.v(\d+)/)?.[1] ?? 0) - Number(a.name.match(/\.v(\d+)/)?.[1] ?? 0)
        || Number(b.name.endsWith('.zstd')) - Number(a.name.endsWith('.zstd')));
    if (candidates.length) files.push(join(directory, candidates[0].name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
    }
  }
  return files;
}

interface UsageSource {
  records: RawUsageRecord[];
  scannedFileCount: number;
  skippedFileCount: number;
  updatedAt: string | null;
  unsupportedFiles: number;
  invalidLines: number;
  formats: number[];
  taskEvents: UsageAnalyticsSummary['taskEvents'];
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function fileSignature(stat: Stats): string {
  return `${fileIdentity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** 一个长期驻留的索引；仅缓存用量元数据，不保留解压文本或对话正文。 */
export class UsageLogIndex {
  private entries = new Map<string, CachedSessionLog>();
  private root = '';
  private cacheFile: string | undefined;
  lastRead = { bytesRead: 0, parsedFiles: 0, reusedFiles: 0, incrementalFiles: 0 };

  constructor(private readonly cacheDirectory?: string) {}

  private load(root: string): void {
    if (this.root === root) return;
    this.root = root;
    this.entries.clear();
    this.cacheFile = this.cacheDirectory ? join(this.cacheDirectory, `${digest(root)}.json`) : undefined;
    if (!this.cacheFile) return;
    try {
      if (statSync(this.cacheFile).size > 128 * 1024 * 1024) return;
      const text = readFileSync(this.cacheFile, 'utf8');
      const separator = text.indexOf('\n');
      const payload = text.slice(separator + 1);
      if (separator !== 64 || digest(payload) !== text.slice(0, separator)) return;
      const saved = JSON.parse(payload);
      if (saved.version !== 4 || !Array.isArray(saved.entries)) return;
      this.entries = new Map(saved.entries);
    } catch {
      // 缓存丢失或损坏时重建，不能影响原始会话日志。
    }
  }

  private save(): void {
    if (!this.cacheFile) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      const payload = JSON.stringify({ version: 4, entries: [...this.entries] });
      writeFileSync(`${this.cacheFile}.tmp`, `${digest(payload)}\n${payload}`, { mode: 0o600 });
      renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    } catch {
      // 磁盘缓存不可写时仍使用内存索引。
    }
  }

  /** Only our disposable metadata index is invalidated. Source logs are never changed. */
  rebuild(): void { this.entries.clear(); this.save(); }
  cacheBytes(): number { try { return this.cacheFile ? statSync(this.cacheFile).size : 0; } catch { return 0; } }

  private readBytes(fd: number, start: number, size: number): Buffer {
    const buffer = Buffer.allocUnsafe(size);
    let count = 0;
    while (count < size) {
      const read = readSync(fd, buffer, count, size - count, start + count);
      if (!read) throw new Error('日志正在截断或替换，请刷新重试');
      count += read;
    }
    this.lastRead.bytesRead += count;
    return buffer;
  }

  private guard(fd: number, end: number): string {
    const size = Math.min(4096, end);
    return createHash('sha256')
      .update(this.readBytes(fd, 0, size))
      .update(this.readBytes(fd, end - size, size))
      .digest('hex');
  }

  private parse(filePath: string, previous?: CachedSessionLog): CachedSessionLog {
    const fd = openSync(filePath, 'r');
    try {
      const stat = fstatSync(fd);
      const incremental = previous?.resumable
        && fileIdentity(stat) === previous.identity
        && stat.size > previous.size
        && this.guard(fd, previous.offset) === previous.guard;
      let offset = incremental ? previous.offset : 0;
      const compressed = filePath.toLowerCase().endsWith('.zstd');
      const reader = this;
      function* chunks(): Generator<string> {
        let pending = Buffer.alloc(0);
        const decoder = new StringDecoder('utf8');
        for (let position = offset; position < stat.size;) {
          const chunk = reader.readBytes(fd, position, Math.min(256 * 1024, stat.size - position));
          position += chunk.length;
          if (!compressed) {
            offset = position;
            yield decoder.write(chunk);
            continue;
          }
          const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          const frames = scanZstdFrames(buffer);
          let consumed = 0;
          // 逐帧释放解压文本，避免一次展开整场会话产生数百 MB 的临时对象。
          for (const frame of frames) {
            yield decoder.write(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
            consumed = frame.end;
          }
          offset += consumed;
          pending = Buffer.from(buffer.subarray(consumed));
        }
        yield decoder.end();
      }
      const result = parseSessionLogChunks(chunks(), basename(dirname(filePath)), incremental ? previous.state : undefined);
      const after = fstatSync(fd);
      if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) {
        throw new Error('日志正在替换，请刷新重试');
      }
      this.lastRead.parsedFiles += 1;
      if (incremental) this.lastRead.incrementalFiles += 1;
      return {
        signature: fileSignature(stat), identity: fileIdentity(stat), size: stat.size,
        offset, guard: this.guard(fd, offset), ...result,
      };
    } finally {
      closeSync(fd);
    }
  }

  read(rootValue: string): UsageSource {
    const root = resolve(rootValue);
    this.load(root);
    this.lastRead = { bytesRead: 0, parsedFiles: 0, reusedFiles: 0, incrementalFiles: 0 };
    const records: RawUsageRecord[] = [];
    let skippedFileCount = 0;
    let unsupportedFiles = 0, invalidLines = 0;
    const formats = new Set<number>();
    const taskEvents: UsageAnalyticsSummary['taskEvents'] = [];
    let updatedMillis = 0;
    let files: string[];
    try {
      files = findSessionLogs(root);
    } catch (error) {
      return { records, scannedFileCount: 0, skippedFileCount: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : 1, updatedAt: null, unsupportedFiles, invalidLines, formats: [], taskEvents };
    }
    // 文件路径只用于计算缓存键，磁盘缓存不记录工作目录。
    const currentFiles = new Set(files.map(digest));
    let changed = false;
    for (const key of this.entries.keys()) {
      if (!currentFiles.has(key)) { this.entries.delete(key); changed = true; }
    }
    for (const filePath of files) {
      try {
        const stat = statSync(filePath);
        const fileVersion = Number(basename(filePath).match(/\.v(\d+)/)?.[1] ?? 0);
        if (fileVersion > 4) { unsupportedFiles++; formats.add(fileVersion); continue; }
        updatedMillis = Math.max(updatedMillis, stat.mtimeMs);
        const key = digest(filePath);
        let cached = this.entries.get(key);
        if (!cached || cached.signature !== fileSignature(stat)) {
          cached = this.parse(filePath, cached);
          this.entries.set(key, cached);
          changed = true;
        } else {
          this.lastRead.reusedFiles += 1;
        }
        formats.add(cached.state.formatVersion ?? fileVersion);
        if ((cached.state.formatVersion ?? 0) > 4) { unsupportedFiles++; continue; }
        invalidLines += cached.state.invalidLines ?? 0;
        if (cached.state.taskState) taskEvents.push({ sessionId: cached.state.sessionId, ...cached.state.taskState });
        // 不使用展开参数，长会话也不会触发 maximum call stack size。
        for (const record of cached.state.records) records.push(record);
      } catch {
        skippedFileCount += 1;
      }
    }
    if (changed) this.save();
    return {
      records, scannedFileCount: files.length - skippedFileCount - unsupportedFiles, skippedFileCount,
      unsupportedFiles, invalidLines, formats: [...formats].sort(), taskEvents,
      updatedAt: updatedMillis ? new Date(updatedMillis).toISOString() : null,
    };
  }
}

const defaultLogIndex = new UsageLogIndex();

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
  index: UsageLogIndex = defaultLogIndex,
  includeAllRecords = false,
): UsageAnalyticsSummary {
  const started = performance.now();
  const request = asRecord(requestValue) ?? {};
  const range = normalizeUsageDateRange(request.range);
  const bounds = resolveDateBounds(range, request, now);
  const requestedFilter = typeof request.modelFilter === 'string' ? request.modelFilter : 'all';
  const requestedRecentPage = positiveInteger(request.recentPage, 1);
  const recentPageSize = normalizeRecentPageSize(request.recentPageSize);
  const pricing = normalizePricingRequest(request.pricing);
  const priceRules = validatePriceRules(request.priceRules);
  const sessionFilter = typeof request.sessionFilter === 'string' ? request.sessionFilter : '';
  const warnings = new Set<string>();
  const source = index.read(root);
  const priceSimulation = asRecord(request.pricing)?.currentPrices === true;
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
      && (!sessionFilter || record.sessionId === sessionFilter)
  ));

  const totals = { ...ZERO_TOTALS };
  const breakdown = { cacheHitCny: 0, cacheMissCny: 0, outputCny: 0 };
  const records: UsageRecord[] = [];
  let fallbackPriceCount = 0;
  for (const record of selected) {
    addTotals(totals, record);
    const resolved = resolveRecordPrice(record, pricing, priceRules, priceSimulation);
    if (resolved.unpriced) fallbackPriceCount += 1;
    if (resolved.warning) warnings.add(resolved.warning);
    const estimate = estimateDeepSeekCost(record, resolved.prices);
    breakdown.cacheHitCny += estimate.cacheHitCny;
    breakdown.cacheMissCny += estimate.cacheMissCny;
    breakdown.outputCny += estimate.outputCny;
    records.push({ ...record, estimatedCny: estimate.totalCny, priceRule: resolved.rule, unpriced: resolved.unpriced });
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
        unpricedCount: 0,
        ...ZERO_TOTALS,
      };
      modelStatMap.set(groupKey, stat);
    }
    addTotals(stat, record);
    stat.requestCount += 1;
    stat.totalTokens += totalTokens(record);
    stat.estimatedCny += record.estimatedCny;
    if (record.unpriced) stat.unpricedCount++;

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
        unpricedCount: 0,
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
    if (record.unpriced) sessionStat.unpricedCount++;
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
  const previousStart = bounds.start - (bounds.end - bounds.start + 1);
  const previousTotals = { ...ZERO_TOTALS };
  let previousCost = 0, previousCount = 0, previousUnpriced = 0;
  for (const record of source.records) {
    if (record.time < previousStart || record.time >= bounds.start || (sessionFilter && record.sessionId !== sessionFilter)
      || (modelFilter !== 'all' && modelKey(record.provider, record.model) !== modelFilter)) continue;
    previousCount++; addTotals(previousTotals, record);
    const price = resolveRecordPrice(record, pricing, priceRules, priceSimulation);
    if (price.unpriced) previousUnpriced++; else previousCost += estimateDeepSeekCost(record, price.prices).totalCny;
  }
  const previousPrompt = previousTotals.uncachedInputTokens + previousTotals.cacheReadTokens + previousTotals.cacheWriteTokens;
  const previousHitRate = previousPrompt ? previousTotals.cacheReadTokens / previousPrompt : 0;
  const previousTokens = totalTokens(previousTotals);
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
    recentRecords: includeAllRecords ? sortedRecentRecords : sortedRecentRecords.slice(recentOffset, recentOffset + recentPageSize),
    recentRecordTotal,
    recentPage,
    recentPageSize,
    recentPageCount,
    scannedFileCount: source.scannedFileCount,
    skippedFileCount: source.skippedFileCount,
    pricingUrl: PRICING_URL,
    priceVerifiedOn: PRICE_VERIFIED_ON,
    sessionFilter,
    ruleVersion: RULE_VERSION,
    customPriceRules: priceRules,
    unpricedCount: fallbackPriceCount,
    warnings: [...warnings],
    taskEvents: source.taskEvents,
    priceSimulation,
    comparison: { start: new Date(previousStart).toISOString(), end: new Date(bounds.start - 1).toISOString(), requestCount: previousCount,
      totalTokens: previousTokens, estimatedCny: previousCost, unpricedCount: previousUnpriced, cacheHitRate: previousHitRate,
      tokenChangeRatio: previousTokens ? (totalTokens(totals) - previousTokens) / previousTokens : null,
      costChangeRatio: previousCost && !previousUnpriced && !fallbackPriceCount ? (estimatedCny - previousCost) / previousCost : null,
      cacheHitChangePoints: (promptTokens ? totals.cacheReadTokens / promptTokens : 0) * 100 - previousHitRate * 100 },
    completeness: source.skippedFileCount || source.unsupportedFiles || source.invalidLines ? 'partial' : source.scannedFileCount ? 'complete' : 'empty',
    indexStatus: { ...index.lastRead, durationMs: Math.round(performance.now() - started), cacheBytes: index.cacheBytes(),
      unsupportedFiles: source.unsupportedFiles, invalidLines: source.invalidLines, formats: source.formats },
  };
}
