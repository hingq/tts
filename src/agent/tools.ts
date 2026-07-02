/**
 * @file tools.ts
 * @description Agent 可调用的工具集。使用 TypeBox 定义 Schema 并适配 pi-agent-core 的 AgentTool。
 */

import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { JobManager } from '../services/job-manager.js';
import type { JobInfo } from '../types/job.js';

/** 把对外的 JobInfo 裁剪为模型够用的精简视图 */
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

const jobIdSchema = Type.Object({
  jobId: Type.String({ description: '任务唯一标识（UUID）' }),
});

const listJobsTool: AgentTool = {
  name: 'list_jobs',
  label: 'List Jobs',
  description: '列出当前所有有声书任务的概览（jobId、状态、阶段、书名、是否已上传等）。',
  parameters: Type.Object({}),
  execute: async () => {
    const jobs = await JobManager.getInstance().listJobs();
    return {
      content: [{ type: 'text', text: JSON.stringify(jobs) }],
      details: {},
    };
  },
};

const getJobStatusTool: AgentTool = {
  name: 'get_job_status',
  label: 'Get Job Status',
  description:
    '查询单个任务的详细状态与进度（TTS / 转码两条流水线的 done/total、下载地址、错误）。',
  parameters: jobIdSchema,
  execute: async (toolCallId, params) => {
    const { jobId } = params as { jobId: string };
    const info = JobManager.getInstance().getJob(jobId);
    if (!info) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', jobId }) }],
        details: {},
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(summarizeJobInfo(info)) }],
      details: {},
    };
  },
};

const cancelJobTool: AgentTool = {
  name: 'cancel_job',
  label: 'Cancel Job',
  description: '取消一个正在进行或排队中的任务。已处于终态的任务无法取消。',
  parameters: jobIdSchema,
  execute: async (toolCallId, params) => {
    const { jobId } = params as { jobId: string };
    const ok = JobManager.getInstance().cancelJob(jobId);
    return {
      content: [{ type: 'text', text: JSON.stringify({ jobId, canceled: ok }) }],
      details: {},
    };
  },
};

const resumeJobTool: AgentTool = {
  name: 'resume_job',
  label: 'Resume Job',
  description:
    '恢复一个此前失败 / 中断的任务，从断点（已完成的分片）继续。任务不存在或状态不允许时返回相应原因。',
  parameters: jobIdSchema,
  execute: async (toolCallId, params) => {
    const { jobId } = params as { jobId: string };
    const result = JobManager.getInstance().resumeJob(jobId);
    return {
      content: [{ type: 'text', text: JSON.stringify({ jobId, result }) }],
      details: {},
    };
  },
};

/** Agent 可用的全部工具 */
export const agentTools = [listJobsTool, getJobStatusTool, cancelJobTool, resumeJobTool];
