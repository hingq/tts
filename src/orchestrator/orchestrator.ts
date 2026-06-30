import { z } from 'zod';
import { logger } from '../utils/logger.js';
import type { JobState, ChunkState } from '../types/job.js';
import type { IncomingChapterChunk } from '../types/orchestrator.js';
import { saveJobState } from '../utils/state.js';
import { assembleAudiobook } from '../utils/ffmpeg.js';
import { config } from '../config.js';
import path from 'node:path';
// ─── 音色白名单 ──────────────────────────────────────────────────────

const VOICE_WHITELIST = ['冰糖', '茉莉', '苏打', '白桦', 'mimo_default'] as const;
type VoiceId = (typeof VOICE_WHITELIST)[number];

// 规则化音色池：同性别按角色在 segments 中的首现顺序轮询，
// 保证同章同性别的不同角色尽量区分、且全书稳定（不依赖 LLM 即兴选择）
const FEMALE_VOICES: VoiceId[] = ['冰糖', '茉莉'];
const MALE_VOICES: VoiceId[] = ['苏打', '白桦'];
const NARRATOR_VOICE: VoiceId = '苏打';
const FALLBACK_VOICE: VoiceId = 'mimo_default';

const SEGMENTATION_RESPONSE_FORMAT = {
  type: 'json_object' as const,
} as const;

// ─── LLM 输出 Zod 校验 Schema ───────────────────────────────────────

const LlmSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  speaker: z.string().min(1),
  // voiceId 由下游 assignVoices 规则统一分配；LLM 可不填，填了也会被覆盖
  voiceId: z.enum(VOICE_WHITELIST).optional(),
  emotion: z.string().min(1).default('neutral'),
  speedModifier: z.number().positive().default(1),
});

const LlmSegmentationOutputSchema = z.object({
  segments: z.array(LlmSegmentSchema).min(1),
  characters: z
    .array(
      z.object({
        id: z.string().min(1),
        // voiceId 同样由下游规则分配，LLM 只需保证 gender 准确
        voiceId: z.enum(VOICE_WHITELIST).optional(),
        gender: z.string().optional(),
      }),
    )
    .default([]),
});

type LlmSegmentationOutput = z.infer<typeof LlmSegmentationOutputSchema>;
type LlmSegment = z.infer<typeof LlmSegmentSchema>;

// ─── Model ────────────────────────────────────────────────────────────
type Config = {
  url: string;
  model: string;
  api_key: string;
  system_prompt: string;
  text: string;
};
const prompt = `
  你是中文有声书制作流水线中的「脚本对齐」引擎。输入是小说某一章的原文，你的唯一任务是把这段原文逐字切分成有序的朗读脚本片段（segments），同时识别
  说话人、分配音色、标注情绪与语速，并汇总本章角色表。你只做切分与标注，绝不改写故事内容。

  【第一约束：文本逐字保真】（违反则整段产物作废）
  - 每个 segment 的 text 必须是原文的连续子串；所有 segments[].text
  按顺序拼接后，必须与输入原文逐字相等——不多一个字、不少一个字、不改一个标点、不调整顺序。
  - 严禁对原文做任何修改：不得改写、润色、增删字词，不得合并相邻句子，不得把一个句子拆成字符，不得修改标点、空格、换行或引号。你只能在「字与字的缝
  隙」处下刀切分。
  - 切分粒度建议以「一个完整朗读呼吸句」为单位：通常是一个自然句或一段对白。整段旁白可适当合并为较长片段，但任何片段都不可跨章、不可重叠。

  【说话人识别 speaker】——有声书角色感的核心，宁可多识别角色，也不要把角色心声全归旁白
  - 旁白：第三人称的客观叙述、场景描写、纯动作描写 → "narrator"。
  - 角色发声（一律归角色，填该角色的名字）：对白、吟诵、自言自语，以及内心独白与第一人称心理活动
    （心想 / 暗想 / 默念 / 暗道 / 寻思 / 心中念道）。例：「郭襄心想："……"」「她低声吟道："……"」
    「她心中默默念道："……"」——这些引号内的内容都归郭襄，speaker 填「郭襄」。
  - 被中文引号「" "」「『 』」包裹、且能确定归属人的内容，默认归该角色；只有真正无法确定归属
    （如无名路人的只言片语）才归 narrator，不要臆造角色名。
  - 同一角色在全章、全书必须用完全一致的名字字符串（如统一「郭襄」，不要时而「郭襄」时而「郭二小姐」）。

  【音色 voiceId】——你不需要、也不应该自行决定 voiceId，它由下游按规则统一分配。
  你唯一要做的是在【角色表 characters】里准确填写每个角色的 gender（男性/女性）。
  下游规则：narrator→苏打；女性按出现顺序在「冰糖 / 茉莉」轮询；男性按出现顺序在「苏打 / 白桦」轮询；
  gender 缺失→mimo_default。segments 里的 voiceId 字段可留空，填了也会被覆盖，请把精力放在 speaker 与 gender 上。

  【情绪 emotion】
  - 取值：neutral / calm / happy / excited / sad / angry / whisper。
  - 旁白多用 neutral 或 calm；对白按语气与剧情判定。拿不准就填 neutral，不要强行加戏。

  【语速 speedModifier】
  - 取值范围 0.5～2.0，1.0 表示原速。
  - 平静叙述用 1.0；激烈、紧张、争吵可略快（如 1.1～1.2）；沉思、悲伤、追忆可略慢（如 0.85～0.95）。极端值慎用，整体应贴近自然听感。

  【角色表 characters】
  - 列出本章所有非 narrator 的角色（去重），id 必须与对应 segments 的 speaker 完全一致。
  - gender 必填「男性」或「女性」——音色分配完全依赖此字段，务必准确，拿不准时按名字与剧情常识判断。
  - narrator 不进 characters 表。

  【输出顺序与编号】
  - segments 严格按原文顺序排列；index 从 0 开始、按 1 严格递增，不得跳号、不得倒序。
  - 只输出指定的 JSON 结构，不要附加任何解释、前言或 markdown 代码围栏。

  再次提醒：底线是「拼接还原原文（字字保真）」与「尽可能把角色心声识别为该角色，而非旁白」。
  若为兼顾保真需要牺牲切分美观度，优先保真。
  `;
