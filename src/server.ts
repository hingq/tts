/**
 * @file server.ts
 * @description Fastify Web 服务入口。注册 multipart / SSE 插件与业务路由，提供健康检查、
 * 统一错误处理与基于信号的优雅停机。
 */

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { config } from './config.js';
import { registerRoutes } from './routes/jobs.js';
import { JobManager } from './services/job-manager.js';

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

  // 注册业务 API 路由
  await fastify.register(registerRoutes, { prefix: '/api/v1/audiobook' });
}

/**
 * 优雅停机：反转健康检查 → 停止接收新连接 → 清理 Mock 定时器 → 退出。
 * @param signal 触发停机的信号名
 */
async function gracefulShutdown(signal: string): Promise<void> {
  fastify.log.info(`Received ${signal}, shutting down gracefully...`);
  shuttingDown = true;
  try {
    await fastify.close(); // 拒绝新连接，等待 in-flight 请求结束
    JobManager.getInstance().clearAllTimers(); // Mock 阶段收尾：清除全部定时器
    process.exit(0);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

/** 启动服务器。 */
const start = async (): Promise<void> => {
  try {
    await bootstrap();
    // 自动扫描 TMP_ROOT 执行未完成任务恢复（Mock 阶段为空）
    await JobManager.getInstance().recoverJobs();

    await fastify.listen({ port: config.PORT, host: config.HOST });
    fastify.log.info(`Server is listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

start();
