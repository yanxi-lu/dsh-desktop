import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { validatePriceRules, type CustomPriceRule } from './pricing-catalog';

export interface DesktopPreferences {
  version: 1;
  theme: 'system' | 'light' | 'dark';
  metadataEnabled: boolean;
  notifications: { enabled: boolean; tasks: boolean; quietStart: number; quietEnd: number };
  budgets: { daily: number; monthly: number; lowBalance: number; highSession: number };
  priceRules: CustomPriceRule[];
  labels: Record<string, { name: string; project: string; tags: string[] }>;
  favorites: string[];
  profiles: Array<{ id: string; name: string; priceRules: CustomPriceRule[]; budgets: DesktopPreferences['budgets'] }>;
  activeProfile: string;
}
const defaults = (): DesktopPreferences => ({ version: 1, theme: 'system', metadataEnabled: false,
  notifications: { enabled: false, tasks: false, quietStart: 22, quietEnd: 8 },
  budgets: { daily: 0, monthly: 0, lowBalance: 0, highSession: 0 }, priceRules: [], labels: {}, favorites: [], profiles: [], activeProfile: '' });
function text(value: unknown, max = 160): string { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function amount(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) throw new Error('预算金额必须是 0 至 10 亿之间的数字');
  return value;
}
function budgets(raw: any): DesktopPreferences['budgets'] { return { daily: amount(raw?.daily), monthly: amount(raw?.monthly), lowBalance: amount(raw?.lowBalance), highSession: amount(raw?.highSession) }; }
/** Explicit allowlist: no credentials, environment, arbitrary paths or official configs in portable backups. */
export function validatePreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置文件无效');
  const raw = value as any, out = defaults();
  if (raw.version !== undefined && raw.version !== 1) throw new Error('不支持该设置备份版本');
  out.theme = ['dark', 'light'].includes(raw.theme) ? raw.theme : 'system';
  out.metadataEnabled = raw.metadataEnabled === true;
  out.notifications.enabled = raw.notifications?.enabled === true;
  out.notifications.tasks = raw.notifications?.tasks === true;
  for (const key of ['quietStart', 'quietEnd'] as const) {
    const n = raw.notifications?.[key];
    if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 23)) throw new Error('免打扰时间必须为 0–23 点');
    if (n !== undefined) out.notifications[key] = n;
  }
  out.budgets = budgets(raw.budgets);
  out.priceRules = validatePriceRules(raw.priceRules);
  if (raw.labels && typeof raw.labels === 'object') {
    if (Object.keys(raw.labels).length > 10000) throw new Error('本地标签数量超过限制');
    for (const [id, v] of Object.entries(raw.labels) as Array<[string, any]>) {
      if (!/^[a-zA-Z0-9_-]{1,180}$/.test(id) || !v || typeof v !== 'object') continue;
      Object.defineProperty(out.labels, id, { enumerable: true, writable: true, configurable: true,
        value: { name: text(v.name), project: text(v.project), tags: Array.isArray(v.tags) ? [...new Set(v.tags.map((t: unknown) => text(t, 40)).filter(Boolean))].slice(0, 20) : [] } });
    }
  }
  out.favorites = Array.isArray(raw.favorites) ? [...new Set(raw.favorites.map((x: unknown) => text(x)).filter(Boolean))].slice(0, 200) as string[] : [];
  out.profiles = Array.isArray(raw.profiles) ? raw.profiles.slice(0, 20).map((p: any) => {
    if (!p || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) || !text(p.name)) throw new Error('配置方案名称或 ID 无效');
    return { id: p.id, name: text(p.name), priceRules: validatePriceRules(p.priceRules), budgets: budgets(p.budgets) };
  }) : [];
  if (new Set(out.profiles.map(p => p.id)).size !== out.profiles.length) throw new Error('配置方案 ID 不能重复');
  out.activeProfile = out.profiles.some(p => p.id === raw.activeProfile) ? raw.activeProfile : '';
  return out;
}

export class PreferencesStore {
  private value: DesktopPreferences;
  constructor(private readonly file: string) {
    try { this.value = validatePreferences(JSON.parse(readFileSync(file, 'utf8'))); } catch { this.value = defaults(); }
  }
  get(): DesktopPreferences { return structuredClone(this.value); }
  set(raw: unknown): DesktopPreferences {
    const value = validatePreferences(raw);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    this.value = value;
    return this.get();
  }
}
