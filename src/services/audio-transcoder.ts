/**
 * @file audio-transcoder.ts
 * @description 有声书音频转码服务。提供安全的子进程执行、音频段标准化转码、时长提取、
 * 章节元数据生成、最终混合（Mux）、完整性验证及临时文件清理等全链路功能。
 *
 * 安全设计要点：
 * - 所有外部命令均通过 `child_process.spawn`（`shell: false`）直接调用，
 *   杜绝 shell 注入风险。
 * - 子进程附加 timeout + SIGKILL 兜底，防止挂起导致资源泄漏。
 * - 写入 ffmeta / filelist 时对用户可控字符串做转义处理。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import type {
  CommandResult,
  TranscodeOptions,
  AudiobookMetadata,
  MuxOptions,
  ValidationResult,
} from '../types/audio-transcoder.js';
import { DEFAULT_TRANSCODE_OPTIONS } from '../types/audio-transcoder.js';

// ─── 1. 安全子进程执行 ────────────────────────────────────────────

/**
 * 以安全方式异步执行外部命令。
 *
 * 使用 `child_process.spawn`（`shell: false`）直接调用可执行文件，
 * 所有参数作为数组传入 OS 内核，避免 shell 元字符注入。
 * 超时后先发 `SIGTERM`，再以 `SIGKILL` 强制终止。
 *
 * @param command 可执行文件路径（如 `ffmpeg`、`ffprobe`）
 * @param args 参数数组
 * @param timeoutMs 超时毫秒数，默认取 `config.SUBPROCESS_TIMEOUT_MS`
 * @returns 标准输出 / 标准错误 / 退出码
 * @throws 超时 / 异常退出时抛出 Error
 */
export function runCommandAsync(
  command: string,
  args: string[],
  timeoutMs: number = config.SUBPROCESS_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // 超时守卫：先 SIGTERM，100ms 后 SIGKILL 兜底
    const timer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn(`[subprocess] 超时 ${timeoutMs}ms，SIGKILL 终止：${command} ${args.join(' ')}`);
      child.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const exitCode = code ?? 1;

      if (exitCode !== 0) {
        const errorMsg = `Command failed with exit code ${exitCode}: ${command} ${args.join(' ')}\nstderr: ${stderr}`;
        // eslint-disable-next-line no-console
        console.error(
          `[subprocess] 退出码 ${exitCode}：${command} ${args.join(' ')}\nstderr: ${stderr.slice(-500)}`,
        );
        reject(new Error(errorMsg));
        return;
      }

      resolve({ exitCode, stdout, stderr });
    });
  });
}

// ─── 1.3 启动时二进制可用性校验 ──────────────────────────────────

/**
 * 校验 `ffmpeg` 和 `ffprobe` 是否可用。
 * 通过执行 `<binary> -version` 检查返回码；失败时抛出明确的启动阻断错误。
 */
export async function validateFfmpegBinaries(): Promise<void> {
  for (const bin of [config.FFMPEG_PATH, config.FFPROBE_PATH]) {
    try {
      await runCommandAsync(bin, ['-version'], 10_000);
    } catch (err) {
      throw new Error(
        `FFmpeg binary not accessible: ${bin}. Ensure it is installed and in PATH. Original error: ${(err as Error).message}`,
      );
    }
  }
}

// ─── 2.1 音频段标准化转码 ────────────────────────────────────────

/**
 * 将单个原始音频段转码为标准化 M4A（AAC）文件。
 *
 * @param inputPath 原始音频段文件路径
 * @param outputPath 输出 M4A 文件路径
 * @param options 编码参数（默认 AAC-LC 64k 24kHz mono）
 */
export async function transcodeSegment(
  inputPath: string,
  outputPath: string,
  options: TranscodeOptions = DEFAULT_TRANSCODE_OPTIONS,
): Promise<CommandResult> {
  const args = [
    '-y',
    '-i',
    inputPath,
    '-c:a',
    options.codec,
    '-profile:a',
    options.profile,
    '-b:a',
    options.bitrate,
    '-ar',
    String(options.sampleRate),
    '-ac',
    String(options.channels),
    '-movflags',
    '+faststart',
    outputPath,
  ];
  return runCommandAsync(config.FFMPEG_PATH, args);
}

