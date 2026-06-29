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
import { JobPipeline } from './job-pipeline.js';
import { saveJobState, loadJobState } from '../utils/state.js';
import { verifyDiskSpace } from '../utils/disk.js';
// 模块 05（假定已存在）：把全部分片 M4A 合成为带章节/封面的 M4B，并完成完整性校验，
// 失败时抛错。写出 `${jobDir}/output.m4b`。
import { assembleAudiobook } from '../utils/ffmpeg.js';
import { objectStore } from './object-store.js';
import type { JobInfo, JobState, ChunkState } from '../types/job.js';
import { logger } from '../utils/logger.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import type { OrchestratorContext } from '../orchestrator/orchestrator.js';

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
  ttsEngine: string;
  voice: string;
  rate: string;
  pitch: string;
  bitrate: string;
}

/** 前端上传的单个分片（已由路由校验/清洗）。对齐前端 `TTSChunk` 的可用字段。 */
export interface IncomingChunk {
  /** 全局分片序号（从 0 开始，跨章节累计） */
  index: number;
  /** 所属章节序号（从 0 开始） */
  chapterIndex: number;
  /** 所属章节标题（可选） */
  chapterTitle?: string;
  /** 待合成的纯文本 */
  text: string;
}

/**
 * 手动上传（{@link JobManager.uploadArtifact}）的结果。供路由层映射为 HTTP 响应。
 * - `ok: true` 上传成功或本就已上传（`alreadyUploaded`）；
 * - `ok: false` 各前置条件未满足，`reason` 指明原因。
 * 实际上传 I/O 失败由方法抛出（路由经全局错误处理器 → 500），不在此枚举内。
 */
export type UploadOutcome =
  | { ok: true; remoteKey: string; alreadyUploaded: boolean }
  | { ok: false; reason: 'not_found' | 'not_done' | 'cos_disabled' | 'no_local_file' };

/** 任务列表项：供运维概览“已有 taskId 及状态”。 */
export interface JobSummary {
  /** 任务标识 */
  jobId: string;
  /** 整体状态 */
  status: string;
  /** 细分阶段 */
  phase: string;
  /** 书名 */
  title: string;
  /** 成品是否已上传 COS */
  uploaded: boolean;
  /** 本地是否仍有 output.m4b（可作下载兜底 / 可手动上传） */
  hasLocalFile: boolean;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 最近更新时间（ISO 8601） */
  updatedAt: string;
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
   * 读取成品在 COS 上的对象键（内部细节，不进对外 {@link JobInfo}）。
   * 下载路由据此决定走 COS 预签名跳转还是本地流式。
   * @param jobId 任务标识
   * @returns 已上传 COS 时返回对象键；未上传或任务不存在时返回 undefined
   */
  public getRemoteKey(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.remoteKey;
  }

  /**
   * 上传成品到 COS 的核心步骤（不含前置校验）：上传 → 记录 `remoteKey` 落盘 →（可选）删本地大文件。
   * 被自动流水线（{@link runJob}）与手动接口（{@link uploadArtifact}）共用，保证两条路径一致。
   *
   * @param state 任务状态（原地写入 `remoteKey`）
   * @param jobDir 任务工作目录绝对路径
   * @param deleteLocal 上传成功后是否删除本地 `output.m4b`（流水线置 true 省盘；手动置 false 保留兜底）
   * @returns 上传后的 COS 对象键
   * @throws 上传 I/O 失败时抛出
   */
  private async doUpload(state: JobState, jobDir: string, deleteLocal: boolean): Promise<string> {
    const key = `${config.COS_KEY_PREFIX}${state.jobId}.m4b`;
    logger.info(`[job ${state.jobId}] 开始上传成品到 COS：key=${key}`);
    await objectStore.uploadFile(path.join(jobDir, 'output.m4b'), key);
    state.remoteKey = key;
    await saveJobState(jobDir, state);
    logger.info(`[job ${state.jobId}] COS 上传成功：key=${key}，删除本地=${deleteLocal}`);
    if (deleteLocal) {
      // 删除失败忽略（如已不存在）：仍可由 GC 兜底
      await fs.promises.unlink(path.join(jobDir, 'output.m4b')).catch(() => undefined);
    }
    return key;
  }

