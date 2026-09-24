// 使用独立、隐藏的 Electron 测试窗口；不启动 Harness，不查询余额/网络。
// electron scripts/smoke-usage-ui.cjs [--packaged]
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const root = resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const appRoot = packaged ? join(root, 'release', 'win-unpacked', 'resources', 'app.asar') : root;
const { UsageAnalyticsService } = require(join(appRoot, 'dist', 'main', 'usage-service.js'));
const { getUsageAnalytics } = require(join(appRoot, 'dist', 'main', 'usage-analytics.js'));
const { PreferencesStore } = require(join(appRoot, 'dist', 'main', 'preferences.js'));
const temporary = mkdtempSync(join(tmpdir(), 'dsh-usage-ui-'));
app.setPath('userData', join(temporary, 'profile'));

// 合成大列表用于可重复的分页和交互验证；真实日志性能另由 check-usage-performance 测量。
const source = join(temporary, 'sessions');
const now = Date.now();
for (let i = 0; i < 80; i++) {
  const directory = join(source, String(i));
  mkdirSync(directory, { recursive: true });
  const events = [
    { type: 'session', id: `fixture-${i}`, createdAt: now },
    { type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
    ...Array.from({ length: 30 }, (_, turn) => ({ type: 'assistant/message', time: now,
      data: { turn, step: 0, usage: { inputTokens: 100 + i, outputTokens: 10 } } })),
  ];
  writeFileSync(join(directory, 'session.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
}

const service = new UsageAnalyticsService({ root: source, cacheDirectory: join(temporary, 'index') });
const preferences = new PreferencesStore(join(temporary, 'preferences.json'));
let calls = 0;
let delayNext = false;
let lastSummary;
ipcMain.handle('usage:get', async (_event, request) => {
  calls++;
  if (delayNext) { delayNext = false; await new Promise(resolve => setTimeout(resolve, 120)); }
  lastSummary = await service.get({ ...request, priceRules: preferences.get().priceRules });
  return lastSummary;
});
ipcMain.handle('dsh:versions', async () => ({ current: '0.1.7-rc.1', latest: '0.1.5-rc.3', versions: ['0.1.7-rc.1', '0.1.5-rc.3'] }));
ipcMain.handle('balance:get', async () => ({ ok: false, error: '测试窗口不查询账户余额' }));
ipcMain.handle('desktop:settings-get', () => preferences.get());
ipcMain.handle('desktop:settings-save', (_e, value) => preferences.set(value));
const budget = async () => { const summary = await service.get({ range: 'today', pricing: { tier: 'official-auto' } }); return { today: summary.estimatedCny, month: summary.estimatedCny, tokensToday: summary.totalTokens,
  budgets: preferences.get().budgets, completeness: summary.completeness, unpricedCount: 0, updatedAt: new Date().toISOString(), topSessions: summary.sessionStats.slice(0, 5) }; };
ipcMain.handle('desktop:overview', async () => ({ appVersion: 'test', running: false, runtime: { port: 3080 }, budget: await budget() }));
ipcMain.handle('desktop:budget', budget);
ipcMain.handle('desktop:sessions', () => [{ sessionId: 'fixture-79', title: '真实接口结构样例', running: false }]);
ipcMain.handle('desktop:plugins', () => [{ name: '@test/plugin', title: '测试插件', version: '1.0.0', enabled: true, installed: true, removable: true, error: '' }]);
ipcMain.handle('desktop:diagnose', () => ({ checkedAt: new Date().toISOString(), items: [{ name: 'fixture check', status: 'ok', detail: 'isolated fixture', action: '' }] }));
let exported;
ipcMain.handle('usage:export', async (_e, request, format, section) => { exported = await service.export({ ...request, priceRules: preferences.get().priceRules }, format, section); return { ok: true, path: 'test-export' }; });
ipcMain.handle('usage:rebuild', (_e, request) => service.rebuild(request));

const errors = [];
let window;
const execute = code => window.webContents.executeJavaScript(code);
async function idle() {
  const deadline = performance.now() + 20_000;
  while (await execute('usageRunning')) {
    assert.ok(performance.now() < deadline, 'UI statistics timeout');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
async function until(expression) {
  const deadline = performance.now() + 20_000;
  while (!await execute(expression)) { assert.ok(performance.now() < deadline, `UI wait: ${expression}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: join(appRoot, 'dist', 'main', 'preload.js'), contextIsolation: true,
    sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
  } });
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const start = performance.now();
  await window.loadFile(join(appRoot, 'src', 'renderer', 'management.html'));
  await idle();
  const firstLoadMs = Math.round(performance.now() - start);
  assert.equal(await execute('el.dateRange.value'), 'today');
  assert.equal(lastSummary.requestCount, 2400);
  assert.equal(await execute('el.sessionStatsBody.rows.length'), 25);
  const firstSession = await execute('el.sessionStatsBody.rows[0].textContent');
  const beforeSessionPaging = calls;
  await execute('el.sessionNext.click()');
  assert.notEqual(await execute('el.sessionStatsBody.rows[0].textContent'), firstSession);
  assert.equal(calls, beforeSessionPaging);
  await execute('globalThis.chartUpdates = 0; const set = trendChart.setOption.bind(trendChart); trendChart.setOption = (...args) => { chartUpdates++; return set(...args); }; el.recentNext.click()');
  await idle();
  assert.equal(await execute('recentPage'), 2);
  assert.equal(await execute('chartUpdates'), 0);
  const beforeRapidChange = calls;
  delayNext = true;
  await execute("el.dateRange.value = '7d'; void refreshUsageFromFirstPage(); el.dateRange.value = '30d'; void refreshUsageFromFirstPage(); el.dateRange.value = 'today'; void refreshUsageFromFirstPage();");
  await idle();
  assert.equal(calls - beforeRapidChange, 2);
  assert.equal(lastSummary.range, 'today');
  assert.equal(await execute('el.refreshUsage.disabled'), false);
  assert.equal(await execute('sessionPage'), 1);
  await until("document.querySelector('[data-tab=overview]').getAttribute('aria-current') === 'page'");
  await execute("document.querySelector('[data-tab=settings]').click(); document.getElementById('theme').value = 'dark'; document.getElementById('dailyBudget').value = '25'; document.getElementById('savePreferences').click()");
  await until("!document.getElementById('savePreferences').disabled");
  assert.equal(preferences.get().budgets.daily, 25);
  assert.equal(await execute('document.documentElement.dataset.theme'), 'dark');
  await execute("document.querySelector('[data-tab=sessions]').click()");
  await until("document.getElementById('managedSessions').rows.length === 20");
  await execute("document.getElementById('managedSessions').rows[0].querySelectorAll('button')[1].click(); document.getElementById('labelName').value = '项目演示'; document.getElementById('labelProject').value = '工作'; document.getElementById('labelTags').value = '重点,审计'; document.getElementById('labelSave').click()");
  await until("!document.querySelector('dialog').open");
  assert.equal(Object.values(preferences.get().labels)[0].project, '工作');
  await execute("document.getElementById('sessionSearch').value = '项目演示'; document.getElementById('sessionSearch').dispatchEvent(new Event('input'));");
  assert.equal(await execute("document.getElementById('managedSessions').rows.length"), 1);
  await execute("document.getElementById('managedSessions').rows[0].querySelector('button').click()"); await idle();
  assert.equal(lastSummary.requestCount, 30);
  await execute("document.getElementById('exportJson').click()"); await until("!document.getElementById('exportJson').disabled");
  assert.equal(JSON.parse(exported).calls.length, 30); assert.equal(JSON.parse(exported).metadata.session, lastSummary.sessionFilter);
  await execute("document.getElementById('clearSessionFilter').click()"); await idle();
  assert.equal(lastSummary.requestCount, 2400);
  await execute("document.querySelector('[data-tab=plugins]').click()"); await until("document.querySelectorAll('#pluginList .plugin-card').length === 1");
  await execute("document.querySelector('#pluginList button').click()"); await until("document.querySelector('#pluginList button').textContent === '取消收藏'");
  assert.deepEqual(preferences.get().favorites, ['@test/plugin']);
  await execute("document.querySelector('[data-tab=updates]').click(); document.getElementById('runDiagnostics').click()"); await until("document.querySelectorAll('.diagnostic').length === 1");
  assert.equal(await execute('!!document.getElementById("restoreSnapshot")'), false);
  assert.equal(await execute('document.getElementById("retryCleanup").hidden'), true);
  // Match small desktop windows and Windows/Electron zoom without clipping or wrapping labels.
  const navLayouts = [];
  for (const width of [820, 1040, 1280]) for (const zoom of [1, 1.25, 1.5]) {
    window.setContentSize(width, 820); window.webContents.setZoomFactor(zoom);
    await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const layout = await execute(`Array.from(document.querySelectorAll('.workbench-nav button')).map(button => {
      const label = button.querySelector('.nav-label'), icon = button.querySelector('.nav-icon');
      const b = button.getBoundingClientRect(), l = label.getBoundingClientRect(), i = icon.getBoundingClientRect();
      return { text: label.textContent, singleLine: l.height <= parseFloat(getComputedStyle(label).lineHeight) + 1,
        fits: l.right <= b.right - 4 && i.right < l.left, whiteSpace: getComputedStyle(label).whiteSpace };
    })`);
    assert.equal(layout.length, 6);
    for (const item of layout) { assert.equal(item.singleLine, true, `${width}/${zoom}: ${item.text}`); assert.equal(item.fits, true, `${width}/${zoom}: ${item.text}`); assert.equal(item.whiteSpace, 'nowrap'); }
    navLayouts.push({ width, zoom });
  }
  window.webContents.setZoomFactor(1); window.setContentSize(1040, 820);
  await new Promise(resolve => setTimeout(resolve, 150));
  mkdirSync(join(root, '.artifacts'), { recursive: true });
  writeFileSync(join(root, '.artifacts', packaged ? 'updates-packaged.png' : 'updates-preview.png'), (await window.webContents.capturePage()).toPNG());
  window.setContentSize(1280, 900);
  // 日期过滤和后台统计结果对齐。
  assert.equal(lastSummary.totalTokens, getUsageAnalytics({}, { range: 'today' }, source).totalTokens);
  assert.equal(preferences.get().budgets.daily, 25, 'later edits preserve budgets');
  assert.equal(Object.values(preferences.get().labels)[0].name, '项目演示', 'later edits preserve labels');
  mkdirSync(join(root, '.artifacts'), { recursive: true });
  await execute("document.querySelector('[data-tab=overview]').click(); document.getElementById('refreshOverview').click()");
  await until("!document.getElementById('refreshOverview').disabled");
  await until("document.getElementById('overviewDay').textContent.includes('25.00')");
  await new Promise(resolve => setTimeout(resolve, 150));
  writeFileSync(join(root, '.artifacts', packaged ? 'workbench-packaged.png' : 'workbench-preview.png'), (await window.webContents.capturePage()).toPNG());
  await execute("document.querySelector('[data-tab=usage]').click(); window.usagePage.resize()");
  await new Promise(resolve => setTimeout(resolve, 150));
  writeFileSync(join(root, '.artifacts', 'usage-preview.png'), (await window.webContents.capturePage()).toPNG());
  await execute("el.dateRange.value = 'custom'; el.customStartDate.value = '2026-01-01'; el.customEndDate.value = '2026-01-02'; void refreshUsageFromFirstPage();");
  await idle();
  assert.equal(lastSummary.requestCount, 0);
  assert.equal(await execute('el.sessionPrev.disabled && el.sessionNext.disabled'), true);
  assert.match(await execute('el.sessionStatsBody.textContent'), /暂无/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verified: true, packaged, firstLoadMs,
    requestCount: 2400, sessions: 80, sessionPageSize: 25,
    rapidChangesCoalesced: true, unchangedChartNotRedrawn: true, customEmptyRange: true, workerLoaded: true,
    settingsPersisted: true, sessionLabelsAndSearch: true, sessionDetailExport: true, pluginFavorites: true, diagnosticsRendered: true, navLayouts, noSnapshotRestore: true }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  service.dispose(); window?.destroy(); app.exit(process.exitCode || 0);
});
