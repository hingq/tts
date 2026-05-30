/**
 * @file gc.test.ts
 * @description runGarbageCollection 的离线单元测试。在临时 TMP_ROOT 下构造各状态工作目录，
 * 验证回收 / 保留判定正确。通过 mock config.TMP_ROOT 指向临时目录。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;

// 把 config.TMP_ROOT 指向每个用例独立的临时目录
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    ...actual,
    get config() {
      return { ...actual.config, TMP_ROOT: process.env.__GC_TEST_ROOT__ };
    },
  };
});

import { runGarbageCollection } from '../../src/services/gc.js';
import type { JobState, JobStatus } from '../../src/types/job.js';

const HOUR = 60 * 60 * 1000;

async function makeJobDir(
  name: string,
  status: JobStatus,
  opts: { createdAt?: string; updatedAt?: string; downloaded?: boolean } = {},
): Promise<string> {
  const jobDir = path.join(root, name);
  await fs.mkdir(jobDir, { recursive: true });
  const state: Partial<JobState> = {
    jobId: name,
    title: 't',
    status,
    phase: 'ready',
    createdAt: opts.createdAt ?? new Date().toISOString(),
    updatedAt: opts.updatedAt ?? new Date().toISOString(),
  };
  await fs.writeFile(path.join(jobDir, 'state.json'), JSON.stringify(state), 'utf-8');
  if (opts.downloaded) await fs.writeFile(path.join(jobDir, '.downloaded'), '', 'utf-8');
  return jobDir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-test-'));
  process.env.__GC_TEST_ROOT__ = root;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.__GC_TEST_ROOT__;
});

describe('runGarbageCollection', () => {
  it('回收已下载的 done 目录', async () => {
    const dir = await makeJobDir('a', 'done', { downloaded: true });
    const removed = await runGarbageCollection();
    expect(removed).toContain(dir);
    await expect(fs.access(dir)).rejects.toBeTruthy();
  });

  it('回收创建超过 1 小时的 done 目录（即便未下载）', async () => {
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    const dir = await makeJobDir('b', 'done', { createdAt: old });
    const removed = await runGarbageCollection();
    expect(removed).toContain(dir);
  });

  it('保留新创建且未下载的 done 目录', async () => {
    const dir = await makeJobDir('c', 'done', {});
    const removed = await runGarbageCollection();
    expect(removed).not.toContain(dir);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('回收 updatedAt 超过 2 小时的 failed 目录', async () => {
    const old = new Date(Date.now() - 3 * HOUR).toISOString();
    const dir = await makeJobDir('d', 'failed', { updatedAt: old });
    const removed = await runGarbageCollection();
    expect(removed).toContain(dir);
  });

  it('保留 updatedAt 在 2 小时内的 canceled 目录', async () => {
    const dir = await makeJobDir('e', 'canceled', {});
    const removed = await runGarbageCollection();
    expect(removed).not.toContain(dir);
  });

  it('保留 running 目录', async () => {
    const dir = await makeJobDir('f', 'running', {
      createdAt: new Date(Date.now() - 5 * HOUR).toISOString(),
    });
    const removed = await runGarbageCollection();
    expect(removed).not.toContain(dir);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });
});