  /**
   * 手动触发把某任务的成品上传到 COS（运维/补传用）。幂等：已上传则直接返回既有 key。
   * 内存中无此任务时回落到磁盘 `state.json` 加载（支持重启后对历史任务补传）。
   * 手动上传**保留**本地文件作下载兜底（与流水线自动上传后删除不同）。
   *
   * @param jobId 任务标识
   * @returns {@link UploadOutcome}；实际上传失败则抛出（路由映射 500）
   */
  public async uploadArtifact(jobId: string): Promise<UploadOutcome> {
    const jobDir = path.join(config.TMP_ROOT, jobId);
    // 内存优先；缺失则尝试从磁盘恢复（历史 done 任务重启后不在内存）
    let state = this.jobs.get(jobId);
    if (!state) {
      const loaded = await loadJobState(jobDir);
      if (loaded) {
        state = loaded;
        this.jobs.set(jobId, state);
      }
    }
    if (!state) return { ok: false, reason: 'not_found' };
    if (state.status !== 'done') return { ok: false, reason: 'not_done' };
    if (!objectStore.isEnabled()) return { ok: false, reason: 'cos_disabled' };
    if (state.remoteKey) return { ok: true, remoteKey: state.remoteKey, alreadyUploaded: true };
    if (!fs.existsSync(path.join(jobDir, 'output.m4b'))) {
      return { ok: false, reason: 'no_local_file' };
    }

    const key = await this.doUpload(state, jobDir, false);
    this.emitSnapshot(state);
    return { ok: true, remoteKey: key, alreadyUploaded: false };
  }

  /**
   * 列出已有任务及状态（运维概览）。合并内存与磁盘 `state.json`——内存视图更新更及时，
   * 磁盘补全重启后不在内存的历史任务。按创建时间倒序返回。
   */
  public async listJobs(): Promise<JobSummary[]> {
    const summaries = new Map<string, JobSummary>();

    // 1. 磁盘：扫描 TMP_ROOT 一级子目录，补全历史任务
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(config.TMP_ROOT, { withFileTypes: true });
    } catch {
      // TMP_ROOT 不可读：仅返回内存视图
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.join(config.TMP_ROOT, entry.name);
      const state = await loadJobState(jobDir);
      if (state) summaries.set(state.jobId, this.toSummary(state));
    }

    // 2. 内存：覆盖磁盘版本（运行中任务以内存为准）
    for (const state of this.jobs.values()) {
      summaries.set(state.jobId, this.toSummary(state));
    }

