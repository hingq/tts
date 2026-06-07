/**
 * @file mimo-tts.test.ts
 * @description MimoTTSProvider 的单元测试。
 * 覆盖 sanitizeVoice 的白名单/回退，以及 synthesize 在 mock fetch 下的：
 * 正常 base64 WAV 落盘、429 转译为 TTSThrottleError、非 2xx 抛错、空音频数据抛错。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MimoTTSProvider, sanitizeVoice } from '../../src/providers/mimo-tts.js';
import { TTSThrottleError } from '../../src/types/tts.js';
import { config } from '../../src/config.js';

describe('sanitizeVoice', () => {
  const cases: Array<[string, string]> = [
    // 白名单内原样透传
    ['苏打', '苏打'],
    ['冰糖', '冰糖'],
    ['茉莉', '茉莉'],
    ['白桦', '白桦'],
    ['mimo_default', 'mimo_default'],
    // 非白名单回退默认音色
    ['Chloe', '苏打'], // 英文音色未暴露
    ['', '苏打'],
    ['<inject>', '苏打'],
  ];

  it.each(cases)('sanitizeVoice(%j) === %j', (input, expected) => {
    expect(sanitizeVoice(input)).toBe(expected);
  });
});

describe('MimoTTSProvider.synthesize', () => {
  let tmpDir: string;
  const options = { voice: '苏打', rate: '+0%', pitch: '+0Hz', bitrate: '64k' };

  let savedKey: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-test-'));
    // 注入测试用 API Key，使 synthesizeOnce 不会因缺 key 提前抛错
    savedKey = config.MIMO_API_KEY;
    config.MIMO_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.MIMO_API_KEY = savedKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构造一个 mock fetch Response。 */
  function mockFetch(impl: () => Partial<Response> & { json?: () => unknown }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => impl() as Response),
    );
  }

  it('正常返回 base64 → 落盘 .wav 并返回 format=wav', async () => {
    const wavBytes = Buffer.from('FAKEWAVDATA');
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { audio: { data: wavBytes.toString('base64') } } }],
      }),
    }));

    const provider = new MimoTTSProvider();
    const outBase = path.join(tmpDir, 'raw_0');
    const result = await provider.synthesize('你好世界', options, outBase);

    expect(result.format).toBe('wav');
    expect(result.audioPath).toBe(`${outBase}.wav`);
    expect(fs.readFileSync(result.audioPath)).toEqual(wavBytes);
  });

  it('429 → 抛出 TTSThrottleError', async () => {
    mockFetch(() => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'rate limited',
    }));

    const provider = new MimoTTSProvider();
    await expect(
      provider.synthesize('文本', options, path.join(tmpDir, 'raw_1')),
    ).rejects.toBeInstanceOf(TTSThrottleError);
  });

  it('非 2xx（500）→ 经退避重试后抛错且不落盘', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'server error',
    }));

    // 用 fake timers 让指数退避（1s/2s/4s）瞬间推进，避免真实等待
    vi.useFakeTimers();
    try {
      const provider = new MimoTTSProvider();
      const outBase = path.join(tmpDir, 'raw_2');
      const p = provider.synthesize('文本', options, outBase);
      const assertion = expect(p).rejects.toThrow(/500/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fs.existsSync(`${outBase}.wav`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('响应缺少音频数据 → 经退避重试后抛错', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { audio: {} } }] }),
    }));

    vi.useFakeTimers();
    try {
      const provider = new MimoTTSProvider();
      const p = provider.synthesize('文本', options, path.join(tmpDir, 'raw_3'));
      const assertion = expect(p).rejects.toThrow(/音频数据/);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
