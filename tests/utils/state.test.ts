/**
 * @file state.test.ts
 * @description saveJobState / loadJobState 的离线单元测试。
 * 用系统临时目录验证：写入后可读回、updatedAt 被刷新、临时文件被重命名（不残留）、损坏文件容错。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveJobState, loadJobState } from '../../src/utils/state.js';
import type { JobState } from '../../src/types/job.js';

function makeState(): JobState {
  return {
    jobId: 'job-1',
    title: '测试书',
    status: 'running',
    phase: 'tts',
    voice: 'zh-CN-YunxiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    bitrate: '64k',
    totalChunks: 2,
    completedTTS: 0,
    completedTranscode: 0,
    chunks: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('saveJobState / loadJobState', () => {
  it('写入后可完整读回', async () => {
    const state = makeState();
    await saveJobState(dir, state);
    const loaded = await loadJobState(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.jobId).toBe('job-1');
    expect(loaded!.title).toBe('测试书');
    expect(loaded!.totalChunks).toBe(2);
  });

  it('每次写入都会刷新 updatedAt', async () => {
    const state = makeState();
    const before = state.updatedAt;
    await saveJobState(dir, state);
    expect(state.updatedAt).not.toBe(before);
    expect(Date.parse(state.updatedAt)).toBeGreaterThan(Date.parse(before));
  });

  it('落盘后不残留临时文件', async () => {
    await saveJobState(dir, makeState());
    const entries = await fs.readdir(dir);
    expect(entries).toContain('state.json');
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('文件缺失时 loadJobState 返回 null', async () => {
    expect(await loadJobState(dir)).toBeNull();
  });

  it('JSON 损坏时 loadJobState 返回 null', async () => {
    await fs.writeFile(path.join(dir, 'state.json'), '{ not valid json', 'utf-8');
    expect(await loadJobState(dir)).toBeNull();
  });
});
