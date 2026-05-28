/**
 * @file job-manager.ts
 * @description 内存 Mock 任务管理器。用定时器模拟任务生命周期的状态推进，供 API 层联调
 * SSE 进度推送、并发控制、取消与恢复。真实流水线（TTS/FFmpeg）将在后续模块替换本实现。
 *
 * 注意：本 Mock 沿用单例 `getInstance()`；真实实现建议改用 `fastify.decorate('jobManager', ...)`
 * 依赖注入，以便 Vitest 跨用例重置状态。
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JobInfo } from '../types/job.js';
import { config } from '../config.js';

/** 终态集合：处于这些状态的任务不再推进。 */
const TERMINAL_STATES: ReadonlyArray<string> = ['done', 'failed', 'canceled'];

export class JobManager extends EventEmitter {
  private static instance: JobManager;
  /** jobId -> 任务状态 */
  private jobs: Map<string, JobInfo> = new Map();
  /** jobId -> 推进定时器句柄 */
  private timers: Map<string, NodeJS.Timeout> = new Map();
  /** 并发占位计数：在 multipart 解析等 await 之前先占位，规避“先查后建”竞态 */
  private reserved = 0;

  private constructor() {
    super();
    // 每个 jobId 一条 SSE 连接链路 + 内部监听，默认 10 上限不够用，放宽以消除 MaxListeners 告警
    this.setMaxListeners(0);
  }

  /** 获取全局单例。 */
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
   * 原子地尝试占用一个并发名额。
   * @returns `true` 占位成功；`false` 表示已达 `MAX_CONCURRENT_JOBS`。
   * 调用方在校验/创建失败时必须调用 {@link releaseSlot} 归还名额。
   */
  public tryReserveSlot(): boolean {
    if (this.getActiveJobsCount() + this.reserved >= config.MAX_CONCURRENT_JOBS) {
      return false;
    }
    this.reserved++;
    return true;
  }

  /** 归还一个此前通过 {@link tryReserveSlot} 占用、但最终未转为真实 job 的名额。 */
  public releaseSlot(): void {
    if (this.reserved > 0) this.reserved--;
  }

  /** 当前活跃（pending/running）任务数。 */
  public getActiveJobsCount(): number {
    return Array.from(this.jobs.values()).filter(
      (j) => j.status === 'running' || j.status === 'pending',
    ).length;
  }

  /**
   * 读取任务状态。
   * @param jobId 任务标识
   * @returns 任务快照引用；不存在时为 undefined
   */
  public getJob(jobId: string): JobInfo | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * 创建并启动一个 Mock 任务。
   * @param params 由客户端校验后的任务参数（title/voice/rate/pitch/bitrate 等）
   * @returns 新建任务的初始 `JobInfo`
   */
  public createMockJob(
    params: Omit<
      JobInfo,
      'jobId' | 'status' | 'progress' | 'downloadUrl' | 'error' | 'startedAt' | 'finishedAt'
    >,
  ): JobInfo {
    const jobId = randomUUID();
    // 占位名额此刻转为真实 job 计数，归还预留计数避免重复占用
    this.releaseSlot();
    const job: JobInfo = {
      jobId,
      status: 'pending',
      progress: {
        phase: 'preprocess',
        ttsChunks: { done: 0, total: 10 },
        transcodeChunks: { done: 0, total: 10 },
      },
      downloadUrl: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ...params,
    };

    this.jobs.set(jobId, job);
    this.startMockWorkflow(jobId);
    return job;
  }

  /**
   * 启动一个定时器，每 1.5s 推进一次任务阶段，模拟 TTS 与转码流水线，直至 `done`。
   * @param jobId 任务标识
   */
  private startMockWorkflow(jobId: string): void {
    let tick = 0;
    const interval = setInterval(() => {
      const job = this.jobs.get(jobId);
      // 任务被删除或已进入终态：停止推进
      if (!job || TERMINAL_STATES.includes(job.status)) {
        clearInterval(interval);
        this.timers.delete(jobId);
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
    }, 1500);

    this.timers.set(jobId, interval);
  }

  /**
   * 派发任务状态快照（深拷贝 progress），避免监听者观测到后续被原地修改的引用。
   * @param job 当前任务
   */
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

  /**
   * 取消任务。对终态任务由路由层处理为幂等，本方法仅在任务存在且非终态时有效。
   * @param jobId 任务标识
   * @returns 任务是否存在
   */
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
   * pending/running/done 一律拒绝，避免重复触发 startMockWorkflow 造成双定时器。
   * @param jobId 任务标识
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

  /** 优雅停机收尾：清除所有 Mock 定时器。 */
  public clearAllTimers(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
