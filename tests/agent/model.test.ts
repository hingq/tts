/**
 * @file model.test.ts
 * @description createChatModel 工厂的离线单元测试：按 config 选对适配器、缺 key / 非法 provider 抛错。
 * 通过临时改写可变的全局 config 对象切换场景，afterEach 恢复，避免污染其它用例。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { config } from '../../src/config.js';
import { createChatModel } from '../../src/agent/model.js';

const snapshot = {
  AGENT_LLM_PROVIDER: config.AGENT_LLM_PROVIDER,
  AGENT_LLM_API_KEY: config.AGENT_LLM_API_KEY,
  AGENT_LLM_MODEL: config.AGENT_LLM_MODEL,
  AGENT_LLM_BASE_URL: config.AGENT_LLM_BASE_URL,
};

afterEach(() => {
  Object.assign(config, snapshot);
});

describe('createChatModel', () => {
  it('缺 AGENT_LLM_API_KEY 时抛错', () => {
    config.AGENT_LLM_API_KEY = '';
    expect(() => createChatModel()).toThrow(/AGENT_LLM_API_KEY/);
  });

  it('provider=anthropic 返回 ChatAnthropic', () => {
    config.AGENT_LLM_API_KEY = 'sk-test';
    config.AGENT_LLM_PROVIDER = 'anthropic';
    config.AGENT_LLM_MODEL = 'claude-opus-4-8';
    expect(createChatModel()).toBeInstanceOf(ChatAnthropic);
  });

  it('provider=openai（含兼容端点 baseURL）返回 ChatOpenAI', () => {
    config.AGENT_LLM_API_KEY = 'sk-test';
    config.AGENT_LLM_PROVIDER = 'openai';
    config.AGENT_LLM_MODEL = 'gpt-4o';
    config.AGENT_LLM_BASE_URL = 'https://api.xiaomimimo.com/v1';
    expect(createChatModel()).toBeInstanceOf(ChatOpenAI);
  });

  it('provider 大小写不敏感', () => {
    config.AGENT_LLM_API_KEY = 'sk-test';
    config.AGENT_LLM_PROVIDER = 'Anthropic';
    expect(createChatModel()).toBeInstanceOf(ChatAnthropic);
  });

  it('不支持的 provider 抛错', () => {
    config.AGENT_LLM_API_KEY = 'sk-test';
    config.AGENT_LLM_PROVIDER = 'gemini';
    expect(() => createChatModel()).toThrow(/不支持/);
  });
});
