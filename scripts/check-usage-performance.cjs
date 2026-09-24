// npm run build 后执行 node scripts/check-usage-performance.cjs。
// 只读本机日志，临时索引放入单独的临时目录；仅输出汇总和耗时。
const assert = require('node:assert/strict');
const { mkdtempSync, readdirSync, rmSync, lstatSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { performance } = require('node:perf_hooks');
const { getUsageAnalytics, UsageLogIndex } = require('../dist/main/usage-analytics');
const { UsageAnalyticsService } = require('../dist/main/usage-service');

async function run() {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-usage-performance-'));
  const source = join(process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME.trim()) : join(homedir(), '.dsh'), 'sessions');
  const cache = join(temporary, 'index');
  const request = { range: '30d', recentPageSize: 10 };
  const now = Date.now();
  const reports = [];
  // Worker wall clock advances while the cold index is being built. Compare
  // actual statistics, not the millisecond start of the equal-duration window.
  const comparable = ({ indexStatus, comparison: { start, ...comparison }, ...summary }) => ({ ...summary, comparison });
  let service;
  let heartbeat;
  try {
    let expected;
    const index = new UsageLogIndex(cache);
    for (const [label, reader] of [['first-index', index], ['repeat', index], ['restart-index', new UsageLogIndex(cache)]]) {
      const start = performance.now();
      const summary = getUsageAnalytics(process.env, request, source, now, reader);
      expected ??= summary;
      assert.deepEqual(comparable(summary), comparable(expected));
      reports.push({ label, ms: Math.round(performance.now() - start), ...reader.lastRead,
        files: summary.scannedFileCount, skipped: summary.skippedFileCount,
        requests: summary.requestCount, tokens: summary.totalTokens,
        rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
    }
    let ticks = 0;
    let maxGap = 0;
    let lastTick = performance.now();
    heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - lastTick); lastTick = now; ticks++; }, 10);
    service = new UsageAnalyticsService({ env: process.env, cacheDirectory: join(temporary, 'worker-index') });
    let start = performance.now();
    const result = await service.get(request);
    assert.deepEqual(comparable(result), comparable(expected));
    maxGap = Math.max(maxGap, performance.now() - lastTick);
    clearInterval(heartbeat);
    reports.push({ label: 'worker-first-index', ms: Math.round(performance.now() - start), heartbeatTicks: ticks, maxMainThreadGapMs: Math.round(maxGap) });
    start = performance.now();
    const nextPage = await service.get({ ...request, recentPage: 2 });
    assert.equal(nextPage.totalTokens, expected.totalTokens);
    reports.push({ label: 'worker-page', ms: Math.round(performance.now() - start) });
    service.dispose();
    service = new UsageAnalyticsService({ env: process.env, cacheDirectory: join(temporary, 'worker-index') });
    start = performance.now();
    assert.deepEqual(comparable(await service.get(request)), comparable(expected));
    reports.push({ label: 'worker-restart', ms: Math.round(performance.now() - start) });
    console.log(JSON.stringify({ verified: true, reports }, null, 2));
  } finally {
    clearInterval(heartbeat);
    service?.dispose();
    // 仅清理本次 mkdtemp 创建的目录，拒绝链接和目录越界。
    assert.equal(dirname(temporary), resolve(tmpdir()));
    const pending = [temporary];
    for (const directory of pending) {
      assert.equal(lstatSync(directory).isSymbolicLink(), false);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) pending.push(join(directory, entry.name));
      }
    }
    rmSync(temporary, { recursive: true });
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
