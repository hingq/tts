/**
 * @file graph.ts
 * @description 对话式控制 Agent 的 LangGraph.js 图。用 prebuilt `createReactAgent` 把
 * {@link createChatModel} 返回的模型与 {@link agentTools} 组成「LLM ↔ 工具」循环，
 * 用 `MemorySaver` 维持多轮对话状态（按 `thread_id` 隔离会话）。
 *
 * 单例懒加载（仿 {@link JobManager}）：首次访问时才构造模型，避免在 `AGENT_ENABLED=false`
 * 或缺 key 的环境下于模块加载期就报错。
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph';
import { config } from '../config.js';
import { createChatModel } from './model.js';
import { agentTools } from './tools.js';

/** Agent 的系统提示：限定职责、列明工具、约束行为。 */
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

/**
 * MVP 用进程内 MemorySaver 维持会话状态：重启即丢失。
 * 后续可替换为基于 `utils/state.ts` 原子写模式的持久化 checkpointer，
 * 与现有 `state.json` 的崩溃恢复哲学保持一致。
 */
const checkpointer = new MemorySaver();

let agent: ReturnType<typeof createReactAgent> | undefined;

/**
 * 获取（并懒加载）单例 Agent 图。
 * @throws 当模型配置缺失时由 {@link createChatModel} 抛出。
 */
export function getAgent(): ReturnType<typeof createReactAgent> {
  if (!agent) {
    agent = createReactAgent({
      llm: createChatModel(),
      tools: agentTools,
      prompt: SYSTEM_PROMPT,
      checkpointer,
    });
  }
  return agent;
}

/**
 * 单轮工具调用循环的递归上限。每次「LLM 调用 + 工具执行」约消耗 2 步，
 * 故按 `AGENT_MAX_STEPS` 折算为 recursionLimit，留 1 步给收尾的最终回答。
 */
export const RECURSION_LIMIT = config.AGENT_MAX_STEPS * 2 + 1;
