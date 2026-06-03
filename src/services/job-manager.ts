/**
 * @file job-manager.ts
 * @description 任务生命周期与并发中枢（真实实现）。
 *
 * 取代此前的内存 Mock：以真实的 {@link JobPipeline}（TTS + 转码双并发池）驱动状态机，
 * 把进度持久化到每个工作目录的 `state.json`，并在崩溃 / 重启后据此断点续传。
 *
 * 职责：
 * - 并发名额管理（`tryReserveSlot` / `releaseSlot` / `MAX_CONCURRENT_JOBS`）。
 * - 任务创建：文本预处理 → 磁盘预检 → 构造并落盘 {@link JobState} → 后台跑流水线。
 * - 阶段编排：`tts`（合成+转码，由 {@link JobPipeline} 完成）→ `mux`（合成 M4B，委托模块 05）→ `validating` → `ready`。
 * - 取消 / 恢复 / 重启扫描恢复。
 * - 把持久化的 {@link JobState} 映射为对外契约 {@link JobInfo}，并通过事件派发 SSE 快照。
 *
 * 内存中的 `jobs` 仅是运行视图；磁盘上的 `state.json` 才是恢复的唯一可靠来源。
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { processText } from './text-processor.js';
import { JobPipeline } from './job-pipeline.js';
import { saveJobState, loadJobState } from '../utils/state.js';
import { verifyDiskSpace } from '../utils/disk.js';
// 模块 05（假定已存在）：把全部分片 M4A 合成为带章节/封面的 M4B，并完成完整性校验，
// 失败时抛错。写出 `${jobDir}/output.m4b`。
import { assembleAudiobook } from '../utils/ffmpeg.js';
import type { JobInfo, JobState } from '../types/job.js';

/** 终态集合：处于这些状态的任务不再推进。 */
const TERMINAL_STATES: ReadonlyArray<string> = ['done', 'failed', 'canceled'];

/**
 * 任务创建期可向上映射为 HTTP 状态码的错误。
 * 路由层据 `statusCode` 直接映射响应，避免任务管理器反向依赖路由的 `HttpError`。
 */
export class JobCreationError extends Error {
  constructor(
    public statusCode: number,
    public publicName: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobCreationError';
  }
}

/** 任务创建参数（已由路由校验）。 */
export interface CreateJobParams {
  title: string;
  author?: string;
  voice: string;
  rate: string;
  pitch: string;
  bitrate: string;
}

export class JobManager extends EventEmitter {
  private static instance: JobManager;
  /** jobId -> 持久化任务状态（运行视图） */
  private jobs: Map<string, JobState> = new Map();
  /** 共享的流水线调度器：并发池与全局 429 冷却在所有任务间统一生效 */
  private pipeline = new JobPipeline();
  /** 并发占位计数：在 multipart 解析等 await 之前先占位，规避“先查后建”竞态 */
  private reserved = 0;

  private constructor() {
    super();
    // 每个 jobId 一条 SSE 链路 + 内部监听，放宽上限以消除 MaxListeners 告警
    this.setMaxListeners(0);
  }

