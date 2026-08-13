// preload:向 renderer 暴露最小 IPC 面(sandbox 环境下仅 contextBridge/ipcRenderer 可用)。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dshApp', {
  /** 获取环境检测状态 */
  getStatus: (): Promise<{ node: boolean; dsh: boolean }> =>
    ipcRenderer.invoke('dsh:status'),
  /** 引导页「重新检测」;通过后主进程自动进入启动流程 */
  recheck: (): Promise<{ ok: boolean; node: boolean; dsh: boolean }> =>
    ipcRenderer.invoke('dsh:recheck'),
  /** 中转页/崩溃页「重试」:重新 spawn 并等待就绪 */
  retry: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dsh:retry'),
  /** 订阅主进程推送的错误消息 */
  onError: (cb: (msg: string) => void): void => {
    ipcRenderer.on('dsh:error', (_e, msg: string) => cb(msg));
  },
});
