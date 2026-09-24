import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { resolveDshCommand, resolveNpmCommand, getDshVersion } from './dsh';
import { redact } from './harness-bridge';
const run = promisify(execFile);
export interface Diagnostic { name: string; status: 'ok' | 'warning' | 'error'; detail: string; action: string }
export async function diagnose(env: NodeJS.ProcessEnv, home: string, port: number, pid?: number): Promise<{ checkedAt: string; items: Diagnostic[] }> {
  const checks: Array<Promise<Diagnostic>> = [];
  const check = (name: string, action: string, fn: () => Promise<string>) => checks.push(fn().then(detail => ({ name, status: 'ok' as const, detail, action: '' }))
    .catch((e: Error) => ({ name, status: 'error' as const, detail: redact(e.message), action })));
  check('Node.js', '在首次启动页面安装 Node.js LTS', async () => {
    const options = { windowsHide: true, timeout: 8000, env };
    const version = (await run('node', ['--version'], options)).stdout.trim();
    const location = (await run('where.exe', ['node'], options)).stdout.trim().split(/\r?\n/)[0];
    return `${version} · ${location}`;
  });
  check('npm', '检查 Node.js 安装和 PATH', async () => { const p = await resolveNpmCommand(env); if (!p) throw new Error('未找到 npm'); return p; });
  check('Harness', '到更新中心安装或切换版本', async () => { const version = await getDshVersion(env); if (!version) throw new Error('无法读取版本'); return `${version} · ${await resolveDshCommand(env)}`; });
  check('数据目录', '检查目录是否存在、权限或选择正确配置方案', async () => { await access(home, constants.R_OK | constants.W_OK); return home; });
  check('本机服务', '检查端口占用或重启 Harness', async () => { const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`); return `端口 ${port} · HTTP ${res.status} · 桌面壳管理进程 ${pid ?? '无'}`; });
  check('端口监听归属', '如果端口被其他应用占用，可选择新端口；不会终止不属于本应用的进程', async () => {
    const { stdout } = await run('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000 });
    const matches = stdout.split(/\r?\n/).filter(l => new RegExp(`:${port}\\s`).test(l) && /LISTENING/.test(l)).map(l => l.trim());
    return matches.join('\n') || '该端口当前没有监听进程';
  });
  for (const [name, url] of [['npm 网络', 'https://registry.npmjs.org/@deepseek-ai%2fdsh/latest'], ['DeepSeek 网络', 'https://api.deepseek.com']]) {
    check(name, '检查网络、代理或防火墙；诊断不发送计费模型请求', async () => { const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`); return `可连接 · HTTP ${res.status}（未发送模型请求）`; });
  }
  return { checkedAt: new Date().toISOString(), items: await Promise.all(checks) };
}
export async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port)); }); });
}
/** Probe before spawning; never stop or silently attach to an unknown listener. */
export async function assertPortAvailable(port: number, host = '127.0.0.1'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被已有服务占用。请先退出旧 Harness 服务，或打开工作台与诊断检查端口；未结束任何已有进程。`
      : `端口 ${port} 无法使用(${error.code || 'UNKNOWN'})，请打开工作台与诊断检查权限或更换端口。`)));
    server.listen({ port, host, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}
export function safeDiagnosticReport(value: unknown): string {
  // Scrub each value before encoding so redaction never corrupts JSON escapes.
  return JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item, 2);
}
