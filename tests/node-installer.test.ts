import { describe, expect, it } from 'vitest';
import {
  parseNodeVersion,
  refreshNodePath,
  resolveWingetCommand,
} from '../src/main/node-installer';

describe('Node.js LTS 一键安装辅助逻辑', () => {
  it('解析 node --version 输出', () => {
    expect(parseNodeVersion('v24.18.0\r\n')).toBe('24.18.0');
    expect(parseNodeVersion('not-a-version')).toBeNull();
  });

  it('优先选择 winget.exe', async () => {
    const command = await resolveWingetCommand(async () => [
      'C:\\WindowsApps\\winget',
      'C:\\WindowsApps\\winget.exe',
    ]);
    expect(command).toBe('C:\\WindowsApps\\winget.exe');
  });

  it('安装后把 node 与 npm 目录加入当前 PATH 且不重复', () => {
    const env = {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    };
    refreshNodePath(env, 'C:\\Program Files\\nodejs\\node.exe');
    const segments = env.Path.split(';');
    expect(segments.filter((item) => item === 'C:\\Program Files\\nodejs')).toHaveLength(1);
    expect(segments).toContain('C:\\Users\\me\\AppData\\Roaming\\npm');
  });
});
