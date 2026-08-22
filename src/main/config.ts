// 集中配置:dsh 服务地址、轮询与超时参数。改动只发生在这里。
export interface Config {
  /** dsh web 监听地址(官方默认) */
  host: string;
  /** dsh web 默认端口(官方默认) */
  port: number;
  /** 就绪轮询超时(毫秒) */
  readyTimeoutMs: number;
  /** 就绪轮询间隔(毫秒) */
  pollIntervalMs: number;
  /** spawn dsh 时传给 CLI 的参数 */
  dshArgs: string[];
}

export const config: Config = {
  host: '127.0.0.1',
  port: 3080,
  // 官方 Harness 首次初始化可能超过 30 秒(本机实测约 40 秒),留足 120 秒。
  readyTimeoutMs: 120_000,
  pollIntervalMs: 500,
  // 官方 CLI 默认会同时打开系统浏览器;桌面套壳使用 --no-open 只启动 Web 服务。
  dshArgs: ['web', '--no-open'],
};

/** dsh Web GUI 的完整地址 */
export function dshUrl(): string {
  return `http://${config.host}:${config.port}`;
}
