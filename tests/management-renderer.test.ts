import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

describe('用量管理页面', () => {
  it('使用本地 ECharts 并保留离线运行能力', () => {
    const html = readFileSync(join(root, 'src', 'renderer', 'management.html'), 'utf8');
    const vendor = join(root, 'src', 'renderer', 'vendor', 'echarts.min.js');
    expect(html).toContain('<script src="vendor/echarts.min.js"></script>');
    expect(html).toContain("window.echarts.init");
    expect(html).toContain("smooth: .58");
    expect(html).toContain('id="sessionStatsBody"');
    expect(html).toContain('function renderSessionStats');
    expect(html).toContain('<option value="custom">自定义范围</option>');
    expect(html).toContain('id="customStartDate"');
    expect(html).toContain('id="customEndDate"');
    expect(html).toContain('const dateRequest = usageDateRequest()');
    expect(html).toContain('id="recentPageSize"');
    expect(html).toContain('id="recentPrev"');
    expect(html).toContain('id="recentNext"');
    expect(html).toContain('function refreshUsageFromFirstPage');
    expect(html).not.toContain('id="balanceApiKey"');
    expect(html).toContain('id="queryBalance"');
    expect(html).toContain('function renderBalance');
    expect(html).toContain('密钥只在主进程内读取和使用');
    expect(statSync(vendor).size).toBeGreaterThan(1_000_000);
  });
});
