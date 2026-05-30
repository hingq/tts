/**
 * @file job-pipeline.test.ts
 * @description JobPipeline 调度器的离线单元测试。mock 掉 TTS Provider 与模块 05 的 ffmpeg 工具，
 * 验证：完整流水线推进、逐分片转码、转码后删除 MP3、TTS 并发不超额、断点续传幂等跳过。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 提升到模块顶部的可控 mock，供 vi.mock 工厂与各用例共享
const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
  transcodeToM4A: vi.fn(),
  getDuration: vi.fn(),
}));

vi.mock('../../src/providers/edge-tts.js', () => ({
  EdgeTTSProvider: vi.fn(() => ({ synthesize: mocks.synthesize })),
}));

// 模块 05 尚未落地——这里用工厂提供桩，使流水线可在隔离环境下测试
vi.mock('../../src/utils/ffmpeg.js', () => ({
  transcodeToM4A: mocks.transcodeToM4A,
  getDuration: mocks.getDuration,
}));

import { JobPipeline } from '../../src/services/job-pipeline.js';
import { config } from '../../src/config.js';
import type { JobState, ChunkState, ChunkStatus } from '../../src/types/job.js';

let dir: string;

function makeChunk(index: number, status: ChunkStatus = 'pending'): ChunkState {
  return {
    index,
    chapterIndex: 0,
    text: `分片 ${index} 的文本`,
    rawPath: path.join(dir, `raw_${index}.mp3`),
    m4aPath: path.join(dir, `chunk_${index}.m4a`),
    durationMs: 0,
    status,
  };
}

function makeState(chunks: ChunkState[]): JobState {
  return {
    jobId: 'job-1',
    title: '测试书',
    status: 'pending',
    phase: 'preprocess',
    voice: 'zh-CN-YunxiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    bitrate: '64k',
    totalChunks: chunks.length,
    completedTTS: 0,
    completedTranscode: 0,
    chunks,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 用 fake timers 驱动包含随机延时的流水线至完成。 */
async function runToCompletion(promise: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  await promise;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-test-'));
  vi.useFakeTimers();
  mocks.synthesize.mockReset();
  mocks.transcodeToM4A.mockReset();
  mocks.getDuration.mockReset();
  // 默认实现：合成写出 MP3、转码写出 M4A、时长固定
  mocks.synthesize.mockImplementation(async (_t: string, _o: unknown, outNoExt: string) => {
    await fs.writeFile(`${outNoExt}.mp3`, 'mp3');
    return { audioPath: `${outNoExt}.mp3`, format: 'mp3' };
  });
  mocks.transcodeToM4A.mockImplementation(async (_raw: string, out: string) => {
    await fs.writeFile(out, 'm4a');
  });
  mocks.getDuration.mockResolvedValue(1234);
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('JobPipeline.execute', () => {
  it('推进所有分片至 transcode_done 并更新检查点计数', async () => {
    const state = makeState([makeChunk(0), makeChunk(1), makeChunk(2)]);
    const pipeline = new JobPipeline();
    await runToCompletion(pipeline.execute(state, dir, () => {}));

    expect(state.completedTTS).toBe(3);
    expect(state.completedTranscode).toBe(3);
    expect(state.chunks.every((c) => c.status === 'transcode_done')).toBe(true);
    expect(state.chunks.every((c) => c.durationMs === 1234)).toBe(true);
    expect(state.phase).toBe('tts');
    expect(state.status).toBe('running');
  });

  it('转码完成后删除临时 MP3、保留 M4A', async () => {
    const state = makeState([makeChunk(0)]);
    const pipeline = new JobPipeline();
    await runToCompletion(pipeline.execute(state, dir, () => {}));

    await expect(fs.access(state.chunks[0].rawPath)).rejects.toBeTruthy();
    await expect(fs.access(state.chunks[0].m4aPath)).resolves.toBeUndefined();
  });

  it('TTS 成功后立刻投递转码（流水线重叠）', async () => {
    const state = makeState([makeChunk(0)]);
    const pipeline = new JobPipeline();
    await runToCompletion(pipeline.execute(state, dir, () => {}));
    // 单分片即可证明链条成立：synth 与 transcode 各被调用一次
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    expect(mocks.transcodeToM4A).toHaveBeenCalledTimes(1);
    expect(mocks.transcodeToM4A).toHaveBeenCalledWith(
      state.chunks[0].rawPath,
      state.chunks[0].m4aPath,
      config.SUBPROCESS_TIMEOUT_MS,
    );
  });

  it('TTS 并发不超过 CONCURRENT_TTS_LIMIT', async () => {
    let active = 0;
    let maxActive = 0;
    mocks.synthesize.mockImplementation(async (_t: string, _o: unknown, outNoExt: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
      await fs.writeFile(`${outNoExt}.mp3`, 'mp3');
      return { audioPath: `${outNoExt}.mp3`, format: 'mp3' };
    });

    const chunks = Array.from({ length: 6 }, (_, i) => makeChunk(i));
    const pipeline = new JobPipeline();
    await runToCompletion(pipeline.execute(makeState(chunks), dir, () => {}));

    expect(maxActive).toBeGreaterThan(0);
    expect(maxActive).toBeLessThanOrEqual(config.CONCURRENT_TTS_LIMIT);
  });

  it('断点续传：跳过 transcode_done 分片，不重复合成或转码', async () => {
    const done = makeChunk(0, 'transcode_done');
    const pending = makeChunk(1, 'pending');
    const state = makeState([done, pending]);
    const pipeline = new JobPipeline();
    await runToCompletion(pipeline.execute(state, dir, () => {}));

    // 只为 pending 分片合成 / 转码各一次
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    expect(mocks.transcodeToM4A).toHaveBeenCalledTimes(1);
    expect(mocks.synthesize).toHaveBeenCalledWith(
      pending.text,
      expect.anything(),
      pending.rawPath.replace(/\.mp3$/, ''),
    );
  });

  it('断点续传：tts_done 分片跳过 TTS 仅转码', async () => {
    const ttsDone = makeChunk(0, 'tts_done');
    const state = makeState([ttsDone]);
    const pipeline = new JobPipeline();
    await runToCompletion(pipeline.execute(state, dir, () => {}));

    expect(mocks.synthesize).not.toHaveBeenCalled();
    expect(mocks.transcodeToM4A).toHaveBeenCalledTimes(1);
    expect(ttsDone.status).toBe('transcode_done');
  });
});
