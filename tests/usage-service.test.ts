import { EventEmitter } from 'node:events';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { UsageAnalyticsService } from '../src/main/usage-service';

class FakeWorker extends EventEmitter {
  messages: Array<{ id: number; request: unknown }> = [];
  postMessage(message: { id: number; request: unknown }): void { this.messages.push(message); }
  ref = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(async () => 0);
}

describe('统计后台服务', () => {
  it('并发相同查询只发送一次，关闭页面后再次查询复用同一 worker', async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker as unknown as Worker);
    const service = new UsageAnalyticsService({}, factory);
    const a = service.get({ range: 'today' });
    const b = service.get({ range: 'today' });
    expect(a).toBe(b);
    expect(worker.messages).toHaveLength(1);
    worker.emit('message', { id: worker.messages[0].id, summary: { totalTokens: 123 } });
    expect(await a).toEqual({ totalTokens: 123 });
    const c = service.get({ range: '7d' });
    expect(factory).toHaveBeenCalledTimes(1);
    worker.emit('message', { id: worker.messages[1].id, summary: { totalTokens: 456 } });
    expect(await c).toEqual({ totalTokens: 456 });
    service.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('worker 退出时释放等待中的请求，并允许下次刷新重新启动', async () => {
    const workers: FakeWorker[] = [];
    const service = new UsageAnalyticsService({}, () => {
      const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker;
    });
    const first = service.get({ range: 'today' });
    const second = service.get({ range: '7d' });
    workers[0].emit('error', new Error('fixture error'));
    await expect(first).rejects.toThrow('统计任务异常退出');
    await expect(second).rejects.toThrow('统计任务异常退出');
    const retry = service.get({ range: 'today' });
    expect(workers).toHaveLength(2);
    workers[0].emit('exit', 1);
    workers[1].emit('message', { id: workers[1].messages[0].id, summary: { totalTokens: 1 } });
    expect(await retry).toEqual({ totalTokens: 1 });
    service.dispose();
  });

  it('仅向后台传入日志位置，不复制 API 凭据', async () => {
    const worker = new FakeWorker();
    let options: WorkerOptions | undefined;
    const service = new UsageAnalyticsService({ env: { DSH_HOME: 'test-home', DEEPSEEK_API_KEY: 'fixture-secret' } }, (_path, value) => {
      options = value; return worker as unknown as Worker;
    });
    const pending = service.get();
    expect(options?.env).toEqual({});
    expect(options?.workerData.env).toEqual({ DSH_HOME: 'test-home' });
    service.dispose();
    await expect(pending).rejects.toThrow('统计服务已关闭');
    await expect(service.get()).rejects.toThrow('统计服务已关闭');
  });

  it('查询超时会终止后台任务，避免永久显示统计中', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const service = new UsageAnalyticsService({}, () => worker as unknown as Worker);
    try {
      const pending = service.get();
      const rejected = expect(pending).rejects.toThrow('统计读取超时');
      await vi.advanceTimersByTimeAsync(120_000);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose(); vi.useRealTimers();
    }
  });
});
