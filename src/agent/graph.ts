/**
 * @file graph.ts
 * @description 对话式控制 Agent 的 LangGraph.js 图。用 prebuilt `createReactAgent` 把
 * {@link createChatModel} 返回的模型与 {@link agentTools} 组成「LLM ↔ 工具」循环，
 * 用 {@link LimitedMemorySaver} 维持多轮对话状态（按 `thread_id` 隔离会话）。
 *
 * 单例懒加载（仿 {@link JobManager}）：首次访问时才构造模型，避免在 `AGENT_ENABLED=false`
 * 或缺 key 的环境下于模块加载期就报错。
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
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
 * 带容量限制的进程内 Checkpointer。
 */
class LimitedMemorySaver extends MemorySaver {
  /** 按 LRU 顺序排列的活跃 threadId（队尾为最近访问） */
  private readonly threadOrder: string[] = [];

  constructor(private readonly maxThreads = 20) {
    super();
  }

  override async put(
    cfg: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = cfg.configurable?.thread_id as string | undefined;

    if (threadId) {
      this.touchThread(threadId);
    }

    return super.put(cfg, checkpoint, metadata);
  }

  /** 更新 LRU 队列；若超出容量则淘汰并清理最老的 Thread。 */
  private touchThread(threadId: string): void {
    const idx = this.threadOrder.indexOf(threadId);
    if (idx !== -1) this.threadOrder.splice(idx, 1);
    this.threadOrder.push(threadId);

    if (this.threadOrder.length > this.maxThreads) {
      const evicted = this.threadOrder.shift()!;
      void this.deleteThread(evicted).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[LimitedMemorySaver] deleteThread(${evicted}) failed:`, err);
      });
    }
  }
}

/**
 * 进程内 Checkpointer（重启即丢失）。
 * 限制最多 20 个活跃会话。
 */
const checkpointer = new LimitedMemorySaver(20);
const MAX_MESSAGES = 10;

/**
 * 安全修剪消息历史，避免切断 ToolCall 与 ToolMessage
 */
function pruneMessages(messages: BaseMessage[], maxMsgs: number): BaseMessage[] {
  if (messages.length <= maxMsgs) return messages;

  let sliceIdx = messages.length - maxMsgs;

  // 往前回溯，直到避开连续的 tool messages
  while (sliceIdx > 0 && messages[sliceIdx]._getType() === 'tool') {
    sliceIdx--;
  }

  return messages.slice(sliceIdx);
}

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
      // 使用 stateModifier 安全过滤历史并注入系统提示
      stateModifier: (state: { messages: BaseMessage[] }) => {
        const pruned = pruneMessages(state.messages, MAX_MESSAGES);
        return [new SystemMessage(SYSTEM_PROMPT), ...pruned];
      },
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
