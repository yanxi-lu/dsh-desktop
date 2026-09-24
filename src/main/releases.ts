import { normalizeDshTargetVersion } from './dsh';
export const RELEASES_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases';
export interface ReleaseCatalog { tags: Record<string, string>; versions: Array<{ version: string; channel: string; publishedAt: string; node: string }>; fetchedAt: string; stale: boolean }
let last: ReleaseCatalog | undefined;
export function releaseChannel(version: string): string { return /-alpha/i.test(version) ? 'Alpha 预览' : /-rc/i.test(version) ? 'RC 候选' : /-/.test(version) ? '预发布' : '正式版本'; }
export async function getReleaseCatalog(fetcher: typeof fetch = fetch): Promise<ReleaseCatalog> {
  if (last && Date.now() - Date.parse(last.fetchedAt) < 60_000) return last;
  try {
    const response = await fetcher('https://registry.npmjs.org/@deepseek-ai%2fdsh', { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`npm HTTP ${response.status}`);
    const data = await response.json() as any;
    const versions = Object.keys(data.versions ?? {}).filter(v => { try { return normalizeDshTargetVersion(v) === v && v !== 'latest'; } catch { return false; } })
      .map(v => ({ version: v, channel: releaseChannel(v), publishedAt: data.time?.[v] ?? '', node: data.versions[v]?.engines?.node ?? '官方未声明' }))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    if (!versions.length) throw new Error('npm 未返回可安装版本');
    const tags: Record<string, string> = {};
    for (const [tag, v] of Object.entries(data['dist-tags'] ?? {})) if (typeof v === 'string' && versions.some(item => item.version === v)) tags[tag] = v;
    last = { tags, versions, fetchedAt: new Date().toISOString(), stale: false }; return last;
  } catch (error) { if (last) return { ...last, stale: true }; throw error; }
}
