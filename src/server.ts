/**
 * @file server.ts
 * @description Fastify Web 服务入口。注册 multipart / SSE 插件与业务路由，提供健康检查、
 * 统一错误处理与基于信号的优雅停机。
 */

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { config } from './config.js';
import { JobManager } from './services/job-manager.js';
import { validateFfmpegBinaries } from './services/audio-transcoder.js';
import { startGarbageCollector } from './services/gc.js';
import cors from '@fastify/cors';
const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
    },
  },
});

/** 优雅停机期间健康检查反转的开关。 */
let shuttingDown = false;

/** 定时垃圾回收器句柄；启动后赋值，停机时清理。 */
let gcTimer: NodeJS.Timeout | undefined;

/**
 * 统一错误处理器：把未捕获异常归一为 { error, message } 响应体（契约见 plan.md 4.1）。
 */
fastify.setErrorHandler((err, _request, reply) => {
  // multipart 超出 fileSize 限制时抛 FST_REQ_FILE_TOO_LARGE，归一为其携带的 413
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  fastify.log.error(err);
  reply.code(status).send({
    error: err.name || 'Internal Server Error',
    message: err.message || 'Unexpected error',
  });
});

/**
 * 健康检查。优雅停机开始后返回 503，便于反代/编排把实例摘除。
 */
fastify.get('/healthz', async (_request, reply) => {
  if (shuttingDown) {
    return reply.code(503).send({ error: 'Service Unavailable', message: 'Shutting down' });
  }
  return { status: 'ok' };
});

/**
 * 注册插件与路由。集中在异步函数内完成，规避顶层 await。
 */
async function bootstrap(): Promise<void> {
  // 注册 Multipart 大文件流式拦截器
  await fastify.register(multipart, {
    limits: {
      files: 2, // text 文本 + 可选 cover 封面
      fileSize: config.MAX_TEXT_SIZE_MB * 1024 * 1024,
    },
  });

  // 注册 SSE 支持
  await fastify.register(FastifySSEPlugin);
  await fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  // 注册业务 API 路由
  // 动态导入路由插件，配合 build.js 的 splitting:true 将路由层拆为独立 chunk
  const { registerRoutes } = await import('./routes/jobs.js');
  await fastify.register(registerRoutes, { prefix: '/api/v1' });
}

/** 防止重复关闭 */
let isShuttingDown = false;

async function shutdown(exitCode: number, reason: string): Promise<never> {
  if (isShuttingDown) {
    // 已经在关闭中，直接强制退出
    process.exit(exitCode);
  }
  isShuttingDown = true;
  shuttingDown = true;

  console.error(`[shutdown] reason=${reason}, exitCode=${exitCode}`);

  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = undefined;
  }

  try {
    JobManager.getInstance().clearAllTimers();
  } catch (e) {
    console.error('[shutdown] JobManager.clearAllTimers() error:', e);
  }

  try {
    // 给 fastify.close() 加硬超时，防止 hang 死
    await Promise.race([
      fastify.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('fastify.close() timed out after 5s')), 5000),
      ),
    ]);
  } catch (e) {
    console.error('[shutdown] fastify.close() error:', e);
  }

  console.error(`[shutdown] calling process.exit(${exitCode})`);

  process.exit(exitCode);
}
/** 启动服务器。 */
const start = async (): Promise<void> => {
  try {
    await bootstrap();
    // 启动期二进制预检：ffmpeg / ffprobe 缺失或不在 PATH 时直接阻断启动，
    // 避免每个任务跑到转码阶段才以 spawn ENOENT 失败。
    await validateFfmpegBinaries();
    // 自动扫描 TMP_ROOT，恢复未完成任务并断点续传
    await JobManager.getInstance().recoverJobs();
    // 启动定时垃圾回收，清理过期工作目录
    gcTimer = startGarbageCollector();

    await fastify.listen({ port: config.PORT, host: config.HOST });
    fastify.log.info(`Server is listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    await shutdown(1, 'start() failed');
  }
};

process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => void shutdown(0, 'SIGINT'));

start();
