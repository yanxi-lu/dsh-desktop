import type { UsageAnalyticsSummary } from './usage-analytics';

/** Defend against spreadsheet formulas, including leading whitespace and control characters. */
export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function exportUsage(summary: UsageAnalyticsSummary, format: 'csv' | 'json', section = 'calls'): string {
  const metadata = { kind: 'estimated-local-usage', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    currency: 'CNY', startDate: summary.startDate, endDate: summary.endDate, model: summary.modelFilter, session: summary.sessionFilter,
    ruleVersion: summary.ruleVersion, priceMode: summary.priceTier, priceSimulation: summary.priceSimulation, completeness: summary.completeness, unpricedCount: summary.unpricedCount,
    priceUnit: 'CNY per million tokens', fixedCustomPrices: summary.priceTier === 'custom' ? summary.prices : null,
    customPriceRules: summary.customPriceRules, updatedAt: summary.updatedAt, warnings: summary.warnings };
  if (format === 'json') return JSON.stringify({ metadata, totals: summary.totals, estimatedCny: summary.estimatedCny,
    models: summary.modelStats, sessions: summary.sessionStats, calls: summary.recentRecords }, null, 2);
  const rows: Array<Record<string, unknown>> = section === 'models' ? summary.modelStats.map(x => ({ ...x })) : section === 'sessions' ? summary.sessionStats.map(x => ({ ...x }))
    : section === 'overview' ? [{ ...summary.totals, requestCount: summary.requestCount, estimatedCny: summary.estimatedCny }]
      : summary.recentRecords.map(r => ({ ...r, time: new Date(r.time).toISOString(), estimatedCny: r.unpriced ? '' : r.estimatedCny }));
  const columns = rows.length ? Object.keys(rows[0]) : ['sessionId', 'estimatedCny'];
  return '\ufeff' + [
    ...Object.entries(metadata).map(([key, value]) => [key, value && typeof value === 'object' ? JSON.stringify(value) : value].map(csvCell).join(',')),
    '', columns.map(csvCell).join(','), ...rows.map(row => columns.map(key => csvCell(Array.isArray(row[key]) ? (row[key] as unknown[]).join(' | ') : row[key])).join(',')),
  ].join('\r\n');
}
