/**
 * @file audio-transcoder.ts
 * @description 音频转码器的类型契约。定义子进程执行、转码选项、章节元数据、
 * 混合输出及验证结果等核心接口，供 `audio-transcoder` 服务与上层调用方共享。
 */

// ─── 子进程执行 ────────────────────────────────────────────────────

/** `runCommandAsync` 的执行结果。 */
export interface CommandResult {
  /** 进程退出码（正常退出时为 0）。 */
  exitCode: number;
  /** 标准输出的完整文本。 */
  stdout: string;
  /** 标准错误的完整文本。 */
  stderr: string;
}

// ─── 转码参数 ──────────────────────────────────────────────────────

/** 单段音频标准化转码的目标编码参数。 */
export interface TranscodeOptions {
  /** 音频编解码器，例如 `"aac"`。 */
  codec: string;
  /** AAC 编码配置，例如 `"aac_low"`。 */
  profile: string;
  /** 目标码率，例如 `"64k"`。 */
  bitrate: string;
  /** 采样率（Hz），例如 `24000`。 */
  sampleRate: number;
  /** 声道数，`1` 为单声道。 */
  channels: number;
}

/** 默认转码参数：AAC-LC 64k 24kHz 单声道，与 spec 保持一致。 */
export const DEFAULT_TRANSCODE_OPTIONS: TranscodeOptions = {
  codec: 'aac',
  profile: 'aac_low',
  bitrate: '64k',
  sampleRate: 24000,
  channels: 1,
};

// ─── 章节元数据 ────────────────────────────────────────────────────

/** 单个章节的描述信息（用于生成 `chapters.ffmeta`）。 */
export interface ChapterDefinition {
  /** 章节标题，例如 `"第一章 开篇"`。 */
  title: string;
  /** 章节对应的标准化音频段时长（毫秒）。 */
  durationMs: number;
}

/** 写入 `chapters.ffmeta` 所需的完整元数据。 */
export interface AudiobookMetadata {
  /** 书名，写入 FFMETADATA1 的 `title` 字段。 */
  title: string;
  /** 作者/Artist，写入 FFMETADATA1 的 `artist` 字段。 */
  artist: string;
  /** 各章节定义（按顺序），用于计算时间轴偏移。 */
  chapters: ChapterDefinition[];
}

// ─── 混合（Mux）参数 ───────────────────────────────────────────────

/** 最终混合输出的参数配置。 */
export interface MuxOptions {
  /** 标准化后的音频段文件路径列表（有序）。 */
  chunkPaths: string[];
  /** 章节元数据文件 (`chapters.ffmeta`) 的绝对路径。 */
  metadataPath: string;
  /** 输出 M4B 文件的绝对路径。 */
  outputPath: string;
  /** 可选的封面图片文件路径（`cover.jpg` / `cover.png`）。 */
  coverImagePath?: string;
}

// ─── 验证结果 ──────────────────────────────────────────────────────

/** M4B 文件完整性验证的结果。 */
export interface ValidationResult {
  /** 是否通过全部验证。 */
  valid: boolean;
  /** 容器格式是否有效（`ffprobe` 检测）。 */
  formatValid: boolean;
  /** 解析到的章节数是否与期望值匹配。 */
  chapterCountMatch: boolean;
  /** `moov` 原子是否位于 `mdat` 原子之前（faststart）。 */
  faststartValid: boolean;
  /** 解析到的实际章节数。 */
  actualChapterCount: number;
  /** 期望的章节数。 */
  expectedChapterCount: number;
}
