/* Desktop-only UI. All variable content is inserted with textContent; privileged operations stay in main. */
(() => {
  'use strict';
  const api = window.dshWorkbench, usage = window.usagePage;
  if (!api || !usage) return;
  const $ = id => document.getElementById(id);
  const oldMain = document.querySelector('main');
  const appRoot = document.createElement('div'); appRoot.className = 'workbench';
  appRoot.innerHTML = `<nav class="workbench-nav" aria-label="工作台导航">
    <button data-tab="overview"><span class="nav-icon" aria-hidden="true">◈</span><span class="nav-label">总览</span></button><button data-tab="usage"><span class="nav-icon" aria-hidden="true">▥</span><span class="nav-label">用量与费用</span></button><button data-tab="sessions"><span class="nav-icon" aria-hidden="true">▤</span><span class="nav-label">会话</span></button>
    <button data-tab="plugins"><span class="nav-icon" aria-hidden="true">◇</span><span class="nav-label">插件</span></button><button data-tab="updates"><span class="nav-icon" aria-hidden="true">↻</span><span class="nav-label">更新与诊断</span></button><button data-tab="settings"><span class="nav-icon" aria-hidden="true">⚙</span><span class="nav-label">设置</span></button>
    <p class="nav-note"><span>本机工作台</span><span>本机数据 · 独立加载</span><span id="desktopVersion">桌面工作台</span></p>
  </nav><div class="workbench-pages"></div>`;
  document.body.append(appRoot);
  const pages = appRoot.querySelector('.workbench-pages');
  oldMain.dataset.page = 'usage'; pages.append(oldMain);
  const makePage = (id, html) => { const page = document.createElement('main'); page.dataset.page = id; page.hidden = true; page.innerHTML = html; pages.append(page); return page; };
  makePage('overview', `<div class="wb-head"><div><p class="eyebrow">YOUR LOCAL HARNESS</p><h2>今天的工作概览</h2></div><button id="refreshOverview">刷新概览</button></div>
    <section><div class="section-head"><h2 id="serviceState">正在读取服务状态…</h2><div class="wb-actions"><button id="openHarness">打开 Harness</button><button id="restartHarness">重启服务</button></div></div>
    <div class="wb-metrics"><div class="wb-metric"><span class="label">今日 Tokens</span><strong id="overviewTokens">—</strong><span class="hint">本机日志统计</span></div>
    <div class="wb-metric"><span class="label">今日费用 / 日预算</span><strong id="overviewDay">—</strong><div class="budget-track"><i id="dayProgress"></i></div></div>
    <div class="wb-metric"><span class="label">本月费用 / 月预算</span><strong id="overviewMonth">—</strong><div class="budget-track"><i id="monthProgress"></i></div></div></div>
    <p class="hint" id="overviewFreshness"></p><div id="overviewQueue" class="notice" hidden></div></section>
    <section id="overviewBalance"><div class="section-head"><h2>官方账户余额</h2></div></section>
    <section><div class="section-head"><h2>本月高消耗会话</h2><button id="goSessions">管理会话</button></div><div id="topSessions"></div><p class="hint">费用为已配置价格的本机估算，不代表该 Key 在其他设备上的总消费。预算提醒不会强制中断任务。</p></section>`);
  makePage('sessions', `<div class="wb-head"><div><p class="eyebrow">SESSION INSIGHTS</p><h2>会话管理</h2></div><button id="refreshSessions">刷新会话</button></div>
    <section><div class="controls"><input id="sessionSearch" placeholder="搜索名称、ID、标签或项目" aria-label="搜索会话"/><select id="sessionProject" aria-label="项目分类"><option value="">全部项目</option></select>
    <select id="sessionSort" aria-label="会话排序"><option value="cost">按费用排序</option><option value="tokens">按 Tokens 排序</option><option value="active">按最近活跃</option></select><button id="sessionRange">修改统计日期/模型</button></div>
    <p id="sessionScope" class="hint"></p><p id="sessionMetadataState" class="notice">默认仅显示会话 ID。可在设置中允许读取官方会话名称；不索引提示词或回答全文。</p>
    <div class="table-wrap"><table class="wb-table"><thead><tr><th>会话 / 标签</th><th>项目</th><th>调用</th><th>Tokens</th><th>预估费用</th><th>操作</th></tr></thead><tbody id="managedSessions"></tbody></table></div>
    <div class="pagination"><button id="managedSessionPrev">上一页</button><span id="managedSessionPage" class="hint"></span><button id="managedSessionNext">下一页</button></div></section>`);
  makePage('plugins', `<div class="wb-head"><div><p class="eyebrow">EXTENSIONS</p><h2>插件中心</h2></div><div class="wb-actions"><button id="pluginConfig">打开官方配置</button><button id="refreshPlugins">刷新插件</button></div></div>
    <section><div class="controls"><select id="pluginFilter"><option value="all">全部已安装/内置</option><option value="enabled">已启用</option><option value="error">异常</option><option value="favorites">收藏</option></select><input id="pluginSearch" placeholder="搜索插件" aria-label="搜索插件"/></div>
    <p class="notice">直接读取官方插件管理接口。安装、启停、卸载沿用官方兼容性校验；没有安全审核背书。旧版本不支持时会显示接口错误，不显示虚构插件。</p><p id="pluginStatus" class="wb-status"></p><div id="pluginList"></div></section>
    <section><h2>从 npm 安装 / 更新插件</h2><p class="hint">输入可信的 npm 包名，可指定 @版本。先检查，再确认安装；不会自动批准依赖构建脚本。配置项仍由官方插件面板管理。</p>
    <div class="controls"><input id="pluginSpec" placeholder="@作者/插件包@版本" aria-label="npm 插件包"/><button id="inspectPlugin">检查来源与兼容性</button><button id="installPlugin" class="primary" disabled>确认安装 / 更新</button></div><pre id="pluginInspection" class="wb-status"></pre></section>`);
  makePage('updates', `<div class="wb-head"><div><p class="eyebrow">MAINTENANCE</p><h2>更新与诊断</h2></div><button id="refreshRuntime">刷新状态</button></div>
    <div id="versionSlot"></div><section><h2>安装管理</h2><p id="runtimeInfo" class="hint">正在读取…</p><div class="wb-actions"><button id="releaseNotes">官方更新说明</button><button id="retryCleanup" hidden>重试清理旧安装</button><button id="cancelQueue">取消排队更新</button></div><p id="cleanupStatus" class="wb-status error" hidden></p><p id="releaseTags" class="wb-status"></p>
    <p class="notice">新版本启动成功后只保留当前托管安装；需要旧版时，在版本列表中选择并重新安装。不再自动创建升级快照，会话与配置继续使用原数据目录。降级前请自行备份重要数据，旧版本不一定兼容新版数据。</p></section>
    <section><div class="section-head"><h2>运行诊断</h2><button id="runDiagnostics" class="primary">开始检查</button></div><p class="hint">检查环境、监听端口、目录权限和网络，不发送付费模型请求。</p><div id="diagnosticResults"></div>
    <div class="wb-actions"><button id="exportDiagnostics" disabled>导出脱敏报告</button><button id="changePort">选择可用端口并重启</button><button id="pickWorkspace">重新选择工作文件夹</button></div></section>
    <section><div class="section-head"><h2>统计索引</h2><button id="rebuildIndex">重建统计索引</button></div><p id="indexStatus" class="wb-status">首次查询后显示索引状态。</p><p class="hint">仅重建可丢弃的用量元数据缓存，不删除会话、附件或凭据。</p></section>`);
  makePage('settings', `<div class="wb-head"><div><p class="eyebrow">PREFERENCES</p><h2>设置</h2></div><div class="wb-actions"><button id="exportSettings">备份桌面设置</button><button id="importSettings">恢复设置</button></div></div>
    <section><h2>外观与隐私</h2><div class="wb-form"><label>外观主题<select id="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label class="check"><input id="metadataEnabled" type="checkbox"/>允许读取官方会话名称</label></div>
    <p class="hint">API Key 不进入工作台。备份仅包含桌面偏好、价格、预算、标签及收藏，不包含 Harness 凭据或对话正文。</p></section>
    <section><h2>预算与通知</h2><div class="wb-form"><label>每日预算（元，0 为关闭）<input id="dailyBudget" type="number" min="0" step="0.01"/></label><label>每月预算（元）<input id="monthlyBudget" type="number" min="0" step="0.01"/></label>
    <label>低余额阈值（元）<input id="lowBalanceBudget" type="number" min="0" step="0.01"/></label><label>单会话月费用提醒（元）<input id="sessionBudget" type="number" min="0" step="0.01"/></label>
    <label class="check"><input id="notificationsEnabled" type="checkbox"/>开启桌面提醒</label><label class="check"><input id="taskNotifications" type="checkbox"/>完成 / 失败 / 等待操作提醒</label>
    <label>免打扰开始（小时）<input id="quietStart" type="number" min="0" max="23"/></label><label>免打扰结束（同开始代表关闭）<input id="quietEnd" type="number" min="0" max="23"/></label></div>
    <button id="savePreferences" class="primary">保存设置</button><p class="hint">日/月预算达到 80% 和 100% 各提醒一次。仅应用运行期间每分钟检查；任务提醒来自官方日志事件，不以文件变动推断完成。通知隐藏内容预览。</p></section>
    <div id="pricingSlot"></div><section><h2>按提供商 / 模型自定义价格</h2><p class="hint">精确匹配实际日志中的提供商与模型名，支持生效区间。单价单位：人民币元 / 百万 Tokens。同一模型区间不能重叠。</p>
    <div class="wb-form"><label>提供商<input id="ruleProvider" placeholder="deepseek"/></label><label>模型<input id="ruleModel" placeholder="deepseek-flash"/></label><label>缓存命中<input id="ruleHit" type="number" min="0" step="0.001"/></label><label>未命中 / 缓存写入<input id="ruleMiss" type="number" min="0" step="0.001"/></label><label>输出<input id="ruleOutput" type="number" min="0" step="0.001"/></label><label>生效时间（本机时区）<input id="ruleFrom" type="datetime-local"/></label><label>结束时间（可留空）<input id="ruleUntil" type="datetime-local"/></label></div>
    <button id="addPriceRule" class="primary">添加规则</button><div id="priceRuleList"></div></section>
    <section><h2>费用配置方案</h2><div class="controls"><input id="profileName" placeholder="工作 / 个人 / 测试" aria-label="方案名称"/><button id="saveProfile">保存当前价格与预算</button><select id="profileSelect" aria-label="费用方案"></select><button id="activateProfile">应用方案</button><button id="deleteProfile">移除方案</button></div><p class="hint">方案保存按模型价格与预算，不切换 API Key、官方模型、插件或数据目录，避免无意影响运行中的任务。</p></section>`);
  // Reuse the existing, tested chart/query panels without duplicating data flows.
  $('pluginFilter').append(new Option('可更新', 'updates'));
  const checkUpdates = document.createElement('button'); checkUpdates.id = 'checkPluginUpdates'; checkUpdates.textContent = '检查插件更新'; $('refreshPlugins').before(checkUpdates);
  const discovery = document.createElement('section'); discovery.innerHTML = `<h2>插件发现 · npm 公共目录</h2><p class="hint">搜索结果由 npm 提供，可能包含非 Harness 插件。选择后必须经过官方插件识别和兼容性检查；不代表官方推荐或安全审核。</p><div class="controls"><input id="discoverQuery" placeholder="插件关键词，例如 browser" aria-label="插件发现关键词"/><button id="discoverPlugins">搜索</button></div><div id="discoveryResults"></div>`;
  pages.querySelector('[data-page=plugins]').append(discovery);
  $('versionSlot').append($('versionSelect').closest('section'));
  $('pricingSlot').append($('priceTier').closest('section'));
  $('overviewBalance').append(document.querySelector('.balance-panel'));
  const usageTools = document.createElement('section'); usageTools.innerHTML = `<div class="wb-actions"><select id="exportSection"><option value="calls">全部筛选调用</option><option value="sessions">会话统计</option><option value="models">模型统计</option><option value="overview">概览</option></select><button id="exportCsv">导出 CSV</button><button id="exportJson">导出 JSON</button><button id="clearSessionFilter" hidden>清除会话筛选</button><label><input id="simulateCurrent" type="checkbox"/> 按现价模拟重算</label></div><p id="pricingWarnings" class="hint"></p>`; oldMain.prepend(usageTools);
  const toastNode = document.createElement('div'); toastNode.className = 'wb-toast'; toastNode.hidden = true; toastNode.setAttribute('role', 'status'); document.body.append(toastNode);
  const editor = document.createElement('dialog'); editor.innerHTML = `<h2>会话分类</h2><p id="labelId" class="hint"></p><div class="wb-form"><label class="full">本地显示名称<input id="labelName"/></label><label>项目<input id="labelProject"/></label><label>标签（逗号分隔）<input id="labelTags"/></label></div><div class="wb-actions"><button id="labelSave" class="primary">保存</button><button id="labelCancel">取消</button></div>`; document.body.append(editor);
  let prefs = null, currentTab = 'overview', metadata = new Map(), pluginRows = [], pluginVersions = new Map(), managedPage = 1, sessionsForPage = [], editingId = '', inspectedSpec = '', autoBusy = false;
  const loaded = new Set(); let toastTimer;
  const yuan = v => `¥${Number(v || 0).toFixed(2)}`;
  const count = v => new Intl.NumberFormat('zh-CN').format(v || 0);
  const msg = value => { toastNode.textContent = value; toastNode.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastNode.hidden = true; }, 6500); };
  const task = (id, fn) => { $(id).onclick = async () => { const button = $(id); button.disabled = true; try { await fn(); } catch (e) { msg(e.message); } finally { button.disabled = false; } }; };
  const node = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; };
  const action = (text, fn) => { const button = node('button', text); button.onclick = async () => { button.disabled = true; try { await fn(); } catch (e) { msg(e.message); } finally { button.disabled = false; } }; return button; };
  async function save(next) { const result = await api.saveSettings(next); prefs = result; applyTheme(); return result; }
  function applyTheme() { document.documentElement.dataset.theme = prefs?.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : prefs?.theme || 'light'; }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  function selectTab(tab) {
    currentTab = tab;
    window.scrollTo({ top: 0 });
    for (const page of pages.children) page.hidden = page.dataset.page !== tab;
    for (const button of appRoot.querySelectorAll('[data-tab]')) button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false');
    if (tab === 'usage') requestAnimationFrame(usage.resize);
    if (!loaded.has(tab)) { loaded.add(tab); loadTab(tab).catch(e => { loaded.delete(tab); msg(e.message); }); }
  }
  async function loadTab(tab) {
    if (tab === 'overview') { await refreshOverview(); if (!loaded.has('balance')) { loaded.add('balance'); void usage.balance(); } }
    if (tab === 'updates') { void usage.versions(); await refreshRuntime(); }
    if (tab === 'sessions') { await refreshSessionMetadata(); renderSessions(); }
    if (tab === 'plugins') await refreshPlugins();
    if (tab === 'settings') renderSettings();
  }
  for (const button of appRoot.querySelectorAll('[data-tab]')) button.onclick = () => selectTab(button.dataset.tab);
  function progress(id, spent, budget) { $(id).style.width = `${budget ? Math.min(100, spent / budget * 100) : 0}%`; $(id).classList.toggle('over', !!budget && spent >= budget); }
  async function refreshOverview() {
    const info = await api.overview();
    $('desktopVersion').textContent = `桌面壳 ${info.appVersion}`;
    $('serviceState').textContent = info.busy ? '维护进行中' : info.running ? 'Harness 服务运行中' : 'Harness 服务未运行';
    const budget = await api.budget();
    $('overviewTokens').textContent = count(budget.tokensToday);
    $('overviewDay').textContent = `${yuan(budget.today)} / ${budget.budgets.daily ? yuan(budget.budgets.daily) : '未设'}`;
    $('overviewMonth').textContent = `${yuan(budget.month)} / ${budget.budgets.monthly ? yuan(budget.budgets.monthly) : '未设'}`;
    progress('dayProgress', budget.today, budget.budgets.daily); progress('monthProgress', budget.month, budget.budgets.monthly);
    $('overviewFreshness').textContent = `更新于 ${new Date(budget.updatedAt).toLocaleString()}${budget.unpricedCount ? ` · ${budget.unpricedCount} 次调用待定价，金额不完整` : ''}${budget.completeness === 'partial' ? ' · 日志统计不完整' : ''}`;
    $('overviewQueue').hidden = !info.queuedUpdate; $('overviewQueue').textContent = `等待任务结束后更新至 ${info.queuedUpdate}`;
    $('topSessions').replaceChildren();
    for (const row of budget.topSessions || []) { const div = node('div', '', 'wb-head'); div.append(node('span', prefs?.labels?.[row.sessionId]?.name || row.sessionId), node('span', `${count(row.totalTokens)} Tokens · ${yuan(row.estimatedCny)}`), action('查看', () => detail(row.sessionId))); $('topSessions').append(div); }
    if (!budget.topSessions?.length) $('topSessions').append(node('p', '本月暂无会话用量', 'hint'));
  }
  async function refreshRuntime() {
    const info = await api.overview();
    $('runtimeInfo').textContent = `桌面壳 ${info.appVersion} · Harness ${info.runtime.version || '使用现有全局安装'} · 端口 ${info.runtime.port}${info.queuedUpdate ? ` · 排队：${info.queuedUpdate}` : ''}`;
    $('retryCleanup').hidden = !info.runtime.cleanupWarning;
    $('cleanupStatus').hidden = !info.runtime.cleanupWarning; $('cleanupStatus').textContent = info.runtime.cleanupWarning || '';
    $('cancelQueue').disabled = !info.queuedUpdate;
  }
  window.dshApp?.onOperationStatus?.(event => {
    if (currentTab === 'updates' && event.kind !== 'busy') void refreshRuntime().catch(e => msg(e.message));
  });
  function detail(id) { window.usageSessionFilter = id; $('clearSessionFilter').hidden = false; $('clearSessionFilter').textContent = `清除会话筛选 · ${id.slice(-10)}`; selectTab('usage'); return usage.refreshFirst(); }
  async function refreshSessionMetadata() {
    if (!prefs?.metadataEnabled) { metadata.clear(); return; }
    try { const rows = await api.sessions(); metadata = new Map(rows.map(r => [r.sessionId, r])); $('sessionMetadataState').textContent = `已读取 ${rows.length} 个官方会话名称；分类保存在本机，不改写官方标题。`; }
    catch (e) { $('sessionMetadataState').textContent = `官方元数据不可用，继续使用本地 ID/标签：${e.message}`; }
  }
  function renderSessions() {
    const summary = window.lastUsageSummary;
    if (!summary || !prefs) return;
    $('sessionScope').textContent = `${summary.startDate} 至 ${summary.endDate} · 与“用量与费用”日期/模型一致${summary.sessionFilter ? ' · 当前还包含单会话筛选，请清除后查看全部' : ''}`;
    const project = $('sessionProject').value;
    const projects = [...new Set(Object.values(prefs.labels).map(l => l.project).filter(Boolean))].sort();
    $('sessionProject').replaceChildren(new Option('全部项目', ''), ...projects.map(p => new Option(p, p))); $('sessionProject').value = project;
    const query = $('sessionSearch').value.trim().toLowerCase();
    sessionsForPage = summary.sessionStats.filter(r => {
      const label = prefs.labels[r.sessionId] || {};
      return (!project || label.project === project) && (!query || [r.sessionId, label.name, label.project, ...(label.tags || []), metadata.get(r.sessionId)?.title].filter(Boolean).join(' ').toLowerCase().includes(query));
    }).sort((a, b) => $('sessionSort').value === 'tokens' ? b.totalTokens - a.totalTokens : $('sessionSort').value === 'active' ? b.lastActiveAt - a.lastActiveAt : b.estimatedCny - a.estimatedCny);
    const pageCount = Math.max(1, Math.ceil(sessionsForPage.length / 20)); managedPage = Math.min(managedPage, pageCount);
    $('managedSessionPage').textContent = `${sessionsForPage.length} 个会话 · ${managedPage} / ${pageCount}`; $('managedSessionPrev').disabled = managedPage <= 1; $('managedSessionNext').disabled = managedPage >= pageCount;
    const body = $('managedSessions'); body.replaceChildren();
    for (const row of sessionsForPage.slice((managedPage - 1) * 20, managedPage * 20)) {
      const label = prefs.labels[row.sessionId] || {}, meta = metadata.get(row.sessionId); const tr = document.createElement('tr'); const title = node('td', label.name || meta?.title || `会话 ${row.sessionId.slice(-8)}`, 'session-name');
      title.append(node('span', row.sessionId, 'small-id')); for (const tag of label.tags || []) title.append(node('span', tag, 'badge'));
      if (meta?.running) title.append(node('span', '运行中', 'badge'));
      tr.append(title, node('td', label.project || '未分类'), node('td', count(row.requestCount)), node('td', count(row.totalTokens)), node('td', row.unpricedCount === row.requestCount ? '待定价' : `${yuan(row.estimatedCny)}${row.unpricedCount ? '（部分）' : ''}`));
      const buttons = node('td', '', 'wb-actions'); buttons.append(action('详情', () => detail(row.sessionId)), action('分类', () => editLabel(row.sessionId)), action('打开', async () => { await api.openHarness(row.sessionId); msg('会话 ID 已复制，请在 Harness 中选择该会话'); }),
        action('归档', async () => { const result = await api.archive(row.sessionId, true); if (result.ok) { msg('已通过官方接口归档'); await refreshSessionMetadata(); renderSessions(); } }),
        action('恢复', async () => { const result = await api.archive(row.sessionId, false); if (result.ok) { msg('已通过官方接口恢复'); await refreshSessionMetadata(); renderSessions(); } }));
      tr.append(buttons); body.append(tr);
    }
    if (!sessionsForPage.length) { const row = document.createElement('tr'), cell = node('td', '当前筛选没有会话'); cell.colSpan = 6; row.append(cell); body.append(row); }
  }
  function editLabel(id) { editingId = id; const saved = prefs.labels[id] || {}; $('labelId').textContent = id; $('labelName').value = saved.name || ''; $('labelProject').value = saved.project || ''; $('labelTags').value = (saved.tags || []).join(', '); editor.showModal(); }
  function renderSettings() {
    if (!prefs) return;
    $('theme').value = prefs.theme; $('metadataEnabled').checked = prefs.metadataEnabled;
    $('dailyBudget').value = prefs.budgets.daily; $('monthlyBudget').value = prefs.budgets.monthly; $('lowBalanceBudget').value = prefs.budgets.lowBalance; $('sessionBudget').value = prefs.budgets.highSession;
    $('notificationsEnabled').checked = prefs.notifications.enabled; $('taskNotifications').checked = prefs.notifications.tasks; $('quietStart').value = prefs.notifications.quietStart; $('quietEnd').value = prefs.notifications.quietEnd;
    renderRules(); $('profileSelect').replaceChildren(new Option('选择费用方案', ''), ...prefs.profiles.map(p => new Option(p.name, p.id))); $('profileSelect').value = prefs.activeProfile;
  }
  function renderRules() {
    $('priceRuleList').replaceChildren();
    prefs.priceRules.forEach((rule, index) => { const card = node('div', '', 'plugin-card'); card.append(node('strong', `${rule.provider} / ${rule.model}`), node('p', `${rule.cacheHitPerMillionCny} / ${rule.cacheMissPerMillionCny} / ${rule.outputPerMillionCny} 元每百万 · ${new Date(rule.effectiveFrom).toLocaleString()} → ${rule.effectiveUntil ? new Date(rule.effectiveUntil).toLocaleString() : '持续生效'}`), action('移除此规则', async () => { await save({ ...prefs, priceRules: prefs.priceRules.filter((_, i) => i !== index) }); renderRules(); await usage.refresh(); })); $('priceRuleList').append(card); });
  }
  async function refreshPlugins() {
    $('pluginStatus').textContent = '正在连接官方插件接口…';
    try { pluginRows = await api.plugins(); renderPlugins(); $('pluginStatus').textContent = `${pluginRows.length} 个真实插件包 · ${new Date().toLocaleTimeString()}`; }
    catch (e) { $('pluginStatus').textContent = `${e.message}。请打开主界面完成认证，或到更新中心检查 Harness 版本。`; $('pluginStatus').classList.add('error'); }
  }
  function renderPlugins() {
    $('pluginList').replaceChildren(); const filter = $('pluginFilter').value, search = $('pluginSearch').value.toLowerCase();
    for (const p of pluginRows.filter(p => (!search || `${p.title} ${p.name}`.toLowerCase().includes(search)) && (filter === 'all' || filter === 'enabled' && p.enabled || filter === 'error' && p.error || filter === 'updates' && pluginVersions.get(p.name)?.newer || filter === 'favorites' && prefs.favorites.includes(p.name)))) {
      const card = node('div', '', 'plugin-card'), head = node('div', '', 'wb-head'); head.append(node('h3', p.title || p.name), node('span', `${p.version || '内置'} · ${p.enabled ? '启用' : '停用'}`, 'badge')); card.append(head, node('p', p.name));
      if (p.error) card.append(node('p', p.error, 'wb-status error'));
      const update = pluginVersions.get(p.name);
      if (update) card.append(node('p', update.error || `npm latest：${update.latest}${update.newer ? ' · 有新版本（安装前仍需官方兼容性检查）' : ' · 当前无更高 latest 版本'}`));
      const buttons = node('div', '', 'wb-actions'); buttons.append(action(prefs.favorites.includes(p.name) ? '取消收藏' : '收藏', async () => { const favorites = prefs.favorites.includes(p.name) ? prefs.favorites.filter(n => n !== p.name) : [...prefs.favorites, p.name]; await save({ ...prefs, favorites }); renderPlugins(); }),
        action(p.enabled ? '停用' : '启用', async () => { const result = await api.changePlugin(p.enabled ? 'disable' : 'enable', p.name); showPluginChange(result); await refreshPlugins(); }),
        action('检查 / 更新', () => { $('pluginSpec').value = p.name; $('pluginSpec').dispatchEvent(new Event('input')); $('inspectPlugin').click(); $('pluginSpec').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
      if (p.removable) buttons.append(action('卸载', async () => { const result = await api.changePlugin('remove', p.name); showPluginChange(result); await refreshPlugins(); })); card.append(buttons); $('pluginList').append(card);
    }
    if (!$('pluginList').children.length) $('pluginList').append(node('p', '当前筛选没有插件', 'hint'));
  }
  function showPluginChange(result) { msg(result.cancelled ? '已取消' : `${result.changed ? '插件已变更' : '未变更'} · ${result.application || ''}${result.error ? ` · ${result.error}` : ''}${result.application === 'restart-required' ? '，请重启 Harness' : ''}`); }
  window.addEventListener('usage-rendered', event => {
    const s = event.detail, index = s.indexStatus;
    $('pricingWarnings').textContent = `规则 ${s.ruleVersion || '—'} · ${s.unpricedCount ? `${s.unpricedCount} 次调用待定价，不含在金额中` : '已匹配的调用按相应规则估价'}${$('simulateCurrent').checked ? ' · 当前为现价模拟，不是历史账单' : ''} ${(s.warnings || []).join('；')}`;
    if (s.comparison) { const c = s.comparison, change = v => v === null ? '无可比基数' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
      $('pricingWarnings').textContent += `\n较前一等长区间：Tokens ${change(c.tokenChangeRatio)} · 费用 ${change(c.costChangeRatio)} · 缓存命中率 ${c.cacheHitChangePoints >= 0 ? '+' : ''}${c.cacheHitChangePoints.toFixed(1)} 个百分点`;
      $('pricingWarnings').title = `比较区间 ${new Date(c.start).toLocaleString()} 至 ${new Date(c.end).toLocaleString()}`; }
    if (index) $('indexStatus').textContent = `格式 V${index.formats.join(' / V')} · ${s.completeness === 'partial' ? '不完整' : s.completeness === 'empty' ? '尚无日志' : '已读取'}\n最近查询 ${index.durationMs} ms · 复用 ${index.reusedFiles} 个 · 新解析 ${index.parsedFiles} 个\n缓存 ${(index.cacheBytes / 1048576).toFixed(2)} MB · 未支持 ${index.unsupportedFiles} 个 · 无法读取 ${s.skippedFileCount} 个 · 异常行 ${index.invalidLines}`;
    renderSessions();
  });
  window.addEventListener('versions-rendered', e => { const c = e.detail.catalog; if (c) $('releaseTags').textContent = `npm 标签：${Object.entries(c.tags).map(([k, v]) => `${k} → ${v}`).join(' · ')}\n获取时间 ${new Date(c.fetchedAt).toLocaleString()}${c.stale ? ' · 网络不可用，显示上次结果' : ''}`; });
  task('refreshOverview', refreshOverview); task('openHarness', () => api.openHarness()); task('restartHarness', async () => { const result = await window.dshApp.restartDsh(); msg(result.ok ? '服务已重启' : result.error); await refreshOverview(); });
  task('goSessions', () => selectTab('sessions')); task('sessionRange', () => selectTab('usage')); task('refreshSessions', async () => { await usage.refresh(); await refreshSessionMetadata(); renderSessions(); });
  $('sessionSearch').oninput = () => { managedPage = 1; renderSessions(); }; $('sessionProject').onchange = $('sessionSort').onchange = () => { managedPage = 1; renderSessions(); };
  $('managedSessionPrev').onclick = () => { managedPage--; renderSessions(); }; $('managedSessionNext').onclick = () => { managedPage++; renderSessions(); };
  $('labelCancel').onclick = () => editor.close(); task('labelSave', async () => { await save({ ...prefs, labels: { ...prefs.labels, [editingId]: { name: $('labelName').value, project: $('labelProject').value, tags: $('labelTags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean) } } }); editor.close(); renderSessions(); });
  task('clearSessionFilter', async () => { window.usageSessionFilter = ''; $('clearSessionFilter').hidden = true; await usage.refreshFirst(); });
  $('simulateCurrent').onchange = () => usage.refreshFirst();
  for (const format of ['Csv', 'Json']) task(`export${format}`, async () => { const result = await api.exportUsage(usage.request(), format.toLowerCase(), $('exportSection').value); if (result.ok) msg(`已保存 ${result.path}`); });
  task('refreshPlugins', refreshPlugins); $('pluginSearch').oninput = $('pluginFilter').onchange = renderPlugins; task('pluginConfig', () => api.openHarness());
  $('pluginSpec').oninput = () => { inspectedSpec = ''; $('installPlugin').disabled = true; };
  task('inspectPlugin', async () => { const spec = $('pluginSpec').value.trim(); inspectedSpec = ''; $('installPlugin').disabled = true; $('pluginInspection').textContent = '正在检查…'; const result = await api.inspectPlugin(spec); $('pluginInspection').textContent = JSON.stringify(result, null, 2); if (result.status === 'accepted' && result.bundle === true) { inspectedSpec = spec; $('installPlugin').disabled = false; } else msg(result.reason || '官方接口尚未确认该包为可安装插件，未开放安装'); });
  task('installPlugin', async () => { if (!inspectedSpec || inspectedSpec !== $('pluginSpec').value.trim()) throw new Error('请先检查该插件'); showPluginChange(await api.changePlugin('install', inspectedSpec)); await refreshPlugins(); });
  task('checkPluginUpdates', async () => { $('pluginStatus').textContent = '正在查询 npm 插件版本…'; const rows = await api.pluginUpdates(); pluginVersions = new Map(rows.map(r => [r.name, r])); renderPlugins(); $('pluginStatus').textContent = `发现 ${rows.filter(r => r.newer).length} 个可更新 · ${rows.filter(r => r.error).length} 个查询失败`; });
  task('discoverPlugins', async () => { $('discoveryResults').textContent = '正在搜索公共 npm 目录…'; const rows = await api.searchPlugins($('discoverQuery').value.trim()); $('discoveryResults').replaceChildren(); for (const p of rows) { const card = node('div', '', 'plugin-card'); card.append(node('strong', `${p.name} · ${p.version}`), node('p', p.description), node('p', `作者 ${p.author || '未提供'} · 许可证 ${p.license} · ${p.source}`), action('选择并检查', () => { $('pluginSpec').value = `${p.name}@${p.version}`; $('pluginSpec').dispatchEvent(new Event('input')); $('inspectPlugin').click(); $('pluginSpec').scrollIntoView({ behavior: 'smooth', block: 'center' }); })); $('discoveryResults').append(card); } if (!rows.length) $('discoveryResults').textContent = '暂无匹配结果'; });
  task('refreshRuntime', refreshRuntime); task('releaseNotes', () => api.releaseNotes($('versionSelect').value || 'latest')); task('cancelQueue', async () => { await api.cancelQueue(); await refreshRuntime(); });
  task('retryCleanup', async () => { const result = await api.retryCleanup(); if (!result.cancelled) msg(result.warning || `已清理 ${result.removed} 个旧安装`); await refreshRuntime(); });
  task('runDiagnostics', async () => { $('diagnosticResults').textContent = '正在检查环境与网络…'; const report = await api.diagnose(); $('diagnosticResults').replaceChildren(); for (const item of report.items) { const row = node('div', '', 'diagnostic'); row.append(node('strong', `${item.status === 'ok' ? '✓' : '!'} ${item.name}`, item.status), node('p', item.detail), node('p', item.action, 'hint')); $('diagnosticResults').append(row); } $('exportDiagnostics').disabled = false; });
  task('exportDiagnostics', async () => { const result = await api.exportDiagnostics(); if (result.ok) msg(`已导出脱敏报告：${result.path}`); });
  task('changePort', async () => { const result = await api.changePort(); if (!result.cancelled) msg(result.ok ? '端口已更换，服务已重启' : result.error); await refreshRuntime(); });
  task('pickWorkspace', async () => { const result = await api.pickWorkspace(); if (result.ok) msg('已在官方 Harness 中打开所选文件夹'); });
  task('rebuildIndex', async () => { $('indexStatus').textContent = '正在后台重建，原始会话不会改动…'; const result = await api.rebuild(usage.request()); usage.render(result); msg('索引重建完成'); });
  task('savePreferences', async () => { const previouslyTasks = prefs.notifications.tasks; await save({ ...prefs, theme: $('theme').value, metadataEnabled: $('metadataEnabled').checked,
    budgets: { daily: Number($('dailyBudget').value), monthly: Number($('monthlyBudget').value), lowBalance: Number($('lowBalanceBudget').value), highSession: Number($('sessionBudget').value) },
    notifications: { enabled: $('notificationsEnabled').checked, tasks: $('taskNotifications').checked, quietStart: Number($('quietStart').value), quietEnd: Number($('quietEnd').value) } });
    if (!prefs.metadataEnabled) metadata.clear(); renderSettings(); renderSessions(); msg(`设置已保存${!previouslyTasks && prefs.notifications.tasks ? '，应用运行期间检查任务事件' : ''}`); });
  task('addPriceRule', async () => { if (!$('ruleFrom').value) throw new Error('请选择价格生效时间'); const rule = { provider: $('ruleProvider').value, model: $('ruleModel').value, cacheHitPerMillionCny: Number($('ruleHit').value), cacheMissPerMillionCny: Number($('ruleMiss').value), outputPerMillionCny: Number($('ruleOutput').value), effectiveFrom: new Date($('ruleFrom').value).toISOString(), ...($('ruleUntil').value ? { effectiveUntil: new Date($('ruleUntil').value).toISOString() } : {}) }; await save({ ...prefs, priceRules: [...prefs.priceRules, rule] }); renderRules(); await usage.refresh(); msg('价格已保存并重算'); });
  task('exportSettings', async () => { const result = await api.exportSettings(); if (result.ok) msg('已备份桌面设置，不包含 API Key'); });
  task('importSettings', async () => { const result = await api.importSettings(); if (result) { prefs = result; metadata.clear(); renderSettings(); applyTheme(); await usage.refresh(); msg('设置已恢复'); } });
  task('saveProfile', async () => { const name = $('profileName').value.trim(); if (!name) throw new Error('请输入方案名称'); await save({ ...prefs, profiles: [...prefs.profiles, { id: `profile-${Date.now()}`, name, budgets: prefs.budgets, priceRules: prefs.priceRules }] }); renderSettings(); msg('已保存当前已生效的价格与预算'); });
  task('activateProfile', async () => { const p = prefs.profiles.find(p => p.id === $('profileSelect').value); if (!p) throw new Error('请选择方案'); await save({ ...prefs, activeProfile: p.id, budgets: p.budgets, priceRules: p.priceRules }); renderSettings(); await usage.refresh(); msg('费用方案已应用，Harness 连接设置保持不变'); });
  task('deleteProfile', async () => { const id = $('profileSelect').value; if (!id) return; await save({ ...prefs, profiles: prefs.profiles.filter(p => p.id !== id) }); renderSettings(); });
  const autoRefresh = setInterval(async () => {
    if (document.hidden || autoBusy || !prefs) return;
    autoBusy = true;
    try { if (currentTab === 'overview') await refreshOverview(); else if (currentTab === 'usage') await usage.refresh(); }
    catch { /* retained data stays visible; manual refresh reports failures */ } finally { autoBusy = false; }
  }, 60_000);
  window.addEventListener('beforeunload', () => clearInterval(autoRefresh));
  api.settings().then(value => { prefs = value; applyTheme(); renderSettings(); renderSessions(); selectTab('overview'); if (window.lastUsageSummary) window.dispatchEvent(new CustomEvent('usage-rendered', { detail: window.lastUsageSummary })); }).catch(e => msg(`设置读取失败：${e.message}`));
})();
