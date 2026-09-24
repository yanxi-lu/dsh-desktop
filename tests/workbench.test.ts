import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePricingRequest } from '../src/main/usage';
import { FLASH_CHANGE, resolveRecordPrice, isDeepSeekPeakTime, validatePriceRules } from '../src/main/pricing-catalog';
import { PreferencesStore, validatePreferences } from '../src/main/preferences';
import { HarnessBridge, safePlugins, safeSessions, redact } from '../src/main/harness-bridge';
import { ManagedInstall, snapshotTree } from '../src/main/managed-install';
import { AlertLedger, budgetAlerts, quietHour } from '../src/main/notifications';
import { getUsageAnalytics, UsageLogIndex, parseSessionLogText } from '../src/main/usage-analytics';
import { csvCell, exportUsage } from '../src/main/usage-export';
import { collectRuntimeDiagnostics, isNewerVersion } from '../src/main/dsh';
import { searchPlugins, pluginUpdates } from '../src/main/plugin-catalog';
import { safeDiagnosticReport } from '../src/main/diagnostics';

const paths: string[] = [];
const fixture = () => { const path = mkdtempSync(join(tmpdir(), 'dsh-workbench-test-')); paths.push(path); return path; };
afterEach(() => { for (const path of paths.splice(0)) { if (dirname(path) !== tmpdir() || !path.includes('dsh-workbench-test-')) throw new Error('Unsafe fixture cleanup'); rmSync(path, { recursive: true, force: true }); } });
const auto = normalizePricingRequest({ tier: 'official-auto' });
const priced = (time: number, model = 'deepseek-v4-flash', provider = 'deepseek') => resolveRecordPrice({ time, provider, model }, auto);

describe('历史价格与待定价口径', () => {
  it('9月调整边界、别名、Pro 持续可用', () => {
    expect(priced(FLASH_CHANGE - 1).prices.outputPerMillionCny).toBe(9);
    expect(priced(FLASH_CHANGE).prices.outputPerMillionCny).toBe(4); // noon offpeak
    const peak = Date.parse('2026-09-11T10:00:00+08:00');
    expect(priced(peak, 'deepseek-flash').prices).toEqual({ cacheHitPerMillionCny: .04, cacheMissPerMillionCny: 2, outputPerMillionCny: 8 });
    expect(priced(Date.parse('2026-09-24T10:00:00+08:00'), 'deepseek-v4-pro').prices.outputPerMillionCny).toBe(27);
  });
  it('周末、节假日、调休周末及跨UTC日', () => {
    for (const date of ['2026-08-22', '2026-09-25', '2026-10-01', '2026-09-20']) expect(isDeepSeekPeakTime(Date.parse(`${date}T10:00:00+08:00`))).toBe(false);
    expect(isDeepSeekPeakTime(Date.parse('2026-09-23T17:00:00Z'))).toBe(false);
    expect(isDeepSeekPeakTime(Date.parse('2026-09-24T02:00:00Z'))).toBe(true);
    expect(priced(Date.parse('2027-01-05T10:00:00+08:00')).warning).toContain('节假日');
  });
  it('未知模型、第三方提供商、缺证据历史不混入官方金额', () => {
    expect(priced(FLASH_CHANGE, 'other-model').unpriced).toBe(true);
    expect(priced(FLASH_CHANGE, 'deepseek-flash', 'reseller').unpriced).toBe(true);
    expect(priced(Date.parse('2026-08-16')).unpriced).toBe(true);
  });
  it('按提供商模型和时间选择自定义规则，拒绝重叠与非法金额', () => {
    const rule = { provider: 'reseller', model: 'm', effectiveFrom: '2026-09-01T00:00:00Z', effectiveUntil: '2026-10-01T00:00:00Z', cacheHitPerMillionCny: 0, cacheMissPerMillionCny: 2, outputPerMillionCny: 3 };
    const rules = validatePriceRules([rule]);
    expect(resolveRecordPrice({ provider: 'reseller', model: 'm', time: FLASH_CHANGE }, auto, rules).prices.outputPerMillionCny).toBe(3);
    expect(resolveRecordPrice({ provider: 'reseller', model: 'm', time: Date.parse(rule.effectiveUntil) }, auto, rules).unpriced).toBe(true);
    expect(() => validatePriceRules([rule, rule])).toThrow('重叠');
    expect(() => validatePriceRules([{ ...rule, outputPerMillionCny: -1 }])).toThrow();
  });
});

