/**
 * @file tools.test.ts
 * @description Agent 工具集的离线单元测试：spy 单例 JobManager 的公共方法，验证每个工具的
 * 入参 schema、对 JobManager 的转发、以及对结果的精简裁剪。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobManager } from '../../src/services/job-manager.js';
import { agentTools } from '../../src/agent/tools.js';
import type { JobInfo } from '../../src/types/job.js';

function getTool(name: string) {
  const t = agentTools.find((tool) => tool.name === name);
  if (!t) throw new Error(`未找到工具 ${name}`);
  return t;
}

async function invokeTool(name: string, args: any) {
  const t = getTool(name);
  const result = await t.execute('test-call-id', args, new AbortController().signal, undefined);
  if (!result || !result.content || result.content.length === 0) {
    throw new Error('Tool returned no content');
  }
  const textContent = (result.content.find((c: any) => c.type === 'text') as any)?.text;
  return textContent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent tools', () => {
  it('list_jobs 透传 JobManager.listJobs 结果', async () => {
    const fake = [{ jobId: 'a', status: 'running', title: '书' }];
    vi.spyOn(JobManager.getInstance(), 'listJobs').mockResolvedValue(fake as never);
    const out = await invokeTool('list_jobs', {});
    expect(JSON.parse(out)).toEqual(fake);
  });

  it('get_job_status 裁剪 JobInfo，剔除引擎/音色细节', async () => {
    const info: JobInfo = {
      jobId: 'a',
      status: 'running',
      progress: {
        phase: 'tts',
        ttsChunks: { done: 1, total: 3 },
        transcodeChunks: { done: 0, total: 3 },
      },
      downloadUrl: null,
      error: null,
      startedAt: '2026-06-20T00:00:00.000Z',
      finishedAt: null,
      title: '书',
      ttsEngine: 'mimo-tts',
      voice: '苏打',
      rate: '+0%',
      pitch: '+0Hz',
      bitrate: '64k',
    };
    vi.spyOn(JobManager.getInstance(), 'getJob').mockReturnValue(info);
    const out = JSON.parse(await invokeTool('get_job_status', { jobId: 'a' }));
    expect(out).toEqual({
      jobId: 'a',
      status: 'running',
      phase: 'tts',
      ttsChunks: { done: 1, total: 3 },
      transcodeChunks: { done: 0, total: 3 },
      title: '书',
      downloadUrl: null,
      error: null,
    });
    expect(out.voice).toBeUndefined();
    expect(out.ttsEngine).toBeUndefined();
  });

  it('get_job_status 任务不存在返回 not_found', async () => {
    vi.spyOn(JobManager.getInstance(), 'getJob').mockReturnValue(undefined);
    const out = JSON.parse(await invokeTool('get_job_status', { jobId: 'x' }));
    expect(out).toEqual({ error: 'not_found', jobId: 'x' });
  });

  it('cancel_job 透传布尔结果', async () => {
    vi.spyOn(JobManager.getInstance(), 'cancelJob').mockReturnValue(true);
    const out = JSON.parse(await invokeTool('cancel_job', { jobId: 'a' }));
    expect(out).toEqual({ jobId: 'a', canceled: true });
  });

  it('resume_job 透传枚举结果', async () => {
    vi.spyOn(JobManager.getInstance(), 'resumeJob').mockReturnValue('invalid_state');
    const out = JSON.parse(await invokeTool('resume_job', { jobId: 'a' }));
    expect(out).toEqual({ jobId: 'a', result: 'invalid_state' });
  });
});
