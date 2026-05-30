/**
 * @file disk.ts
 * @description 磁盘可用空间预检。在允许任务运行前估算峰值占用并比对剩余空间，
 * 防止生成大型有声书时写满磁盘导致写入失败、服务崩溃。
 */

import { promises as fs } from 'node:fs';

/**
 * 单分片峰值占用估算系数（字节）。
 *
 * 经验值：每个分片在"MP3 与 M4A 并存、尚未删除 MP3"的时刻占用约 1.9MB。
 * 这是流水线中的瞬时峰值（转码完成即删 MP3），按它估算最坏情况。
 */
const PER_CHUNK_PEAK_BYTES = 1.9 * 1024 * 1024;

/**
 * 安全余量系数。要求可用空间不低于估算峰值的 1.2 倍，预留 20% 缓冲，
 * 吸收估算误差与 state.json / 最终 M4B 等额外开销。
 */
const SAFETY_FACTOR = 1.2;

/**
 * 校验目标目录所在文件系统的可用空间是否足以容纳预估峰值。
 *
 * @param dir 目标目录（任务工作目录或其根 `TMP_ROOT`）
 * @param totalChunks 任务的分片总数
 * @returns 可用空间 ≥ 峰值 × 安全余量 时返回 `true`，否则 `false`
 */
export async function verifyDiskSpace(dir: string, totalChunks: number): Promise<boolean> {
  const expectedPeakBytes = totalChunks * PER_CHUNK_PEAK_BYTES;
  const stats = await fs.statfs(dir);

  // bavail：非特权用户可用的块数；bsize：块大小（字节）。两者相乘即真实可写字节数。
  const availableBytes = stats.bavail * stats.bsize;
  return availableBytes >= expectedPeakBytes * SAFETY_FACTOR;
}
