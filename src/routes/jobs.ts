/**
 * @file jobs.ts
 * @description 有声书任务的 REST/SSE 路由。前缀 `/api/v1/audiobook`（在 server.ts 注册时指定）。
 * Mock 阶段：所有任务状态由内存 {@link JobManager} 驱动；上传内容仅用于校验，不参与最终输出。
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
// 加载插件对 fastify 的类型增强：request.parts() / reply.sse()
import '@fastify/multipart';
import 'fastify-sse-v2';
import fs from 'node:fs';
import path from 'node:path';
import { JobManager, JobCreationError } from '../services/job-manager.js';
import { JobInfo } from '../types/job.js';
import { config } from '../config.js';

/** 合法发音人白名单（核心普通话音色）。 */
const VOICE_WHITELIST = ['zh-CN-YunxiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunjianNeural'];
/** 合法码率枚举。 */
const BITRATE_WHITELIST = ['32k', '64k', '128k'];
/** 合法 TTS 引擎枚举。 */
const ENGINE_WHITELIST = ['edge-tts'];
const RATE_RE = /^[+-]\d+%$/;
const PITCH_RE = /^[+-]\d+Hz$/;
const COVER_MAX_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 200;

/** 客户端可控的错误：携带 HTTP 状态码，由路由直接映射。 */
class HttpError extends Error {
  constructor(
    public statusCode: number,
    public publicName: string,
    message: string,
  ) {
    super(message);
  }
}

/** 去除控制字符，防止污染日志与后续 FFmpeg 元数据。 */
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/** 排干并丢弃一个可读流，返回累计字节数（用于大小校验）。 */
async function drainAndCount(stream: AsyncIterable<Buffer>): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

