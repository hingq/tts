/**
 * @file job-pipeline.ts
 * @description 有声书生成的核心并发调度器。
 *
 * 用 `p-limit` 建立两个相互独立的并发池：
 * - **TTS 池**（受 `config.CONCURRENT_TTS_LIMIT` 约束）：限制对 Edge-TTS 公网接口的在途请求数，防止触发 429 风控。
 * - **转码池**（受 `config.CONCURRENT_TRANSCODE_LIMIT` 约束）：限制并发的 FFmpeg 子进程数，避免压垮 CPU。
 *
 * 关键设计是"逐分片流水线链条"：每个分片是一条 `ttsLimit(...).then(() => transcodeLimit(...))` 的链，
 * 某分片 TTS 一旦成功就**立刻**把它投入转码池，而不等待其余分片的 TTS——从而让网络 I/O 与 CPU 算力充分重叠。
 *
 * 容错与恢复：
 * - 每个关键跃迁后通过 {@link saveJobState} 原子落盘检查点；崩溃后据此恢复。
 * - 执行链条依据 `chunk.status` 幂等跳过已完成的分片，使恢复路径与正常路径共用同一份代码（断点续传）。
 * - 捕获 {@link TTSThrottleError} 时触发全局冷却（约 30s 暂停派发新 TTS 请求）并对该分片重试。
 *
 * 依赖（前置模块）：模块 04 `EdgeTTSProvider`、模块 05 `src/utils/ffmpeg.ts` 的 `transcodeToM4A` / `getDuration`。
 */

import { promises as fs } from 'node:fs';
import pLimit from 'p-limit';
import { EdgeTTSProvider } from '../providers/edge-tts.js';
import { transcodeToM4A, getDuration } from '../utils/ffmpeg.js';
import { saveJobState } from '../utils/state.js';
import { TTSThrottleError } from '../types/tts.js';
import type { JobState, ChunkState } from '../types/job.js';
import { config } from '../config.js';

/** 命中 429 风控后全局暂停派发新 TTS 请求的冷却时长（毫秒）。 */
const COOLDOWN_MS = 30_000;

/** 单分片因 429 触发冷却后的最大重试次数，超过则判定该分片失败。 */
const MAX_THROTTLE_RETRIES = 5;

/** TTS 成功后插入的随机延时下界（毫秒），用于打散请求时刻避风控。 */
const TTS_DELAY_MIN_MS = 1000;
/** TTS 成功后随机延时的抖动幅度（毫秒），实际延时为 [1000, 2500)。 */
const TTS_DELAY_JITTER_MS = 1500;

/** 等待指定毫秒。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 双并发池流水线调度器。一个实例可被多个任务复用——并发池与全局冷却在实例上共享，
 * 因此 TTS 限额与 429 冷却对**所有**在跑任务统一生效，符合"全局风控"的语义。
 */
export class JobPipeline {
  /** TTS 合成并发池：限制对公网接口的在途请求数。 */
  private readonly ttsLimit = pLimit(config.CONCURRENT_TTS_LIMIT);
  /** 转码并发池：限制并发 FFmpeg 子进程数。 */
  private readonly transcodeLimit = pLimit(config.CONCURRENT_TRANSCODE_LIMIT);
  /** TTS 合成器（实例复用，内部自带指数退避与 429 识别）。 */
  private readonly ttsProvider = new EdgeTTSProvider();

  /**
   * 全局 TTS 冷却的截止时间戳（epoch ms）。
   * 命中 429 时被推后到 `now + COOLDOWN_MS`；每次发请求前都先 {@link waitForCooldown} 等到该时刻之后。
   * 共享于实例，故一个分片触发的冷却会让所有并发分片一起退避。
   */
  private cooldownUntil = 0;

