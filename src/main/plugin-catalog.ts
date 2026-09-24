import { parsePublishedDshVersions } from './dsh';
import { type PluginMetadata } from './harness-bridge';
export interface PublicPlugin { name: string; version: string; description: string; author: string; license: string; source: string }
const short = (v: unknown, limit = 200): string => typeof v === 'string' ? v.slice(0, limit) : '';
const validName = (v: unknown): v is string => typeof v === 'string' && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(v) && v.length < 180;
export async function searchPlugins(query: unknown, fetcher: typeof fetch = fetch): Promise<PublicPlugin[]> {
  if (typeof query !== 'string' || query.length > 120) throw new Error('请输入 120 字以内的关键词');
  const response = await fetcher(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`dsh ${query}`)}&size=20`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`npm 搜索失败 HTTP ${response.status}`);
  const body = await response.json() as any;
  return (Array.isArray(body.objects) ? body.objects : []).map((v: any) => v.package).filter((p: any) => p && validName(p.name)).map((p: any) => ({
    name: p.name, version: short(p.version), description: short(p.description, 300), author: short(p.author?.name ?? p.publisher?.username), license: short(p.license) || '详情待核实', source: 'npm 公共目录（尚未验证为 Harness 插件）',
  }));
}
export async function pluginUpdates(plugins: PluginMetadata[], fetcher: typeof fetch = fetch): Promise<Array<{ name: string; latest?: string; newer?: boolean; error?: string }>> {
  const items = plugins.filter(p => validName(p.name)).slice(0, 100);
  const results: Array<{ name: string; latest?: string; newer?: boolean; error?: string }> = [];
  for (let start = 0; start < items.length; start += 4) results.push(...await Promise.all(items.slice(start, start + 4).map(async p => {
    try {
      const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(p.name)}/latest`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as any, latest = short(data.version);
      const ordered = parsePublishedDshVersions(JSON.stringify([latest, p.version]));
      return { name: p.name, latest, newer: ordered.length === 2 && ordered[0] === latest };
    } catch { return { name: p.name, error: '暂时无法查询版本' }; }
  })));
  return results;
}