// ─── 2.2 时长提取 ────────────────────────────────────────────────

/**
 * 使用 `ffprobe` 提取单个音频段的精确时长（毫秒）。
 *
 * @param filePath 音频文件路径
 * @returns 时长（毫秒），四舍五入到整数
 */
export async function extractDurationMs(filePath: string): Promise<number> {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ];
  const result = await runCommandAsync(config.FFPROBE_PATH, args, 15_000);
  const durationSec = parseFloat(result.stdout.trim());
  if (isNaN(durationSec)) {
    throw new Error(
      `Failed to parse duration from ffprobe output: "${result.stdout.trim()}" for file ${filePath}`,
    );
  }
  return Math.round(durationSec * 1000);
}

// ─── 3.1 FFMETADATA1 章节元数据生成 ─────────────────────────────

/**
 * 转义 FFMETADATA1 格式中的特殊字符（`\`, `=`, `;`, `#`）。
 * 防止用户可控的书名/作者/章节名破坏元数据结构。
 *
 * @param value 原始字符串
 * @returns 转义后的安全字符串
 */
export function escapeMetadataValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/;/g, '\\;')
    .replace(/#/g, '\\#');
}

/**
 * 生成 FFMETADATA1 格式的章节元数据文件。
 *
 * 时间基准为毫秒（`TIMEBASE=1/1000`），每个章节的 START/END 由累积时长计算。
 *
 * @param metadata 完整的有声书元数据
 * @param outputPath 输出 `.ffmeta` 文件路径
 */