  /**
   * 执行一个任务的完整 TTS → 转码流水线。
   *
   * 流程：
   * 1. 置 `running` / `phase = 'tts'` 并落盘检查点。
   * 2. 为每个分片构建一条"先入 TTS 池、完成后立刻入转码池"的 Promise 链。
   * 3. `Promise.all` 等待所有链条收口。
   *
   * 已完成的分片（`tts_done` / `transcode_done`）会被各阶段幂等跳过，从而支持断点续传。
   *
   * @param jobState 任务持久化状态（会被原地推进并多次落盘）
   * @param jobDir 任务工作目录绝对路径
   * @param onProgress 每次进度推进后的回调（供上层派发 SSE 快照）
   * @param isCanceled 取消查询钩子；返回 `true` 时尚未开始的分片会被跳过
   */
  public async execute(
    jobState: JobState,
    jobDir: string,
    onProgress: () => void,
    isCanceled: () => boolean = () => false,
  ): Promise<void> {
    jobState.status = 'running';
    jobState.phase = 'tts';
    await saveJobState(jobDir, jobState);

    const pending = jobState.chunks.filter(
      (c) => c.status !== 'tts_done' && c.status !== 'transcode_done',
    ).length;
    // eslint-disable-next-line no-console
    console.log(
      `[job ${jobState.jobId}] 流水线启动：待处理 ${pending}/${jobState.totalChunks} 分片`,
    );

    // 熔断状态：记录首个错误。任一分片失败后，尚未开始的分片应立即停止派发，
    // 不再发 TTS 请求 / spawn ffmpeg / 改写任务状态——避免“抛错后阶段一仍在继续”。
    let firstError: unknown;
    // 统一“应停止”判定：被取消，或已发生过失败，均视为停止信号。
    const shouldStop = (): boolean => isCanceled() || firstError !== undefined;

    // 建立分片 Promise 数组：每条链把 TTS 与转码以流水线方式串联
    const chunkTasks = jobState.chunks.map((chunk) =>
      this.ttsLimit(async () => {
        // 取消 / 已失败 / 断点续传：已就绪的分片直接跳过 TTS
        if (shouldStop()) return;
        if (chunk.status === 'transcode_done' || chunk.status === 'tts_done') return;
        await this.runTts(chunk, jobState, jobDir, onProgress);
        // TTS 成功后插入随机延时（[1000,2500)ms）打散请求时刻，缓解风控
        await delay(TTS_DELAY_MIN_MS + Math.random() * TTS_DELAY_JITTER_MS);
      })
        .then(() =>
          // TTS 成功（或被跳过）后，立刻把该分片推入转码并发池——无需等待其它分片的 TTS
          this.transcodeLimit(async () => {
            if (shouldStop()) return;
            // 已转码：断点续传跳过
            if (chunk.status === 'transcode_done') return;
            // TTS 未成功（被取消跳过 / 失败）：没有可用 MP3，转码无从谈起
            if (chunk.status !== 'tts_done') return;
            await this.runTranscode(chunk, jobState, jobDir, onProgress);
          }),
        )
        // 登记首个错误并吞下，避免未处理拒绝；后续分片据 shouldStop() 立即跳过
        .catch((err) => {
          if (firstError === undefined) firstError = err;
        }),
    );

    // 等待所有分片链条收口（含因 shouldStop() 立即返回者），不留孤儿任务在失败后改状态
    await Promise.all(chunkTasks);
    // 有失败则原样上抛，交由 runJob 置 failed 并经 SSE 推出 error
    if (firstError !== undefined) {
      // eslint-disable-next-line no-console
      console.error(
        `[job ${jobState.jobId}] 流水线失败：TTS=${jobState.completedTTS}/${jobState.totalChunks}，转码=${jobState.completedTranscode}/${jobState.totalChunks}`,
        firstError,
      );
      throw firstError;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[job ${jobState.jobId}] 流水线完成：TTS=${jobState.completedTTS}/${jobState.totalChunks}，转码=${jobState.completedTranscode}/${jobState.totalChunks}`,
    );
  }

  /**
   * 合成单个分片为 MP3，内置 429 冷却重试。
   *
   * 每次尝试前先等待全局冷却结束；命中 {@link TTSThrottleError} 时触发冷却并重试（不超过
   * {@link MAX_THROTTLE_RETRIES} 次），其它错误（已含 Provider 内部的指数退避）直接上抛。
   */
  private async runTts(
    chunk: ChunkState,
    jobState: JobState,
    jobDir: string,
    onProgress: () => void,
  ): Promise<void> {
    for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
      await this.waitForCooldown();
      try {
        await this.ttsProvider.synthesize(
          chunk.text,
          {
            voice: jobState.voice,
            rate: jobState.rate,
            pitch: jobState.pitch,
            bitrate: jobState.bitrate,
          },
          // 传入不带后缀的路径，由 Provider 自行拼接 .mp3
          chunk.rawPath.replace(/\.mp3$/, ''),
        );
        chunk.status = 'tts_done';
        jobState.completedTTS++;
        await saveJobState(jobDir, jobState);
        onProgress();
        if (config.LOG_VERBOSE) {
          // eslint-disable-next-line no-console
          console.log(
            `[job ${jobState.jobId} chunk ${chunk.index}] TTS 完成（${jobState.completedTTS}/${jobState.totalChunks}）`,
          );
        }
        return;
      } catch (err) {
        // 429 风控：触发全局冷却后重试（不计入失败），重试只会加剧风控故先等冷却
        if (err instanceof TTSThrottleError && attempt < MAX_THROTTLE_RETRIES) {
          this.triggerCooldown();
          // eslint-disable-next-line no-console
          console.warn(
            `[job ${jobState.jobId} chunk ${chunk.index}] 命中 429 风控，触发全局冷却 ${COOLDOWN_MS}ms，重试 ${attempt + 1}/${MAX_THROTTLE_RETRIES}`,
          );
          continue;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[job ${jobState.jobId} chunk ${chunk.index}] TTS 最终失败（尝试 ${attempt + 1} 次）：`,
          err,
        );
        throw err;
      }
    }
  }

  /**
   * 转码单个分片 MP3 → M4A，读取精确时长，落盘检查点后删除临时 MP3 释放空间。
   */
  private async runTranscode(
    chunk: ChunkState,
    jobState: JobState,
    jobDir: string,
    onProgress: () => void,
  ): Promise<void> {
    if (config.LOG_VERBOSE) {
      // eslint-disable-next-line no-console
      console.log(`[job ${jobState.jobId} chunk ${chunk.index}] 转码开始`);
    }
    // 1. 标准化转码为 AAC/M4A（带子进程超时守护）
    await transcodeToM4A(chunk.rawPath, chunk.m4aPath, config.SUBPROCESS_TIMEOUT_MS);
    // 2. 读取精确时长（毫秒），供后续章节时间戳计算
    chunk.durationMs = await getDuration(chunk.m4aPath);
    chunk.status = 'transcode_done';
    jobState.completedTranscode++;
    await saveJobState(jobDir, jobState);
    onProgress();
    if (config.LOG_VERBOSE) {
      // eslint-disable-next-line no-console
      console.log(
        `[job ${jobState.jobId} chunk ${chunk.index}] 转码完成（${jobState.completedTranscode}/${jobState.totalChunks}，时长=${chunk.durationMs}ms）`,
      );
    }
    // 3. 转码完成即删除临时 MP3，尽快压低峰值磁盘占用
    try {
      await fs.unlink(chunk.rawPath);
    } catch {
      // 文件已不存在（如续传场景）：忽略
    }
  }

  /** 若全局冷却尚未结束，则等待至冷却截止时刻。 */
  private async waitForCooldown(): Promise<void> {
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) await delay(remaining);
  }

  /** 把全局冷却截止时刻推后 {@link COOLDOWN_MS}，使所有并发分片一起退避。 */
  private triggerCooldown(): void {
    this.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}
