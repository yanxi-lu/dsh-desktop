// preload:向 renderer 暴露最小 IPC 面(sandbox 环境下仅 contextBridge/ipcRenderer 可用)。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dshApp', {
  /** 桌面壳与本机 Harness 的版本信息 */
  getInfo: (): Promise<{
    appVersion: string;
    dshVersion: string | null;
    latestDshVersion: string | null;
  }> =>
    ipcRenderer.invoke('dsh:info'),
  /** 获取环境检测状态 */
  getStatus: (): Promise<{ node: boolean; dsh: boolean }> =>
    ipcRenderer.invoke('dsh:status'),
  /** 无 Node.js 时通过 Windows Package Manager 安装官方 LTS */
  installNode: (): Promise<{ ok: boolean; version?: string; error?: string }> =>
    ipcRenderer.invoke('node:install'),
  /** 引导页「重新检测」;通过后主进程自动进入启动流程 */
  recheck: (): Promise<{ ok: boolean; node: boolean; dsh: boolean }> =>
    ipcRenderer.invoke('dsh:recheck'),
  /** 中转页/崩溃页「重试」:重新 spawn 并等待就绪 */
  retry: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dsh:retry'),
  /** 正常运行时一键重启 Harness 服务 */
  restartDsh: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dsh:restart'),
  /** 一键安装/更新 npm 全局 DeepSeek Harness,随后自动重启服务 */
  updateDsh: (targetVersion?: string): Promise<{ ok: boolean; version?: string; error?: string }> =>
    ipcRenderer.invoke('dsh:update', targetVersion),
  /** npm 官方已发布版本列表 */
  getDshVersions: (): Promise<{
    current: string | null;
    latest: string | null;
    versions: string[];
  }> => ipcRenderer.invoke('dsh:versions'),
  /** 取消仍在运行的 Harness npm 安装 */
  cancelDshUpdate: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dsh:update-cancel'),
  /** 重启整个桌面应用 */
  restartApp: (): Promise<void> => ipcRenderer.invoke('app:restart'),
  /** 打开用量估价与版本管理窗口 */
  openManagement: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('management:open'),
  /** 读取本机 Harness 会话日志中的用量元数据并生成统计视图 */
  getUsage: (request?: {
    range?: 'today' | '7d' | '30d' | 'custom';
    startDate?: string;
    endDate?: string;
    modelFilter?: string;
    recentPage?: number;
    recentPageSize?: 10 | 20 | 50 | 100;
    pricing?: {
      model?: string;
      tier?: string;
      customPrices?: {
        cacheHitPerMillionCny?: number;
        cacheMissPerMillionCny?: number;
        outputPerMillionCny?: number;
      };
    };
  }): Promise<unknown> => ipcRenderer.invoke('usage:get', request),
  /** 通过 DeepSeek 官方接口查询账户余额；API Key 不在桌面壳中持久化 */
  getBalance: (apiKey?: string): Promise<{
    ok: boolean;
    isAvailable?: boolean;
    balanceInfos?: Array<{
      currency: string;
      totalBalance: string;
      grantedBalance: string;
      toppedUpBalance: string;
    }>;
    queriedAt?: string;
    keySource?: 'input' | 'environment';
    code?: string;
    error?: string;
  }> => ipcRenderer.invoke('balance:get', apiKey),
  /** 在系统浏览器打开 DeepSeek 官方价格页 */
  openPricingDocs: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('usage:open-pricing'),
  /** 订阅主进程推送的错误消息 */
  onError: (cb: (msg: string) => void): void => {
    ipcRenderer.on('dsh:error', (_e, msg: string) => cb(msg));
  },
  /** Harness 安装/更新/重启进度 */
  onOperationStatus: (cb: (status: unknown) => void): void => {
    ipcRenderer.on('dsh:operation-status', (_e, status: unknown) => cb(status));
  },
});