export async function writeChaptersMetadata(
  metadata: AudiobookMetadata,
  outputPath: string,
): Promise<void> {
  const lines: string[] = [
    ';FFMETADATA1',
    `title=${escapeMetadataValue(metadata.title)}`,
    `artist=${escapeMetadataValue(metadata.artist)}`,
    `genre=Audiobook`,
    '',
  ];

  let currentMs = 0;
  for (const chapter of metadata.chapters) {
    const startMs = currentMs;
    const endMs = currentMs + chapter.durationMs;
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${startMs}`);
    lines.push(`END=${endMs}`);
    lines.push(`title=${escapeMetadataValue(chapter.title)}`);
    lines.push('');
    currentMs = endMs;
  }

  await fs.promises.writeFile(outputPath, lines.join('\n'), 'utf-8');
}

// ─── 3.2 concat demuxer 文件列表 ─────────────────────────────────

/**
 * 转义 FFmpeg concat demuxer `filelist.txt` 中的文件路径。
 * 单引号路径格式：将路径内的单引号替换为 `'\''`。
 *
 * @param filePath 原始文件路径
 * @returns 转义后可安全写入 filelist.txt 的路径
 */
export function escapeFilelistPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

/**
 * 写入 FFmpeg concat demuxer 所需的 `filelist.txt`。
 *
 * @param chunkPaths 有序的音频段文件路径列表
 * @param outputPath 输出 filelist.txt 路径
 */
export async function writeFileList(chunkPaths: string[], outputPath: string): Promise<void> {
  const lines = chunkPaths.map((p) => `file '${escapeFilelistPath(p)}'`);
  await fs.promises.writeFile(outputPath, lines.join('\n'), 'utf-8');
}

// ─── 3.3 最终混合（Mux） ────────────────────────────────────────

/**
 * 将多个标准化 M4A 音频段合并为单个 M4B 文件，注入章节元数据和可选封面图片。
 *
 * @param options 混合参数（段列表、元数据路径、输出路径、可选封面）
 * @returns ffmpeg 执行结果
 */
export async function muxAudiobook(options: MuxOptions): Promise<CommandResult> {
  // 生成临时 filelist
  const filelistPath = path.join(path.dirname(options.outputPath), 'filelist.txt');
  await writeFileList(options.chunkPaths, filelistPath);

  const args: string[] = [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    filelistPath,
    '-i',
    options.metadataPath,
  ];

  if (options.coverImagePath) {
    args.push('-i', options.coverImagePath);
  }

  // 映射流：音频（复制）+ 元数据
  args.push('-map', '0:a');
  args.push('-c:a', 'copy');
  args.push('-map_metadata', '1');

  if (options.coverImagePath) {
    // 将封面映射为附加图片视频流
    args.push('-map', '2:v');
    args.push('-c:v', 'copy');
    args.push('-disposition:v:0', 'attached_pic');
  }

  args.push('-movflags', '+faststart');
  args.push(options.outputPath);

  return runCommandAsync(config.FFMPEG_PATH, args);
}

// ─── 4.1 M4B 完整性验证 ─────────────────────────────────────────

/**
 * 使用 `ffprobe` 验证 M4B 文件的容器格式并检查章节数量。
 *
 * @param filePath M4B 文件路径
 * @param expectedChapterCount 期望的章节数
 * @returns 验证结果
 */
export async function validateM4bFile(
  filePath: string,
  expectedChapterCount: number,
): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: false,
    formatValid: false,
    chapterCountMatch: false,
    faststartValid: false,
    actualChapterCount: 0,
    expectedChapterCount,
  };

  // 1) 验证容器格式
  try {
    const formatArgs = [
      '-v',
      'error',
      '-show_entries',
      'format=format_name',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ];
    const formatResult = await runCommandAsync(config.FFPROBE_PATH, formatArgs, 15_000);
    const formatName = formatResult.stdout.trim();
    result.formatValid =
      formatName.includes('mp4') || formatName.includes('m4a') || formatName.includes('mov');
  } catch {
    result.formatValid = false;
  }

  // 2) 验证章节数量
  try {
    const chapterArgs = ['-v', 'error', '-show_chapters', '-of', 'json', filePath];
    const chapterResult = await runCommandAsync(config.FFPROBE_PATH, chapterArgs, 15_000);
    const parsed = JSON.parse(chapterResult.stdout);
    result.actualChapterCount = Array.isArray(parsed.chapters) ? parsed.chapters.length : 0;
    result.chapterCountMatch = result.actualChapterCount === expectedChapterCount;
  } catch {
    result.chapterCountMatch = false;
  }

  // 3) 验证 faststart（moov atom 位置）
  result.faststartValid = await validateFaststart(filePath);

  result.valid = result.formatValid && result.chapterCountMatch && result.faststartValid;
  return result;
}

// ─── 4.2 moov faststart atom 验证 ──────────────────────────────

/**
 * 读取文件前 128KB 并检查 `moov` atom 是否出现在 `mdat` atom 之前。
 *
 * MP4 容器的 box 结构中，每个 box 的第 4–7 字节是 ASCII 类型标识（如 `moov`、`mdat`）。
 * 对于 faststart 优化文件，`moov` 应在文件头部，位于 `mdat` 之前。
 *
 * @param filePath M4B/M4A 文件路径
 * @returns `true` 表示 moov 在 mdat 之前
 */
export async function validateFaststart(filePath: string): Promise<boolean> {
  const SCAN_SIZE = 128 * 1024; // 128KB
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const stat = await fd.stat();
    const readSize = Math.min(SCAN_SIZE, stat.size);
    const buffer = Buffer.alloc(readSize);
    await fd.read(buffer, 0, readSize, 0);

    const moovMarker = Buffer.from('moov', 'ascii');
    const mdatMarker = Buffer.from('mdat', 'ascii');

    const moovIndex = buffer.indexOf(moovMarker);
    const mdatIndex = buffer.indexOf(mdatMarker);

    if (moovIndex === -1) {
      // moov 不在前 128KB —— faststart 无效
      return false;
    }
    if (mdatIndex === -1) {
      // mdat 不在前 128KB 而 moov 在 —— moov 在前，通过
      return true;
    }
    return moovIndex < mdatIndex;
  } catch {
    return false;
  } finally {
    if (fd) {
      await fd.close();
    }
  }
}

// ─── 4.3 临时文件清理 ────────────────────────────────────────────

/**
 * 清理转码过程中产生的临时文件（标准化段、filelist.txt、chapters.ffmeta 等）。
 * 遇到单个文件删除失败时不阻断，仅静默跳过。
 *
 * @param filePaths 需要清理的文件路径列表
 */
export async function cleanupTempFiles(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // 文件不存在或删除失败 — 静默跳过
    }
  }
}