    return Array.from(summaries.values()).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }

  /** 把 {@link JobState} 投影为列表项 {@link JobSummary}。 */
  private toSummary(state: JobState): JobSummary {
    return {
      jobId: state.jobId,
      status: state.status,
      phase: state.phase,
      title: state.title,
      uploaded: Boolean(state.remoteKey),
      hasLocalFile: fs.existsSync(path.join(config.TMP_ROOT, state.jobId, 'output.m4b')),
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
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
      ttsEngine: state.ttsEngine,
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
   * 一步创建任务：前端已切分并随 `POST /jobs` 携带全部分片与元数据，故此处无需"接收中"窗口，
   * 创建后立即进入 `running`/`tts` 并后台跑 {@link runJob}。
   *
   * 流程：磁盘空间预检（按分片总数估算峰值）→ 保存封面 → 构造并落盘 {@link JobState}（分片按 `index`
   * 排序后一次性填入）→ 后台启动流水线。
   *
   * @param params 已校验的任务参数
   * @param chunks 前端切分得到的全部分片（已由路由校验/清洗，至少一片）
   * @returns 新建任务的初始 {@link JobInfo}
   * @throws {JobCreationError} 磁盘空间不足（507）或保存封面失败（500）
   */
  public async createJob(
    params: CreateJobParams,
    chunks: IncomingChunk[],
    cover?: Buffer,
    coverExtension?: string,
  ): Promise<JobInfo> {
    const jobId = randomUUID();
    const jobDir = path.join(config.TMP_ROOT, jobId);
    const totalChunks = chunks.length;

    // 1. 磁盘空间预检：按分片总数估算峰值，不足直接拒绝，避免运行中途写满磁盘。
    //    注意：以下校验若抛错，并发名额仍为“预留”状态，由路由层 catch 归还，避免重复释放。
    fs.mkdirSync(jobDir, { recursive: true });
    if (!(await verifyDiskSpace(jobDir, totalChunks))) {
      fs.rmSync(jobDir, { recursive: true, force: true });
      logger.error(`[job ${jobId}] 磁盘可用空间不足，拒绝创建（分片=${totalChunks}）`);
      throw new JobCreationError(507, 'Insufficient Storage', '磁盘可用空间不足以容纳本次任务');
    }

    // 2. 保存封面图片（如果存在）
    if (cover && coverExtension) {
      try {
        fs.writeFileSync(path.join(jobDir, `cover${coverExtension}`), cover);
      } catch (error) {
        fs.rmSync(jobDir, { recursive: true, force: true });
        logger.error(`[job ${jobId}] 保存封面图片失败：`, error);
        throw new JobCreationError(500, 'Internal Server Error', '保存封面图片失败');
      }
    }

    // 校验通过、确定创建：把预留名额转为真实 job 计数
    this.releaseSlot();

    // 3. 把分片按 index 排序后映射为持久化状态，构造并落盘初始 JobState，直接进入运行态。
    const chunkStates: ChunkState[] = chunks
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((c) => ({
        index: c.index,
        chapterIndex: c.chapterIndex,
        chapterTitle: c.chapterTitle,
        text: c.text,
        rawPath: path.join(jobDir, `raw_${c.index}.mp3`),
        m4aPath: path.join(jobDir, `chunk_${c.index}.m4a`),
        durationMs: 0,
        status: 'pending',
      }));

    const now = new Date().toISOString();
    const state: JobState = {
      jobId,
      title: params.title,
      author: params.author,
      status: 'running',
      phase: 'tts',
      ttsEngine: params.ttsEngine,
      voice: params.voice,
      rate: params.rate,
      pitch: params.pitch,
      bitrate: params.bitrate,
      totalChunks,
      completedTTS: 0,
      completedTranscode: 0,
      chunks: chunkStates,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(jobId, state);
    await saveJobState(jobDir, state);
    this.emitSnapshot(state);

    logger.info(`[job ${jobId}] 创建任务并启动流水线：title=${params.title}，分片=${totalChunks}`);
    void this.runJob(jobId, jobDir);
    return this.toJobInfo(state);
  }

  /**
   * 后台编排任务：按 `ORCHESTRATOR_ENABLED` 分流到编排图或既有命令式流水线。
   * 两条路径共享 {@link finalizeJob} 的 uploading/validating/ready 收尾；
   * 任一阶段抛错由本方法的 try/catch 统一置 `failed`（取消导致的抛错除外）。
   *
   * @param jobId 任务标识
   * @param jobDir 工作目录绝对路径
   */
  private async runJob(jobId: string, jobDir: string): Promise<void> {
    const state = this.jobs.get(jobId);
    if (!state) return;
    // 取消查询钩子：以内存中的最新状态为准，使流水线/图内尚未开始的工作能及时跳过
    const isCanceled = (): boolean => this.jobs.get(jobId)?.status === 'canceled';
    const mode = config.ORCHESTRATOR_ENABLED ? '编排图' : '命令式';
    logger.info(`[job ${jobId}] 开始执行（${mode}流水线），共 ${state.totalChunks} 分片`);
    try {
      if (config.ORCHESTRATOR_ENABLED) {
        // 暂不处理
        // await this.runOrchestrated(state, jobDir, isCanceled);
      } else {
        await this.runImperative(state, jobDir, isCanceled);
      }
    } catch (err) {
      // 被取消导致的抛错不视为失败
      if (isCanceled()) return;
      state.status = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      // 记录失败时所处阶段与完整错误（含堆栈），便于定位卡在哪一步
      logger.error(`[job ${jobId}] 任务失败 @phase=${state.phase}：`, err);
      await saveJobState(jobDir, state).catch(() => undefined);
      this.emitSnapshot(state);
    }
  }

  /**
   * 既有命令式流水线（`ORCHESTRATOR_ENABLED=false` 默认）：
   * 双并发池 TTS+转码 → mux 合成 M4B → 收尾。
   */
  private async runImperative(
    state: JobState,
    jobDir: string,
    isCanceled: () => boolean,
  ): Promise<void> {
    // 阶段一：TTS 合成 + 逐分片转码（双并发池流水线）
    await this.pipeline.execute(state, jobDir, () => this.emitSnapshot(state), isCanceled);
    if (isCanceled()) return;
    // 阶段二：合成 M4B（委托模块 05：拼接 M4A + 章节元数据 + 封面，并做完整性校验）
    state.phase = 'mux';
    await saveJobState(jobDir, state);
    this.emitSnapshot(state);
    logger.info(`[job ${state.jobId}] 阶段 -> mux：合成 M4B`);
    await assembleAudiobook(state, jobDir);
    if (isCanceled()) return;
    await this.finalizeJob(state, jobDir, isCanceled);
  }

  /**
   * 编排器流水线（`ORCHESTRATOR_ENABLED=true`）：用 OOP Orchestrator 完成 tts+mux，
   * 委托既有 `JobPipeline`/`assembleAudiobook` 作叶子执行器，复用 CheckpointStore 实现断点续传。
   * 取消语义经 `isCanceled` 贯穿（pipeline 内未开始分片跳过；Audio Merger 检查取消）。
   */
  // private async runOrchestrated(
  //   state: JobState,
  //   jobDir: string,
  //   isCanceled: () => boolean,
  // ): Promise<void> {
  //   logger.info(`[job ${state.jobId}] 编排器启动`);
  //   const ctx: OrchestratorContext = {
  //     jobState: state,
  //     jobDir,
  //     voice: state.voice,
  //     onProgress: () => this.emitSnapshot(state),
  //     isCanceled,
  //     // decisionClient: createDecisionClient(),
  //     // Phase 1 自动放行 HITL 中断；Phase 2 置 true 启用人工审核
  //     enableHumanReview: false,
  //     // 委托既有 JobPipeline.execute：幂等跳过已完成分片，429 冷却/续传由 pipeline 继承
  //     runTTSPhase: () =>
  //       this.pipeline.execute(state, jobDir, () => this.emitSnapshot(state), isCanceled),
  //   };
  //   // 加载 checkpoint（缺失/损坏则空内存安全回退，从第一章重跑）
  //   // const checkpoint = await createCheckpointStore(jobDir);
  //   const orch = new Orchestrator(ctx, checkpoint, {
  //     projectId: state.jobId,
  //     title: state.title,
  //     inputChunks: state.chunks.map((c) => ({
  //       index: c.index,
  //       chapterIndex: c.chapterIndex,
  //       chapterTitle: c.chapterTitle,
  //       text: c.text,
  //     })),
  //   });
  //   await orch.run();
  //   if (isCanceled()) return;
  //   // Orchestrator 已完成 tts+mux（mergeAudio 产出 output.m4b），收尾 uploading/validating/ready
  //   await this.finalizeJob(state, jobDir, isCanceled);
  // }

  /**
   * 收尾阶段（两条路径共享）：可选 COS 卸载 → validating → ready。
   * 复用既有契约：COS 失败不致任务失败（回退本地流式下载）。
   */
  private async finalizeJob(
    state: JobState,
    jobDir: string,
    isCanceled: () => boolean,
  ): Promise<void> {
    // 卸载成品到 COS（开关开启、COS 已配置且尚未上传时）。上传走内网域名，快且不占公网出口。
    // `COS_UPLOAD_ENABLED` 为总开关（默认 false）；`!state.remoteKey` 保证重跑/恢复时幂等跳过；
    // 失败不致整任务失败——remoteKey 留空，下载回退本地流式。
    if (config.COS_UPLOAD_ENABLED && objectStore.isEnabled() && !state.remoteKey) {
      state.phase = 'uploading';
      await saveJobState(jobDir, state);
      this.emitSnapshot(state);
      logger.info(`[job ${state.jobId}] 阶段 -> uploading：卸载成品到 COS`);
      try {
        await this.doUpload(state, jobDir, true);
      } catch (uploadErr) {
        logger.info(`[job ${state.jobId}] COS 上传失败，回退本地下载：`, uploadErr);
      }
      if (isCanceled()) return;
    }
    // 校验已在 assembleAudiobook 内完成，此处推进至就绪
    state.phase = 'validating';
    await saveJobState(jobDir, state);
    this.emitSnapshot(state);
    // 就绪，标记完成
    state.phase = 'ready';
    state.status = 'done';
    await saveJobState(jobDir, state);
    this.emitSnapshot(state);
    logger.info(`[job ${state.jobId}] 任务完成（done）`);
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
    // eslint-disable-next-line no-console
    console.log(`[job ${jobId}] 收到取消请求（phase=${state.phase}）`);
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
    // eslint-disable-next-line no-console
    console.log(
      `[job ${jobId}] 恢复任务，断点续传（TTS=${state.completedTTS}/${state.totalChunks}，转码=${state.completedTranscode}/${state.totalChunks}）`,
    );
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

    // eslint-disable-next-line no-console
    console.log(`[recovery] 开始扫描 ${config.TMP_ROOT}，候选目录 ${entries.length} 个`);
    let recovered = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.join(config.TMP_ROOT, entry.name);
      const state = await loadJobState(jobDir);
      // 解析失败或缺失：跳过该目录
      if (!state) continue;
      // 仅恢复未完成任务
      if (state.status !== 'pending' && state.status !== 'running') continue;
      // 跳过"接收中但未 start"的任务（pending/preprocess）：分片可能尚未到齐，
      // 此时盲跑流水线会用残缺分片合成，故等用户重新走创建/上传流程。
      if (state.status === 'pending' && state.phase === 'preprocess') continue;

      // 重置为 running，载入内存，重新投入调度——execute 内据 chunk.status 跳过已就绪分片
      state.status = 'running';
      this.jobs.set(state.jobId, state);
      await saveJobState(jobDir, state).catch(() => undefined);
      this.emitSnapshot(state);
      // eslint-disable-next-line no-console
      console.log(
        `[recovery] 恢复任务 [job ${state.jobId}]（TTS=${state.completedTTS}/${state.totalChunks}，转码=${state.completedTranscode}/${state.totalChunks}）`,
      );
      recovered++;
      void this.runJob(state.jobId, jobDir);
    }

    // eslint-disable-next-line no-console
    console.log(`[recovery] 恢复完成，共重新投入 ${recovered} 个任务`);
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
