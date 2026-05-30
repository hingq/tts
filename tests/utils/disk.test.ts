/**
 * @file disk.test.ts
 * @description verifyDiskSpace 的离线单元测试。通过 mock fs.statfs 覆盖
 * 空间充足放行与空间不足拒绝两条分支。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { verifyDiskSpace } from '../../src/utils/disk.js';

const PER_CHUNK_PEAK_BYTES = 1.9 * 1024 * 1024;
const SAFETY_FACTOR = 1.2;

afterEach(() => {
  vi.restoreAllMocks();
});

/** 用给定的可用字节数 mock fs.statfs（拆成 bsize=1，bavail=可用字节）。 */
function mockAvailable(bytes: number): void {
  vi.spyOn(fs, 'statfs').mockResolvedValue({
    bsize: 1,
    bavail: bytes,
  } as unknown as Awaited<ReturnType<typeof fs.statfs>>);
}

describe('verifyDiskSpace', () => {
  it('空间充足时放行', async () => {
    const totalChunks = 100;
    const required = totalChunks * PER_CHUNK_PEAK_BYTES * SAFETY_FACTOR;
    mockAvailable(required + 1);
    expect(await verifyDiskSpace('/tmp', totalChunks)).toBe(true);
  });

  it('空间恰好等于阈值时放行', async () => {
    const totalChunks = 50;
    const required = totalChunks * PER_CHUNK_PEAK_BYTES * SAFETY_FACTOR;
    mockAvailable(required);
    expect(await verifyDiskSpace('/tmp', totalChunks)).toBe(true);
  });

  it('空间不足时拒绝', async () => {
    const totalChunks = 100;
    const required = totalChunks * PER_CHUNK_PEAK_BYTES * SAFETY_FACTOR;
    mockAvailable(required - 1);
    expect(await verifyDiskSpace('/tmp', totalChunks)).toBe(false);
  });
});
