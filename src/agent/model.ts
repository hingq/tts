/**
 * @file model.ts
 * @description Agent 的「模型无关」工厂，返回 pi-ai 对应的模型实例。
 */

import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Model } from '@earendil-works/pi-ai';
import { config } from '../config.js';

export const models = builtinModels();

/**
 * 获取 pi-ai 支持的模型实例。
 */
export function getChatModel(): Model<any> {
  if (!config.DEEPSEEK_API_KEY) {
    throw new Error('AGENT_LLM_API_KEY 未配置，无法初始化 Agent 模型');
  }
  if (!config.DEEPSEEK_MODEL) {
    throw new Error('AGENT_LLM_MODEL 未配置，无法初始化 Agent 模型');
  }

  const providerId = config.AGENT_LLM_PROVIDER.toLowerCase();

  // 对于支持 fallback 机制的自建模型或者 openai 兼容接口：
  // 如果是 deepseek 且我们要强制走它的端点，由于 pi-ai 自带了 deepseek provider，我们可以直接用
  const model = models.getModel(providerId, config.AGENT_LLM_MODEL);

  if (!model) {
    throw new Error(`在 ${providerId} 提供商中找不到模型 ${config.AGENT_LLM_MODEL}`);
  }

  return model;
}

export function getApiKeyForProvider(providerId: string): string | undefined {
  if (providerId === config.AGENT_LLM_PROVIDER.toLowerCase()) {
    return config.AGENT_LLM_API_KEY;
  }
  return undefined;
}