/** 收集一个可读流的全部字节为 Buffer（文本体积受 multipart fileSize 限制保护）。 */
async function collectBuffer(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

interface ParsedUpload {
  fields: Record<string, string>;
  hasText: boolean;
  /** 上传的正文文本字节，供真实流水线预处理；非法或缺失时为 null */
  textBuffer: Buffer | null;
  coverBuffer: Buffer | null;
  coverExtension: string | null;
}

/**
 * 解析并校验 multipart 上传。消费所有文件流（Mock 阶段仅校验大小/类型，不持久化内容）。
 * @throws HttpError 当任一字段或文件非法
 */
async function parseAndValidate(request: FastifyRequest): Promise<ParsedUpload> {
  const fields: Record<string, string> = {};
  let hasText = false;
  let textBuffer: Buffer | null = null;
  let coverBuffer: Buffer | null = null;
  let coverExtension: string | null = null;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const ext = path.extname(part.filename || '').toLowerCase();
      if (part.fieldname === 'text') {
        if (part.mimetype !== 'text/plain' || ext !== '.txt') {
          await drainAndCount(part.file); // 必须排干，避免连接挂起
          throw new HttpError(400, 'Bad Request', 'text 必须 be text/plain 的 .txt 文件');
        }
        // 收集正文字节供后续流水线预处理；大小超限由 multipart 抛 413
        textBuffer = await collectBuffer(part.file);
        hasText = true;
      } else if (part.fieldname === 'cover') {
        const okMime = part.mimetype === 'image/jpeg' || part.mimetype === 'image/png';
        const okExt = ['.jpg', '.jpeg', '.png'].includes(ext);
        if (!okMime || !okExt) {
          await drainAndCount(part.file);
          throw new HttpError(400, 'Bad Request', 'cover 必须是 jpg/png 图片');
        }
        coverBuffer = await collectBuffer(part.file);
        if (coverBuffer.length > COVER_MAX_BYTES) {
          throw new HttpError(400, 'Bad Request', 'cover 大小不能超过 2MB');
        }
        coverExtension = ext;
      } else {
        await drainAndCount(part.file); // 未知文件字段：排干丢弃
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }

  return { fields, hasText, textBuffer, coverBuffer, coverExtension };
}

/**
 * 校验文本字段并补默认值，返回 createMockJob 所需参数。
 * @throws HttpError 当任一字段非法
 */
function buildJobParams(fields: Record<string, string>): {
  title: string;
  author?: string;
  voice: string;
  rate: string;
  pitch: string;
  bitrate: string;
} {
  const title = stripControlChars(fields.title ?? '');
  if (!title) throw new HttpError(400, 'Bad Request', 'title 为必填项');
  if (title.length > TITLE_MAX) {
    throw new HttpError(400, 'Bad Request', `title 长度不能超过 ${TITLE_MAX}`);
  }

  const author = fields.author !== undefined ? stripControlChars(fields.author) : undefined;
  if (author !== undefined && author.length > TITLE_MAX) {
    throw new HttpError(400, 'Bad Request', `author 长度不能超过 ${TITLE_MAX}`);
  }

  const ttsEngine = fields.ttsEngine ?? 'edge-tts';
  if (!ENGINE_WHITELIST.includes(ttsEngine)) {
    throw new HttpError(400, 'Bad Request', `不支持的 ttsEngine：${ttsEngine}`);
  }

  const voice = fields.voice ?? 'zh-CN-YunxiNeural';
  if (!VOICE_WHITELIST.includes(voice)) {
    throw new HttpError(400, 'Bad Request', `voice 不在白名单内：${voice}`);
  }

  const rate = fields.rate ?? '+0%';
  if (!RATE_RE.test(rate)) throw new HttpError(400, 'Bad Request', `rate 格式非法：${rate}`);

  const pitch = fields.pitch ?? '+0Hz';
  if (!PITCH_RE.test(pitch)) throw new HttpError(400, 'Bad Request', `pitch 格式非法：${pitch}`);

  const bitrate = fields.bitrate ?? '64k';
  if (!BITRATE_WHITELIST.includes(bitrate)) {
    throw new HttpError(400, 'Bad Request', `bitrate 非法：${bitrate}`);
  }

  return { title, author, voice, rate, pitch, bitrate };
}

const TERMINAL_STATES = ['done', 'failed', 'canceled'];

/**
 * 注册有声书任务的全部路由。
 * @param fastify Fastify 实例（已带前缀）
 */
export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  const manager = JobManager.getInstance();

  /**
   * 创建任务：原子占位并发名额 → 解析/校验 multipart → 创建 Mock 任务。
   * 任一失败分支均归还名额。
   */
  fastify.post('/jobs', async (request, reply) => {
    if (!manager.tryReserveSlot()) {
      return reply
        .code(503)
        .send({ error: 'Service Unavailable', message: '已达最大并发任务数，请稍后重试' });
    }

    try {
      const { fields, hasText, textBuffer, coverBuffer, coverExtension } =
        await parseAndValidate(request);
      if (!hasText || !textBuffer) throw new HttpError(400, 'Bad Request', 'text 文件为必填项');
      const params = buildJobParams(fields);

      // 真实创建：内部做文本预处理、磁盘预检（不足抛 507）、落盘并后台跑流水线。
      // createJob 内部 releaseSlot 并转为真实计数。
      const job = await manager.createJob(
        params,
        textBuffer,
        coverBuffer || undefined,
        coverExtension || undefined,
      );
      return reply.code(201).send({
        jobId: job.jobId,
        statusUrl: `/api/v1/audiobook/jobs/${job.jobId}`,
        status: job.status,
      });
    } catch (err) {
      manager.releaseSlot();
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send({ error: err.publicName, message: err.message });
      }
      // 任务创建期错误（如文本为空 400、磁盘不足 507）按其携带的状态码映射
      if (err instanceof JobCreationError) {
        return reply.code(err.statusCode).send({ error: err.publicName, message: err.message });
      }
      throw err; // 交由全局错误处理器（含 multipart 413）
    }
  });

  /** 查询任务状态。 */
  fastify.get('/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = manager.getJob(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Not Found', message: '任务不存在' });
    }
    return reply.send(job);
  });

  /**
   * SSE 进度事件流：handshake → progress* → status（终态）。
   * 晚订阅的终态任务会立即补发 status 并关闭；连接关闭时清理监听器与心跳。
   */
  fastify.get('/jobs/:jobId/events', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = manager.getJob(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Not Found', message: '任务不存在' });
    }

    const isTerminal = (s: string): boolean => TERMINAL_STATES.includes(s);

    // 先握手 + 推送当前快照
    reply.sse({ event: 'handshake', data: JSON.stringify({ jobId }) });
    reply.sse({ event: 'progress', data: JSON.stringify(job) });

    // 终态补发：晚到的订阅者也能立即收到结束事件，然后关闭。
    // 用 sseContext.source.end() 而非 reply.raw.end()，确保已入队的事件先刷出再关流。
    if (isTerminal(job.status)) {
      reply.sse({
        event: 'status',
        data: JSON.stringify({
          status: job.status,
          downloadUrl: job.downloadUrl,
          error: job.error,
        }),
      });
      reply.sseContext.source.end();
      return;
    }

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      manager.off(`job:${jobId}`, listener);
      reply.sseContext.source.end();
    };

    const listener = (eventData: JobInfo): void => {
      reply.sse({ event: 'progress', data: JSON.stringify(eventData) });
      if (isTerminal(eventData.status)) {
        reply.sse({
          event: 'status',
          data: JSON.stringify({
            status: eventData.status,
            downloadUrl: eventData.downloadUrl,
            error: eventData.error,
          }),
        });
        cleanup();
      }
    };

    // 心跳，防止反代空闲超时切断长连接
    const heartbeat = setInterval(() => reply.sse({ comment: 'keepalive' }), 20_000);

    manager.on(`job:${jobId}`, listener);
    request.raw.on('close', cleanup);
  });
  /**
   * SSE 流式输出 Mock：模拟大模型逐 token 推送场景。
   * 事件流：handshake → ai-stream* → ai-complete。
   * 复用与 /jobs/:jobId/events 相同的 cleanup + heartbeat 模式。
   */
  fastify.get('/sse', async (request, reply) => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    const MOCK_TEXT =
      `# 🚀 Hermes Agent 接入测试\n\n` +
      `这是流式传输的 **Markdown** 文本渲染测试。Hermes Agent 运行状态正常。\n\n` +
      `### 1. 核心功能特点\n` +
      `* **工具调用**：支持自动执行终端命令、运行 Python 脚本。\n` +
      `* **沙箱隔离**：支持 Local、Docker、SSH 等 6 种环境。\n\n` +
      `### 2. 代码执行示例\n` +
      `\`\`\`javascript\n` +
      `const http = require('http');\n` +
      `server.listen(3000);\n` +
      `\`\`\`\n\n` +
      `--- \n` +
      `检查完毕，即将发射 ai-complete 信号...`;

    async function* createTokenStream() {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // 🔥 握手事件：纯 Fastify 风格的第一个发射信号
      yield {
        event: 'handshake',
        data: JSON.stringify({ status: '200', message: 'connected' }),
      };

      // 🔥 核心修正：使用 for...of 遍历，绝不切碎 UTF-8 编码
      for (const char of MOCK_TEXT) {
        // 如果遇到换行符，依然转义为 '\\n' 字符串发给前端，避开 SSE 协议的“空行吞噬”漏洞
        if (char === '\n') {
          yield { event: 'ai-stream', data: '\\n' };
        } else {
          yield { event: 'ai-stream', data: char };
        }

        await sleep(25); // 打字机速度
      }

      yield { event: 'ai-complete', data: 'done' };
    }

    // Fastify 会自动接管心跳（Keep-Alive）、编码（UTF-8）以及客户端连接断开时的资源释放（Cleanup）
    return reply.sse(createTokenStream());
  });
  /** 带 Range 的文件下载；下载完成后异步清理工作目录。 */
  fastify.get('/jobs/:jobId/file', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = manager.getJob(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Not Found', message: '任务不存在' });
    }
    if (job.status !== 'done') {
      return reply.code(409).send({ error: 'Conflict', message: '任务尚未完成' });
    }

    const filePath = path.join(config.TMP_ROOT, jobId, 'output.m4b');
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return reply.code(404).send({ error: 'Not Found', message: '输出文件不存在' });
    }

    // 先解析并校验 Range，再设置音频响应头。
    // 若先设了 Content-Type: audio/mp4，则 416 的 JSON 错误体会触发 FST_ERR_REP_INVALID_PAYLOAD_TYPE。
    const range = request.headers.range;
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (match[1] === '' && match[2] === '')) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${size}`)
          .send({ error: 'Range Not Satisfiable', message: 'Range 格式非法' });
      }
      start = match[1] === '' ? 0 : parseInt(match[1], 10);
      end = match[2] === '' ? size - 1 : parseInt(match[2], 10);
      if (start > end || start < 0 || end >= size) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${size}`)
          .send({ error: 'Range Not Satisfiable', message: 'Range 越界' });
      }
      partial = true;
    }

    const filename = encodeURIComponent(`${job.title || 'audiobook'}.m4b`);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', 'audio/mp4');
    reply.header(
      'Content-Disposition',
      `attachment; filename="audiobook.m4b"; filename*=UTF-8''${filename}`,
    );

    if (partial) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', end - start + 1);
      const stream = fs.createReadStream(filePath, { start, end });
      return reply.send(stream); // 部分下载不清理目录
    }

    // 完整下载（连接关闭）后写入 `.downloaded` 标记，交由定时 GC 异步回收工作目录。
    // 注意：仅在完整 200 下载后标记；部分 206（Range）请求可能是断点续传的一段，不可标记。
    const markDownloaded = (): void => {
      fs.writeFile(path.join(config.TMP_ROOT, jobId, '.downloaded'), '', () => undefined);
    };
    reply.header('Content-Length', size);
    const stream = fs.createReadStream(filePath);
    reply.raw.on('close', markDownloaded);
    return reply.send(stream);
  });

  /** 取消任务（对终态幂等）。 */
  fastify.delete('/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = manager.getJob(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Not Found', message: '任务不存在' });
    }
    // 已是终态：幂等返回，不改变状态
    if (!TERMINAL_STATES.includes(job.status)) {
      manager.cancelJob(jobId);
    }
    return reply.code(204).send();
  });

  /** 恢复 failed/canceled 任务。 */
  fastify.post('/jobs/:jobId/resume', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };

    if (!manager.tryReserveSlot()) {
      return reply
        .code(503)
        .send({ error: 'Service Unavailable', message: '已达最大并发任务数，请稍后重试' });
    }

    const result = manager.resumeJob(jobId);
    if (result === 'ok') {
      manager.releaseSlot(); // 任务已回到 pending（计入活跃数），归还占位避免重复计数
      return reply.code(200).send(manager.getJob(jobId));
    }

    manager.releaseSlot();
    if (result === 'not_found') {
      return reply.code(404).send({ error: 'Not Found', message: '任务不存在' });
    }
    return reply.code(400).send({ error: 'Bad Request', message: '仅 failed/canceled 任务可恢复' });
  });
}
