/**
 * @file jobs.ts
 * @description 有声书任务的 REST/SSE 路由。前缀在 server.ts 注册时指定（`/api/v1`）。
 * 创建任务为单次 `POST /jobs`：前端切分后随请求携带全部分片（`chunks` JSON 文件分片）+ 元数据
 * + 可选封面，后端据此创建任务并后台启动流水线（TTS → 转码 → 合成 M4B）。
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
// 加载插件对 fastify 的类型增强：request.parts() / reply.sse()
import '@fastify/multipart';
import 'fastify-sse-v2';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobManager, JobCreationError, IncomingChunk } from '../services/job-manager.js';
import { objectStore } from '../services/object-store.js';
import { JobInfo } from '../types/job.js';
import { config } from '../config.js';
import { getAgent } from '../agent/agent.js';

/** 合法 TTS 引擎枚举（用于校验服务端 env 配置，非前端入参）。 */
const ENGINE_WHITELIST = ['edge-tts', 'mimo-tts'];
/** 按引擎划分的合法发音人白名单（用于校验服务端 env 配置，非前端入参）。 */
const VOICE_WHITELIST: Record<string, string[]> = {
  'edge-tts': ['zh-CN-YunxiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunjianNeural'],
  'mimo-tts': ['苏打', '冰糖', '茉莉', '白桦', 'mimo_default'],
};
/** 合法码率枚举。 */
const BITRATE_WHITELIST = ['32k', '64k', '128k'];
const RATE_RE = /^[+-]\d+%$/;
const PITCH_RE = /^[+-]\d+Hz$/;
const COVER_MAX_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 200;
/** 单次任务允许的分片总数上限（防滥用） */
const TOTAL_CHUNKS_MAX = 100_000;
/** 单个分片正文的字符上限（前端按 ~2500 字切分，留足余量） */
const CHUNK_TEXT_MAX = 10_000;

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

/**
 * 清洗分片正文：剔除除换行（\n \r）与制表符（\t）外的控制字符，保留正文换行。
 * 与 {@link stripControlChars} 的区别在于不吞掉换行——正文需要保留段落结构。
 */
function sanitizeChunkText(raw: string | undefined): string {
  if (raw === undefined) return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

/** 排干并丢弃一个可读流，返回累计字节数（用于大小校验）。 */
async function drainAndCount(stream: AsyncIterable<Buffer>): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

/**
 * 从 LangChain 的 AIMessageChunk 中提取纯文本增量。
 * content 可能是 string，也可能是 content blocks 数组（如 Anthropic 的 `{type:'text', text}`）。
 */
export function extractChunkText(chunk: unknown): string {
  const content = (chunk as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('');
  }
  return '';
}

/**
 * 将文本中的换行转义为字面量 `\n` 再走 SSE data 字段，沿用与旧 mock 一致的前端协议，
 * 规避 SSE 协议「空行吞噬」导致前端拼接错位。
 */
export function escapeSseText(text: string): string {
  return text.replace(/\n/g, '\\n');
}

/** 收集一个可读流的全部字节为 Buffer（文本体积受 multipart fileSize 限制保护）。 */
async function collectBuffer(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

interface ParsedUpload {
  fields: Record<string, string>;
  chunks: IncomingChunk[];
  coverBuffer: Buffer | null;
  coverExtension: string | null;
}

/**
 * 解析并校验创建任务的 multipart 请求：元数据 value 字段 + `chunks` JSON 文件分片 + 可选 `cover`。
 * 分片由前端切分后整体以 `application/json` 文件分片（`TTSChunk[]`）一次性提交——走 `fileSize`
 * 限制而非字段大小上限，适配整本数 MB 文本。消费所有文件流以避免连接挂起。
 * @throws HttpError 当封面文件非法、缺少 chunks、chunks 非法 JSON 或分片内容非法
 */
async function parseAndValidate(request: FastifyRequest): Promise<ParsedUpload> {
  const fields: Record<string, string> = {};
  let coverBuffer: Buffer | null = null;
  let coverExtension: string | null = null;
  let chunksBuffer: Buffer | null = null;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const ext = path.extname(part.filename || '').toLowerCase();
      if (part.fieldname === 'cover') {
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
      } else if (part.fieldname === 'chunks') {
        chunksBuffer = await collectBuffer(part.file);
      } else {
        await drainAndCount(part.file); // 未知文件字段：排干丢弃
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }

  const chunks = parseChunks(chunksBuffer);
  return { fields, chunks, coverBuffer, coverExtension };
}

/**
 * 解析并校验 `chunks` JSON 文件分片为 {@link IncomingChunk} 数组。
 * 要求：可解析为非空数组、片数不超上限；逐片清洗 `text`（非空、不超长）与序号/章节字段。
 * @throws HttpError（400）当缺失、非法 JSON、或任一分片字段非法
 */
function parseChunks(buffer: Buffer | null): IncomingChunk[] {
  if (!buffer || buffer.length === 0) {
    throw new HttpError(400, 'Bad Request', 'chunks 为必填项（JSON 文件分片）');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString('utf-8'));
  } catch {
    throw new HttpError(400, 'Bad Request', 'chunks 不是合法 JSON');
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'Bad Request', 'chunks 必须为非空数组');
  }
  if (raw.length > TOTAL_CHUNKS_MAX) {
    throw new HttpError(400, 'Bad Request', `分片数不能超过 ${TOTAL_CHUNKS_MAX}`);
  }

  return raw.map((item, i) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    const index = Number(obj.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new HttpError(400, 'Bad Request', `chunks[${i}].index 必须为非负整数`);
    }
    const chapterIndex = Number(obj.chapterIndex);
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      throw new HttpError(400, 'Bad Request', `chunks[${i}].chapterIndex 必须为非负整数`);
    }
    const chapterTitle =
      obj.chapterTitle !== undefined && obj.chapterTitle !== null
        ? stripControlChars(String(obj.chapterTitle)).slice(0, TITLE_MAX)
        : undefined;
    const text = sanitizeChunkText(obj.text === undefined ? undefined : String(obj.text));
    if (!text) {
      throw new HttpError(400, 'Bad Request', `chunks[${i}].text 不能为空`);
    }
    if (text.length > CHUNK_TEXT_MAX) {
      throw new HttpError(400, 'Bad Request', `chunks[${i}].text 长度不能超过 ${CHUNK_TEXT_MAX}`);
    }
    return { index, chapterIndex, chapterTitle, text };
  });
}

