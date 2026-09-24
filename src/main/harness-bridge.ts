import { randomUUID } from 'node:crypto';

export interface SessionMetadata { sessionId: string; title: string; running: boolean; updatedAt: number }
export interface PluginMetadata { name: string; version: string; title: string; enabled: boolean; installed: boolean; removable: boolean; error: string }
export function redact(text: string): string {
  return text.replace(/(?:sk-[\w-]{8,}|Bearer\s+[^\s"']+|(?:token|api[_-]?key|authorization|secret|password)\s*[:=]\s*[^\s&,;"']+)/gi, '[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/\\\\[^\r\n"<>|]+/g, '[网络路径]')
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n"<>|]+/g, '[本机路径]');
}
function short(value: unknown, limit = 200): string { return typeof value === 'string' ? value.slice(0, limit) : ''; }
export function safeSessions(raw: any): SessionMetadata[] {
  return (Array.isArray(raw?.items) ? raw.items : []).map((r: any) => ({ sessionId: short(r.sessionId),
    title: short(r.projections?.values?.title), running: r.running === true, updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0 }));
}
function localized(raw: any): string { return short(typeof raw === 'string' ? raw : raw?.['zh-CN'] ?? raw?.zh ?? raw?.en); }
export function safePlugins(raw: any): PluginMetadata[] {
  return (Array.isArray(raw) ? raw : []).map((p: any) => ({ name: short(p.name), version: short(p.version), title: localized(p.meta?.title) || short(p.name),
    enabled: p.enabled === true, installed: p.installed === true, removable: p.removable === true,
    error: redact(short(p.error?.diagnostic ?? p.meta?.error ?? p.readOnlyReason)) }));
}
/** Version-tested unary protocol from official 0.1.7-rc.1 generated Remote contracts. */
export class HarnessBridge {
  constructor(private readonly origin: () => string | null, private readonly fetcher: typeof fetch) {}
  private async call(method: string, args: Record<string, unknown> = {}, timeout = 20_000): Promise<any> {
    const base = this.origin();
    if (!base) throw new Error('Harness 未运行，请先启动服务');
    const url = new URL(base);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('仅允许连接桌面壳管理的本机服务');
    const result = await this.fetcher(`${url.origin}/api/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: url.origin }, credentials: 'include', redirect: 'error',
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(timeout) });
    if (!result.ok) throw new Error(result.status === 401 ? '请先打开 Harness 主界面完成本机认证' : `当前 Harness 接口不可用（HTTP ${result.status}），请检查版本`);
    const body = await result.json() as any;
    if (body?.result?.ok !== true) throw new Error(redact(short(body?.result?.error?.message, 500)) || 'Harness 返回不支持的接口响应');
    return body.result.value;
  }
  async sessions(): Promise<SessionMetadata[]> { return safeSessions(await this.call('session/list', { _request: {} })); }
  async createWorkspace(path: string): Promise<void> { await this.call('workspace/create', { request: { path } }); }
  async archive(sessionId: string, archived: boolean): Promise<void> {
    if (!/^[\w-]{1,180}$/.test(sessionId)) throw new Error('会话 ID 无效');
    await this.call(`workspace/${archived ? 'archiveSession' : 'unarchiveSession'}`, { request: { sessionId, ...(archived ? { stopActivity: false } : {}) } });
  }
  async plugins(): Promise<PluginMetadata[]> { return safePlugins(await this.call('pluginManager/listBundles')); }
  async inspect(spec: string): Promise<any> {
    this.validateSpec(spec);
    const raw = await this.call('pluginManager/inspect', { spec });
    let registry = '';
    try { registry = raw.registry ? new URL(raw.registry).origin : ''; } catch { /* invalid provider registry */ }
    return { status: short(raw.status), kind: short(raw.kind), name: short(raw.name), version: short(raw.version),
      description: redact(short(raw.description, 500)), bundle: raw.bundle === true ? true : raw.bundle === false ? false : null,
      registry, problem: short(raw.problem), reason: redact(short(raw.reason, 500)) };
  }
  validateSpec(spec: unknown): void {
    if (typeof spec !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[a-zA-Z0-9.+-]+)?$/.test(spec) || spec.length > 200) throw new Error('只接受 npm 包名及可选版本号，不接受命令、文件或任意网址');
  }
  async changePlugin(action: 'install' | 'enable' | 'disable' | 'remove', spec: string): Promise<{ application: string; changed: boolean; error: string }> {
    this.validateSpec(spec);
    const method = action === 'install' ? 'installBundle' : action === 'remove' ? 'removeBundle' : 'setBundleEnabled';
    const args = action === 'install' ? { spec, options: { enabled: true, approvedBuilds: [] } }
      : action === 'remove' ? { name: spec } : { name: spec, enabled: action === 'enable' };
    const raw = await this.call(`pluginManager/${method}`, args, 15 * 60_000);
    return { application: short(raw?.application), changed: raw?.changed === true,
      error: redact(short(raw?.error?.diagnostic ?? raw?.error?.code ?? raw?.warnings?.join('；'), 1000)) };
  }
}
