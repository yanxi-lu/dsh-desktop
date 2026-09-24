import { parentPort, workerData } from 'node:worker_threads';
import { getUsageAnalytics, UsageLogIndex } from './usage-analytics';
import { exportUsage } from './usage-export';

const { env, cacheDirectory, root } = workerData;
const index = new UsageLogIndex(cacheDirectory);

parentPort!.on('message', ({ id, request, action, format, section }) => {
  try {
    if (action === 'rebuild') index.rebuild();
    const result = getUsageAnalytics(env, request, root, Date.now(), index, action === 'export');
    const summary = action === 'export' ? exportUsage(result, format, section) : result;
    parentPort!.postMessage({ id, summary });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : '统计读取失败，请重试' });
  }
});
