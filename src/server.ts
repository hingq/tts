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

/**
 * 优雅停机：反转健康检查 → 停止接收新连接 → 清理 Mock 定时器 → 退出。
 * @param signal 触发停机的信号名
 */
async function gracefulShutdown(signal: string): Promise<void> {
  fastify.log.info(`Received ${signal}, shutting down gracefully...`);
  shuttingDown = true;
  try {
    await fastify.close(); // 拒绝新连接，等待 in-flight 请求结束
    if (gcTimer) clearInterval(gcTimer); // 停止定时垃圾回收
    JobManager.getInstance().clearAllTimers(); // 收尾：清理任务管理器资源
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
    // 自动扫描 TMP_ROOT，恢复未完成任务并断点续传
    await JobManager.getInstance().recoverJobs();
    // 启动定时垃圾回收，清理过期工作目录
    gcTimer = startGarbageCollector();

    await fastify.listen({ port: config.PORT, host: config.HOST });
    fastify.log.info(`Server is listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  console.log('等待关闭');

  void gracefulShutdown('SIGTERM');
  console.log('⚡️关闭成功');
});
process.on('SIGINT', () => {
  console.log('等待关闭');

  void gracefulShutdown('SIGINT');
  console.log('⚡️关闭成功');
});

start();
