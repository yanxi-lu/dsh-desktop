import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { assertPortAvailable } from '../src/main/diagnostics';

describe('启动前端口检查', () => {
  it('阻止重复启动，保留已有监听服务；释放后允许重试', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    try {
      await expect(assertPortAvailable(address.port)).rejects.toThrow(`端口 ${address.port}`);
      await expect(assertPortAvailable(address.port)).rejects.toThrow('未结束任何已有进程');
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    await expect(assertPortAvailable(address.port)).resolves.toBeUndefined();
  });
});
