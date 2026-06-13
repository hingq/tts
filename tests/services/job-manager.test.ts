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
  verifyDiskSpace: vi.fn(),
  saveJobState: vi.fn(),
  loadJobState: vi.fn(),
  pipelineExecute: vi.fn(),
  assembleAudiobook: vi.fn(),
  randomUUID: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  cosIsEnabled: vi.fn(),
  cosUploadFile: vi.fn(),
}));

// ─── vi.mock 各依赖模块 ─────────────────────────────────────────

vi.mock('../../src/config.js', () => ({
  config: {
    TMP_ROOT: '/tmp/test-jobs',
    MAX_CONCURRENT_JOBS: 2,
    CONCURRENT_TTS_LIMIT: 2,
    CONCURRENT_TRANSCODE_LIMIT: 2,
    SUBPROCESS_TIMEOUT_MS: 60000,
    COS_UPLOAD_ENABLED: false,
    COS_KEY_PREFIX: 'audiobooks/',
  },
}));

vi.mock('../../src/services/object-store.js', () => ({
  objectStore: {
    isEnabled: mocks.cosIsEnabled,
    uploadFile: mocks.cosUploadFile,
  },
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
      writeFileSync: mocks.writeFileSync,
    },
  };
});

// ─── 被测模块（必须在 mock 之后导入） ───────────────────────────

import { JobManager, JobCreationError } from '../../src/services/job-manager.js';
import { config } from '../../src/config.js';

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
    ttsEngine: 'edge-tts',
    voice: 'zh-CN-YunxiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    bitrate: '64k',
  };
}

/** 构造 n 片示例分片（前端切分结果）。 */
function makeChunks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    chapterIndex: 0,
    chapterTitle: '第一章',
    text: `分片${i}`,
  }));
}

/** 单次 createJob：携带全部分片直接创建并启动流水线，返回 jobId。 */
async function createAndRun(manager: JobManager, totalChunks = 2): Promise<string> {
  const job = await manager.createJob(makeCreateParams(), makeChunks(totalChunks));
  return job.jobId;
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('JobManager', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = JobManager.getInstance();
    resetManager(manager);
    vi.clearAllMocks();

    mocks.verifyDiskSpace.mockResolvedValue(true);
    mocks.saveJobState.mockResolvedValue(undefined);
    mocks.loadJobState.mockResolvedValue(null);
    mocks.pipelineExecute.mockResolvedValue(undefined);
    mocks.assembleAudiobook.mockResolvedValue(undefined);
    mocks.randomUUID.mockReturnValue('test-uuid-1234');
    mocks.cosIsEnabled.mockReturnValue(true);
    mocks.cosUploadFile.mockResolvedValue(undefined);
    config.COS_UPLOAD_ENABLED = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 3.1 状态机切换 ──────────────────────────────────────────

  describe('状态机变化', () => {
    it('createJob 直接创建 running/tts 任务、写入分片并落盘', async () => {
      // pipeline 不完成，便于观察创建后的初始态
      mocks.pipelineExecute.mockImplementation(() => new Promise(() => {}));
      expect(manager.tryReserveSlot()).toBe(true);

      const job = await manager.createJob(makeCreateParams(), makeChunks(2));

      expect(job.jobId).toBe('test-uuid-1234');
      expect(job.status).toBe('running');
      expect(job.progress.phase).toBe('tts');
      expect(job.progress.ttsChunks.total).toBe(2);
      // saveJobState 至少被调用一次（初始落盘）
      expect(mocks.saveJobState).toHaveBeenCalled();
    });

    it('单片任务：携带真实 index 的单个分片可创建并跑完', async () => {
      // 一个切片一个任务：分片保留其在整本中的真实序号（如 57）
      expect(manager.tryReserveSlot()).toBe(true);
      const job = await manager.createJob(makeCreateParams(), [
        { index: 57, chapterIndex: 0, chapterTitle: '第十章', text: '单片正文' },
      ]);

      await vi.waitFor(() => {
        const j = manager.getJob(job.jobId);
        expect(j?.status).toBe('done');
        expect(j?.progress.ttsChunks.total).toBe(1);
      });
    });

    it('createJob 跑完流水线变为 done', async () => {
      // pipeline 和 assembleAudiobook 都成功 → 应推进到 done
      expect(manager.tryReserveSlot()).toBe(true);
      await createAndRun(manager, 2);

      // 等 runJob 的 microtask 推进
      await vi.waitFor(() => {
        const job = manager.getJob('test-uuid-1234');
        expect(job?.status).toBe('done');
      });
    });

    it('流水线异常时状态变为 failed', async () => {
      mocks.pipelineExecute.mockRejectedValue(new Error('TTS 故障'));
      expect(manager.tryReserveSlot()).toBe(true);
      await createAndRun(manager, 2);

      await vi.waitFor(() => {
        const job = manager.getJob('test-uuid-1234');
        expect(job?.status).toBe('failed');
      });
    });
  });

  // ── COS 卸载开关 ──────────────────────────────────────────

  describe('COS 卸载开关 (COS_UPLOAD_ENABLED)', () => {
    it('默认关闭时即使 COS 已配置也不调用 uploadFile', async () => {
      config.COS_UPLOAD_ENABLED = false;
      expect(manager.tryReserveSlot()).toBe(true);
      await createAndRun(manager, 2);

      await vi.waitFor(() => {
        expect(manager.getJob('test-uuid-1234')?.status).toBe('done');
      });
      expect(mocks.cosUploadFile).not.toHaveBeenCalled();
    });

    it('开关开启且 COS 已配置时卸载成品到 COS', async () => {
      config.COS_UPLOAD_ENABLED = true;
      expect(manager.tryReserveSlot()).toBe(true);
      await createAndRun(manager, 2);

      await vi.waitFor(() => {
        expect(manager.getJob('test-uuid-1234')?.status).toBe('done');
      });
      expect(mocks.cosUploadFile).toHaveBeenCalled();
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

      await expect(manager.createJob(makeCreateParams(), makeChunks(2))).rejects.toThrow(
        JobCreationError,
      );

      try {
        expect(manager.tryReserveSlot()).toBe(true); // 名额已释放
        await manager.createJob(makeCreateParams(), makeChunks(2));
      } catch (err) {
        expect(err).toBeInstanceOf(JobCreationError);
        expect((err as JobCreationError).statusCode).toBe(507);
      }
    });

    it('磁盘充足时 createJob 成功', async () => {
      mocks.verifyDiskSpace.mockResolvedValue(true);
      mocks.pipelineExecute.mockImplementation(() => new Promise(() => {}));
      expect(manager.tryReserveSlot()).toBe(true);

      const job = await manager.createJob(makeCreateParams(), makeChunks(2));
      expect(job.jobId).toBe('test-uuid-1234');
      expect(job.status).toBe('running');
    });
  });

  // ── 取消与恢复 ────────────────────────────────────────────

  describe('cancelJob / resumeJob', () => {
    it('cancelJob 将活跃任务置为 canceled', async () => {
      // 让 pipeline 一直 pending 不完成
      mocks.pipelineExecute.mockImplementation(() => new Promise(() => {}));
      expect(manager.tryReserveSlot()).toBe(true);
      await createAndRun(manager, 2);

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
      await createAndRun(manager, 2);
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