export class Model {
  protected base_url: string;
  protected model: string;
  protected api_key: string;
  protected system_prompt: string;
  protected text: string;
  constructor(config: Config) {
    this.base_url = config.url;
    this.model = config.model;
    this.api_key = config.api_key;
    this.system_prompt = prompt;
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
   * 规则化分配音色：
   *  - narrator → 苏打
   *  - 角色按 gender 在同性音色池里按 segments 首现顺序轮询（女→冰糖/茉莉，男→苏打/白桦）
   *  - gender 缺失/未知 → mimo_default
   * 由本函数统一决定 voiceId，保证同一角色在本章及全书稳定、同性别的不同角色尽量区分，
   * 彻底避免「同角色音色漂移」与「LLM 随机挑音色」两类问题。
   * 返回重建后的 characters 表（voiceId 已规则化）。
   */
  private assignVoices(
    segments: { speaker: string; voiceId?: string }[],
    characters: { id: string; gender?: string }[],
  ): { id: string; voiceId: VoiceId; gender?: string }[] {
    const genderOf = new Map(characters.map((c) => [c.id, c.gender]));

    // 按 segments 首现顺序收集去重角色（保证全书只要角色识别一致，音色就稳定）
    const order: string[] = [];
    const seen = new Set<string>();
    for (const s of segments) {
      if (s.speaker === 'narrator' || seen.has(s.speaker)) continue;
      seen.add(s.speaker);
      order.push(s.speaker);
    }

    // 为每个角色派生稳定 voiceId
    const voiceOf = new Map<string, VoiceId>();
    const counters: Record<'女性' | '男性', number> = { 女性: 0, 男性: 0 };
    for (const id of order) {
      const gender = genderOf.get(id);
      let voice: VoiceId = FALLBACK_VOICE;
      if (gender === '女性') {
        voice = FEMALE_VOICES[counters['女性']++ % FEMALE_VOICES.length] ?? FALLBACK_VOICE;
      } else if (gender === '男性') {
        voice = MALE_VOICES[counters['男性']++ % MALE_VOICES.length] ?? FALLBACK_VOICE;
      }
      voiceOf.set(id, voice);
    }

    // 回填 segments：narrator 固定苏打，其余查表
    for (const s of segments) {
      s.voiceId =
        s.speaker === 'narrator' ? NARRATOR_VOICE : (voiceOf.get(s.speaker) ?? FALLBACK_VOICE);
    }

    // 重建 characters 表：去重、带规则化 voiceId 与原 gender
    return order.map((id) => ({
      id,
      voiceId: voiceOf.get(id) ?? FALLBACK_VOICE,
      gender: genderOf.get(id),
    }));
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
   *    音色规则化分配（assignVoices，确定性，不触发回退）
   */
  async runModel(): Promise<LlmSegmentationOutput | null> {
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

      // L7: 规则化音色分配（覆盖 LLM 的 voiceId，保证全书稳定，不触发回退）
      const normalizedCharacters = this.assignVoices(segments, characters);

      // 钳位 speedModifier 到 [0.5, 2.0]
      this.clampSpeedModifier(segments);

      return { segments, characters: normalizedCharacters };
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

export interface OrchestratorContext {
  jobState: JobState;
  jobDir: string;
  voice: string;
  onProgress: () => void;
  isCanceled: () => boolean;
  runTTSPhase: () => Promise<void>;
}

export class Orchestrator extends Model {
  private ctx: OrchestratorContext;
  private options: {
    projectId: string;
    title: string;
    inputChunks: IncomingChapterChunk[];
  };

  constructor(
    ctx: OrchestratorContext,
    options: {
      projectId: string;
      title: string;
      inputChunks: IncomingChapterChunk[];
    },
  ) {
    super({
      url: config.DEEPSEEK_BASE_URL,
      model: config.DEEPSEEK_MODEL,
      api_key: config.DEEPSEEK_API_KEY,
      system_prompt: '', // Model constructor overrides this anyway with internal prompt
      text: '', // Set per chapter dynamically
    });

    this.ctx = ctx;
    this.options = options;
  }

  /**
   * 1.1 将分片按 chapterIndex 分组并返回分组 Map
   */
  private groupChunksByChapter(
    inputChunks: IncomingChapterChunk[],
  ): Map<number, IncomingChapterChunk[]> {
    const chaptersMap = new Map<number, IncomingChapterChunk[]>();
    for (const chunk of inputChunks) {
      if (!chaptersMap.has(chunk.chapterIndex)) {
        chaptersMap.set(chunk.chapterIndex, []);
      }
      chaptersMap.get(chunk.chapterIndex)!.push(chunk);
    }
    return chaptersMap;
  }

  /**
   * 1.3 核心段落文本分割（触发 LLM 并在失败时自动回退兜底）
   */
  private async segmentChapterText(
    chapterIndex: number,
    chapterChunks: IncomingChapterChunk[],
  ): Promise<LlmSegment[]> {
    const chapterText = chapterChunks.map((c) => c.text).join('');
    logger.info(`[Orchestrator] Chapter ${chapterIndex} text length: ${chapterText.length}`);

    const llmSegments = await this.callLlmSegmentation(chapterText, chapterIndex);
    if (llmSegments) {
      return llmSegments;
    }

    return this.generateFallbackSegments(chapterChunks);
  }

  /**
   * 1.3 尝试调用 LLM 进行分段
   */
  private async callLlmSegmentation(
    chapterText: string,
    chapterIndex: number,
  ): Promise<LlmSegment[] | null> {
    if (!config.DEEPSEEK_API_KEY) {
      logger.info(
        `[Orchestrator] No DEEPSEEK_API_KEY configured, using deterministic fallback chunks.`,
      );
      return null;
    }

    this.text = chapterText;
    logger.info(`[Orchestrator] Calling DeepSeek LLM for chapter ${chapterIndex}...`);
    const llmResult = await super.runModel();

    if (llmResult && llmResult.segments && llmResult.segments.length > 0) {
      logger.info(
        `[Orchestrator] LLM segmentation succeeded with ${llmResult.segments.length} segments.`,
      );
      return llmResult.segments;
    }

    logger.error(
      `[Orchestrator] LLM segmentation returned null, falling back to deterministic chunks.`,
    );
    return null;
  }

  /**
   * 1.4 生成确定性兜底分段（当未配置 LLM 或调用失败时）
   */
  private generateFallbackSegments(chapterChunks: IncomingChapterChunk[]): LlmSegment[] {
    return chapterChunks.map((chunk, i) => ({
      index: i,
      text: chunk.text,
      speaker: 'narrator',
      voiceId: (VOICE_WHITELIST as readonly string[]).includes(this.ctx.voice)
        ? (this.ctx.voice as VoiceId)
        : FALLBACK_VOICE,
      emotion: 'neutral',
      speedModifier: 1.0,
    }));
  }

  /**
   * 1.5 将段落片段映射为持久化 ChunkState 实体
   */
  private mapSegmentsToChunks(
    segments: LlmSegment[],
    chapterIndex: number,
    chapterTitle: string,
    jobDir: string,
    startGlobalIndex: number,
  ): ChunkState[] {
    return segments.map((seg, i) => {
      const globalIndex = startGlobalIndex + i;
      return {
        index: globalIndex,
        chapterIndex: chapterIndex,
        chapterTitle: chapterTitle,
        text: seg.text,
        rawPath: path.join(jobDir, `chunk_${globalIndex}.mp3`),
        m4aPath: path.join(jobDir, `chunk_${globalIndex}.m4a`),
        durationMs: 0,
        status: 'pending',
        voiceId: seg.voiceId || this.ctx.voice,
        speedModifier: seg.speedModifier || 1.0,
        emotion: seg.emotion || 'neutral',
        speaker: seg.speaker || 'narrator',
      };
    });
  }

  /**
   * 1.2 单个章节的高级生命周期处理
   */
  private async processChapter(
    chapterIndex: number,
    chapterChunks: IncomingChapterChunk[],
    jobDir: string,
    startGlobalIndex: number,
  ): Promise<ChunkState[]> {
    const chapterTitle = chapterChunks[0]?.chapterTitle || '';

    // 1. 获取本章分段
    const segments = await this.segmentChapterText(chapterIndex, chapterChunks);

    // 2. 映射为 ChunkState
    return this.mapSegmentsToChunks(segments, chapterIndex, chapterTitle, jobDir, startGlobalIndex);
  }

  /**
   * 1.6 运行 TTS 合成叶子执行器
   */
  private async runTtsPhase(): Promise<void> {
    logger.info(`[Orchestrator] Running TTS phase...`);
    await this.ctx.runTTSPhase();
  }

  /**
   * 1.7 运行混音 Mux 叶子执行器并更新任务状态
   */
  private async runMuxPhase(allNewChunks: ChunkState[], jobDir: string): Promise<void> {
    const jobState = this.ctx.jobState;
    logger.info(`[Orchestrator] Assembling audiobook (mux phase)...`);
    jobState.phase = 'mux';
    await saveJobState(jobDir, jobState);
    this.ctx.onProgress();

    await assembleAudiobook(jobState, jobDir);
  }

  /**
   * 2.1 主流程协调控制器
   */
  async run(): Promise<void> {
    const jobState = this.ctx.jobState;
    const jobDir = this.ctx.jobDir;

    logger.info(`[Orchestrator] Starting run for project: ${this.options.projectId}`);

    // 1. 按章节对文本进行整体分组
    const chaptersMap = this.groupChunksByChapter(this.options.inputChunks);
    const sortedChapterIndices = Array.from(chaptersMap.keys()).sort((a, b) => a - b);

    // 2. 顺序处理章节
    const allNewChunks: ChunkState[] = [];
    let globalIndex = 0;

    for (const chapterIndex of sortedChapterIndices) {
      if (this.ctx.isCanceled()) {
        logger.info(`[Orchestrator] Cancelled during chapter ${chapterIndex} preparation.`);
        return;
      }

      const chapterChunks = chaptersMap.get(chapterIndex)!;
      const chapterNewChunks = await this.processChapter(
        chapterIndex,
        chapterChunks,
        jobDir,
        globalIndex,
      );
      allNewChunks.push(...chapterNewChunks);
      globalIndex += chapterNewChunks.length;
    }

    if (this.ctx.isCanceled()) return;

    // 更新任务总块数
    jobState.chunks = allNewChunks;
    jobState.totalChunks = allNewChunks.length;
    jobState.completedTTS = 0;
    jobState.completedTranscode = 0;

    logger.info(
      `[Orchestrator] Handled output text. Reconstructed ${jobState.totalChunks} chunks.`,
    );

    // 3. 执行 TTS 阶段
    await this.runTtsPhase();

    if (this.ctx.isCanceled()) return;

    // 4. 执行 Mux 混音阶段
    await this.runMuxPhase(allNewChunks, jobDir);

    logger.info(`[Orchestrator] Finished run successfully.`);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────

export { VOICE_WHITELIST, SEGMENTATION_RESPONSE_FORMAT, LlmSegmentationOutputSchema };
export type { LlmSegmentationOutput };
