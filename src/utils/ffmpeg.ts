/**
 * @file ffmpeg.ts
 * @description FFmpeg 适配器封装层。
 *
 * 职责：
 * - 为流水线调度层和任务管理层提供符合既定契约的底层 FFmpeg 调用接口。
 * - 导出 `transcodeToM4A`、`getDuration` 和 `assembleAudiobook` 函数。
 * - 桥接至 `src/services/audio-transcoder.ts` 的核心实现，并在 `assembleAudiobook` 内部做章节时间轴合并、生成 ffmeta、可选封面检测与混合（Mux），以及执行最终的可用性校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  runCommandAsync,
  extractDurationMs,
  writeFileList,
  writeChaptersMetadata,
  muxAudiobook,
  validateM4bFile,
} from '../services/audio-transcoder.js';
import type { JobState } from '../types/job.js';
import type { AudiobookMetadata } from '../types/audio-transcoder.js';
import { logger } from './logger.js';

/**
 * 将单个原始音频段转码为标准化 M4A（AAC）文件，带超时守护与单线程 CPU 优化限制。
 *
 * @param rawPath 原始音频段（MP3）路径
 * @param m4aPath 目标 M4A 路径
 * @param timeoutMs 进程执行超时时长（毫秒）
 */
export async function transcodeToM4A(
  rawPath: string,
  m4aPath: string,
  timeoutMs: number,
): Promise<void> {
  const args = [
    '-y',
    '-i',
    rawPath,
    '-c:a',
    'aac',
    '-profile:a',
    'aac_low',
    '-b:a',
    '64k',
    '-ar',
    '24000',
    '-ac',
    '1',
    '-threads',
    '1', // 限制单线程，防止高并发时瞬间压爆 CPU
    '-movflags',
    '+faststart',
    m4aPath,
  ];
  await runCommandAsync(config.FFMPEG_PATH, args, timeoutMs);
}

/**
 * 获取音频文件的精确时长（毫秒）。
 *
 * @param filePath 音频文件路径
 * @returns 毫秒时长数值（整数）
 */
export async function getDuration(filePath: string): Promise<number> {
  return extractDurationMs(filePath);
}

/**
 * 合成整本有声书（M4B 容器封装）：生成 filelist → 合并 chapters.ffmeta 时间轴 → 自动检测并载入封面 → Muxing 合并 → ffprobe 完整性及 moov 前置审计校验。
 *
 * @param state 任务持久化状态
 * @param jobDir 任务工作目录的绝对路径
 * @throws 当任何子进程执行失败或输出校验不合格时抛出异常，触发任务转为 failed 状态
 */
export async function assembleAudiobook(state: JobState, jobDir: string): Promise<void> {
  const filelistPath = path.join(jobDir, 'filelist.txt');
  const ffmetaPath = path.join(jobDir, 'chapters.ffmeta');
  const outputPath = path.join(jobDir, 'output.m4b');

  // 1. 生成 filelist.txt
  const chunkPaths = state.chunks.map((c) => c.m4aPath);
  await writeFileList(chunkPaths, filelistPath);

  // 2. 按章节对齐并汇总计算 chapters
  const chaptersMap = new Map<number, { title: string; durationMs: number }>();
  for (const chunk of state.chunks) {
    const existing = chaptersMap.get(chunk.chapterIndex);
    if (existing) {
      existing.durationMs += chunk.durationMs;
    } else {
      chaptersMap.set(chunk.chapterIndex, {
        title: chunk.chapterTitle || `第 ${chunk.chapterIndex + 1} 部分`,
        durationMs: chunk.durationMs,
      });
    }
  }

  // 按照章节序号升序排序并构建 definitions
  const chapters = Array.from(chaptersMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);

  logger.info(
    `[job ${state.jobId}] 合成 M4B：分片=${state.chunks.length}，章节=${chapters.length}`,
  );

  const metadata: AudiobookMetadata = {
    title: state.title,
    artist: state.author || 'Unknown',
    chapters,
  };
  await writeChaptersMetadata(metadata, ffmetaPath);

  // 3. 检测是否存在封面（若存在则传入 mux 选项中）
  let coverImagePath: string | undefined;
  for (const ext of ['.jpg', '.jpeg', '.png']) {
    const p = path.join(jobDir, `cover${ext}`);
    if (fs.existsSync(p)) {
      coverImagePath = p;
      break;
    }
  }

  // 4. 开始 Muxing 合并
  await muxAudiobook({
    chunkPaths,
    metadataPath: ffmetaPath,
    outputPath,
    coverImagePath,
  });

  // 5. 执行输出审计校验
  const validationResult = await validateM4bFile(outputPath, chapters.length);
  if (!validationResult.valid) {
    throw new Error(
      `M4B Output Validation Failed: formatValid=${validationResult.formatValid}, ` +
        `chapterCountMatch=${validationResult.chapterCountMatch} (expected ${chapters.length}, actual ${validationResult.actualChapterCount}), ` +
        `faststartValid=${validationResult.faststartValid}`,
    );
  }
}
