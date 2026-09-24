import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DesktopPreferences } from './preferences';
export interface DesktopAlert { id: string; title: string; body: string; sessionId?: string }
export function quietHour(hour: number, start: number, end: number): boolean {
  return start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end);
}
export function budgetAlerts(today: number, month: number, budgets: DesktopPreferences['budgets'], now: Date): DesktopAlert[] {
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`, period = day.slice(0, day.lastIndexOf('-'));
  const alerts: DesktopAlert[] = [];
  for (const [key, spent, limit, date, label] of [['day', today, budgets.daily, day, '今日'], ['month', month, budgets.monthly, period, '本月']] as const) {
    if (!limit) continue;
    for (const fraction of [0.8, 1]) if (spent >= limit * fraction) alerts.push({ id: `budget:${key}:${date}:${limit}:${fraction}`, title: `${label}预算达到 ${fraction * 100}%`, body: `本机日志预估 ¥${spent.toFixed(2)} / ¥${limit.toFixed(2)}；不包含其他设备用量。` });
  }
  return alerts;
}
export class AlertLedger {
  private seen = new Set<string>();
  constructor(private readonly file: string) { try { this.seen = new Set(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* first launch */ } }
  take(alerts: DesktopAlert[], settings: DesktopPreferences['notifications'], now = new Date()): DesktopAlert[] {
    if (!settings.enabled || quietHour(now.getHours(), settings.quietStart, settings.quietEnd)) return [];
    const fresh = alerts.filter(a => !this.seen.has(a.id));
    for (const a of fresh) this.seen.add(a.id);
    if (fresh.length) {
      this.seen = new Set([...this.seen].slice(-3000));
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.seen]), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file);
    }
    return fresh;
  }
}
