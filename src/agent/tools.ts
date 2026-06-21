/**
 * @file tools.ts
 * @description Agent 可调用的工具集。每个工具是对 {@link JobManager} 既有公共方法的薄包装，
 * 不引入新的业务逻辑：只负责「裁剪入参 schema」与「把结果精简成小 JSON」，避免把庞大的
 * 任务对象（含逐分片状态）塞回模型上下文。
 *
 * MVP 仅暴露只读 / 控制类工具（查询、取消、恢复）。「从原始文本创建任务」需要服务端文本切分能力
 * （现切分在前端），列为下一步，见计划文档「已知边界」。
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { JobManager } from '../services/job-manager.js';
import type { JobInfo } from '../types/job.js';

/** 把对外的 {@link JobInfo} 裁剪为模型够用的精简视图，剔除引擎/音色等与对话无关的细节。 */
function summarizeJobInfo(info: JobInfo): Record<string, unknown> {
  return {
    jobId: info.jobId,
    status: info.status,
    phase: info.progress.phase,
    ttsChunks: info.progress.ttsChunks,
    transcodeChunks: info.progress.transcodeChunks,
    title: info.title,
    downloadUrl: info.downloadUrl,
    error: info.error,
  };
}

const jobIdSchema = z.object({
  jobId: z.string().describe('任务唯一标识（UUID）'),
});

const listJobsTool = tool(
  async () => {
    const jobs = await JobManager.getInstance().listJobs();
    return JSON.stringify(jobs);
  },
  {
    name: 'list_jobs',
    description: '列出当前所有有声书任务的概览（jobId、状态、阶段、书名、是否已上传等）。',
    schema: z.object({}),
  },
);

const getJobStatusTool = tool(
  async ({ jobId }) => {
    const info = JobManager.getInstance().getJob(jobId);
    if (!info) {
      return JSON.stringify({ error: 'not_found', jobId });
    }
    return JSON.stringify(summarizeJobInfo(info));
  },
  {
    name: 'get_job_status',
    description:
      '查询单个任务的详细状态与进度（TTS / 转码两条流水线的 done/total、下载地址、错误）。',
    schema: jobIdSchema,
  },
);

const cancelJobTool = tool(
  async ({ jobId }) => {
    const ok = JobManager.getInstance().cancelJob(jobId);
    return JSON.stringify({ jobId, canceled: ok });
  },
  {
    name: 'cancel_job',
    description: '取消一个正在进行或排队中的任务。已处于终态的任务无法取消。',
    schema: jobIdSchema,
  },
);

const resumeJobTool = tool(
  async ({ jobId }) => {
    const result = JobManager.getInstance().resumeJob(jobId);
    return JSON.stringify({ jobId, result });
  },
  {
    name: 'resume_job',
    description:
      '恢复一个此前失败 / 中断的任务，从断点（已完成的分片）继续。任务不存在或状态不允许时返回相应原因。',
    schema: jobIdSchema,
  },
);

/** Agent 可用的全部工具，按注册顺序提供给图。 */
export const agentTools = [listJobsTool, getJobStatusTool, cancelJobTool, resumeJobTool];
