import { describe, it, expect } from 'vitest';
import { sanitizeWindowState, loadWindowState, saveWindowState } from '../src/main/windows';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sanitizeWindowState', () => {
  it('合法值原样保留', () => {
    expect(sanitizeWindowState({ x: 10, y: 20, width: 1280, height: 800 }))
      .toEqual({ x: 10, y: 20, width: 1280, height: 800 });
  });

  it('缺字段回退默认值', () => {
    expect(sanitizeWindowState(null)).toEqual({ width: 1280, height: 800 });
    expect(sanitizeWindowState({ width: 999 })).toEqual({ width: 999, height: 800 });
  });

  it('尺寸 clamp 到最小 800x600', () => {
    expect(sanitizeWindowState({ width: 100, height: 100 }))
      .toEqual({ width: 800, height: 600 });
  });

  it('非法类型丢弃字段', () => {
    expect(sanitizeWindowState({ width: 'big', x: 'left' }))
      .toEqual({ width: 1280, height: 800 });
  });
});

describe('窗口状态文件读写', () => {
  it('save 后 load 得到相同状态;文件不存在时返回默认值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'));
    const file = join(dir, 'state.json');
    try {
      expect(loadWindowState(file)).toEqual({ width: 1280, height: 800 });
      saveWindowState(file, { x: 5, y: 6, width: 1024, height: 768 });
      expect(loadWindowState(file)).toEqual({ x: 5, y: 6, width: 1024, height: 768 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
