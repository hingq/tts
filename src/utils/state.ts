/**
 * @file state.ts
 * @description 任务状态 `state.json` 的原子化读写工具。
 *
 * 设计要点：状态是崩溃恢复的唯一可靠来源，因此写入必须杜绝"半写文件"。
 * 采用"临时文件写 + 原子重命名"策略：先把完整内容写入 `state.json.tmp`，
 * 再用 `fs.rename` 原子替换为 `state.json`。`rename` 在同一文件系统上是原子操作，
 * 任何时刻读到的 `state.json` 要么是旧的完整内容、要么是新的完整内容，绝不会是半写的损坏 JSON。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JobState } from '../types/job.js';

/** 工作目录下状态文件的固定名称。 */
const STATE_FILENAME = 'state.json';

/**
 * 原子化持久化任务状态。
 *
 * 步骤：
 * 1. 刷新 `updatedAt` 为当前 ISO 时间（每次落盘都更新，便于 GC 据此判断超期）。
 * 2. 序列化为带缩进的 JSON 写入临时文件 `state.json.tmp`。
 * 3. `fs.rename` 原子替换为 `state.json`——若第 2 步中途崩溃，损坏内容至多停留在 `.tmp`，
 *    既有 `state.json` 保持完整。
 *
 * @param jobDir 任务工作目录的绝对路径
 * @param state 待持久化的任务状态（其 `updatedAt` 会被原地刷新）
 */
export async function saveJobState(jobDir: string, state: JobState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const filePath = path.join(jobDir, STATE_FILENAME);
  const tmpPath = `${filePath}.tmp`;

  // 先写临时文件——失败或崩溃不会污染既有的 state.json
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  // 原子替换：rename 同盘原子，杜绝半写损坏
  await fs.rename(tmpPath, filePath);
}

/**
 * 读取并解析任务状态。供重启恢复扫描使用，因此对损坏 / 缺失文件做容错。
 *
 * @param jobDir 任务工作目录的绝对路径
 * @returns 解析成功返回 {@link JobState}；文件缺失或 JSON 解析失败返回 `null`（由调用方跳过该目录）
 */
export async function loadJobState(jobDir: string): Promise<JobState | null> {
  const filePath = path.join(jobDir, STATE_FILENAME);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as JobState;
  } catch {
    // 文件不存在、读取失败或 JSON 损坏：恢复扫描应跳过该目录而非整体失败
    return null;
  }
}
