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

const writeQueues = new Map<string, Promise<void>>();

/**
 * 原子化持久化任务状态。
 *
 * 采用队列化串行写入以解决高并发时产生的临时文件竞态冲突问题。
 *
 * @param jobDir 任务工作目录的绝对路径
 * @param state 待持久化的任务状态（其 `updatedAt` 会被原地刷新）
 */
export function saveJobState(jobDir: string, state: JobState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const filePath = path.join(jobDir, STATE_FILENAME);
  const tmpPath = `${filePath}.tmp`;

  const currentQueue = writeQueues.get(jobDir) || Promise.resolve();
  const nextQueue = currentQueue.then(async () => {
    try {
      await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // 这里的错误需要继续往上抛，以便外部调用方感知写入失败
      throw err;
    }
  });

  writeQueues.set(jobDir, nextQueue);

  // 执行完毕后清理 Map 键值，避免内存泄漏
  nextQueue.finally(() => {
    if (writeQueues.get(jobDir) === nextQueue) {
      writeQueues.delete(jobDir);
    }
  });

  return nextQueue;
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
