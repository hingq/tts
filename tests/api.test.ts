/**
 * @file api.test.ts
 * @description API 集成测试。使用 fastify.inject 模拟请求，
 * 验证创建任务、SSE 进度流、断点下载、任务取消/恢复以及 AI 流端点。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import cors from '@fastify/cors';
import { registerRoutes } from '../src/routes/jobs.js';
import { config } from '../src/config.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// ─── 提升 mock 桩 ───────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  statSync: vi.fn(),
  createReadStream: vi.fn(),
  writeFile: vi.fn(),
}));

// Mock node:fs to prevent hitting actual files during testing
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      statSync: (path: string, options?: any) => {
        if (path.includes('output.m4b')) {
          return mocks.statSync(path, options);
        }
        return actual.default.statSync(path, options);
      },
      createReadStream: (path: string, options?: any) => {
        if (path.includes('output.m4b')) {
          return mocks.createReadStream(path, options);
        }
        return actual.default.createReadStream(path, options);
      },
      writeFile: (path: string, data: any, options: any, callback?: any) => {
        if (path.includes('.downloaded')) {
          const cb = typeof options === 'function' ? options : callback;
          mocks.writeFile(path, data, cb);
          if (cb) cb(null);
          return;
        }
        return actual.default.writeFile(path, data, options, callback);
      },
    },
  };
});

// Mock JobManager as a clean EventEmitter subclass
const mockManager = new (class extends EventEmitter {
  tryReserveSlot = vi.fn();
  releaseSlot = vi.fn();
  createJob = vi.fn();
  getJob = vi.fn();
  getRemoteKey = vi.fn();
  listJobs = vi.fn();
  uploadArtifact = vi.fn();
  cancelJob = vi.fn();
  resumeJob = vi.fn();
})();

// COS 卸载层桩：默认禁用；按用例驱动 getPresignedUrl 验证 302 跳转分支
const mockObjectStore = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
}));
vi.mock('../src/services/object-store.js', () => ({ objectStore: mockObjectStore }));

vi.mock('../src/services/job-manager.js', () => {
  return {
    JobManager: {
      getInstance: () => mockManager,
    },
    JobCreationError: class extends Error {
      constructor(
        public statusCode: number,
        public publicName: string,
        message: string,
      ) {
        super(message);
        this.name = 'JobCreationError';
      }
    },
  };
});

// Helper to construct boundary-delimited multipart form-data
function buildMultipartBody(
  fields: Record<string, string>,
  files: Array<{ name: string; filename: string; mimetype: string; data: string | Buffer }>,
  boundary: string,
): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, val] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
    chunks.push(Buffer.from(`${val}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`,
      ),
    );
    chunks.push(Buffer.from(`Content-Type: ${file.mimetype}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// Helper to construct Fastify instance for route tests
async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(multipart, {
    limits: {
      files: 2,
      fileSize: 10 * 1024 * 1024,
    },
  });
  await app.register(FastifySSEPlugin);
  await app.register(cors, { origin: true });
  await app.register(registerRoutes, { prefix: '/api/v1' });
  return app;
}

// ─── 测试用例 ──────────────────────────────────────────────────

describe('API Integration Tests', () => {
  let app: any;

  beforeEach(async () => {
    app = await buildApp();
    vi.clearAllMocks();
    // 统一从 edge-tts 起跑：.env 可能把默认引擎设为 mimo-tts，逐用例显式置位避免顺序耦合
    config.DEFAULT_TTS_ENGINE = 'edge-tts';
  });

  afterEach(async () => {
    await app.close();
    // 还原可能被用例临时改写的全局引擎配置
    config.DEFAULT_TTS_ENGINE = 'edge-tts';
  });

  // ── 4.1 创建任务接口（单次 POST /jobs：元数据 + chunks JSON 文件分片）─────────────

  describe('POST /api/v1/jobs (创建并启动任务)', () => {
    const boundary = '----VitestBoundary123';

    /** 示例分片数组（前端切分结果），作为 `chunks` JSON 文件分片提交。 */
    const SAMPLE_CHUNKS = [
      { index: 0, chapterIndex: 0, chapterTitle: '第一章', text: '第一片正文' },
      { index: 1, chapterIndex: 0, chapterTitle: '第一章', text: '第二片正文' },
    ];

    /** 构造带 `chunks` JSON 文件分片（+ 可选额外文件）的 multipart body。 */
    function jobBody(
      fields: Record<string, string>,
      chunks: unknown = SAMPLE_CHUNKS,
      extraFiles: Array<{ name: string; filename: string; mimetype: string; data: string | Buffer }> = [],
    ): Buffer {
      const files = [
        {
          name: 'chunks',
          filename: 'chunks.json',
          mimetype: 'application/json',
          data: JSON.stringify(chunks),
        },
        ...extraFiles,
      ];
      return buildMultipartBody(fields, files, boundary);
    }

    it('成功创建任务并返回 201（chunks 经 createJob 落盘）', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);
      mockManager.createJob.mockResolvedValue({
        jobId: 'test-uuid-1234',
        status: 'running',
        downloadUrl: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书' }),
      });

      expect(response.statusCode).toBe(201);
      const json = JSON.parse(response.body);
      expect(json.jobId).toBe('test-uuid-1234');
      expect(json.status).toBe('running');
      expect(json.statusUrl).toBe('/api/v1/jobs/test-uuid-1234');
      expect(mockManager.tryReserveSlot).toHaveBeenCalled();
      expect(mockManager.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '测试书',
          ttsEngine: 'edge-tts',
          voice: 'zh-CN-YunxiNeural',
        }),
        SAMPLE_CHUNKS,
        undefined,
        undefined,
      );
    });

    it('并发超限返回 503 Service Unavailable', async () => {
      mockManager.tryReserveSlot.mockReturnValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书' }),
      });

      expect(response.statusCode).toBe(503);
      const json = JSON.parse(response.body);
      expect(json.error).toBe('Service Unavailable');
      expect(mockManager.tryReserveSlot).toHaveBeenCalled();
      expect(mockManager.createJob).not.toHaveBeenCalled();
      expect(mockManager.releaseSlot).not.toHaveBeenCalled();
    });

    it('缺少 chunks 文件分片返回 400 Bad Request 并释放名额', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);

      const body = buildMultipartBody({ title: '测试书' }, [], boundary);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.body);
      expect(json.error).toBe('Bad Request');
      expect(json.message).toContain('chunks');
      expect(mockManager.createJob).not.toHaveBeenCalled();
      expect(mockManager.releaseSlot).toHaveBeenCalled();
    });

    it('chunks 为空数组返回 400 并释放名额', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书' }, []),
      });

      expect(response.statusCode).toBe(400);
      expect(mockManager.createJob).not.toHaveBeenCalled();
      expect(mockManager.releaseSlot).toHaveBeenCalled();
    });

    it('分片 text 为空返回 400 并释放名额', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书' }, [{ index: 0, chapterIndex: 0, text: '' }]),
      });

      expect(response.statusCode).toBe(400);
      expect(mockManager.createJob).not.toHaveBeenCalled();
      expect(mockManager.releaseSlot).toHaveBeenCalled();
    });

    it('前端传入的 ttsEngine / voice 被忽略，仍采用 env 配置', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);
      mockManager.createJob.mockResolvedValue({
        jobId: 'test-uuid-ignored',
        status: 'running',
        downloadUrl: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书', ttsEngine: 'mimo-tts', voice: 'zh-CN-IllegalVoice' }),
      });

      expect(response.statusCode).toBe(201);
      expect(mockManager.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ ttsEngine: 'edge-tts', voice: 'zh-CN-YunxiNeural' }),
        SAMPLE_CHUNKS,
        undefined,
        undefined,
      );
    });

    it('env 设为 mimo-tts 时使用 mimo 引擎与 MIMO_VOICE 音色创建任务', async () => {
      config.DEFAULT_TTS_ENGINE = 'mimo-tts';
      mockManager.tryReserveSlot.mockReturnValue(true);
      mockManager.createJob.mockResolvedValue({
        jobId: 'test-uuid-mimo',
        status: 'running',
        downloadUrl: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书' }),
      });

      expect(response.statusCode).toBe(201);
      expect(mockManager.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ ttsEngine: 'mimo-tts', voice: config.MIMO_VOICE }),
        SAMPLE_CHUNKS,
        undefined,
        undefined,
      );
    });

    it('服务端 DEFAULT_TTS_ENGINE 配置非法返回 500', async () => {
      config.DEFAULT_TTS_ENGINE = 'bogus-engine';
      mockManager.tryReserveSlot.mockReturnValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书' }),
      });

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).message).toContain('DEFAULT_TTS_ENGINE');
      expect(mockManager.releaseSlot).toHaveBeenCalled();
    });

    it('磁盘空间不足返回 507 Insufficient Storage', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);
      // 模拟磁盘不足异常
      const { JobCreationError } = await import('../src/services/job-manager.js');
      mockManager.createJob.mockRejectedValue(
        new JobCreationError(507, 'Insufficient Storage', '磁盘空间不足'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: jobBody({ title: '测试书' }),
      });

      expect(response.statusCode).toBe(507);
      const json = JSON.parse(response.body);
      expect(json.error).toBe('Insufficient Storage');
      expect(mockManager.releaseSlot).toHaveBeenCalled();
    });
  });

  // ── 4.2 SSE 进度监控 ─────────────────────────────────────────

  describe('GET /api/v1/jobs/:jobId/events (SSE 监控)', () => {
    it('任务不存在返回 404', async () => {
      mockManager.getJob.mockReturnValue(undefined);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/nonexistent-id/events',
      });

      expect(response.statusCode).toBe(404);
      const json = JSON.parse(response.body);
      expect(json.error).toBe('Not Found');
    });

    it('已完成任务直接完成 SSE 传输并关闭', async () => {
      mockManager.getJob.mockReturnValue({
        jobId: 'done-uuid',
        status: 'done',
        progress: {
          phase: 'ready',
          ttsChunks: { done: 3, total: 3 },
          transcodeChunks: { done: 3, total: 3 },
        },
        downloadUrl: '/api/v1/audiobook/jobs/done-uuid/file',
        error: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:10.000Z',
        title: '已完成的书',
        voice: 'zh-CN-YunxiNeural',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/done-uuid/events',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('event: handshake');
      expect(response.body).toContain('event: progress');
      expect(response.body).toContain('event: status');
      expect(response.body).toContain('"status":"done"');
    });

    it('运行中任务能够通过事件监听接收更新并在到达终态时结束', async () => {
      const mockJob = {
        jobId: 'running-uuid',
        status: 'running',
        progress: {
          phase: 'tts',
          ttsChunks: { done: 0, total: 3 },
          transcodeChunks: { done: 0, total: 3 },
        },
        downloadUrl: null,
        error: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        title: '运行中的书',
        voice: 'zh-CN-YunxiNeural',
      };

      mockManager.getJob.mockReturnValue(mockJob);

      // 模拟在连接建立后，过 50ms 派发完成事件，从而终止 SSE 传输
      setTimeout(() => {
        mockManager.emit('job:running-uuid', {
          ...mockJob,
          status: 'done',
          progress: {
            phase: 'ready',
            ttsChunks: { done: 3, total: 3 },
            transcodeChunks: { done: 3, total: 3 },
          },
          downloadUrl: '/api/v1/audiobook/jobs/running-uuid/file',
          finishedAt: '2026-01-01T00:00:15.000Z',
        });
      }, 50);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/running-uuid/events',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('event: handshake');
      // 包含初始运行状态
      expect(response.body).toContain('"status":"running"');
      // 包含最终状态
      expect(response.body).toContain('event: status');
      expect(response.body).toContain('"status":"done"');
    });
  });

  // ── 4.3 断点下载 ───────────────────────────────────────────

  describe('GET /api/v1/jobs/:jobId/file (音频文件下载)', () => {
    it('任务未完成返回 409 Conflict', async () => {
      mockManager.getJob.mockReturnValue({
        jobId: 'running-id',
        status: 'running',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/running-id/file',
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toBe('Conflict');
    });

    it('输出文件不存在在文件系统返回 404', async () => {
      mockManager.getJob.mockReturnValue({
        jobId: 'done-id',
        status: 'done',
        title: '不存在文件',
      });
      // 模拟 fs 抛出 ENOENT
      mocks.statSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/done-id/file',
      });

      expect(response.statusCode).toBe(404);
    });

    it('已卸载到 COS（remoteKey 非空）：302 跳转到预签名 URL，不读本地文件', async () => {
      mockManager.getJob.mockReturnValue({
        jobId: 'cos-id',
        status: 'done',
        title: '云端书名',
      });
      mockManager.getRemoteKey.mockReturnValueOnce('audiobooks/cos-id.m4b');
      mockObjectStore.getPresignedUrl.mockResolvedValueOnce(
        'https://bucket.cos.ap-guangzhou.myqcloud.com/audiobooks/cos-id.m4b?sign=abc',
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/cos-id/file',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('myqcloud.com');
      expect(mockObjectStore.getPresignedUrl).toHaveBeenCalledWith(
        'audiobooks/cos-id.m4b',
        '云端书名.m4b',
      );
      // 走 COS 时不应触碰本地文件系统
      expect(mocks.statSync).not.toHaveBeenCalled();
    });

    describe('完整及 Partial Content Range 下载', () => {
      beforeEach(() => {
        mockManager.getJob.mockReturnValue({
          jobId: 'done-id',
          status: 'done',
          title: '已完成的书',
        });
        mocks.statSync.mockReturnValue({ size: 2000 });
        mocks.createReadStream.mockImplementation((path: string, options?: any) => {
          const start = options?.start ?? 0;
          const end = options?.end ?? 1999;
          const length = end - start + 1;
          return Readable.from(Buffer.alloc(length));
        });
      });

      it('无 Range 头请求：返回 200 及完整文件，并调用 downloaded 异步标记', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/jobs/done-id/file',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-length']).toBe('2000');
        expect(response.headers['accept-ranges']).toBe('bytes');
        expect(response.headers['content-type']).toBe('audio/mp4');
        expect(response.rawPayload.length).toBe(2000);
        expect(mocks.writeFile).toHaveBeenCalledWith(
          expect.stringContaining('.downloaded'),
          '',
          expect.any(Function),
        );
      });

      it('合法 Range 头请求：返回 206 局部内容', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/jobs/done-id/file',
          headers: {
            range: 'bytes=0-1023',
          },
        });

        expect(response.statusCode).toBe(206);
        expect(response.headers['content-range']).toBe('bytes 0-1023/2000');
        expect(response.headers['content-length']).toBe('1024');
        expect(response.headers['accept-ranges']).toBe('bytes');
        expect(response.rawPayload.length).toBe(1024);
        // 部分下载不触发 downloaded 标记
        expect(mocks.writeFile).not.toHaveBeenCalled();
      });

      it('Range 越界返回 416', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/jobs/done-id/file',
          headers: {
            range: 'bytes=2000-3000',
          },
        });

        expect(response.statusCode).toBe(416);
        expect(response.headers['content-range']).toBe('bytes */2000');
      });

      it('Range 格式非法返回 416', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/jobs/done-id/file',
          headers: {
            range: 'bytes=invalid',
          },
        });

        expect(response.statusCode).toBe(416);
      });
    });
  });

  // ── 4.4 取消与恢复 ───────────────────────────────────────────

  describe('DELETE /api/v1/jobs/:jobId (取消任务)', () => {
    it('任务不存在返回 404', async () => {
      mockManager.getJob.mockReturnValue(undefined);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/jobs/nonexistent-id',
      });

      expect(response.statusCode).toBe(404);
      expect(mockManager.cancelJob).not.toHaveBeenCalled();
    });

    it('活跃任务调用 cancelJob 并返回 204', async () => {
      mockManager.getJob.mockReturnValue({
        jobId: 'active-id',
        status: 'running',
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/jobs/active-id',
      });

      expect(response.statusCode).toBe(204);
      expect(mockManager.cancelJob).toHaveBeenCalledWith('active-id');
    });

    it('终态任务幂等直接返回 204 且不调用 cancelJob', async () => {
      mockManager.getJob.mockReturnValue({
        jobId: 'done-id',
        status: 'done',
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/jobs/done-id',
      });

      expect(response.statusCode).toBe(204);
      expect(mockManager.cancelJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/jobs/:jobId/resume (恢复任务)', () => {
    it('任务恢复成功返回 200 并携带任务详情', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);
      mockManager.resumeJob.mockReturnValue('ok');
      mockManager.getJob.mockReturnValue({
        jobId: 'resumed-id',
        status: 'running',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/resumed-id/resume',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('running');
      expect(mockManager.resumeJob).toHaveBeenCalledWith('resumed-id');
      expect(mockManager.releaseSlot).toHaveBeenCalled(); // 恢复调用后会释放占位槽
    });

    it('并发满导致无法恢复返回 503', async () => {
      mockManager.tryReserveSlot.mockReturnValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/resumed-id/resume',
      });

      expect(response.statusCode).toBe(503);
      expect(mockManager.resumeJob).not.toHaveBeenCalled();
    });

    it('任务不存在返回 404', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);
      mockManager.resumeJob.mockReturnValue('not_found');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/nonexistent-id/resume',
      });

      expect(response.statusCode).toBe(404);
      expect(mockManager.releaseSlot).toHaveBeenCalled();
    });

    it('非 failed/canceled 状态任务不能恢复返回 400', async () => {
      mockManager.tryReserveSlot.mockReturnValue(true);
      mockManager.resumeJob.mockReturnValue('invalid_state');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/running-id/resume',
      });

      expect(response.statusCode).toBe(400);
      expect(mockManager.releaseSlot).toHaveBeenCalled();
    });
  });

  // ── 4.x 任务列表与手动上传 ─────────────────────────────────────

  describe('GET /api/v1/jobs (任务列表)', () => {
    it('返回任务概览数组', async () => {
      const jobs = [
        { jobId: 'a', status: 'done', phase: 'ready', title: '书A', uploaded: true, hasLocalFile: false },
        { jobId: 'b', status: 'running', phase: 'tts', title: '书B', uploaded: false, hasLocalFile: true },
      ];
      mockManager.listJobs.mockResolvedValue(jobs);

      const response = await app.inject({ method: 'GET', url: '/api/v1/jobs' });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ jobs });
      expect(mockManager.listJobs).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/jobs/:jobId/upload (手动上传 COS)', () => {
    it('上传成功返回 200 及 remoteKey', async () => {
      mockManager.uploadArtifact.mockResolvedValue({
        ok: true,
        remoteKey: 'audiobooks/x.m4b',
        alreadyUploaded: false,
      });

      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/x/upload' });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        jobId: 'x',
        remoteKey: 'audiobooks/x.m4b',
        alreadyUploaded: false,
      });
      expect(mockManager.uploadArtifact).toHaveBeenCalledWith('x');
    });

    it('已上传过则幂等返回 alreadyUploaded=true', async () => {
      mockManager.uploadArtifact.mockResolvedValue({
        ok: true,
        remoteKey: 'audiobooks/x.m4b',
        alreadyUploaded: true,
      });

      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/x/upload' });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).alreadyUploaded).toBe(true);
    });

    it('任务不存在返回 404', async () => {
      mockManager.uploadArtifact.mockResolvedValue({ ok: false, reason: 'not_found' });
      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/none/upload' });
      expect(response.statusCode).toBe(404);
    });

    it('任务未完成返回 409', async () => {
      mockManager.uploadArtifact.mockResolvedValue({ ok: false, reason: 'not_done' });
      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/running/upload' });
      expect(response.statusCode).toBe(409);
    });

    it('COS 未配置返回 409', async () => {
      mockManager.uploadArtifact.mockResolvedValue({ ok: false, reason: 'cos_disabled' });
      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/x/upload' });
      expect(response.statusCode).toBe(409);
    });

    it('本地成品不存在返回 404', async () => {
      mockManager.uploadArtifact.mockResolvedValue({ ok: false, reason: 'no_local_file' });
      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/x/upload' });
      expect(response.statusCode).toBe(404);
    });

    it('上传 I/O 失败抛错经全局处理器映射为 500', async () => {
      mockManager.uploadArtifact.mockRejectedValue(new Error('COS 网络中断'));
      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/x/upload' });
      expect(response.statusCode).toBe(500);
    });
  });

  // ── 额外测试 (AI Stream 接口) ─────────────────────────────────

  describe('GET /api/v1/sse (AI Stream 接口)', () => {
    it('正确生成 AI 流式文本，包含 handshake、ai-stream 与 ai-complete', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sse',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('event: handshake');
      expect(response.body).toContain('event: ai-stream');
      expect(response.body).toContain('event: ai-complete');
    }, 15000);
  });
});
