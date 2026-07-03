/**
 * @file agent.ts
 * @description 结合 pi-agent-core 的 Agent 实现，带有基于 LRU 缓存的多轮对话支持。
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { getChatModel } from './model.js';
import { agentTools } from './tools.js';
import { config } from '../config.js';

const SYSTEM_PROMPT = [
  '你是「有声书任务助手」，帮助用户查询和管理文本转有声书的后台任务。',
  '你可以调用以下工具：',
  '- list_jobs：列出全部任务概览；',
  '- get_job_status：查询单个任务的详细进度；',
  '- cancel_job：取消进行中的任务；',
  '- resume_job：恢复失败/中断的任务。',
  '准则：需要实时数据时务必调用工具，不要凭空编造任务状态；',
  '用户未提供 jobId 时，先用 list_jobs 帮其确认；用简洁的中文回答。',
  '你只负责任务的查询与管理，不处理与有声书无关的请求。',
].join('\n');

/** 基于 Map 结合数组实现的简单 LRU 缓存，最多保留一定数量的 Agent 实例 */
class AgentCache {
  private readonly agents = new Map<string, Agent>();
  private readonly threadOrder: string[] = [];

  constructor(private readonly maxThreads = 20) {}

  getOrCreate(threadId: string): Agent {
    let agent = this.agents.get(threadId);
    if (!agent) {
      agent = new Agent({
        getApiKey: async (providerId) => {
          // 强制使用系统配置中的 API Key，不依赖进程环境变量
          if (providerId === config.AGENT_LLM_PROVIDER.toLowerCase()) {
            return { auth: { apiKey: config.AGENT_LLM_API_KEY } } as any;
          }
          return undefined;
        },
        initialState: {
          systemPrompt: SYSTEM_PROMPT,
          model: getChatModel(),
          tools: agentTools,
          messages: [],
          thinkingLevel: 'off',
        },
      });
      this.agents.set(threadId, agent);
      this.threadOrder.push(threadId);

      // 淘汰最早的会话
      if (this.threadOrder.length > this.maxThreads) {
        const evicted = this.threadOrder.shift()!;
        this.agents.delete(evicted);
      }
    } else {
      // 触碰，移到队尾
      const idx = this.threadOrder.indexOf(threadId);
      if (idx !== -1) {
        this.threadOrder.splice(idx, 1);
        this.threadOrder.push(threadId);
      }
    }
    return agent;
  }
}

const cache = new AgentCache(20);

/**
 * 获取或懒加载对应会话的 Agent 实例。
 */
export function getAgent(threadId: string): Agent {
  return cache.getOrCreate(threadId);
}