  /** 获取全局单例。 */
  public static getInstance(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  // ==========================================================================
  // 并发名额
  // ==========================================================================

  /**
   * 原子地尝试占用一个并发名额。
   * @returns `true` 占位成功；`false` 表示已达 `MAX_CONCURRENT_JOBS`。
   */
  public tryReserveSlot(): boolean {
    if (this.getActiveJobsCount() + this.reserved >= config.MAX_CONCURRENT_JOBS) {
      return false;
    }
    this.reserved++;
    return true;
  }

  /** 归还一个此前占用、但最终未转为真实 job 的名额。 */
  public releaseSlot(): void {
    if (this.reserved > 0) this.reserved--;
  }

  /** 当前活跃（pending/running）任务数。 */
  public getActiveJobsCount(): number {
    return Array.from(this.jobs.values()).filter(
      (j) => j.status === 'running' || j.status === 'pending',
    ).length;
  }

  // ==========================================================================
  // 查询与映射
  // ==========================================================================

  /**
   * 读取任务的对外快照。
   * @param jobId 任务标识
   * @returns 映射后的 {@link JobInfo}；不存在时为 undefined
   */
  public getJob(jobId: string): JobInfo | undefined {
    const state = this.jobs.get(jobId);
    return state ? this.toJobInfo(state) : undefined;
  }

  /**
   * 把持久化的 {@link JobState} 投影为对外契约 {@link JobInfo}。
   * 只暴露阶段与两条流水线的 `done/total`，不泄露 `chunks` 等内部细节。
   */
  private toJobInfo(state: JobState): JobInfo {
    const terminal = TERMINAL_STATES.includes(state.status);
    return {
      jobId: state.jobId,
      status: state.status,
      progress: {
        phase: state.phase,
        ttsChunks: { done: state.completedTTS, total: state.totalChunks },
        transcodeChunks: { done: state.completedTranscode, total: state.totalChunks },
      },
      downloadUrl: state.status === 'done' ? `/api/v1/audiobook/jobs/${state.jobId}/file` : null,
      error: state.error ?? null,
      startedAt: state.createdAt,
      finishedAt: terminal ? state.updatedAt : null,
      title: state.title,
      author: state.author,
      voice: state.voice,
      rate: state.rate,
      pitch: state.pitch,
      bitrate: state.bitrate,
    };
  }

  /** 派发对外快照到 `job:${jobId}` 频道（供 SSE 监听者消费）。 */
  private emitSnapshot(state: JobState): void {
    this.emit(`job:${state.jobId}`, this.toJobInfo(state));
  }

  // ==========================================================================
  // 创建与编排
  // ==========================================================================

  /**
   * 创建并启动一个真实任务。
   *
   * 流程：文本预处理（分块）→ 磁盘空间预检 → 构造并落盘初始 {@link JobState} → 后台跑流水线。
   *
   * @param params 已校验的任务参数
   * @param text 上传的文本原始字节
   * @returns 新建任务的初始 {@link JobInfo}
   * @throws {JobCreationError} 文本为空（400）或磁盘空间不足（507）
   */
  public async createJob(
    params: CreateJobParams,
    text: Buffer,
    cover?: Buffer,
    coverExtension?: string,
  ): Promise<JobInfo> {
    const jobId = randomUUID();
    const jobDir = path.join(config.TMP_ROOT, jobId);
    // 1. 文本预处理：切分为 TTS 分块。
    //    注意：以下校验若抛错，并发名额仍为“预留”状态，由路由层 catch 归还，避免重复释放。
    const ttsChunks = processText(text);
    if (ttsChunks.length === 0) {
      throw new JobCreationError(400, 'Bad Request', '文本内容为空或无法切分出有效分片');
    }

    // 2. 磁盘空间预检：不足直接拒绝，避免运行中途写满磁盘
    fs.mkdirSync(jobDir, { recursive: true });
    if (!(await verifyDiskSpace(jobDir, ttsChunks.length))) {
      fs.rmSync(jobDir, { recursive: true, force: true });
      throw new JobCreationError(507, 'Insufficient Storage', '磁盘可用空间不足以容纳本次任务');
    }

    // 保存封面图片（如果存在）
    if (cover && coverExtension) {
      try {
        fs.writeFileSync(path.join(jobDir, `cover${coverExtension}`), cover);
      } catch (error) {
        fs.rmSync(jobDir, { recursive: true, force: true });
        throw new JobCreationError(500, 'Internal Server Error', '保存封面图片失败');
      }
    }

    // 校验通过、确定创建：把预留名额转为真实 job 计数
    this.releaseSlot();

    // 3. 构造初始持久化状态
    const now = new Date().toISOString();
    const state: JobState = {
      jobId,
      title: params.title,
      author: params.author,
      status: 'pending',
      phase: 'preprocess',
      voice: params.voice,
      rate: params.rate,
      pitch: params.pitch,
      bitrate: params.bitrate,
      totalChunks: ttsChunks.length,
      completedTTS: 0,
      completedTranscode: 0,
      chunks: ttsChunks.map((c) => ({
        index: c.index,
        chapterIndex: c.chapterIndex,
        chapterTitle: c.chapterTitle,
        text: c.text,
        rawPath: path.join(jobDir, `raw_${c.index}.mp3`),
        m4aPath: path.join(jobDir, `chunk_${c.index}.m4a`),
        durationMs: 0,
        status: 'pending' as const,
      })),
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(jobId, state);
    await saveJobState(jobDir, state);
    this.emitSnapshot(state);

    // 4. 后台执行（不阻塞创建响应）
    void this.runJob(jobId, jobDir);
    return this.toJobInfo(state);
  }

  /**
   * 后台编排一个任务的完整生命周期：tts（合成+转码）→ mux → validating → ready。
   * 任一阶段抛错则置 `failed`；运行中被取消则提前退出且不覆盖终态。
   *
   * @param jobId 任务标识
   * @param jobDir 工作目录绝对路径
   */
  private async runJob(jobId: string, jobDir: string): Promise<void> {
    const state = this.jobs.get(jobId);
    if (!state) return;
    // 取消查询钩子：以内存中的最新状态为准，使流水线内尚未开始的分片能及时跳过
    const isCanceled = (): boolean => this.jobs.get(jobId)?.status === 'canceled';

    try {
      // 阶段一：TTS 合成 + 逐分片转码（双并发池流水线）
      await this.pipeline.execute(state, jobDir, () => this.emitSnapshot(state), isCanceled);
      if (isCanceled()) return;

      // 阶段二：合成 M4B（委托模块 05：拼接 M4A + 章节元数据 + 封面，并做完整性校验）
      state.phase = 'mux';
      await saveJobState(jobDir, state);
      this.emitSnapshot(state);
      await assembleAudiobook(state, jobDir);
      if (isCanceled()) return;

      // 阶段三：校验已在 assembleAudiobook 内完成，此处推进至就绪
      state.phase = 'validating';
      await saveJobState(jobDir, state);
      this.emitSnapshot(state);

      // 阶段四：就绪，标记完成
      state.phase = 'ready';
      state.status = 'done';
      await saveJobState(jobDir, state);
      this.emitSnapshot(state);
    } catch (err) {
      // 被取消导致的抛错不视为失败
      if (isCanceled()) return;
      state.status = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      await saveJobState(jobDir, state).catch(() => undefined);
      this.emitSnapshot(state);
    }
  }

  // ==========================================================================
  // 取消 / 恢复
  // ==========================================================================

  /**
   * 取消任务。对终态任务由路由层处理为幂等，本方法仅在任务存在且非终态时有效。
   * @param jobId 任务标识
   * @returns 任务是否存在
   */
  public cancelJob(jobId: string): boolean {
    const state = this.jobs.get(jobId);
    if (!state) return false;

    // 置内存状态为 canceled —— 流水线内的 isCanceled 钩子据此让尚未开始的分片跳过
    state.status = 'canceled';
    const jobDir = path.join(config.TMP_ROOT, jobId);
    // 终态需在重启后可见：异步落盘检查点
    void saveJobState(jobDir, state).catch(() => undefined);
    this.emitSnapshot(state);
    return true;
  }

  /**
   * 恢复任务。仅允许从 failed / canceled 回到运行；借助 `chunk.status` 实现断点续传，
   * 已就绪的分片会被流水线无缝跳过，无需重复请求或转码。
   * @param jobId 任务标识
   * @returns 'ok' 恢复成功 | 'not_found' 任务不存在 | 'invalid_state' 状态不允许
   */
  public resumeJob(jobId: string): 'ok' | 'not_found' | 'invalid_state' {
    const state = this.jobs.get(jobId);
    if (!state) return 'not_found';
    if (!['failed', 'canceled'].includes(state.status)) return 'invalid_state';

    state.status = 'running';
    state.error = undefined;
    const jobDir = path.join(config.TMP_ROOT, jobId);
    void saveJobState(jobDir, state).catch(() => undefined);
    this.emitSnapshot(state);
    void this.runJob(jobId, jobDir);
    return 'ok';
  }

  // ==========================================================================
  // 重启恢复
  // ==========================================================================

  /**
   * 服务启动恢复：扫描 `TMP_ROOT` 的一级子目录，读取各 `state.json`，
   * 把未完成（pending/running）的任务重置为 running 并重新投入调度（断点续传）。
   * 终态任务忽略；损坏 / 缺失的状态文件跳过，绝不阻断启动。
   */
  public async recoverJobs(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(config.TMP_ROOT, { withFileTypes: true });
    } catch {
      // TMP_ROOT 不可读：无可恢复任务
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.join(config.TMP_ROOT, entry.name);
      const state = await loadJobState(jobDir);
      // 解析失败或缺失：跳过该目录
      if (!state) continue;
      // 仅恢复未完成任务
      if (state.status !== 'pending' && state.status !== 'running') continue;

      // 重置为 running，载入内存，重新投入调度——execute 内据 chunk.status 跳过已就绪分片
      state.status = 'running';
      this.jobs.set(state.jobId, state);
      await saveJobState(jobDir, state).catch(() => undefined);
      this.emitSnapshot(state);
      void this.runJob(state.jobId, jobDir);
    }
  }

  // ==========================================================================
  // 停机
  // ==========================================================================

  /**
   * 优雅停机收尾。当前真实实现无需清理定时器（流水线随进程退出而中断，
   * 未完成任务的检查点已落盘，可在重启后断点续传）。保留方法以兼容既有调用方。
   */
  public clearAllTimers(): void {
    // 无定时器需要清理；保留为兼容性空实现。
  }
}
