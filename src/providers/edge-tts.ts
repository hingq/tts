/**
 * @file edge-tts.ts
 * @description 基于微软 Edge 大声朗读（Edge-TTS）公网 WebSocket 接口的 {@link TTSProvider} 实现。
 *
 * 职责边界：
 * - 按 `config.TTS_PROXY` 为 WebSocket 注入 HTTPS 代理出口。
 * - 发请求前对 voice / rate / pitch 做防御式清洗，规避 SSML 逃逸与非法参数导致的连接中断。
 * - 把文本片段稳定合成为调用方指定路径的 MP3（输出格式固定为 `audio-24khz-48kbitrate-mono-mp3`）。
 * - 用指数退避吸收瞬时网络抖动；把 429 风控信号转译为 {@link TTSThrottleError} 上抛。
 * - 落盘后做完整性校验，避免把空文件交给下游转码。
 *
 * 非职责：流水线集成、全局冷却锁、并发限流、FFmpeg 转码——均属后续模块。
 */

import fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { TTSProvider, TTSOptions, TTSResult, TTSThrottleError } from '../types/tts.js';
import { config } from '../config.js';

/**
 * 可信中文发音人白名单。非名单内的 voice 一律回退为 {@link DEFAULT_VOICE}。
 * 即便 API 路由层已校验，Provider 仍重新校验——它可能被流水线以非路由来源的参数调用。
 */
const VOICE_WHITELIST = [
  'zh-CN-YunxiNeural', // 推荐，男声
  'zh-CN-XiaoxiaoNeural', // 推荐，女声
  'zh-CN-YunjianNeural', // 男声
  'zh-CN-XiaoyiNeural', // 女声
  'zh-HK-HiuMaanNeural', // 粤语女声
  'zh-TW-HsiaoChenNeural', // 国语女声
] as const;

/** 非白名单发音人的统一回退音色。 */
const DEFAULT_VOICE = 'zh-CN-YunxiNeural';

/**
 * 固定输出格式：24kHz / 48kbit / 单声道 MP3。
 * 单声道契合人声、信噪比高；真实目标码率在后续转码模块落地，与 `options.bitrate` 解耦。
 */
const FIXED_OUTPUT_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

/** 瞬时网络错误的最大重试次数（不含首次尝试）。 */
const MAX_RETRIES = 3;

/** 合法语速：带符号整数百分比，如 `+15%` / `-20%`。 */
const RATE_RE = /^[+-]\d+%$/;
/** 裸小数语速：如 `1.2` / `0.5`，将被换算为带符号百分比。 */
const BARE_DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
/** 合法音高：带符号整数 + `Hz` 或 `%`，如 `+5Hz` / `-10%`。 */
const PITCH_RE = /^[+-]\d+(?:Hz|%)$/;

/**
 * 校验并归一化发音人。
 *
 * @param voice 调用方提供的原始发音人标识
 * @returns 白名单内的值原样返回；否则回退为 `zh-CN-YunxiNeural`
 */
export function sanitizeVoice(voice: string): string {
  // 白名单是闭集，任何不在其中的输入（含空串、注入片段）都被收敛为安全的默认音色
  return (VOICE_WHITELIST as readonly string[]).includes(voice) ? voice : DEFAULT_VOICE;
}

/**
 * 校验并归一化语速。
 *
 * 规则（按优先级）：
 * 1. 已是合法带符号百分比（匹配 {@link RATE_RE}）→ 原样透传。
 * 2. 裸小数（如 `1.2`）→ 视为相对倍率，换算为带符号百分比：`(n-1)*100` 四舍五入，
 *    并强制带符号（如 `1.2` → `+20%`，`0.8` → `-20%`，`1` → `+0%`）。
 * 3. 其余一切非法输入 → 重置为安全默认 `+0%`。
 *
 * @param rate 调用方提供的原始语速
 * @returns 符合 SSML 规范的带符号百分比字符串
 */
export function sanitizeRate(rate: string): string {
  // 规则 1：已合规，直接透传，避免任何精度损失
  if (RATE_RE.test(rate)) return rate;

  // 规则 2：裸小数按相对倍率换算（1.0 为基准，差值即百分比偏移）
  if (BARE_DECIMAL_RE.test(rate)) {
    const ratio = Number(rate);
    if (Number.isFinite(ratio)) {
      const percent = Math.round((ratio - 1) * 100);
      // 显式补正号：正数 / 0 加 `+`，负数 Math.round 已带 `-`
      const sign = percent >= 0 ? '+' : '';
      return `${sign}${percent}%`;
    }
  }

  // 规则 3：兜底重置，确保送入 SSML 的永远是合法值
  return '+0%';
}

/**
 * 校验并归一化音高。
 *
 * @param pitch 调用方提供的原始音高
 * @returns 匹配 {@link PITCH_RE}（带符号整数 + `Hz`/`%`）则透传；否则重置为 `+0Hz`
 */
