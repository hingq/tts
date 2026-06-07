/**
 * @file mimo-tts.ts
 * @description 基于小米 MiMo 开放平台「语音合成」接口的 {@link TTSProvider} 实现。
 *
 * 与 Edge-TTS 的关键差异：
 * - 接口为 OpenAI 兼容的 `POST {MIMO_BASE_URL}/chat/completions`，`api-key` 头认证，**非流式**调用。
 * - 请求 body 的 `messages` 必须同时含 `user`（风格指令）与 `assistant`（待合成文本）两条；
 *   音色与输出格式经 `audio: { format, voice }` 指定。
 * - 响应把音频以 **base64 编码的 WAV** 放在 `choices[0].message.audio.data`，需解码落盘。
 *
 * 职责边界（对齐 {@link EdgeTTSProvider}）：
 * - 发请求前对 voice 做防御式清洗，非白名单回退默认音色。
 * - 把文本片段稳定合成为调用方指定路径的 WAV。
 * - 用指数退避吸收瞬时网络抖动；把 429 风控信号转译为 {@link TTSThrottleError} 上抛。
 * - 落盘后做完整性校验，避免把空文件交给下游转码。
 *
 * 非职责：流水线集成、全局冷却锁、并发限流、FFmpeg 转码——均属后续模块。
 */

import fs from 'node:fs';
import { TTSProvider, TTSOptions, TTSResult, TTSThrottleError } from '../types/tts.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * mimo-tts 引擎可信中文音色白名单（mimo-v2.5-tts 预置音色）。
 * 非名单内的 voice 一律回退为 {@link DEFAULT_VOICE}。即便 API 路由层已校验，
 * Provider 仍重新校验——它可能被流水线以非路由来源的参数调用。
 */
const VOICE_WHITELIST = [
  '苏打', // 默认，男声
  '冰糖', // 女声
  '茉莉', // 女声
  '白桦', // 男声
  'mimo_default', // 通用缺省音色
] as const;

/** 非白名单音色的统一回退值。 */
const DEFAULT_VOICE = '苏打';

/** 瞬时网络错误的最大重试次数（不含首次尝试）。 */
const MAX_RETRIES = 3;

/**
 * 校验并归一化音色。
 *
 * @param voice 调用方提供的原始音色标识
 * @returns 白名单内的值原样返回；否则回退为 `苏打`
 */
export function sanitizeVoice(voice: string): string {
  // 白名单是闭集，任何不在其中的输入（含空串、注入片段）都被收敛为安全的默认音色
  return (VOICE_WHITELIST as readonly string[]).includes(voice) ? voice : DEFAULT_VOICE;
}

/**
 * 判定错误是否为 429 风控限流。错误文本中含 `429` 或 `Too Many Requests` 即视为命中。
 *
 * @param err 捕获到的错误
 */
function isThrottleError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests/i.test(msg);
}

/**
 * 等待指定毫秒数。
 *
 * @param ms 毫秒
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 小米 MiMo TTS 合成器。详见文件头说明。
 */
export class MimoTTSProvider implements TTSProvider {
  /**
   * 见 {@link TTSProvider.synthesize}。包裹指数退避重试与 429 风控识别。
   *
   * 注意：MiMo 无数值化 rate/pitch，故 `options` 仅取 `voice`，rate/pitch 被忽略。
   */
  async synthesize(
    text: string,
    options: TTSOptions,
    outPathWithoutExt: string,
  ): Promise<TTSResult> {
    // 发请求前重做防御式清洗，确保送入的音色永远合法
    const voice = sanitizeVoice(options.voice);
    const audioPath = `${outPathWithoutExt}.wav`;

    let lastError: unknown;

    // 指数退避循环：retryCount 从 0（首次尝试）到 MAX_RETRIES（含），最多 MAX_RETRIES 次重试
    for (let retryCount = 0; retryCount <= MAX_RETRIES; retryCount++) {
      try {
        await this.synthesizeOnce(text, voice, audioPath);
        // 落盘完整性校验：文件须存在且体积 > 0，否则视为写入失败，不把空文件交给下游
        const stat = await fs.promises.stat(audioPath).catch(() => null);
        if (!stat || stat.size === 0) {
          throw new Error(`MiMo 合成落盘校验失败：文件缺失或为空 -> ${audioPath}`);
        }
        return { audioPath, format: 'wav' };
      } catch (err) {
        // 429 风控在本层不重试：立即转译为语义错误上抛，交由流水线触发全局冷却。
        // 该分支不消耗重试次数——重试只会加剧风控。
        if (isThrottleError(err)) {
          if (config.LOG_VERBOSE) {
            logger.error(`[mimo-tts] 命中 429，转译为 TTSThrottleError 上抛（${audioPath}）`);
          }
          throw new TTSThrottleError();
        }

        lastError = err;

        // 已是最后一次尝试：跳出循环，抛出最后一次错误（见循环外）
        if (retryCount === MAX_RETRIES) break;

        // 瞬时网络错误：指数退避 + 抖动后重试。
        const backoff = 2 ** retryCount * 1000;
        if (config.LOG_VERBOSE) {
          logger.error(
            `[mimo-tts] 合成瞬时失败，第 ${retryCount + 1}/${MAX_RETRIES} 次重试，退避 ${backoff}ms（${audioPath}）：`,
            err instanceof Error ? err.message : err,
          );
        }
        await delay(backoff);
      }
    }

    // 连续重试达上限仍失败：抛出最后一次捕获的错误
    throw lastError;
  }

  /**
   * 单次合成尝试：非流式 POST → 解析 base64 WAV → 落盘。
   *
   * @param text 待合成文本
   * @param voice 已清洗的音色
   * @param audioPath 含 `.wav` 后缀的目标落盘路径
   * @throws 当未配置 API Key、HTTP 非 2xx（429 文案触发上层转译）或响应缺少音频数据时抛出
   */
  private async synthesizeOnce(text: string, voice: string, audioPath: string): Promise<void> {
    if (!config.MIMO_API_KEY) {
      throw new Error('未配置 MIMO_API_KEY，无法使用 mimo-tts 引擎');
    }

    const res = await fetch(`${config.MIMO_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.MIMO_API_KEY,
      },
      body: JSON.stringify({
        model: config.MIMO_MODEL,
        messages: [
          // user 角色放风格指令，assistant 角色放待合成文本（接口要求两条缺一不可）
          { role: 'user', content: config.MIMO_STYLE_PROMPT },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'wav', voice },
        stream: false,
      }),
    });

    if (!res.ok) {
      // 读取响应体片段辅助定位；429 文案会被上层 isThrottleError 识别并转译为冷却信号
      const bodyText = await res.text().catch(() => '');
      throw new Error(`MiMo 接口返回 ${res.status} ${res.statusText}：${bodyText.slice(0, 500)}`);
    }

    const json = (await res.json()) as MimoChatCompletionResponse;
    const b64 = json?.choices?.[0]?.message?.audio?.data;
    if (!b64) {
      throw new Error('MiMo 响应缺少音频数据（choices[0].message.audio.data 为空）');
    }

    await fs.promises.writeFile(audioPath, Buffer.from(b64, 'base64'));
  }
}

/** MiMo 非流式响应的最小结构契约（仅取所需字段）。 */
interface MimoChatCompletionResponse {
  choices?: Array<{
    message?: {
      audio?: {
        /** base64 编码的音频数据 */
        data?: string;
      };
    };
  }>;
}
