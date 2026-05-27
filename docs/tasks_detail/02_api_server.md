# 2. Fastify 服务端与路由 API 编写 (API & Web Server) 详细执行步骤

本模块负责通过 Fastify 运行 Web 服务，定义核心数据契约 Stub，并实现一个简易的内存 Mock 任务管理器，以调通 POST 任务、GET 状态、SSE 进度流推送、DELETE 取消以及带 Range 的文件流式下载。

> [!IMPORTANT]
> **代码注释约束**：
> 必须为本模块定义的 `JobManager` 类（包括 Mock 队列推进定时器逻辑）、Fastify 各 API 路由控制器方法及优雅停机钩子编写规范的 JSDoc 和行内注释。

---

## 2.1 任务契约与最小接口定义 (Interface Stub)

为了在后台生成流水线（如文本预处理、TTS 合成、FFmpeg 转码等）未完成时能让 API 服务器正常编译运行并进行联调，首先需要定义任务类型契约。

### 文件路径：[src/types/job.ts](file:///Users/he/projects/tts/src/types/job.ts)
```typescript
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';
export type JobPhase = 'preprocess' | 'tts' | 'mux' | 'validating' | 'ready';

export interface JobProgress {
  phase: JobPhase;
  ttsChunks: { done: number; total: number };
  transcodeChunks: { done: number; total: number };
}

export interface JobInfo {
  jobId: string;
  status: JobStatus;
  progress: JobProgress;
  downloadUrl: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  title: string;
  author?: string;
  voice: string;
  rate: string;
  pitch: string;
  bitrate: string;
}
```

---

## 2.2 编写内存 Mock 任务管理器 `JobManager`

在 `src/services/job-manager.ts` 中实现一个简易的内存 Mock 队列，使用定时器模拟任务生命周期的状态转变（`pending -> preprocess -> tts -> mux -> validating -> ready -> done`），以便联调 SSE 推送。

### 文件路径：[src/services/job-manager.ts](file:///Users/he/projects/tts/src/services/job-manager.ts)
```typescript
import { EventEmitter } from 'events';
import { JobInfo } from '../types/job.js';
import crypto from 'crypto';

export class JobManager extends EventEmitter {
  private static instance: JobManager;
  private jobs: Map<string, JobInfo> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  private constructor() {
    super();
  }

  public static getInstance(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  public async recoverJobs(): Promise<void> {
    // 启动恢复存根 - Mock 阶段直接返回 resolve
    return Promise.resolve();
  }

  public getActiveJobsCount(): number {
    return Array.from(this.jobs.values()).filter(
      j => j.status === 'running' || j.status === 'pending'
    ).length;
  }

  public getJob(jobId: string): JobInfo | undefined {
    return this.jobs.get(jobId);
  }

  public createMockJob(params: Omit<JobInfo, 'jobId' | 'status' | 'progress' | 'downloadUrl' | 'error' | 'startedAt' | 'finishedAt'>): JobInfo {
    const jobId = crypto.randomUUID();
    const job: JobInfo = {
      jobId,
      status: 'pending',
      progress: {
        phase: 'preprocess',
        ttsChunks: { done: 0, total: 10 },
        transcodeChunks: { done: 0, total: 10 }
      },
      downloadUrl: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ...params
    };

    this.jobs.set(jobId, job);
    this.startMockWorkflow(jobId);
    return job;
  }

  private startMockWorkflow(jobId: string) {
    let tick = 0;
    const interval = setInterval(() => {
      const job = this.jobs.get(jobId);
      if (!job || ['done', 'failed', 'canceled'].includes(job.status)) {
        clearInterval(interval);
        return;
      }

      tick++;
      job.status = 'running';

      if (tick === 1) {
        job.progress.phase = 'preprocess';
      } else if (tick <= 6) {
        job.progress.phase = 'tts';
        job.progress.ttsChunks.done = (tick - 1) * 2;
        // 转码稍慢于 TTS，做流水线模拟
        job.progress.transcodeChunks.done = Math.max(0, (tick - 2) * 2);
      } else if (tick === 7) {
        job.progress.phase = 'mux';
        job.progress.ttsChunks.done = 10;
        job.progress.transcodeChunks.done = 10;
      } else if (tick === 8) {
        job.progress.phase = 'validating';
      } else {
        job.status = 'done';
        job.progress.phase = 'ready';
        job.downloadUrl = `/api/v1/audiobook/jobs/${jobId}/file`;
        job.finishedAt = new Date().toISOString();
        clearInterval(interval);
      }

      this.jobs.set(jobId, job);
      // 触发状态改变事件
      this.emit(`job:${jobId}`, job);
    }, 1500); // 每 1.5s 改变一次进度状态

    this.timers.set(jobId, interval);
  }

  public cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    
    const timer = this.timers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(jobId);
    }

    job.status = 'canceled';
    job.finishedAt = new Date().toISOString();
    this.jobs.set(jobId, job);
    this.emit(`job:${jobId}`, job);
    return true;
  }

  public resumeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (['running', 'done'].includes(job.status)) return false;

    job.status = 'pending';
    job.error = null;
    this.jobs.set(jobId, job);
    this.startMockWorkflow(jobId);
    this.emit(`job:${jobId}`, job);
    return true;
  }
}
```

---

## 2.3 Fastify 服务端初始化与插件注册

### 核心插件：
1. **`@fastify/multipart`**：流式上传文本与封面。配置 `fileSize` 属性限制文件上传大小为 `MAX_TEXT_SIZE_MB`。
2. **`fastify-sse-v2`**：支持推送 Server-Sent Events 流。

