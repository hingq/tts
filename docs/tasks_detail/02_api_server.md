# 2. Fastify 服务端与路由 API 编写 (API & Web Server) 详细执行步骤

本模块负责通过 Fastify 运行 Web 服务，定义核心数据契约 Stub，并实现一个简易的内存 Mock 任务管理器，以调通 POST 任务、GET 状态、SSE 进度流推送、DELETE 取消以及带 Range 的文件流式下载。

> [!IMPORTANT]
> **代码注释约束**：
> 必须为本模块定义的 `JobManager` 类（包括 Mock 队列推进定时器逻辑）、Fastify 各 API 路由控制器方法及优雅停机钩子编写规范的 JSDoc 和行内注释。

---

## 2.1 任务契约与最小接口定义 (Interface Stub)

为了在后台生成流水线（如文本预处理、TTS 合成、FFmpeg 转码等）未完成时能让 API 服务器正常编译运行并进行联调，首先需要定义任务类型契约。

### 文件路径：[src/types/job.ts](file:///Users/a123/project/tts/src/types/job.ts)

> [!NOTE]
> **状态集不含 `paused`**：服务重启后复活的未完成任务**不进入暂停态**，统一置为 `failed`，由用户手动调用 `resume` 续跑（见 2.2 `recoverJobs` 与 2.4.6）。`implementation_plan.md` 第 8 条 "Boot Recovery in Paused State" 已废弃。

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

### 文件路径：[src/services/job-manager.ts](file:///Users/a123/project/tts/src/services/job-manager.ts)
> [!TIP]
> **依赖注入优先于单例**：为便于 Vitest 重置状态，真实实现建议通过 `fastify.decorate('jobManager', new JobManager())` 注入，路由经 `request.server.jobManager` 访问。本 Mock 为简化沿用 `getInstance()` 单例，但不应在测试中跨用例共享。

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JobInfo } from '../types/job.js';
import { config } from '../config.js';

export class JobManager extends EventEmitter {
  private static instance: JobManager;
  private jobs: Map<string, JobInfo> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  /** 并发占位计数：在 multipart 解析等 await 之前先占位，规避“先查后建”竞态 */
  private reserved = 0;

  private constructor() {
    super();
    // 每个 jobId 一条 SSE 连接链路 + 内部监听，默认 10 上限不够用，放宽以消除 MaxListeners 告警
    this.setMaxListeners(0);
  }

