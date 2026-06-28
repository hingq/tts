import { z } from 'zod';
import { logger } from '../utils/logger.js';

// ─── 音色白名单 ──────────────────────────────────────────────────────

const VOICE_WHITELIST = ['冰糖', '茉莉', '苏打', '白桦', 'mimo_default'] as const;

const SEGMENTATION_RESPONSE_FORMAT = {
  type: 'json_object' as const,
} as const;

// ─── LLM 输出 Zod 校验 Schema ───────────────────────────────────────

const LlmSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  speaker: z.string().min(1),
  voiceId: z.enum(VOICE_WHITELIST),
  emotion: z.string().min(1).default('neutral'),
  speedModifier: z.number().positive().default(1),
});

const LlmSegmentationOutputSchema = z.object({
  segments: z.array(LlmSegmentSchema).min(1),
  characters: z
    .array(
      z.object({
        id: z.string().min(1),
        voiceId: z.enum(VOICE_WHITELIST),
        gender: z.string().optional(),
      }),
    )
    .default([]),
});

type LlmSegmentationOutput = z.infer<typeof LlmSegmentationOutputSchema>;

// ─── Model ────────────────────────────────────────────────────────────
type Config = {
  url: string;
  model: string;
  api_key: string;
  system_prompt: string;
  text: string;
};
export class Model {
  private base_url;
  private model;
  private api_key;
  private system_prompt;
  private text;
  constructor(config: Config) {
    this.base_url = config.url;
    this.model = config.model;
    this.api_key = config.api_key;
    this.system_prompt = config.system_prompt;
    this.text = config.text;
  }

  /**
   * 文本完整性校验：所有 segments[].text 拼接后必须逐字等于原文。
   * 这是有声书制作的核心约束——漏字会导致音频缺失、字数对不上。
   */
  private validateTextIntegrity(segments: { text: string }[]): boolean {
    const reconstructed = segments.map((s) => s.text).join('');
    const norm = (s: string) => s.replace(/\s+/g, '');
    return norm(reconstructed) === norm(this.text);
  }

  /**
   * Index 连续性校验：index 必须严格从 0 开始按 1 递增。
   * 跳号或乱序会导致下游章节合并时状态错乱。
   */
  private validateIndexContinuity(segments: { index: number }[]): boolean {
    return segments.every((s, i) => s.index === i);
  }

  /**
   * 角色-音色一致性校验：
   * 1. segments 中同一 speaker 必须使用相同的 voiceId（防止角色音色漂移）
   * 2. characters 表中每个角色的 voiceId 必须与其在 segments 中的 voiceId 一致
   */
  private validateCharacterVoiceConsistency(
    segments: { speaker: string; voiceId: string }[],
    characters: { id: string; voiceId: string }[],
  ): boolean {
    // 建立角色→音色映射（从 characters 表）
    const charVoice = new Map(characters.map((c) => [c.id, c.voiceId]));

    // 检查 segments 中同一 speaker 的 voiceId 是否一致
    const seen = new Map<string, string>();
    for (const seg of segments) {
      if (seg.speaker === 'narrator') continue;
      const existing = seen.get(seg.speaker);
      if (existing !== undefined && existing !== seg.voiceId) return false;
      seen.set(seg.speaker, seg.voiceId);
    }

    // 检查 characters 表中的音色与 segments 一致
    return Array.from(seen).every(([speaker, voiceId]) => {
      const expected = charVoice.get(speaker);
      return expected === undefined || expected === voiceId;
    });
  }

  /**
   * speedModifier 钳位：将超出 [0.5, 2.0] 的值钳回范围，NaN → 1.0。
   */
  private clampSpeedModifier(segments: { speedModifier: number }[]): void {
    for (const seg of segments) {
      if (typeof seg.speedModifier !== 'number' || Number.isNaN(seg.speedModifier)) {
        seg.speedModifier = 1;
      } else {
        seg.speedModifier = Math.min(2, Math.max(0.5, seg.speedModifier));
      }
    }
  }

  /**
   * 调用 LLM 进行文本分段和音色分配，返回经过多层校验的类型化结果。
   *
   * 校验链（任一层失败 → return null，调用方回退确定性 narrator）：
   *    HTTP 响应码 + 30s 超时
   *   JSON 响应解析（`response.choices[0].message.content`）
   *    Zod schema 结构校验（字段类型、enum 白名单）
   *   文本完整性（拼接 segments.text 逐字等于原文）
   *    Index 连续性（严格 0, 1, 2...）
   *    角色-音色一致性
   */
  async run(): Promise<LlmSegmentationOutput | null> {
    const controller = new AbortController();
    // 逐句切分输出体量大（segments JSON 可达数千 token），非流式 + 中转网关下 30s 偏紧。
    // 若长期命中超时，根治方向是改 stream:true 流式接收；当前先放宽到 120s。
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(`${this.base_url}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.api_key}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: this.system_prompt },
            { role: 'user', content: this.text },
          ],
          stream: false,
          response_format: SEGMENTATION_RESPONSE_FORMAT,
        }),
        signal: controller.signal,
      });

      // L2: HTTP 错误检查
      if (!response.ok) {
        throw new Error(`API ${response.status}: ${await response.text()}`);
      }

      // L3: 响应体解析
      const body = await response.json();
      const content: string | undefined = body.choices?.[0]?.message?.content;
      if (!content) return null;

      // L4: JSON 内容解析（json_object 模式下极少失败，但保留防御）
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return null;
      }

      // L5: Zod 结构校验
      const parseResult = LlmSegmentationOutputSchema.safeParse(parsed);
      if (!parseResult.success) {
        logger.error(`[orchestrator] 分割输出 Zod 校验失败：${parseResult.error.message}`);
        return null;
      }

      const { segments, characters } = parseResult.data;

      // L6: 文本完整性 + Index 连续性
      if (!this.validateTextIntegrity(segments)) {
        logger.error('[orchestrator] 分割输出文本完整性校验失败');
        return null;
      }
      if (!this.validateIndexContinuity(segments)) {
        logger.error('[orchestrator] 分割输出 Index 连续性校验失败');
        return null;
      }

      // L7: 角色-音色一致性
      if (!this.validateCharacterVoiceConsistency(segments, characters)) {
        logger.error('[orchestrator] 分割输出角色-音色一致性校验失败');
        return null;
      }

      // 钳位 speedModifier 到 [0.5, 2.0]
      this.clampSpeedModifier(segments);

      return { segments, characters };
    } catch (err) {
      logger.error(
        `[orchestrator] 分割 LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────

export class Orchestrator {}

// ─── Exports ──────────────────────────────────────────────────────────

export { VOICE_WHITELIST, SEGMENTATION_RESPONSE_FORMAT, LlmSegmentationOutputSchema };
export type { LlmSegmentationOutput };