describe('官方 V4 日志及完整性', () => {
  const at = Date.parse('2026-09-24T10:00:00+08:00');
  const header = { type: 'session', id: 's1', version: 4, createdAt: at };
  const ctx = { type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-flash' } };
  const attempt = (n: number) => ({ type: 'assistant/attempt', time: at, data: { turn: 1, step: 0, stream: [{ type: 'text-chunks', texts: ['PRIVATE_CONTENT'] }, { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: n, outputTokens: 3 } } }] } });
  const lines = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  it('读取 compact stream，重试独立累加，同一次请求最后用量覆盖', () => {
    const parsed = parseSessionLogText(lines([header, ctx, attempt(10), attempt(20), { type: 'llm/retry-started', data: { turn: 1, step: 0 } }, attempt(5)]));
    expect(parsed.records.map(r => r.uncachedInputTokens)).toEqual([20, 5]);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_CONTENT');
  });
  it('分叉会话继承的历史请求不二次计费', () => {
    const parsed = parseSessionLogText(lines([{ ...header, isSeeded: true, parentSession: 'parent' }, ctx, attempt(1000),
      { type: 'session/end-seed', data: { inherited: true } }, attempt(5)]));
    expect(parsed.records.map(r => r.uncachedInputTokens)).toEqual([5]);
  });
  it('只选最高日志代际，未知代际和损坏行标记不完整；重建不改原日志', () => {
    const root = fixture(), dir = join(root, 's1'); mkdirSync(dir);
    const old = join(dir, 'session.jsonl'), file = join(dir, 'session.v4.jsonl');
    writeFileSync(old, lines([header, ctx, attempt(100)])); writeFileSync(file, lines([header, ctx, attempt(10), { type: 'turn/end', time: at, seq: 9, data: { reason: { kind: 'completed' } } }]) + '{bad}\n');
    const index = new UsageLogIndex(join(root, 'index'));
    const summary = getUsageAnalytics({}, { range: 'today', pricing: { tier: 'official-auto' } }, root, at + 1000, index);
    expect(summary.totals.uncachedInputTokens).toBe(10); expect(summary.completeness).toBe('partial'); expect(summary.indexStatus.invalidLines).toBe(1);
    expect(summary.taskEvents[0]).toMatchObject({ kind: 'completed', seq: 9 });
    index.rebuild(); expect(existsSync(old)).toBe(true); expect(readFileSync(file, 'utf8')).toContain('PRIVATE_CONTENT');
    writeFileSync(join(dir, 'session.v5.jsonl'), lines([{ ...header, version: 5 }]));
    const next = getUsageAnalytics({}, {}, root, at, index); expect(next.indexStatus.unsupportedFiles).toBe(1); expect(next.completeness).toBe('partial');
  });
  it('会话过滤与导出对齐，不以分页截断全部调用导出', () => {
    const root = fixture();
    for (const id of ['s1', 's2']) { mkdirSync(join(root, id)); writeFileSync(join(root, id, 'session.v4.jsonl'), lines([{ ...header, id }, ctx, ...Array.from({ length: 30 }, (_, i) => ({ type: 'assistant/message', time: at, data: { turn: i, step: 0, usage: { inputTokens: 10 } } }))])); }
    const all = getUsageAnalytics({}, { range: 'today', sessionFilter: 's2', pricing: { tier: 'official-auto' } }, root, at + 1, undefined, true);
    expect(all.requestCount).toBe(30); expect(all.recentRecords).toHaveLength(30); expect(all.sessionStats.map(s => s.sessionId)).toEqual(['s2']);
    const json = JSON.parse(exportUsage(all, 'json')); expect(json.metadata.session).toBe('s2'); expect(json.calls).toHaveLength(30); expect(json.totals).toEqual(all.totals);
    expect(exportUsage(all, 'csv')).toContain('ruleVersion');
    expect(json.metadata.priceUnit).toBe('CNY per million tokens');
    expect(json.metadata.customPriceRules).toEqual([]);
  });
  it('上一等长时段和未定价模型汇总明确区分', () => {
    const root = fixture(), dir = join(root, 's1'); mkdirSync(dir);
    const file = join(dir, 'session.v4.jsonl');
    const now = new Date(2026, 8, 24, 10).getTime();
    const previous = new Date(2026, 8, 23, 20).getTime();
    writeFileSync(file, lines([header, ctx, { type: 'assistant/message', time: previous, data: { turn: 1, step: 0, usage: { inputTokens: 10 } } },
      { type: 'request/context', data: { provider: 'reseller', model: 'unknown' } },
      { type: 'assistant/message', time: now, data: { turn: 2, step: 0, usage: { inputTokens: 20 } } }]));
    const summary = getUsageAnalytics({}, { range: 'today' }, root, now);
    expect(summary.comparison.totalTokens).toBe(10);
    expect(summary.comparison.tokenChangeRatio).toBe(1);
    expect(summary.comparison.costChangeRatio).toBeNull();
    expect(summary.modelStats[0].unpricedCount).toBe(1);
    expect(summary.sessionStats[0].unpricedCount).toBe(1);
  });
});

