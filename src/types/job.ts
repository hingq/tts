/**
 * @file job.ts
 * @description 有声书生成任务的核心类型契约。供 API 路由、任务管理器与流水线模块共享。
 *
 * 这里存在两层模型，分工明确，不可混用：
 * - {@link JobState}/{@link ChunkState}：**持久化模型**。每个工作目录下 `state.json` 的内存映射，
 *   含分片级细节（`chunks`）与检查点计数，是崩溃恢复与断点续传的唯一可靠来源。
 * - {@link JobInfo}/{@link JobProgress}：**对外契约模型**。`GET /jobs/:id` 与 SSE 的响应体，
 *   只暴露阶段与两条流水线的 `done/total`，不泄露 `chunks` 等内部细节。
 *   路由层通过映射函数把 `JobState` 投影为 `JobInfo`，两者解耦后持久化模型可独立演进。
 *
 * 注意：状态集刻意不含 `paused`——服务重启后复活的未完成任务直接恢复执行（断点续传），
 * 终态失败/取消的任务由用户手动 resume 续跑。
 */

/** 任务整体状态。`pending`/`running` 为活跃态，`done`/`failed`/`canceled` 为终态。 */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';

/** 任务所处的细分阶段，用于前端展示流水线进度。 */
export type JobPhase = 'preprocess' | 'tts' | 'mux' | 'uploading' | 'validating' | 'ready';

/** 任务进度结构：当前阶段 + TTS/转码两条流水线的分块完成度。 */
export interface JobProgress {
  /** 当前细分阶段 */
  phase: JobPhase;
  /** TTS 合成分块进度 */
  ttsChunks: { done: number; total: number };
  /** 转码分块进度 */
  transcodeChunks: { done: number; total: number };
}

/** 单个分片在流水线中的细分状态。 */
export type ChunkStatus = 'pending' | 'tts_done' | 'transcode_done' | 'failed';

/**
 * 单个 TTS 分片的持久化状态。`status` 的跃迁顺序为
 * `pending` → `tts_done`（MP3 已合成）→ `transcode_done`（M4A 已转码且时长已知）。
 * 断点续传依据该字段幂等跳过已完成的分片。
 */
export interface ChunkState {
  /** 全局分片序号（从 0 开始，跨章节累计） */
  index: number;
  /** 所属章节序号（从 0 开始） */
  chapterIndex: number;
  /** 所属章节标题（可选） */
  chapterTitle?: string;
  /** 待合成的纯文本 */
  text: string;
  /** 临时 MP3 的绝对路径（TTS 输出，转码完成后删除） */
  rawPath: string;
  /** 标准化 M4A 的绝对路径（转码输出，参与最终合成） */
  m4aPath: string;
  /** M4A 精确时长（毫秒），由 FFprobe 读取，未转码时为 0 */
  durationMs: number;
  /** 分片细分状态 */
  status: ChunkStatus;
}

/**
 * 任务的持久化状态模型，落盘为工作目录下的 `state.json`。
 * 这是崩溃恢复与断点续传的唯一可靠来源——内存仅为运行视图。
 */
export interface JobState {
  /** 任务唯一标识（UUID） */
  jobId: string;
  /** 书名，写入 M4B 元数据标题 */
  title: string;
  /** 作者，写入 M4B 元数据 Artist（可选） */
  author?: string;
  /** 任务整体状态 */
  status: JobStatus;
  /** 当前细分阶段 */
  phase: JobPhase;
  /** 发音人（白名单内） */
  voice: string;
  /** 语速，如 `+0%` */
  rate: string;
  /** 音高，如 `+0Hz` */
  pitch: string;
  /** 目标音频码率，如 `64k` */
  bitrate: string;
  /** 分片总数 */
  totalChunks: number;
  /** 已完成 TTS 合成的分片数（检查点计数） */
  completedTTS: number;
  /** 已完成转码的分片数（检查点计数） */
  completedTranscode: number;
  /** 全部分片的细分状态 */
  chunks: ChunkState[];
  /** 失败原因，无错误时省略 */
  error?: string;
  /** 成品在 COS 上的对象键；上传成功后写入，作为“下载走 COS 还是本地”的判据，未上传时省略 */
  remoteKey?: string;
  /** 任务创建时间（ISO 8601） */
  createdAt: string;
  /** 最近一次状态落盘时间（ISO 8601），由 `saveJobState` 自动刷新 */
  updatedAt: string;
}

/** 任务的对外状态快照，既是对外内存视图也是 `GET /jobs/:id` 的响应体。 */
export interface JobInfo {
  /** 任务唯一标识（UUID） */
  jobId: string;
  /** 任务整体状态 */
  status: JobStatus;
  /** 任务进度 */
  progress: JobProgress;
  /** 完成后可用的下载地址，未就绪时为 null */
  downloadUrl: string | null;
  /** 失败原因，无错误时为 null */
  error: string | null;
  /** 任务创建时间（ISO 8601） */
  startedAt: string;
  /** 任务终结时间（ISO 8601），未结束时为 null */
  finishedAt: string | null;
  /** 书名，写入 M4B 元数据标题 */
  title: string;
  /** 作者，写入 M4B 元数据 Artist（可选） */
  author?: string;
  /** 发音人（白名单内） */
  voice: string;
  /** 语速，如 `+0%` */
  rate: string;
  /** 音高，如 `+0Hz` */
  pitch: string;
  /** 目标音频码率，如 `64k` */
  bitrate: string;
}
