import { normalizePricingRequest, type UnitPrices } from './usage';

export const RULE_VERSION = '2026-09-24.1';
export const FLASH_CHANGE = Date.parse('2026-09-10T12:00:00+08:00');
export const V4_START = Date.parse('2026-08-17T00:00:00+08:00');
export const PRICING_SOURCES = [
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  'https://api-docs.deepseek.com/zh-cn/updates/',
  'https://api-docs.deepseek.com/zh-cn/news/news260910/',
];
// 国办发明电〔2025〕7号。周末即使调休上班，仍按官方定价的周末规则处理。
const HOLIDAYS_2026 = [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']];
export const HOLIDAY_SOURCE = 'https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html';

export interface CustomPriceRule extends UnitPrices {
  id: string;
  provider: string;
  model: string;
  effectiveFrom: string;
  effectiveUntil?: string;
}

export function validatePriceRules(value: unknown): CustomPriceRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error('自定义价格最多 200 条');
  const rules = value.map((raw: any, i) => {
    if (!raw || typeof raw !== 'object') throw new Error('价格规则无效');
    const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim().toLowerCase() : '';
    if (!provider || !model || provider.length > 160 || model.length > 160) throw new Error('请填写提供商和完整模型名');
    if (typeof raw.effectiveFrom !== 'string' || !Number.isFinite(Date.parse(raw.effectiveFrom))) throw new Error('价格生效时间无效');
    const until = raw.effectiveUntil;
    if (until && (typeof until !== 'string' || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.parse(raw.effectiveFrom))) throw new Error('结束时间必须晚于生效时间');
    const prices = normalizePricingRequest({ tier: 'custom', customPrices: raw }).prices;
    return { id: `rule-${i}`, provider, model, effectiveFrom: new Date(raw.effectiveFrom).toISOString(),
      ...(until ? { effectiveUntil: new Date(until).toISOString() } : {}), ...prices };
  });
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    if (a.provider === b.provider && a.model === b.model && Date.parse(a.effectiveFrom) < (b.effectiveUntil ? Date.parse(b.effectiveUntil) : Infinity)
      && Date.parse(b.effectiveFrom) < (a.effectiveUntil ? Date.parse(a.effectiveUntil) : Infinity)) throw new Error('同一提供商/模型的价格生效区间不能重叠');
  }
  return rules;
}

export function isDeepSeekPeakTime(time: number): boolean {
  const beijing = new Date(time + 8 * 3600_000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const date = beijing.toISOString().slice(5, 10);
  if (beijing.getUTCFullYear() === 2026 && HOLIDAYS_2026.some(([start, end]) => date >= start && date <= end)) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export interface ResolvedPrice { prices: UnitPrices; rule: string; unpriced: boolean; warning?: string }
const ZERO: UnitPrices = { cacheHitPerMillionCny: 0, cacheMissPerMillionCny: 0, outputPerMillionCny: 0 };

export function resolveRecordPrice(
  record: { time: number; provider: string; model: string },
  pricing: ReturnType<typeof normalizePricingRequest>, rules: CustomPriceRule[] = [], currentPrices = false,
): ResolvedPrice {
  const provider = record.provider.toLowerCase(), model = record.model.toLowerCase();
  const rule = rules.find(r => r.provider === provider && r.model === model && record.time >= Date.parse(r.effectiveFrom)
    && (!r.effectiveUntil || record.time < Date.parse(r.effectiveUntil)));
  if (rule) return { prices: rule, rule: `custom:${rule.id}`, unpriced: false };
  if (pricing.tier === 'custom') return { prices: pricing.prices, rule: 'custom:all-models', unpriced: false };
  const unpriced = (warning: string): ResolvedPrice => ({ prices: ZERO, rule: 'unpriced', unpriced: true, warning });
  if (!['deepseek', 'deepseek-anthropic', 'deepseek-official'].includes(provider)) return unpriced('提供商未匹配官方价格，请配置自定义价格');
  const pro = ['deepseek-v4-pro', 'deepseek-v4-pro-0813'].includes(model);
  const flash = ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-flash-vision-exp'].includes(model);
  if (!pro && !flash) return unpriced('模型未配置价格');
  const time = currentPrices ? Math.max(record.time, FLASH_CHANGE) : record.time;
  if (time < V4_START || (['deepseek-flash', 'deepseek-v4.1-flash'].includes(model) && time < FLASH_CHANGE)) return unpriced('该历史区间缺少已核实价格');
  const peak = pricing.tier === 'official-peak' || (pricing.tier === 'official-auto' && isDeepSeekPeakTime(record.time));
  const multiplier = peak ? 1 : 0.5;
  const base = pro ? [0.3, 9, 27] : time >= FLASH_CHANGE ? [0.04, 2, 8] : [0.1, 3, 9];
  return {
    prices: { cacheHitPerMillionCny: base[0] * multiplier, cacheMissPerMillionCny: base[1] * multiplier, outputPerMillionCny: base[2] * multiplier },
    rule: `${pro ? 'v4-pro' : time >= FLASH_CHANGE ? 'v4.1-flash' : 'v4-flash'}:${peak ? 'peak' : 'offpeak'}${currentPrices ? ':simulation' : ''}`,
    unpriced: false,
    ...(new Date(record.time + 8 * 3600_000).getUTCFullYear() !== 2026 && pricing.tier === 'official-auto'
      ? { warning: '该年度节假日尚未核实，仅按星期和小时估价' } : {}),
  };
}
