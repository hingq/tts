/**
 * @file job-manager.test.ts
 * @description JobManager 的离线单元测试。
 * 通过 vi.mock 替换所有外部依赖（processText、verifyDiskSpace、JobPipeline、
 * assembleAudiobook、saveJobState、loadJobState、randomUUID、fs），
 * 在隔离环境中验证：状态机切换、并发名额管理、磁盘预检错误传播。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── 提升 mock 桩 ───────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  processText: vi.fn(),
  verifyDiskSpace: vi.fn(),
  saveJobState: vi.fn(),
  loadJobState: vi.fn(),
  pipelineExecute: vi.fn(),
  assembleAudiobook: vi.fn(),
  randomUUID: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

// ─── vi.mock 各依赖模块 ─────────────────────────────────────────

vi.mock('../../src/config.js', () => ({
  config: {
    TMP_ROOT: '/tmp/test-jobs',
    MAX_CONCURRENT_JOBS: 2,
    CONCURRENT_TTS_LIMIT: 2,
    CONCURRENT_TRANSCODE_LIMIT: 2,
    SUBPROCESS_TIMEOUT_MS: 60000,
  },
}));

vi.mock('../../src/services/text-processor.js', () => ({
  processText: mocks.processText,
}));

vi.mock('../../src/utils/disk.js', () => ({
  verifyDiskSpace: mocks.verifyDiskSpace,
}));

vi.mock('../../src/utils/state.js', () => ({
  saveJobState: mocks.saveJobState,
  loadJobState: mocks.loadJobState,
}));

vi.mock('../../src/services/job-pipeline.js', () => ({
  JobPipeline: vi.fn().mockImplementation(class {
    execute = mocks.pipelineExecute;
  }),
}));

vi.mock('../../src/utils/ffmpeg.js', () => ({
  assembleAudiobook: mocks.assembleAudiobook,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: mocks.randomUUID,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mocks.mkdirSync,
      rmSync: mocks.rmSync,
    },
  };
});

// ─── 被测模块（必须在 mock 之后导入） ───────────────────────────

import { JobManager, JobCreationError } from '../../src/services/job-manager.js';

// ─── 辅助函数 ────────────────────────────────────────────────────

/** 由于 JobManager 是单例，需要通过类型断言访问私有 Map 进行重置 */
function resetManager(manager: JobManager): void {
  // 清空内部 jobs map 和 reserved 计数
  (manager as unknown as { jobs: Map<string, unknown>; reserved: number }).jobs.clear();
  (manager as unknown as { reserved: number }).reserved = 0;
}

