/**
 * @file job.ts
 * @description 有声书生成任务的核心类型契约。供 API 路由、任务管理器与后续流水线模块共享。
 * 注意：状态集刻意不含 `paused`——服务重启后复活的未完成任务统一置为 `failed`，由用户手动 resume 续跑。
 */

/** 任务整体状态。`pending`/`running` 为活跃态，`done`/`failed`/`canceled` 为终态。 */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';

/** 任务所处的细分阶段，用于前端展示流水线进度。 */
export type JobPhase = 'preprocess' | 'tts' | 'mux' | 'validating' | 'ready';

/** 任务进度结构：当前阶段 + TTS/转码两条流水线的分块完成度。 */
export interface JobProgress {
  /** 当前细分阶段 */
  phase: JobPhase;
  /** TTS 合成分块进度 */
  ttsChunks: { done: number; total: number };
  /** 转码分块进度 */
  transcodeChunks: { done: number; total: number };
}

/** 任务的完整状态快照，既是内存模型也是 `GET /jobs/:id` 的响应体。 */
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
