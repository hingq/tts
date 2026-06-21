/**
 * @file model.ts
 * @description Agent 的「模型无关」工厂。仿照 {@link ../providers/edge-tts} 的 Provider 工厂模式
 * （见 `job-pipeline.ts` 的 `getProvider`），按 {@link config} 返回一个 LangChain `BaseChatModel`。
 *
 * 目前支持两类适配器：
 * - `anthropic`：Claude 原生（`@langchain/anthropic`）。
 * - `openai`：一切 OpenAI 兼容端点（`@langchain/openai`），通过 `AGENT_LLM_BASE_URL` 覆盖基址，
 *   故小米 MiMo 等兼容服务也走这一支。
 *
 * 未来接入新厂商只需在此 switch 增加分支，图与路由层无需改动。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { config } from '../config.js';

/**
 * 依据全局配置构造一个支持工具调用的对话模型。
 *
 * @returns 已配置好的 `BaseChatModel` 实例（启用流式，供 SSE 逐 token 推送）。
 * @throws 当 `AGENT_LLM_API_KEY` 缺失或 `AGENT_LLM_PROVIDER` 不受支持时抛出，便于启动期快速定位配置问题。
 */
export function createChatModel(): BaseChatModel {
  if (!config.AGENT_LLM_API_KEY) {
    throw new Error('AGENT_LLM_API_KEY 未配置，无法初始化 Agent 模型');
  }

  const provider = config.AGENT_LLM_PROVIDER.toLowerCase();
  switch (provider) {
    case 'anthropic':
      return new ChatAnthropic({
        model: config.AGENT_LLM_MODEL,
        apiKey: config.AGENT_LLM_API_KEY,
        streaming: true,
      });
    case 'openai':
      return new ChatOpenAI({
        model: config.AGENT_LLM_MODEL,
        apiKey: config.AGENT_LLM_API_KEY,
        streaming: true,
        // 覆盖基址以适配 MiMo 等 OpenAI 兼容端点；留空则用官方默认。
        configuration: config.AGENT_LLM_BASE_URL
          ? { baseURL: config.AGENT_LLM_BASE_URL }
          : undefined,
      });
    default:
      throw new Error(`不支持的 AGENT_LLM_PROVIDER: ${config.AGENT_LLM_PROVIDER}`);
  }
}
