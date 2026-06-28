/**
 * @file orchestrator.ts
 * @description V2 编排图（`src/orchestrator/`）的类型契约与 `zod` 校验 schema。
 *
 * 设计要点（见 `openspec/changes/langgraph-audiobook-pipeline/` 的 proposal/design/spec）：
 * - 类型与 schema 同源：用 `z.infer` 从 schema 推导类型，保证「运行时校验」与「编译期类型」天然对齐，
 *   杜绝二者漂移。节点输出经 schema 校验后才写回状态。
 * - `ScriptLine` 是逐句脚本单元：保留原文 `text`（**不可被决策节点改动**，否则破坏字符级对齐），
 *   外挂决策产物 `emotion` / `speedModifier`（DeepSeek 注入，失败回退 `neutral` / `1.0`）与可选 `ssml`（Phase 2 音素）。
 * - `CharacterRegistry` 按 `id` 键的画像表，跨章增量合并；已绑定的 `voiceId` 在合并时不被覆盖（杜绝声音漂移）。
 * - `OrchestratorGlobalState` / `OrchestratorChapterState` 是双层状态的语义接口；实际图状态由
 *   `src/orchestrator/state.ts` 的 `Annotation.Root` 落地（扁平存储，章节局部字段逐章重置）。
 *
 * 与既有 {@link JobState}（`src/types/job.ts`）的关系：分片级进度仍以 `JobState`/`state.json` 为权威
 * （SSE/GC/recovery 已消费它）；此处仅描述**阶段级**的编排状态。
 */

import { z } from 'zod';

// ─── 脚本单元 ────────────────────────────────────────────────────

/**
 * 单句脚本行。`text` 为对应原文片段（拼接后须逐字等于章节原文）；
 * `emotion` / `speedModifier` 由 Script Director 注入；`ssml` 留给 Phase 2 音素修正。
 */
export const ScriptLineSchema = z.object({
  /** 脚本行序号（章内从 0 开始） */
  index: z.number().int().nonnegative(),
  /** 说话人标识：`narrator` 或具名角色 id */
  speaker: z.string().min(1),
  /** 原文片段，**决策节点不得改动** */
  text: z.string(),
  /** 情绪标签（如 `neutral` / `happy` / `sad`）；缺失或非法时回退 `neutral` */
  emotion: z.string().min(1).default('neutral'),
  /** 语速系数，`1.0` 为原速；缺失或非法时回退 `1.0` */
  speedModifier: z.number().positive().default(1),
  /** 可选 SSML 音素修正串（Phase 2 g2pW 引擎产物） */
  ssml: z.string().optional(),
});

export type ScriptLine = z.infer<typeof ScriptLineSchema>;

/**
 * 一章的脚本清单：本章全部脚本行的有序集合。拼接各 `line.text` 须逐字等于章节原文。
 */
export const ScriptManifestSchema = z.object({
  /** 所属章节序号（从 0 开始） */
  chapterIndex: z.number().int().nonnegative(),
  /** 本章脚本行（按 `index` 升序） */
  lines: z.array(ScriptLineSchema),
});

export type ScriptManifest = z.infer<typeof ScriptManifestSchema>;

// ─── 角色注册表 ──────────────────────────────────────────────────

/**
 * 单个角色的画像。`voiceId` 一旦绑定即视为全书固定（reducer 不覆盖）；
 * Phase 1 具名角色可塌缩为任务 voice，故 `voiceId` 可选。
 */
export const CharacterProfileSchema = z.object({
  /** 身份键（说话人标识，与 `ScriptLine.speaker` 对齐） */
  id: z.string().min(1),
  /** 绑定音色；首次绑定后跨章稳定 */
  voiceId: z.string().optional(),
  /** 性别（Phase 2 角色匹配用） */
  gender: z.string().optional(),
  /** 年龄段（Phase 2 角色匹配用） */
  ageGroup: z.string().optional(),
  /** 风格标签（Phase 2 角色匹配用） */
  tags: z.array(z.string()).optional(),
  /** 声纹/文本向量（Phase 2 pgvector 注册表用） */
  embedding: z.array(z.number()).optional(),
});

