# 6. 流水线任务管理器 (Pipeline & Job Manager) 详细执行步骤

本模块是有声书生成服务的核心控制器。它负责维护任务的状态机、在磁盘空间预检通过后分配工作空间、通过 `p-limit` 调度 TTS 和 FFmpeg 转码队列、执行原子化检查点读写，并在重启后实施断点续传。

> [!IMPORTANT]
> **代码注释约束**：
> 必须为本模块定义的 `JobPipeline` 调度器（核心 `execute` 并发流程、`p-limit` 串联逻辑）、原子状态写入 `saveJobState`、磁盘预估与空间检查 `verifyDiskSpace`、服务重启恢复任务扫描逻辑以及定时 GC 清理逻辑编写详尽的 JSDoc 和行内注释。

---

## 6.1 状态定义与生命周期

系统使用细粒度的子状态来精准汇报有声书生成进度：

### 状态定义类型
```typescript
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';
export type JobPhase = 'preprocess' | 'tts' | 'mux' | 'validating' | 'ready';

export interface ChunkState {
  index: number;
  chapterIndex: number;
  text: string;
  rawPath: string;      // MP3 绝对路径
  m4aPath: string;      // M4A 绝对路径
  durationMs: number;
  status: 'pending' | 'tts_done' | 'transcode_done' | 'failed';
}

export interface JobState {
  jobId: string;
  title: string;
  author?: string;
  status: JobStatus;
  phase: JobPhase;
  voice: string;
  rate: string;
  pitch: string;
  bitrate: string;
  totalChunks: number;
  completedTTS: number;
  completedTranscode: number;
  chunks: ChunkState[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

---

## 6.2 原子化状态写保护 (`state.json`)

为防止任务处理中系统崩溃导致 `state.json` 损坏，必须采用**临时文件写 + 重命名**的原子写入策略。

### 写入算法：
```typescript
import { promises as fs } from 'fs';
import path from 'path';

export async function saveJobState(jobDir: string, state: JobState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const filePath = path.join(jobDir, 'state.json');
  const tmpPath = `${filePath}.tmp`;
  
  // 先写入临时文件
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  // 原子替换
  await fs.rename(tmpPath, filePath);
}
```

---

## 6.3 磁盘可用空间预检

在允许任务运行前，通过 `fs.statfs` 查询磁盘剩余空间。防止生成大型有声书时写入失败导致服务崩溃。

* **空间预估公式**：每一千字（按单分片均值计）预留约 1.9MB。
  $$\text{ExpectedPeakSpaceBytes} = N_{\text{chunks}} \times 1.9 \times 1024 \times 1024$$

### 校验实现：
```typescript
import { promises as fs } from 'fs';

export async function verifyDiskSpace(dir: string, totalChunks: number): Promise<boolean> {
  const expectedPeakBytes = totalChunks * 1.9 * 1024 * 1024;
  const stats = await fs.statfs(dir);
  
  // 可用块数 * 块大小 = 剩余可用字节
  const availableBytes = stats.bavail * stats.bsize;
  return availableBytes >= expectedPeakBytes * 1.2; // 留 20% 安全余量
}
```

---

## 6.4 双并发池流水线调度 (基于 p-limit)

使用 `p-limit` 建立独立的并发池，确保：
1. `msedge-tts` 并发请求不超过限额（防止 429）。
2. 在 TTS 成功生成单个分片后，**立刻**把转码任务投递到转码池中，充分重叠网络 I/O 与 CPU 算力。

### 调度器核心代码架构：
```typescript
import pLimit from 'p-limit';
import { EdgeTTSProvider } from '../providers/edge-tts.js';
import { transcodeToM4A, getDuration } from '../utils/ffmpeg.js';

export class JobPipeline {
  private ttsLimit = pLimit(config.CONCURRENT_TTS_LIMIT);
  private transcodeLimit = pLimit(config.CONCURRENT_TRANSCODE_LIMIT);
  private ttsProvider = new EdgeTTSProvider();
  
  public async execute(jobState: JobState, jobDir: string, onProgress: () => void): Promise<void> {
    jobState.status = 'running';
    jobState.phase = 'tts';
    await saveJobState(jobDir, jobState);

    // 建立分片Promise数组，将 TTS 与转码以流水线链条绑定
    const chunkTasks = jobState.chunks.map(chunk => {
      // 链条：当前分片先入 TTS 并发池，完成后立即进入转码并发池
      return this.ttsLimit(async () => {
        // 如果断点续传检测到已完成，则跳过
        if (chunk.status === 'transcode_done' || chunk.status === 'tts_done') {
          return;
        }

        // 1. 调用 TTS 合成 MP3
        await this.ttsProvider.synthesize(
          chunk.text,
          {
            voice: jobState.voice,
            rate: jobState.rate,
            pitch: jobState.pitch,
            bitrate: jobState.bitrate
          },
          chunk.rawPath.replace(/\.mp3$/, '') // 传入不带后缀的路径
        );

        chunk.status = 'tts_done';
        jobState.completedTTS++;
        await saveJobState(jobDir, jobState);
        onProgress();

        // 2. 插入随机延时避风控 (1000 - 2500ms)
        const delay = 1000 + Math.random() * 1500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }).then(() => {
        // TTS 成功后（或断点跳过），立刻将该分片推入转码并发池
        return this.transcodeLimit(async () => {
          if (chunk.status === 'transcode_done') {
            return;
          }

          // 3. 转码 MP3 -> M4A (AAC)
          await transcodeToM4A(chunk.rawPath, chunk.m4aPath, config.SUBPROCESS_TIMEOUT_MS);
          
          // 4. 读取精确时长
          chunk.durationMs = await getDuration(chunk.m4aPath);
          chunk.status = 'transcode_done';
          
          jobState.completedTranscode++;
          await saveJobState(jobDir, jobState);
          onProgress();

          // 5. 转码完成，删除临时 MP3 文件释放空间
          try {
            await fs.unlink(chunk.rawPath);
          } catch (e) {
            // 忽略删除未找到的错误
          }
        });
      });
    });

    // 等待所有分片流水线（包括转码）全部执行完毕
    await Promise.all(chunkTasks);
  }
}
```

---

## 6.5 重启后的状态重建与断点续传

服务在 `server.ts` 启动时，需要扫描 `TMP_ROOT` 自动重建未完成任务的内存上下文并恢复执行。

### 自动扫描恢复算法：
1. 遍历 `TMP_ROOT` 的一级目录。
2. 尝试读取每个子目录下的 `state.json`。
3. 若解析成功，且任务状态为 `pending` 或 `running`：
   - 将其重置为 `running`，从检查点读入进度。
   - 重新实例化 `JobState`。
   - 放入全局任务队列中启动调度器。
   - **注意**：由于在 `execute` 链条中检查了 `chunk.status === 'transcode_done'`，断点续传将无缝跳过所有已就绪的 M4A 分片，无需重复请求 TTS 或转码。

---

## 6.6 垃圾回收任务 (Garbage Collection)

为了防止临时文件撑满磁盘，系统每 `1 小时` 定期对 `TMP_ROOT` 执行一次垃圾回收。

### 回收标准：
* 状态为 `done`（已生成 M4B）且最终下载完成（通过标记文件 `.downloaded` 存在）或创建时间已超过 `1 小时` 的工作目录。
* 状态为 `failed` 或 `canceled`，且 `updatedAt` 时间距离当前已超过 `2 小时` 的工作目录。
* 异步删除：使用 `fs.rm(jobDir, { recursive: true, force: true })` 进行清除。