/**
 * 校验文本字段并补默认值，返回 createMockJob 所需参数。
 * 引擎（ttsEngine）与音色（voice）取自服务端环境变量，前端传入一律忽略。
 * @throws HttpError 当任一字段非法（400），或服务端引擎/音色配置非法（500）
 */
function buildJobParams(fields: Record<string, string>): {
  title: string;
  author?: string;
  ttsEngine: string;
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

  // 引擎与音色由服务端环境变量固定，前端不可选（fields.ttsEngine / fields.voice 被忽略）。
  // 配置非法属于运维问题，按 500 暴露而非 400。
  const ttsEngine = config.DEFAULT_TTS_ENGINE;
  if (!ENGINE_WHITELIST.includes(ttsEngine)) {
    throw new HttpError(
      500,
      'Internal Server Error',
      `服务端 DEFAULT_TTS_ENGINE 配置非法：${ttsEngine}`,
    );
  }

  // 音色按引擎从各自的环境变量取（edge → EDGE_VOICE / mimo → MIMO_VOICE）
  const voice = ttsEngine === 'mimo-tts' ? config.MIMO_VOICE : config.EDGE_VOICE;
  if (!VOICE_WHITELIST[ttsEngine].includes(voice)) {
    throw new HttpError(
      500,
      'Internal Server Error',
      `服务端 ${ttsEngine} voice 配置非法：${voice}`,
    );
  }

  const rate = fields.rate ?? '+0%';
  if (!RATE_RE.test(rate)) throw new HttpError(400, 'Bad Request', `rate 格式非法：${rate}`);

  const pitch = fields.pitch ?? '+0Hz';
  if (!PITCH_RE.test(pitch)) throw new HttpError(400, 'Bad Request', `pitch 格式非法：${pitch}`);

  const bitrate = fields.bitrate ?? '64k';
  if (!BITRATE_WHITELIST.includes(bitrate)) {
    throw new HttpError(400, 'Bad Request', `bitrate 非法：${bitrate}`);
  }

  return { title, author, ttsEngine, voice, rate, pitch, bitrate };
}

const TERMINAL_STATES = ['done', 'failed', 'canceled'];

/**
 * 注册有声书任务的全部路由。
 * @param fastify Fastify 实例（已带前缀）
 */
