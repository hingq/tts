import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, parseEnv } from '../src/config.js';
import { LlmSegmentationClient, Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { JobState } from '../src/types/job.js';
import { logger } from '../src/utils/logger.js';

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

  it('includes locked character voices in later LLM requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [{ index: 0, text: '测试文本', speaker: '郭襄' }],
                  characters: [{ id: '郭襄', gender: '女性', voiceId: '冰糖' }],
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

    await client.segment('测试文本', new Map([['郭襄', '冰糖']]));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages[1].content).toContain('"郭襄":"冰糖"');
  });

  it('logs bounded diagnostics for the first non-whitespace text mismatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [
                    {
                      index: 0,
                      text: `${'前'.repeat(25)}误${'后'.repeat(25)}`,
                      speaker: 'narrator',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const client = new LlmSegmentationClient({
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      api_key: 'test-key',
    });

    await expect(client.segment(`${'前'.repeat(25)}错${'后'.repeat(25)}`)).resolves.toBeNull();

    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('原文长度=51，输出长度=51');
    expect(message).toContain('去空白原文长度=51，去空白输出长度=51');
    expect(message).toContain('首个差异位置=25');
    expect(message).toContain(`原文片段="${'前'.repeat(20)}错${'后'.repeat(20)}"`);
    expect(message).toContain(`输出片段="${'前'.repeat(20)}误${'后'.repeat(20)}"`);
    expect(message).not.toContain('前'.repeat(21));
  });

  it('logs Unicode character lengths and EOF for truncated output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [{ index: 0, text: '甲\t😀', speaker: 'narrator' }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const client = new LlmSegmentationClient({
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      api_key: 'test-key',
    });

    await expect(client.segment('甲\n😀乙')).resolves.toBeNull();

    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('原文长度=4，输出长度=3');
    expect(message).toContain('去空白原文长度=3，去空白输出长度=2');
    expect(message).toContain('首个差异位置=2');
    expect(message).toContain('原文差异字符="乙"');
    expect(message).toContain('输出差异字符=<EOF>');
    expect(message).toContain('原文片段="甲\\n😀乙"');
    expect(message).toContain('输出片段="甲\\t😀"');
  });

  it('accepts whitespace-only differences without logging an integrity error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [{ index: 0, text: '甲 \t乙', speaker: 'narrator' }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const client = new LlmSegmentationClient({
      url: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      api_key: 'test-key',
    });

    await expect(client.segment('甲\n乙')).resolves.not.toBeNull();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('分割输出文本完整性校验失败'),
    );
  });

  it.each([
    { segments: [] },
    { segments: [{ index: -1, text: '测试文本', speaker: 'narrator' }] },
    { segments: [{ index: 0, text: '', speaker: 'narrator' }] },
    { segments: [{ index: 0, text: '测试文本', speaker: 'narrator', speedModifier: 0 }] },
    {
      segments: [{ index: 0, text: '测试文本', speaker: '角色' }],
      characters: [{ id: '角色', gender: '女性', voiceId: 'unknown-voice' }],
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

describe('Orchestrator character voice assignment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createJobState(): JobState {
    return {
      jobId: 'voice-test',
      title: '测试',
      author: '',
      status: 'running',
      phase: 'tts',
      ttsEngine: 'mimo-tts',
      voice: 'mimo_default',
      rate: '1',
      pitch: '0',
      bitrate: '64k',
      totalChunks: 2,
      completedTTS: 0,
      completedTranscode: 0,
      chunks: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }

  it('locks the first model-selected voice across chapters', async () => {
    const originalApiKey = config.DEEPSEEK_API_KEY;
    config.DEEPSEEK_API_KEY = 'test-key';
    const responses = [
      {
        segments: [{ index: 0, text: '第一章', speaker: '郭襄' }],
        characters: [{ id: '郭襄', gender: '女性', voiceId: '冰糖' }],
      },
      {
        segments: [{ index: 0, text: '第二章', speaker: '郭襄' }],
        characters: [{ id: '郭襄', gender: '女性', voiceId: '茉莉' }],
      },
    ];
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses[0]) } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses[1]) } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const state = createJobState();
    let canceled = false;
    const orchestrator = new Orchestrator(
      {
        jobState: state,
        jobDir: '/tmp/voice-test',
        voice: state.voice,
        onProgress: () => undefined,
        isCanceled: () => canceled,
        runTTSPhase: async () => {
          canceled = true;
        },
      },
      {
        projectId: state.jobId,
        title: state.title,
        inputChunks: [
          { index: 0, chapterIndex: 0, chapterTitle: '一', text: '第一章' },
          { index: 1, chapterIndex: 1, chapterTitle: '二', text: '第二章' },
        ],
      },
    );

    await orchestrator.run();

    expect(state.chunks.map((chunk) => chunk.voiceId)).toEqual(['冰糖', '冰糖']);
    config.DEEPSEEK_API_KEY = originalApiKey;
  });

  it('repairs a gender-incompatible first voice selection', async () => {
    const originalApiKey = config.DEEPSEEK_API_KEY;
    config.DEEPSEEK_API_KEY = 'test-key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [{ index: 0, text: '第一章', speaker: '郭襄' }],
                  characters: [{ id: '郭襄', gender: '女性', voiceId: '苏打' }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const state = createJobState();
    let canceled = false;
    const orchestrator = new Orchestrator(
      {
        jobState: state,
        jobDir: '/tmp/voice-test',
        voice: state.voice,
        onProgress: () => undefined,
        isCanceled: () => canceled,
        runTTSPhase: async () => {
          canceled = true;
        },
      },
      {
        projectId: state.jobId,
        title: state.title,
        inputChunks: [{ index: 0, chapterIndex: 0, chapterTitle: '一', text: '第一章' }],
      },
    );

    await orchestrator.run();

    expect(state.chunks[0]?.voiceId).toBe('冰糖');
    config.DEEPSEEK_API_KEY = originalApiKey;
  });
});