describe('配置、导出和提醒', () => {
  it('持久化回读、备份白名单、无效输入不覆盖旧设置', () => {
    const file = join(fixture(), 'settings.json'), store = new PreferencesStore(file);
    store.set({ ...store.get(), theme: 'dark', budgets: { daily: 20 }, apiKey: 'NEVER_EXPORT' });
    expect(new PreferencesStore(file).get().theme).toBe('dark'); expect(readFileSync(file, 'utf8')).not.toContain('NEVER_EXPORT');
    expect(() => store.set({ ...store.get(), budgets: { daily: -2 } })).toThrow(); expect(store.get().budgets.daily).toBe(20);
    const copy = store.get(); copy.theme = 'light'; expect(store.get().theme).toBe('dark');
    expect(() => validatePreferences({ version: 9 })).toThrow();
  });
  it('CSV 转义公式和换行；诊断隐藏路径和凭据', () => {
    for (const value of ['=SUM(A1)', ' @evil', '\t+foo', '-formula']) expect(csvCell(value)).toMatch(/^"'/);
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(redact('C:\\Users\\private\\file token=secret sk-secret123456 Bearer abc')).not.toMatch(/private|secret|abc/);
    const report = safeDiagnosticReport({ path: 'C:\\Users\\Private Name\\file', unc: '\\\\server\\share\\Private Name', url: 'https://registry.npmjs.org', key: 'token=private-key' });
    expect(JSON.parse(report).url).toBe('https://registry.npmjs.org');
    expect(report).not.toMatch(/Private|private-key|server|share/);
  });
  it('预算80/100阈值分别去重，跨天恢复；免打扰不会消耗提醒', () => {
    const file = join(fixture(), 'alerts.json'), now = new Date(2026, 8, 24, 12), prefs = validatePreferences({ notifications: { enabled: true, quietStart: 22, quietEnd: 8 }, budgets: { daily: 10, monthly: 100 } });
    const ledger = new AlertLedger(file), alerts = budgetAlerts(10, 90, prefs.budgets, now);
    expect(alerts).toHaveLength(3); expect(ledger.take(alerts, prefs.notifications, new Date(2026, 8, 24, 23))).toHaveLength(0);
    expect(ledger.take(alerts, prefs.notifications, now)).toHaveLength(3); expect(new AlertLedger(file).take(alerts, prefs.notifications, now)).toHaveLength(0);
    expect(quietHour(12, 0, 0)).toBe(false);
  });
});

describe('官方适配与安装管理', () => {
  it('兼容旧状态，不再依赖快照恢复，也不改变当前数据目录', async () => {
    const root = fixture(), home = join(root, 'home'), runtime = join(root, 'runtime'); mkdirSync(home); mkdirSync(runtime);
    const installation = { bin: join(root, 'current.cmd'), home, version: '0.1.7-rc.1' };
    writeFileSync(join(runtime, 'state.json'), JSON.stringify({ active: installation, previous: installation, pending: true, backup: join(root, 'missing') }));
    const manager = new ManagedInstall(runtime, {});
    await manager.confirm();
    expect(manager.home()).toBe(home);
    expect(manager.info().pending).toBe(false);
    expect(JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'))).not.toHaveProperty('backup');
    expect(JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'))).not.toHaveProperty('previous');
  });
  it('latest 指向较低版本时不误报为可升级', () => {
    expect(isNewerVersion('0.1.1-rc.2', '0.1.2-alpha.3')).toBe(false);
    expect(isNewerVersion('0.1.7-rc.1', '0.1.2-alpha.3')).toBe(true);
    expect(isNewerVersion('0.1.7-rc.1', '0.1.7-rc.1')).toBe(false);
    expect(isNewerVersion('invalid', '0.1.7-rc.1')).toBe(false);
  });
  it('外部链接不会被复制或指向原数据', async () => {
    const root = fixture(), home = join(root, 'home'), other = join(root, 'other'); mkdirSync(home); mkdirSync(other);
    const link = join(home, 'external'); symlinkSync(other, link, 'junction');
    try { await expect(snapshotTree(home, join(root, 'backup'))).rejects.toThrow('外部'); }
    finally { unlinkSync(link); }
  });
  it('运行状态写盘失败时保留原内存选择', async () => {
    const root = fixture(), home = join(root, 'home'), runtime = join(root, 'runtime'); mkdirSync(home);
    const manager = new ManagedInstall(runtime, { DSH_HOME: home, DSH_BIN: join(root, 'old.cmd') });
    await manager.activate({ bin: join(root, 'new.cmd'), home, version: '0.1.7-rc.1' });
    mkdirSync(join(runtime, 'state.json.tmp'));
    await expect(manager.setPort(12345)).rejects.toThrow();
    expect(manager.info().port).toBe(3080);
    await expect(manager.activate({ bin: join(root, 'old.cmd'), home, version: '0.1.1-rc.2' })).rejects.toThrow();
    expect(manager.env().DSH_BIN).toBe(join(root, 'new.cmd'));
    expect(manager.home()).toBe(home);
    expect(new ManagedInstall(runtime, {}).home()).toBe(home);
  });
  it('备份不遍历 pnpm 内部链接，目标重定向到副本而不是原数据', async () => {
    const root = fixture(), home = join(root, 'home'), backup = join(root, 'backup'); mkdirSync(home); mkdirSync(join(home, 'store'));
    writeFileSync(join(home, 'store', 'package.json'), '{}');
    const link = join(home, 'pkg'); symlinkSync(join(home, 'store'), link, 'junction');
    try { await snapshotTree(home, backup); expect(readlinkSync(join(backup, 'pkg'))).toContain('backup');
      expect(readFileSync(join(backup, 'pkg', 'package.json'), 'utf8')).toBe('{}');
    } finally { unlinkSync(link); if (existsSync(join(backup, 'pkg'))) unlinkSync(join(backup, 'pkg')); }
  });
  it('错误分类不保留原始启动日志、路径或凭据', () => {
    const reports: any[] = [];
    collectRuntimeDiagnostics('EADDRINUSE sk-private-secret C:\\private\\data ENOENT', reports);
    expect(reports.map(r => r.code)).toEqual(['port-in-use', 'missing-path']);
    expect(JSON.stringify(reports)).not.toMatch(/private|secret/);
  });
  it('npm 发现只返回公开字段，更新比较不将低版本误判升级', async () => {
    const results = await searchPlugins('browser', async () => new Response(JSON.stringify({ objects: [
      { package: { name: '@demo/pkg', version: '1.2.0', description: 'A plugin', publisher: { username: 'demo' }, credentials: 'PRIVATE' } },
      { package: { name: 'pkg; bad' } },
    ] })));
    expect(results).toHaveLength(1); expect(JSON.stringify(results)).not.toContain('PRIVATE');
    const list = safePlugins([{ name: '@demo/pkg', version: '1.2.0' }]);
    expect((await pluginUpdates(list, async () => new Response(JSON.stringify({ version: '1.1.0' }))))[0].newer).toBe(false);
    expect((await pluginUpdates(list, async () => new Response(JSON.stringify({ version: '1.3.0' }))))[0].newer).toBe(true);
  });
  it('官方会话和插件响应只提取允许字段', () => {
    expect(safeSessions({ items: [{ sessionId: 's', cwd: 'PRIVATE_PATH', projections: { values: { title: '标题', inbox: 'PRIVATE_TEXT' } } }] })).toEqual([{ sessionId: 's', title: '标题', running: false, updatedAt: 0 }]);
    expect(JSON.stringify(safePlugins([{ name: 'pkg', config: { key: 'PRIVATE_KEY' } }]))).not.toContain('PRIVATE_KEY');
  });
  it('使用准确的 RPC 信封和认证origin，拒绝任意来源及包命令', async () => {
    const requests: any[] = [];
    const bridge = new HarnessBridge(() => 'http://127.0.0.1:3080/?token=PRIVATE', async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ result: { ok: true, value: { items: [] } } }), { status: 200 }); });
    await bridge.sessions(); expect(requests[0].url).toBe('http://127.0.0.1:3080/api/session/list');
    expect(JSON.parse(requests[0].options.body).payload).toEqual({ args: { _request: {} } });
    expect(() => bridge.validateSpec('pkg; calc.exe')).toThrow(); expect(() => bridge.validateSpec('https://bad/pkg')).toThrow();
    expect(() => bridge.validateSpec('@trusted/plugin@1.2.3')).not.toThrow();
    await expect(new HarnessBridge(() => 'http://evil.test', fetch).sessions()).rejects.toThrow('本机');
  });
  it('切换安装不生成数据快照、不回滚数据，保持数据目录和持久化选择', async () => {
    const root = fixture(), home = join(root, 'home'), managedRoot = join(root, 'runtime'); mkdirSync(home);
    writeFileSync(join(home, 'original.json'), 'before');
    const manager = new ManagedInstall(managedRoot, { DSH_BIN: join(root, 'old.cmd'), DSH_HOME: home });
    await manager.activate({ bin: join(root, 'new.cmd'), home, version: '0.1.7-rc.1' });
    expect(manager.info().pending).toBe(true);
    writeFileSync(join(home, 'original.json'), 'migrated'); writeFileSync(join(home, 'after.json'), 'keep');
    await manager.confirm();
    expect(manager.home()).toBe(home); expect(readFileSync(join(manager.home(), 'original.json'), 'utf8')).toBe('migrated');
    expect(readFileSync(join(home, 'after.json'), 'utf8')).toBe('keep'); expect(manager.env().DSH_BIN).toBe(join(root, 'new.cmd'));
    expect(existsSync(join(managedRoot, 'backups'))).toBe(false);
    expect(new ManagedInstall(managedRoot, {}).home()).toBe(manager.home());
    await expect(snapshotTree(home, join(home, 'bad-backup'))).rejects.toThrow('原数据目录');
  });
});