export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  const manager = JobManager.getInstance();

  /**
   * 一步创建并启动任务：原子占位并发名额 → 解析/校验 multipart（元数据 + `chunks` JSON 文件分片
   * + 可选封面）→ 创建任务（含全部分片）并后台启动流水线。前端负责切分，后端只做文本→音频。
   * 任一失败分支均归还名额。
   */
  fastify.post('/jobs', async (request, reply) => {
    if (!manager.tryReserveSlot()) {
      return reply
        .code(503)
        .send({ error: 'Service Unavailable', message: '已达最大并发任务数，请稍后重试' });
    }

    try {
      const { fields, chunks, coverBuffer, coverExtension } = await parseAndValidate(request);
      const params = buildJobParams(fields);

      // 创建任务：内部做磁盘预检（不足抛 507）、保存封面、落盘状态并后台启动流水线。
      // createJob 内部 releaseSlot 并转为真实计数。
      const job = await manager.createJob(
        params,
        chunks,
        coverBuffer || undefined,
        coverExtension || undefined,
      );
      return reply.code(201).send({
        jobId: job.jobId,
        statusUrl: `/api/v1/jobs/${job.jobId}`,
        status: job.status,
      });
    } catch (err) {
      manager.releaseSlot();
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send({ error: err.publicName, message: err.message });
      }
      // 任务创建期错误（如磁盘不足 507、保存封面失败 500）按其携带的状态码映射
      if (err instanceof JobCreationError) {
        return reply.code(err.statusCode).send({ error: err.publicName, message: err.message });
      }
      throw err; // 交由全局错误处理器（含 multipart 413）
    }
  });

  /** 列出已有任务及状态（运维概览：含是否已上传 COS、本地是否仍有成品）。 */
  fastify.get('/jobs', async (_request, reply) => {
    const jobs = await manager.listJobs();
    return reply.send({ jobs });
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
  fastify.post('/agent/chat', async (request, reply) => {
    const body = (request.body ?? {}) as { message?: unknown; threadId?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return reply.code(400).send({ error: 'Bad Request', message: 'message 不能为空' });
    }
    // threadId 用于 LangGraph 多轮会话隔离；未提供则新建一轮会话。
    const threadId =
      typeof body.threadId === 'string' && body.threadId ? body.threadId : randomUUID();

    let agent: ReturnType<typeof getAgent>;
    try {
      agent = getAgent(threadId);
    } catch (err) {
      // 缺 key / provider 不支持等配置问题：明确 503，避免吞错。
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: `Agent 未正确配置：${(err as Error).message}`,
      });
    }

    reply.sse({ event: 'handshake', data: JSON.stringify({ threadId }) });

    let cleaned = false;
    const heartbeat = setInterval(() => reply.sse({ comment: 'keepalive' }), 20_000);

    const unsubscribe = agent.subscribe((event) => {
      if (cleaned) return;
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        reply.sse({ event: 'ai-stream', data: escapeSseText(event.assistantMessageEvent.delta) });
      } else if (event.type === 'tool_execution_start') {
        reply.sse({
          event: 'tool-call',
          data: JSON.stringify({ name: event.toolName, input: event.args }),
        });
      } else if (event.type === 'tool_execution_end') {
        // 提取文本内容或者直接返回序列化的 result
        const contentArray = (event.result as any)?.content;
        const textContent = Array.isArray(contentArray)
          ? contentArray.find((c: any) => c.type === 'text')?.text
          : undefined;
        reply.sse({
          event: 'tool-result',
          data: JSON.stringify({
            name: event.toolName,
            output: textContent || JSON.stringify(event.result),
          }),
        });
      }
    });

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      agent.abort(); // 触发中止信号，停止当前 turn 的 LLM 及工具执行
      unsubscribe();
      reply.sseContext.source.end();
    };
    request.raw.on('close', cleanup);

    try {
      await agent.prompt(message);
      if (!cleaned) reply.sse({ event: 'ai-complete', data: 'done' });
    } catch (err) {
      if (!cleaned) {
        reply.sse({
          event: 'ai-error',
          data: JSON.stringify({ message: (err as Error).message }),
        });
      }
    } finally {
      cleanup();
    }
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

    const remoteKey = manager.getRemoteKey(jobId);
    if (remoteKey) {
      const url = await objectStore.getPresignedUrl(remoteKey, `${job.title || 'audiobook'}.m4b`);
      return reply.redirect(url, 302);
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

  /**
   * 手动触发把成品上传到 COS（运维/补传）。幂等：已上传则原样返回既有 key。
   * 内存中无此任务时会回落到磁盘加载，支持对重启后的历史任务补传。
   */
  fastify.post('/jobs/:jobId/upload', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const result = await manager.uploadArtifact(jobId);
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          return reply.code(404).send({ error: 'Not Found', message: '任务不存在' });
        case 'not_done':
          return reply.code(409).send({ error: 'Conflict', message: '任务尚未完成，无法上传' });
        case 'cos_disabled':
          return reply
            .code(409)
            .send({ error: 'Conflict', message: 'COS 未配置，无法上传（请设置 COS_BUCKET 等）' });
        case 'no_local_file':
          return reply
            .code(404)
            .send({ error: 'Not Found', message: '本地成品不存在，无法上传（可能已被回收）' });
      }
    }
    return reply.send({
      jobId,
      remoteKey: result.remoteKey,
      alreadyUploaded: result.alreadyUploaded,
    });
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