### 接口文件结构：[src/server.ts](file:///Users/he/projects/tts/src/server.ts)
```typescript
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { fastifySsePlugin } from 'fastify-sse-v2';
import { config } from './config.js';
import { registerRoutes } from './routes/jobs.js';
import { JobManager } from './services/job-manager.js';

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' }
    }
  }
});

// 注册 Multipart 大文件流式拦截器
await fastify.register(multipart, {
  limits: {
    files: 2, // text 文本 + 可选 cover 封面
    fileSize: config.MAX_TEXT_SIZE_MB * 1024 * 1024
  }
});

// 注册 SSE 支持
await fastify.register(fastifySsePlugin);

// 注册业务 API 路由
await fastify.register(registerRoutes, { prefix: '/api/v1/audiobook' });

// 启动服务器
const start = async () => {
  try {
    // 自动扫描 TMP_ROOT 执行未完成任务断点恢复（Mock 阶段为空）
    await JobManager.getInstance().recoverJobs();
    
    await fastify.listen({ port: config.PORT, host: config.HOST });
    fastify.log.info(`Server is listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
```

---

## 2.4 详细 API 接口路由实现

路由声明写在 `src/routes/jobs.ts` 中。

### 2.4.1 `POST /api/v1/audiobook/jobs`
* **并发控制与拒绝策略**：
  在路由首部检查 `JobManager.getInstance().getActiveJobsCount()`。如果已达 `MAX_CONCURRENT_JOBS` 上限，直接返回 `503 Service Unavailable`。
* **解析 Multipart 数据**：
  使用 `const parts = request.parts()` 迭代获取文件流及普通参数。
  - 解析 `text` 文件流：在此阶段可以仅将上传的内容存为临时文件（通过 `fs.createWriteStream`），或忽略内容仅获取大小。
  - 提取字段并验证：`title`（必填）、`author`、`voice`（校验是否在白名单中）、`rate`、`pitch`、`bitrate`。
* **启动 Mock 任务**：
  验证成功后，调用 `JobManager.getInstance().createMockJob(...)`，然后将 `201 Created` 状态码与 `{ jobId, statusUrl, status: "pending" }` 响应返回。

---

### 2.4.2 `GET /api/v1/audiobook/jobs/:jobId`
* **功能**：获取任务进度。
* **逻辑**：
  - 检查内存状态 `JobManager.getInstance().getJob(jobId)`。
  - 若不存在，返回 `404 Not Found`。
  - 存在则返回整个 `JobInfo` 状态结构。

---

### 2.4.3 `GET /api/v1/audiobook/jobs/:jobId/events` (SSE 进度接口)
* **功能**：流式推送进度直至合成结束或失败。
* **代码逻辑实现**：
  ```typescript
  import { FastifyInstance } from 'fastify';
  import { JobManager } from '../services/job-manager.js';

  export async function registerRoutes(fastify: FastifyInstance) {
    fastify.get('/jobs/:jobId/events', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const manager = JobManager.getInstance();
      const job = manager.getJob(jobId);

      if (!job) {
        reply.code(404).send({ error: 'Not Found', message: 'Job not found' });
        return;
      }
      
      // 监听任务状态更新事件
      const listener = (eventData: any) => {
        reply.sse({ event: 'progress', data: JSON.stringify(eventData) });
        
        // 如果任务结束，推送最后一包并关闭连接
        if (['done', 'failed', 'canceled'].includes(eventData.status)) {
          reply.sse({ event: 'status', data: JSON.stringify({ status: eventData.status }) });
          cleanup();
        }
      };
      
      const cleanup = () => {
        manager.off(`job:${jobId}`, listener);
        reply.raw.end();
      };

      manager.on(`job:${jobId}`, listener);
      request.raw.on('close', cleanup);
      
      // 发送 SSE 握手响应并推送当前状态
      reply.sse({ event: 'handshake', data: JSON.stringify({ jobId }) });
      reply.sse({ event: 'progress', data: JSON.stringify(job) });
    });
  }
  ```

---

### 2.4.4 `GET /api/v1/audiobook/jobs/:jobId/file` (支持 Range 断点下载)
* **功能**：下载 Mock 输出的 M4B 音频。
* **逻辑**：
  - 在 Mock 阶段，若任务状态为 `done`，可以在临时文件夹中生成一个 10KB 的 Mock 二进制文件作为占位音频（`output.m4b`）。
  - 支持 `Range` 响应。如果客户端请求了范围（例如 `Range: bytes=0-1023`），返回 `206 Partial Content`，并携带 `Content-Range` 以及 `Accept-Ranges: bytes` 头。

---

### 2.4.5 `DELETE /api/v1/audiobook/jobs/:jobId`
* **功能**：取消任务。
* **逻辑**：
  - 调用 `JobManager.getInstance().cancelJob(jobId)`。
  - 成功则返回 `204 No Content`，不存在则返回 `404 Not Found`。

---

### 2.4.6 `POST /api/v1/audiobook/jobs/:jobId/resume`
* **功能**：恢复暂停或失败的任务。
* **逻辑**：
  - 检查任务是否存在。如果临时目录或 `state.json` 不存在，返回 `404 Not Found`。
  - 检查状态，如果已在运行或已完成，返回 `400 Bad Request`。
  - 调用 `JobManager.getInstance().resumeJob(jobId)` 将任务状态设为 `pending` 并重新入队。
  - 成功则返回 `200 OK` 及更新后的 `JobInfo`。

---

## 2.5 服务优雅停机与子进程清理 (Graceful Shutdown)

在接收到 `SIGTERM` / `SIGINT` 时，系统安全退出：
1. **停止监听新连接**：调用 `await fastify.close()` 拒绝所有进入的请求。
2. ** Mock 阶段收尾**：清除所有活动的 Mock 定时器 `timers`。
3. **退出进程**：`process.exit(0)`。
