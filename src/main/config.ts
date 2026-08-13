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
  readyTimeoutMs: 30_000,
  pollIntervalMs: 500,
  dshArgs: ['web'],
};

/** dsh Web GUI 的完整地址 */
export function dshUrl(): string {
  return `http://${config.host}:${config.port}`;
}