export function sanitizePitch(pitch: string): string {
  // 音高无小数换算语义，非合规一律重置为中性值，避免 SSML 解析失败导致连接中断
  return PITCH_RE.test(pitch) ? pitch : '+0Hz';
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
 * Edge-TTS 合成器。详见文件头说明。
 */
export class EdgeTTSProvider implements TTSProvider {
  /**
   * 可选的 HTTPS 代理 agent。仅当 `config.TTS_PROXY` 非空时实例化，
   * 用于把 WebSocket 流量导向代理出口；为空则底层 `MsEdgeTTS` 直连微软接口。
   */
  private readonly agent?: HttpsProxyAgent<string>;

  /**
   * 根据全局配置决定 WebSocket 的出口路径：
   * 配置了 `TTS_PROXY` → 创建 `HttpsProxyAgent`；否则保持 `undefined`（直连）。
   */
  constructor() {
    if (config.TTS_PROXY) {
      // 为底层 WebSocket 注入 HTTPS 代理，所有 Edge-TTS 流量经此转发
      this.agent = new HttpsProxyAgent(config.TTS_PROXY);
    }
  }

  /**
   * 见 {@link TTSProvider.synthesize}。包裹指数退避重试与 429 风控识别。
   */
  async synthesize(
    text: string,
    options: TTSOptions,
    outPathWithoutExt: string,
  ): Promise<TTSResult> {
    // 发请求前重做防御式清洗，确保送入 SSML 的参数永远合法
    const voice = sanitizeVoice(options.voice);
    const rate = sanitizeRate(options.rate);
    const pitch = sanitizePitch(options.pitch);
    const audioPath = `${outPathWithoutExt}.mp3`;

    let lastError: unknown;

    // 指数退避循环：retryCount 从 0（首次尝试）到 MAX_RETRIES（含），最多 MAX_RETRIES 次重试
    for (let retryCount = 0; retryCount <= MAX_RETRIES; retryCount++) {
      try {
        await this.synthesizeOnce(text, voice, rate, pitch, audioPath);
        // 落盘完整性校验：文件须存在且体积 > 0，否则视为写入失败，不把空文件交给下游
        const stat = await fs.promises.stat(audioPath).catch(() => null);
        if (!stat || stat.size === 0) {
          throw new Error(`TTS 合成落盘校验失败：文件缺失或为空 -> ${audioPath}`);
        }
        return { audioPath, format: 'mp3' };
      } catch (err) {
        // 429 风控在本层不重试：立即转译为语义错误上抛，交由流水线触发全局冷却。
        // 该分支不消耗重试次数——重试只会加剧风控。
        if (isThrottleError(err)) {
          if (config.LOG_VERBOSE) {
            // eslint-disable-next-line no-console
            console.warn(`[tts] 命中 429，转译为 TTSThrottleError 上抛（${audioPath}）`);
          }
          throw new TTSThrottleError();
        }

        lastError = err;

        // 已是最后一次尝试：跳出循环，抛出最后一次错误（见循环外）
        if (retryCount === MAX_RETRIES) break;

        // 瞬时网络错误：指数退避 + 抖动后重试。
        // 公式 2^retryCount * 1000 + Random(0,500) ms：指数项快速拉开重试间隔吸收抖动，
        // 抖动项打散并发请求的重试时刻、缓解惊群。
        const backoff = 2 ** retryCount * 1000 + Math.floor(Math.random() * 500);
        if (config.LOG_VERBOSE) {
          // eslint-disable-next-line no-console
          console.warn(
            `[tts] 合成瞬时失败，第 ${retryCount + 1}/${MAX_RETRIES} 次重试，退避 ${backoff}ms（${audioPath}）：`,
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
   * 单次合成尝试：建连 → 取流 → 管道落盘 → 关连接。每次重试都新建实例并重新 `setMetadata`，
   * 确保断开的 socket 被彻底重建（库语义下复用同一实例重连不可靠）。
   *
   * @param text 待合成文本
   * @param voice 已清洗的发音人
   * @param rate 已清洗的语速
   * @param pitch 已清洗的音高
   * @param audioPath 含 `.mp3` 后缀的目标落盘路径
   */
  private async synthesizeOnce(
    text: string,
    voice: string,
    rate: string,
    pitch: string,
    audioPath: string,
  ): Promise<void> {
    const tts = new MsEdgeTTS({ agent: this.agent });
    try {
      // 建立 WebSocket 并设定音色与固定输出格式；失败时在此抛错
      await tts.setMetadata(voice, FIXED_OUTPUT_FORMAT);

      // toStream 同步返回流对象，但内部 WebSocket 为异步——以流的 finish/error 事件判定完成
      const { audioStream } = tts.toStream(text, { rate, pitch });

      // 用 stream/promises 的 pipeline 管道写入自有写入流：
      // 任一端 error 会 reject，写入端 finish 会 resolve，自动处理背压与流销毁
      await pipeline(audioStream, createWriteStream(audioPath));
    } finally {
      // 无论成功失败都关闭 WebSocket，避免连接泄漏
      tts.close();
    }
  }
}
