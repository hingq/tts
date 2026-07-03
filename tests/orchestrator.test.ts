import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, parseEnv } from '../src/config.js';
import { LlmSegmentationClient } from '../src/orchestrator/orchestrator.js';

describe('DeepSeek segmentation client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('disables thinking mode in the request body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [
                    {
                      index: 0,
                      text: '测试文本',
                      speaker: 'narrator',
                      emotion: 'neutral',
                      speedModifier: 1,
                    },
                  ],
                  characters: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new LlmSegmentationClient({
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      api_key: 'test-key',
    });

    await expect(client.segment('测试文本')).resolves.not.toBeNull();

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('defaults the DeepSeek timeout to 300 seconds', () => {
    expect(parseEnv({}).DEEPSEEK_TIMEOUT_MS).toBe(300_000);
  });

  it('applies defaults to valid LLM output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [{ index: 0, text: '测试文本', speaker: 'narrator' }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new LlmSegmentationClient({
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      api_key: 'test-key',
    });

    await expect(client.segment('测试文本')).resolves.toEqual({
      segments: [
        {
          index: 0,
          text: '测试文本',
          speaker: 'narrator',
          emotion: 'neutral',
          speedModifier: 1,
        },
      ],
      characters: [],
    });
  });

  it.each([
    { segments: [] },
    { segments: [{ index: -1, text: '测试文本', speaker: 'narrator' }] },
    { segments: [{ index: 0, text: '', speaker: 'narrator' }] },
    { segments: [{ index: 0, text: '测试文本', speaker: 'narrator', speedModifier: 0 }] },
    {
      segments: [{ index: 0, text: '测试文本', speaker: 'narrator', voiceId: 'unknown-voice' }],
    },
  ])('returns null for malformed LLM output %#', async (content) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(content) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new LlmSegmentationClient({
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      api_key: 'test-key',
    });

    await expect(client.segment('测试文本')).resolves.toBeNull();
  });

  it('uses the configured timeout value', async () => {
    vi.useFakeTimers();
    const originalTimeout = config.DEEPSEEK_TIMEOUT_MS;
    config.DEEPSEEK_TIMEOUT_MS = 25;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const client = new LlmSegmentationClient({
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      api_key: 'test-key',
    });

    const resultPromise = client.segment('测试文本');
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toBeNull();
    config.DEEPSEEK_TIMEOUT_MS = originalTimeout;
  });
});
