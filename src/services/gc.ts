/**
 * @file gc.ts
 * @description 临时工作目录的定时垃圾回收。防止 `done` / `failed` / `canceled` 任务的
 * 工作目录长期堆积撑满磁盘。每小时扫描一次 `TMP_ROOT`，按状态与时效删除过期目录，
 * 运行中（pending/running）任务的目录一律保留。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { loadJobState } from '../utils/state.js';

/** GC 扫描间隔：1 小时。 */
const GC_INTERVAL_MS = 60 * 60 * 1000;

/** `done` 任务即便未下载，创建超过该时长也回收：1 小时。 */
const DONE_MAX_AGE_MS = 60 * 60 * 1000;

/** `failed` / `canceled` 任务在最后更新后超过该时长回收：2 小时。 */
const FAILED_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** 下载完成标记文件名（由下载路由在完整下载后写入）。 */
const DOWNLOADED_MARKER = '.downloaded';

/**
 * 判定某工作目录是否应被回收。
 *
 * 标准：
 * - `done`：存在 `.downloaded` 标记（已成功下载）或创建时间已超过 1 小时。
 * - `failed` / `canceled`：`updatedAt` 距今已超过 2 小时。
 * - 其它（pending / running）：保留。
 *
 * @param jobDir 工作目录绝对路径
 * @param now 当前时间戳（epoch ms），便于测试注入
 * @returns 应删除返回 `true`
 */
async function shouldCollect(jobDir: string, now: number): Promise<boolean> {
  const state = await loadJobState(jobDir);
  // 无法解析状态：交由保守策略保留（避免误删正在写入的新任务目录）
  if (!state) return false;

  if (state.status === 'done') {
    const downloaded = await fs
      .access(path.join(jobDir, DOWNLOADED_MARKER))
      .then(() => true)
      .catch(() => false);
    if (downloaded) return true;
    return now - Date.parse(state.createdAt) > DONE_MAX_AGE_MS;
  }

  if (state.status === 'failed' || state.status === 'canceled') {
    return now - Date.parse(state.updatedAt) > FAILED_MAX_AGE_MS;
  }

  // pending / running：保留
  return false;
}

/**
 * 执行一次垃圾回收：遍历 `TMP_ROOT` 一级子目录，删除满足回收标准的工作目录。
 * 单个目录的删除失败不影响其余目录。
 *
 * @param now 当前时间戳（epoch ms），默认 `Date.now()`，测试可注入
 * @returns 实际被删除的工作目录绝对路径列表
 */
export async function runGarbageCollection(now: number = Date.now()): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(config.TMP_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(config.TMP_ROOT, entry.name);
    if (await shouldCollect(jobDir, now)) {
      try {
        await fs.rm(jobDir, { recursive: true, force: true });
        removed.push(jobDir);
      } catch {
        // 删除失败（如权限 / 占用）：跳过，下一轮再试
      }
    }
  }
  return removed;
}

/**
 * 启动定时垃圾回收器。每 {@link GC_INTERVAL_MS} 触发一次 {@link runGarbageCollection}。
 * 返回的句柄已 `unref`，不会阻止进程退出；调用方应在停机时 `clearInterval`。
 *
 * @returns 定时器句柄
 */
export function startGarbageCollector(): NodeJS.Timeout {
  const handle = setInterval(() => {
    void runGarbageCollection();
  }, GC_INTERVAL_MS);
  // 避免 GC 定时器把进程“吊住”，使优雅停机得以退出
  handle.unref();
  return handle;
}