function makeCreateParams() {
  return {
    title: '测试书',
    voice: 'zh-CN-YunxiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    bitrate: '64k',
  };
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('JobManager', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = JobManager.getInstance();
    resetManager(manager);
    vi.clearAllMocks();

    // 默认：processText 返回 2 个分片
    mocks.processText.mockReturnValue([
      { index: 0, chapterIndex: 0, chapterTitle: '第一章', text: '分片0', charCount: 3 },
      { index: 1, chapterIndex: 0, chapterTitle: '第一章', text: '分片1', charCount: 3 },
    ]);
    mocks.verifyDiskSpace.mockResolvedValue(true);
    mocks.saveJobState.mockResolvedValue(undefined);
    mocks.loadJobState.mockResolvedValue(null);
    mocks.pipelineExecute.mockResolvedValue(undefined);
    mocks.assembleAudiobook.mockResolvedValue(undefined);
    mocks.randomUUID.mockReturnValue('test-uuid-1234');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 3.1 状态机切换 ──────────────────────────────────────────

  describe('状态机变化', () => {
    it('createJob 创建 pending 状态任务并落盘', async () => {
      // 先占位
      expect(manager.tryReserveSlot()).toBe(true);

      const job = await manager.createJob(makeCreateParams(), Buffer.from('文本内容'));

      expect(job.jobId).toBe('test-uuid-1234');
      expect(job.status).toBe('pending');
      // saveJobState 至少被调用一次（初始落盘）
      expect(mocks.saveJobState).toHaveBeenCalled();
    });

    it('任务跑完流水线后变为 done', async () => {
      // pipeline 和 assembleAudiobook 都成功 → 应推进到 done
      expect(manager.tryReserveSlot()).toBe(true);

      await manager.createJob(makeCreateParams(), Buffer.from('文本内容'));

      // 等 runJob 的 microtask 推进
      await vi.waitFor(() => {
        const job = manager.getJob('test-uuid-1234');
        expect(job?.status).toBe('done');
      });
    });

    it('流水线异常时状态变为 failed', async () => {
      mocks.pipelineExecute.mockRejectedValue(new Error('TTS 故障'));
      expect(manager.tryReserveSlot()).toBe(true);

      await manager.createJob(makeCreateParams(), Buffer.from('文本'));

      await vi.waitFor(() => {
        const job = manager.getJob('test-uuid-1234');
        expect(job?.status).toBe('failed');
      });
    });
  });

  // ── 3.2 全局并发锁 ──────────────────────────────────────────

  describe('全局并发锁', () => {
    it('达到 MAX_CONCURRENT_JOBS 后 tryReserveSlot 返回 false', () => {
      // MAX_CONCURRENT_JOBS = 2
      expect(manager.tryReserveSlot()).toBe(true);  // reserved=1
      expect(manager.tryReserveSlot()).toBe(true);  // reserved=2
      expect(manager.tryReserveSlot()).toBe(false); // 已满
    });

    it('释放名额后可以重新占位', () => {
      expect(manager.tryReserveSlot()).toBe(true);
      expect(manager.tryReserveSlot()).toBe(true);
      expect(manager.tryReserveSlot()).toBe(false);

      manager.releaseSlot();
      expect(manager.tryReserveSlot()).toBe(true); // 归还后重新可用
    });

    it('reserved 不会降为负数', () => {
      manager.releaseSlot(); // 已经为 0，不应崩溃
      manager.releaseSlot();
      expect(manager.tryReserveSlot()).toBe(true); // 仍然可用
    });
  });

  // ── 3.3 磁盘预检 ──────────────────────────────────────────

  describe('磁盘预检', () => {
    it('磁盘不足时 createJob 抛出 507 JobCreationError', async () => {
      mocks.verifyDiskSpace.mockResolvedValue(false);
      expect(manager.tryReserveSlot()).toBe(true);

      await expect(
        manager.createJob(makeCreateParams(), Buffer.from('文本')),
      ).rejects.toThrow(JobCreationError);

      try {
        expect(manager.tryReserveSlot()).toBe(true); // 名额已释放
        await manager.createJob(makeCreateParams(), Buffer.from('文本'));
      } catch (err) {
        expect(err).toBeInstanceOf(JobCreationError);
        expect((err as JobCreationError).statusCode).toBe(507);
      }
    });

    it('磁盘充足时 createJob 成功', async () => {
      mocks.verifyDiskSpace.mockResolvedValue(true);
      expect(manager.tryReserveSlot()).toBe(true);

      const job = await manager.createJob(makeCreateParams(), Buffer.from('文本'));
      expect(job.jobId).toBe('test-uuid-1234');
      expect(job.status).toBe('pending');
    });

    it('文本为空时 createJob 抛出 400 JobCreationError', async () => {
      mocks.processText.mockReturnValue([]);
      expect(manager.tryReserveSlot()).toBe(true);

      try {
        await manager.createJob(makeCreateParams(), Buffer.from(''));
      } catch (err) {
        expect(err).toBeInstanceOf(JobCreationError);
        expect((err as JobCreationError).statusCode).toBe(400);
      }
    });
  });

  // ── 取消与恢复 ────────────────────────────────────────────

  describe('cancelJob / resumeJob', () => {
    it('cancelJob 将活跃任务置为 canceled', async () => {
      // 让 pipeline 一直 pending 不完成
      mocks.pipelineExecute.mockImplementation(() => new Promise(() => {}));
      expect(manager.tryReserveSlot()).toBe(true);
      await manager.createJob(makeCreateParams(), Buffer.from('文本'));

      const result = manager.cancelJob('test-uuid-1234');
      expect(result).toBe(true);
      expect(manager.getJob('test-uuid-1234')?.status).toBe('canceled');
    });

    it('cancelJob 对不存在的任务返回 false', () => {
      expect(manager.cancelJob('nonexistent')).toBe(false);
    });

    it('resumeJob 将 canceled 任务恢复为 running', async () => {
      mocks.pipelineExecute.mockImplementation(() => new Promise(() => {}));
      expect(manager.tryReserveSlot()).toBe(true);
      await manager.createJob(makeCreateParams(), Buffer.from('文本'));
      manager.cancelJob('test-uuid-1234');

      const result = manager.resumeJob('test-uuid-1234');
      expect(result).toBe('ok');
      expect(manager.getJob('test-uuid-1234')?.status).toBe('running');
    });

    it('resumeJob 对不存在的任务返回 not_found', () => {
      expect(manager.resumeJob('nonexistent')).toBe('not_found');
    });
  });
});
