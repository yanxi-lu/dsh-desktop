import { join } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type { UsageAnalyticsSummary } from './usage-analytics';

interface PendingRequest {
  resolve: (summary: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 只把紧凑的统计结果送回 Electron 主进程，日志 I/O 和解压始终在 worker 内。 */
export class UsageAnalyticsService {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingRequest>();
  private inFlight = new Map<string, Promise<any>>();
  private nextId = 0;
  private disposed = false;

  constructor(
    private readonly options: { env?: NodeJS.ProcessEnv; cacheDirectory?: string; root?: string } = {},
    private readonly createWorker = (file: string, options: WorkerOptions): Worker => new Worker(file, options),
  ) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker(join(__dirname, 'usage-worker.js'), {
      // 统计不需要 API Key 或任何其他凭据。
      env: {},
      workerData: {
        env: { DSH_HOME: this.options.env?.DSH_HOME },
        root: this.options.root,
        cacheDirectory: this.options.cacheDirectory,
      },
    });
    this.worker = worker;
    worker.on('message', ({ id, summary, error }) => {
      if (this.worker !== worker) return;
      const request = this.pending.get(id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(summary);
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', () => this.fail(worker, new Error('统计任务异常退出，请刷新重试')));
    worker.on('exit', () => this.fail(worker, new Error('统计任务已结束，请刷新重试')));
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.inFlight.clear();
    void worker.terminate();
  }

  get(request?: unknown): Promise<UsageAnalyticsSummary> { return this.execute(request); }
  rebuild(request?: unknown): Promise<UsageAnalyticsSummary> { return this.execute(request, { action: 'rebuild' }); }
  export(request: unknown, format: 'csv' | 'json', section: string): Promise<string> { return this.execute(request, { action: 'export', format, section }); }
  private execute<T>(request?: unknown, operation: { action?: 'export' | 'rebuild'; format?: 'csv' | 'json'; section?: string } = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('统计服务已关闭'));
    const key = JSON.stringify([request ?? {}, operation]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.pending.size >= 32) return Promise.reject(new Error('统计查询较多，请稍后刷新'));
    const id = ++this.nextId;
    const promise = new Promise<T>((resolve, reject) => {
      const worker = this.start();
      const timer = setTimeout(() => this.fail(worker, new Error('统计读取超时，请刷新重试')), 120_000);
      this.pending.set(id, { resolve, reject, timer });
      worker.ref();
      try {
        worker.postMessage({ id, request, ...operation });
      } catch {
        this.fail(worker, new Error('无法启动统计查询，请刷新重试'));
      }
    });
    this.inFlight.set(key, promise);
    const settled = (): void => { if (this.inFlight.get(key) === promise) this.inFlight.delete(key); };
    void promise.then(settled, settled);
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    if (this.worker) this.fail(this.worker, new Error('统计服务已关闭'));
  }
}
