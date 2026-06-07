/**
 * @file tts.ts
 * @description TTS 引擎抽象层的类型契约。定义引擎无关的 `TTSProvider` 接口与其入参 / 出参结构，
 * 以及用于上抛 429 风控信号的自定义错误。后续流水线模块（如分块编排）只依赖此处的接口，
 * 不直接耦合任何具体引擎（Edge-TTS / 其它），从而把引擎更换的影响收敛在 Provider 实现内。
 */

/**
 * 单次合成的音频控制参数。
 *
 * 注意：这些字段由调用方提供，Provider 不信任其合法性，会在发请求前重新做防御式清洗
 * （见 `EdgeTTSProvider` 的 `sanitizeVoice` / `sanitizeRate` / `sanitizePitch`）。
 */
export interface TTSOptions {
  /** 发音人标识，例如 `"zh-CN-YunxiNeural"`；非白名单将被回退为默认音色。 */
  voice: string;
  /** 语速，规范格式为带符号百分比，如 `"+0%"` / `"+15%"`。 */
  rate: string;
  /** 音高，规范格式为带符号 Hz 或百分比，如 `"+0Hz"` / `"-5Hz"` / `"+10%"`。 */
  pitch: string;
  /**
   * 目标码率，如 `"32k"` / `"64k"` / `"128k"`。
   * 仅作为契约字段保留：Edge-TTS 输出格式固定，真实码率在后续 FFmpeg 转码模块落地，
   * 故本字段当前不影响 Edge 合成结果。
   */
  bitrate: string;
}

/** 一次成功合成的结果。 */
export interface TTSResult {
  /** 本地暂存音频文件的绝对路径（含扩展名）。 */
  audioPath: string;
  /** 输出音频格式扩展名，如 `"mp3"`（Edge-TTS）/ `"wav"`（MiMo），由具体 Provider 决定。 */
  format: string;
}

/**
 * 引擎无关的 TTS 合成器接口。具体引擎以实现此接口的方式接入，调用方不感知底层实现。
 */
export interface TTSProvider {
  /**
   * 将纯文本片段合成为本地临时音频文件。
   *
   * @param text 经过预处理的纯文本数据
   * @param options 音频控制参数（voice / rate / pitch / bitrate）
   * @param outPathWithoutExt 不含扩展名的输出路径；由 Provider 自行拼接后缀（如 `.mp3` / `.wav`），
   *   文件名完全由调用方决定，而非底层库自行命名
   * @returns 落盘成功后的结果 `{ audioPath, format }`
   * @throws {TTSThrottleError} 命中 429 风控限流时抛出，交由上层流水线触发全局冷却
   */
  synthesize(text: string, options: TTSOptions, outPathWithoutExt: string): Promise<TTSResult>;
}

/**
 * TTS 风控限流错误。
 *
 * 当底层接口返回 `429` / `Too Many Requests` 时抛出。该错误是一个明确的语义信号：
 * 上层流水线模块（模块 06）应捕获它以触发全局 TTS 冷却锁（约 30s 内暂停派发新请求），
 * 而非在本层重试——重试只会加剧风控。沿用 `src/routes/jobs.ts` 中 `HttpError extends Error`
 * 的自定义错误范式。
 */
export class TTSThrottleError extends Error {
  constructor(message = 'TTS 请求被风控限流（429 / Too Many Requests）') {
    super(message);
    // 修正原型链，确保 `instanceof TTSThrottleError` 在编译到 ES5 目标时仍可靠
    this.name = 'TTSThrottleError';
  }
}