export type CharacterProfile = z.infer<typeof CharacterProfileSchema>;

/**
 * 全书角色注册表：`身份键 → 画像`。由自定义 reducer 跨章增量合并，
 * 已绑定 `voiceId` 的条目在合并时不被覆盖。
 */
export const CharacterRegistrySchema = z.record(z.string(), CharacterProfileSchema);

export type CharacterRegistry = z.infer<typeof CharacterRegistrySchema>;

// ─── 章节分组（Chapter Splitter 产物） ──────────────────────────

/** 章节内单分片的精简结构（来自前端 `IncomingChunk`，剥离上传层细节，仅留对齐所需）。 */
export interface ChapterChunk {
  /** 全局分片序号（保留前端 index，供回填 `JobState.chunks`） */
  index: number;
  /** 待合成原文 */
  text: string;
}

/**
 * 图入口的原始未聚合分片（结构等价于 `JobManager.IncomingChunk`）。
 * 独立定义以避免 `orchestrator` ↔ `job-manager` 的循环依赖；Chapter Splitter 据其
 * `chapterIndex` 聚合成 {@link ChapterGroup}。
 */
export interface IncomingChapterChunk {
  /** 全局分片序号（从 0 开始，跨章节累计） */
  index: number;
  /** 所属章节序号（从 0 开始） */
  chapterIndex: number;
  /** 所属章节标题（可选） */
  chapterTitle?: string;
  /** 待合成原文 */
  text: string;
}

/**
 * Chapter Splitter 按 `chapterIndex` 聚合出的单章分组。**不重新切分**，
 * 仅把同一章的分片归拢并保留章节标题。
 */
export interface ChapterGroup {
  /** 所属章节序号（从 0 开始） */
  chapterIndex: number;
  /** 章节标题（来自前端，保留原样） */
  chapterTitle?: string;
  /** 本章包含的分片（按前端 index 升序） */
  chunks: ChapterChunk[];
}

// ─── 双层状态语义接口 ──────────────────────────────────────────

/**
 * 全局状态语义：项目元数据 + 主角色注册表 + 章节分组 + 迭代游标。
 * 跨章持久；`characterRegistry` 经 reducer 增量合并。
 */
export interface OrchestratorGlobalState {
  /** 任务/项目标识（= `JobState.jobId`） */
  projectId: string;
  /** 书名（= `JobState.title`） */
  title: string;
  /** 章节总数 */
  totalChapters: number;
  /** 全书角色注册表 */
  characterRegistry: CharacterRegistry;
  /** 有序章节分组（Chapter Splitter 产出） */
  chapters: ChapterGroup[];
  /** 当前正在处理的章节序号 */
  currentChapterIndex: number;
}

/**
 * 章节局部状态语义：仅本章登场角色 + 本章脚本清单 + QA 反馈 + 重试计数。
 * 每章处理开始时重置，避免跨章污染、控制长篇 Token 消耗。
 */
export interface OrchestratorChapterState {
  /** 本章标识（= chapterIndex 字符串化） */
  chapterId: string;
  /** 章节标题 */
  chapterTitle?: string;
  /** 本章登场角色画像（注入 LLM 决策节点以省 Token） */
  activeCharacters: CharacterProfile[];
  /** 本章逐句脚本清单 */
  scriptManifest: ScriptManifest;
  /** QA 校验错误（Phase 2 ASR/声纹回滚用） */
  qaErrors: string[];
  /** 本章重试计数（Phase 2 回滚重试用） */
  retryCount: number;
}

// ─── 确定性兜底常量 ──────────────────────────────────────────────

/** 确定性兜底使用的默认情绪。 */
export const NEUTRAL_EMOTION = 'neutral';
/** 确定性兜底使用的默认语速系数（原速）。 */
export const DEFAULT_SPEED_MODIFIER = 1;
/** 确定性兜底使用的默认说话人（单音色整段朗读）。 */
export const NARRATOR_SPEAKER = 'narrator';