  public static getInstance(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  /**
   * 服务启动恢复存根。
   * Mock 阶段刻意不实现；真实实现会扫描 TMP_ROOT 下各 state.json，
   * 将未完成（pending/running）的任务统一置为 `failed`，等待用户手动 resume 续跑（不引入暂停态）。
   */
  public async recoverJobs(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 原子地尝试占用一个并发名额。返回 false 表示已达 MAX_CONCURRENT_JOBS。
   * 调用方在校验/创建失败时必须调用 releaseSlot() 归还名额。
   */
  public tryReserveSlot(): boolean {
    if (this.getActiveJobsCount() + this.reserved >= config.MAX_CONCURRENT_JOBS) {
      return false;
    }
    this.reserved++;
    return true;
  }

  /** 归还一个此前通过 tryReserveSlot 占用、但最终未转为真实 job 的名额 */
  public releaseSlot(): void {
    if (this.reserved > 0) this.reserved--;
  }

  public getActiveJobsCount(): number {
    return Array.from(this.jobs.values()).filter(
      j => j.status === 'running' || j.status === 'pending'
    ).length;
  }

  /** 派发任务状态快照（深拷贝 progress），避免监听者观测到后续被原地修改的引用 */
  private emitSnapshot(job: JobInfo): void {
    const snapshot: JobInfo = {
      ...job,
      progress: {
        ...job.progress,
        ttsChunks: { ...job.progress.ttsChunks },
        transcodeChunks: { ...job.progress.transcodeChunks },
      },
    };
    this.emit(`job:${job.jobId}`, snapshot);
  }

  /** 优雅停机收尾：清除所有 Mock 定时器 */
  public clearAllTimers(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  public getJob(jobId: string): JobInfo | undefined {
    return this.jobs.get(jobId);
  }

  public createMockJob(params: Omit<JobInfo, 'jobId' | 'status' | 'progress' | 'downloadUrl' | 'error' | 'startedAt' | 'finishedAt'>): JobInfo {
    const jobId = randomUUID();
    // 占位名额此刻转为真实 job 计数，归还预留计数避免重复占用
    this.releaseSlot();
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
        // Mock 阶段：终态时落盘一个 10KB 占位 M4B，供下载路由 createReadStream 使用
        const dir = path.join(config.TMP_ROOT, jobId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'output.m4b'), Buffer.alloc(10 * 1024));
        clearInterval(interval);
        this.timers.delete(jobId); // 自然结束也要清理定时器引用，防止 Map 泄漏
      }

      this.jobs.set(jobId, job);
      // 触发状态改变事件（派发快照而非内存引用）
      this.emitSnapshot(job);
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
    this.emitSnapshot(job);
    return true;
  }

  /**
   * 恢复任务。仅允许从终态中的可重试状态（failed / canceled）回到 pending；
   * pending/running/done 一律拒绝（返回值见下），避免重复触发 startMockWorkflow 造成双定时器。
   * @returns 'ok' 恢复成功 | 'not_found' 任务不存在 | 'invalid_state' 状态不允许
   */
  public resumeJob(jobId: string): 'ok' | 'not_found' | 'invalid_state' {
    const job = this.jobs.get(jobId);
    if (!job) return 'not_found';
    if (!['failed', 'canceled'].includes(job.status)) return 'invalid_state';

    // 防御性清理：恢复前若残留旧定时器，先行清除
    const stale = this.timers.get(jobId);
    if (stale) {
      clearInterval(stale);
      this.timers.delete(jobId);
    }

    job.status = 'pending';
    job.error = null;
    job.finishedAt = null;
    this.jobs.set(jobId, job);
    this.startMockWorkflow(jobId);
    this.emitSnapshot(job);
    return 'ok';
  }
}
```

---

## 2.3 Fastify 服务端初始化与插件注册

### 核心插件：
1. **`@fastify/multipart`**：流式上传文本与封面。配置 `fileSize` 属性限制文件上传大小为 `MAX_TEXT_SIZE_MB`。
2. **`fastify-sse-v2`**：支持推送 Server-Sent Events 流。

> [!IMPORTANT]
> 所有 `await fastify.register(...)` 必须放进 `bootstrap()` async 函数内，**不要使用顶层 await**，以免对 `tsconfig.json` 的 `module`/`target` 产生隐式约束（顶层 await 需 `module: NodeNext` + `target: ES2022`）。

### 接口文件结构：[src/server.ts](file:///Users/a123/project/tts/src/server.ts)
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

// 优雅停机期间健康检查反转的开关
let shuttingDown = false;

/**
 * 统一错误处理器：把未捕获异常归一为 { error, message } 响应体（契约见 plan.md 4.1）。
 */
fastify.setErrorHandler((err, _request, reply) => {
  // multipart 超出 fileSize 限制时抛 FST_REQ_FILE_TOO_LARGE，归一为 413
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  fastify.log.error(err);
  reply.code(status).send({
    error: err.name || 'Internal Server Error',
    message: err.message || 'Unexpected error'
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
      fileSize: config.MAX_TEXT_SIZE_MB * 1024 * 1024
    }
  });

  // 注册 SSE 支持
  await fastify.register(fastifySsePlugin);

  // 注册业务 API 路由
  await fastify.register(registerRoutes, { prefix: '/api/v1/audiobook' });
}

/**
 * 优雅停机：反转健康检查 → 停止接收新连接 → 清理 Mock 定时器 → 退出。
 */
async function gracefulShutdown(signal: string): Promise<void> {
  fastify.log.info(`Received ${signal}, shutting down gracefully...`);
  shuttingDown = true;
  try {
    await fastify.close();              // 拒绝新连接，等待 in-flight 请求结束
    JobManager.getInstance().clearAllTimers(); // Mock 阶段收尾：清除全部定时器
    process.exit(0);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// 启动服务器
const start = async () => {
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
```

---

## 2.4 详细 API 接口路由实现

路由声明写在 `src/routes/jobs.ts` 中。

### 2.4.1 `POST /api/v1/audiobook/jobs`
* **并发控制与拒绝策略（原子占位）**：
  在路由首部调用 `JobManager.getInstance().tryReserveSlot()`。返回 `false` 直接返回 `503 Service Unavailable`。占位成功后，**必须**在 multipart 解析/校验失败的所有分支里调用 `releaseSlot()` 归还名额；只有成功 `createMockJob()` 才会把占位转为真实 job 计数。
  > 不要用“先 `getActiveJobsCount()` 后 `createMockJob()`”两段式判断——两步之间的 multipart `await` 会让并发请求同时穿过 503 检查。
* **解析 Multipart 数据**：
  使用 `const parts = request.parts()` 迭代获取文件流及普通参数，将 `text`（必要时 `cover`）流式写入 `TMP_ROOT/<jobId 占位>/`。
* **严格校验清单**（任一不满足即归还名额并返回对应错误码）：
  | 字段 | 必填 | 校验 | 失败码 |
  | :--- | :--- | :--- | :--- |
  | `text` | 是 | MIME `text/plain` 且后缀 `.txt`；大小 ≤ `MAX_TEXT_SIZE_MB`（超限由 multipart 抛 413） | 400 / 413 |
  | `cover` | 否 | MIME `image/jpeg`\|`image/png` 且后缀 `.jpg/.jpeg/.png`；大小 ≤ 2MB | 400 |
  | `title` | 是 | 非空，去除控制字符后长度 ≤ 200 | 400 |
  | `author` | 否 | 长度 ≤ 200，过滤控制字符 | 400 |
  | `ttsEngine` | 否 | 仅允许 `edge-tts`，默认 `edge-tts` | 400 |
  | `voice` | 否 | 白名单：`zh-CN-YunxiNeural` / `zh-CN-XiaoxiaoNeural` / `zh-CN-YunjianNeural`，默认 `zh-CN-YunxiNeural` | 400 |
  | `rate` | 否 | 匹配 `^[+-]\d+%$`，默认 `+0%` | 400 |
  | `pitch` | 否 | 匹配 `^[+-]\d+Hz$`，默认 `+0Hz` | 400 |
  | `bitrate` | 否 | 枚举 `32k`\|`64k`\|`128k`，默认 `64k` | 400 |
  > Mock 阶段也要执行上述校验，以便联调期间尽早暴露契约错误。`title`/`author` 因后续会进入 FFmpeg `-metadata`，须过滤控制字符（即便使用 `spawn` 数组传参也做防御性清洗）。
* **磁盘空间预检**：真实实现需在此按 `plan.md` 5.2 预估峰值空间，不足返回 `507 Insufficient Storage`；Mock 阶段可省略，但需保留 TODO 注释。
* **启动 Mock 任务**：
  校验成功后调用 `JobManager.getInstance().createMockJob(...)`，返回 `201 Created` 与 `{ jobId, statusUrl, status: "pending" }`。

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
* **关键要点**：
  - **终态补发**：若客户端在任务已 `done/failed/canceled` 之后才订阅，后续不会再有 `emit`。因此初始推送当前状态后，必须立即判断是否已终态，是则补发 `status` 并结束，**不再注册监听器**。
  - **监听器生命周期**：`cleanup` 必须在 `request.raw.on('close')` 与异常路径都被调用，避免 EventEmitter 监听器泄漏（`JobManager` 构造时已 `setMaxListeners(0)` 兜底告警）。
  - **心跳**：每 20s 发送一条 comment 行 `: keepalive`，防止反代空闲超时切断长连接。
  - **API 用法**：本示例使用 `reply.sse(...)` 多次写入；落地时以所选 `fastify-sse-v2` 版本 README 为准（必要时改用 async iterator / `EventIterator` 形式）。
* **代码逻辑实现**：
  ```typescript
  import { FastifyInstance } from 'fastify';
  import { JobManager } from '../services/job-manager.js';
  import { JobInfo } from '../types/job.js';

  export async function registerRoutes(fastify: FastifyInstance) {
    fastify.get('/jobs/:jobId/events', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const manager = JobManager.getInstance();
      const job = manager.getJob(jobId);

      if (!job) {
        reply.code(404).send({ error: 'Not Found', message: 'Job not found' });
        return;
      }

      const isTerminal = (s: string) => ['done', 'failed', 'canceled'].includes(s);

      // 先握手 + 推送当前快照
      reply.sse({ event: 'handshake', data: JSON.stringify({ jobId }) });
      reply.sse({ event: 'progress', data: JSON.stringify(job) });

      // 终态补发：晚到的订阅者也能立即收到结束事件，然后直接关闭
      if (isTerminal(job.status)) {
        reply.sse({
          event: 'status',
          data: JSON.stringify({ status: job.status, downloadUrl: job.downloadUrl, error: job.error })
        });
        reply.raw.end();
        return;
      }

      const listener = (eventData: JobInfo) => {
        reply.sse({ event: 'progress', data: JSON.stringify(eventData) });
        if (isTerminal(eventData.status)) {
          reply.sse({
            event: 'status',
            data: JSON.stringify({
              status: eventData.status,
              downloadUrl: eventData.downloadUrl,
              error: eventData.error
            })
          });
          cleanup();
        }
      };

      // 心跳，防止反代空闲超时
      const heartbeat = setInterval(() => reply.sse({ data: '', comment: 'keepalive' }), 20_000);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        manager.off(`job:${jobId}`, listener);
        reply.raw.end();
      };

      manager.on(`job:${jobId}`, listener);
      request.raw.on('close', cleanup);
    });
  }
  ```

---

### 2.4.4 `GET /api/v1/audiobook/jobs/:jobId/file` (支持 Range 断点下载)
* **功能**：下载 Mock 输出的 M4B 音频。Mock 文件由 `JobManager` 在任务转入 `done` 时落盘于 `TMP_ROOT/<jobId>/output.m4b`（见 2.2）。
* **逻辑**：
  - 校验任务存在且 `status === 'done'`，否则 `404`（不存在）/ `409`（未就绪）。
  - 用 `fs.statSync` 取文件大小，缺失文件返回 `404`。
  - **响应头**：始终带 `Accept-Ranges: bytes`、`Content-Type: audio/mp4`、`Content-Disposition: attachment; filename="audiobook.m4b"; filename*=UTF-8''<encodeURIComponent(title)>.m4b`（title 含中文，用 RFC 5987 编码）。
  - **无 Range**：`200 OK` + `Content-Length` + `fs.createReadStream(path)`。
  - **有 Range**（仅支持单段 `bytes=start-end`）：解析后校验 `0 <= start <= end < size`；合法返回 `206 Partial Content` + `Content-Range: bytes start-end/size` + `Content-Length`，并 `createReadStream(path, { start, end })`。
  - **非法 / 越界 Range**：返回 `416 Range Not Satisfiable` + `Content-Range: bytes */<size>`。
  - **下载完成后清理**：在 `reply.raw.on('close')` 且已完整发送时，异步递归删除 `TMP_ROOT/<jobId>`（对应 `implementation_plan.md` 第 3 条 Immediate Cleanup）。

---

### 2.4.5 `DELETE /api/v1/audiobook/jobs/:jobId`
* **功能**：取消任务（幂等）。
* **逻辑**：
  - 任务不存在 → `404 Not Found`。
  - 任务存在但已是终态（`done/failed/canceled`）→ 直接返回 `204 No Content`，**不改变状态**（幂等语义）。
  - 否则调用 `cancelJob(jobId)` 终止 Mock 定时器并置 `canceled`，返回 `204 No Content`。

---

### 2.4.6 `POST /api/v1/audiobook/jobs/:jobId/resume`
* **功能**：恢复 `failed` / `canceled` 的任务（不存在暂停态）。
* **逻辑**：
  - 先 `tryReserveSlot()`：达 `MAX_CONCURRENT_JOBS` 上限返回 `503`（恢复会重新占用并发名额）。
  - 调用 `JobManager.getInstance().resumeJob(jobId)`，按返回值映射：
    - `'not_found'` → `404 Not Found`（归还名额）；
    - `'invalid_state'` → `400 Bad Request`（`pending/running/done` 不可恢复，归还名额）；
    - `'ok'` → 返回 `200 OK` 及更新后的 `JobInfo`（占位转为真实计数，无需归还）。

---

## 2.5 服务优雅停机与子进程清理 (Graceful Shutdown)

完整实现见 2.3 `server.ts` 的 `gracefulShutdown`。接收到 `SIGTERM` / `SIGINT` 时：
1. **反转健康检查**：`shuttingDown = true`，`/healthz` 立即返回 `503`，便于反代/编排摘除实例。
2. **停止监听新连接**：`await fastify.close()` 拒绝新请求并等待 in-flight 请求结束。
3. **Mock 阶段收尾**：`JobManager.getInstance().clearAllTimers()` 清除所有活动定时器。
4. **退出进程**：`process.exit(0)`。

---

## 2.6 手动验证步骤 (Smoke Test)

```bash
# 1. 创建任务（201 + jobId）
curl -F text=@sample.txt -F title=测试书 http://127.0.0.1:3000/api/v1/audiobook/jobs

# 2. 并发触发，验证 503（默认 MAX_CONCURRENT_JOBS=2，第 3 个应 503）
for i in 1 2 3; do curl -s -o /dev/null -w "%{http_code}\n" \
  -F text=@sample.txt -F title=t$i http://127.0.0.1:3000/api/v1/audiobook/jobs & done; wait

# 3. 订阅 SSE，观察 handshake → progress* → status，Ctrl-C 后服务端应清理监听器
curl -N http://127.0.0.1:3000/api/v1/audiobook/jobs/<jobId>/events

# 4. 待 done 后再订阅一次，应立即收到 progress + status（终态补发）
curl -N http://127.0.0.1:3000/api/v1/audiobook/jobs/<jobId>/events

# 5. Range 下载，应 206 + Content-Range
curl -i -r 0-1023 -o part.bin http://127.0.0.1:3000/api/v1/audiobook/jobs/<jobId>/file

# 6. 非法 Range，应 416
curl -i -r 999999-1000000 http://127.0.0.1:3000/api/v1/audiobook/jobs/<jobId>/file

# 7. DELETE 已 done 任务，应 204（幂等，不改状态）
curl -i -X DELETE http://127.0.0.1:3000/api/v1/audiobook/jobs/<jobId>

# 8. 优雅停机：kill -TERM，/healthz 立即 503，定时器全清后进程退出
kill -TERM <pid>
```

> [!NOTE]
> **注释约束补充**：本模块所有公有方法须带 JSDoc，至少包含一行职责说明，以及 `@param` / `@returns`（如有 `@throws`）。复杂分支（Mock 定时器推进、Range 解析、SSE 监听器生命周期）须有行内 `why` 注释。
