/**
 * @file text-processor.ts
 * @description 文本预处理模块的业务编排层。
 *
 * 负责章节检测（正则初筛 + 四重后置校验）、虚拟章节兜底切分、
 * TTS 请求块切片（标点回退算法），以及完整处理管线的入口编排。
 *
 * 依赖：
 * - `src/utils/text.ts`：编码检测、文本清洗、字数统计、中文数字转换等工具函数
 * - `src/types/text.ts`：`TTSChunk`、`Chapter` 类型定义
 */

import type { TTSChunk, Chapter } from '../types/text.js';
import {
  decodeBuffer,
  sanitizeText,
  getCleanCharCount,
  chineseToNumber,
} from '../utils/text.js';

// ============================================================================
// 1. 章节检测常量与正则
// ============================================================================

/**
 * 章节匹配正则表达式（多行模式）。
 *
 * 匹配规则：
 * - 行首可有可选空白
 * - 关键词：序章|楔子|引子|尾声|后记|番外(篇)  或  第X章/回/卷/集/节/篇/部
 *   - X 支持中文数字（一二三…万）和阿拉伯数字
 * - 可选的章节标题（空白分隔，最多 40 字符）
 * - 行尾可有可选空白
 *
 * 使用 `gm` 标志：
 * - `g`：全局匹配，找出所有候选
 * - `m`：多行模式，`^` 和 `$` 匹配每行的起止
 */
const CHAPTER_REGEX =
  /^\s*(序章|楔子|引子|尾声|后记|番外(?:篇)?|第\s*[一二三四五六七八九十百千万零\d]+\s*(?:章|回|卷|集|节|篇|部))(?:[\s\u3000]+\S[^\n]{0,40})?\s*$/gm;

/** 虚拟章节的目标字数（约 15,000 字） 检测不到章节时的兜底*/
const VIRTUAL_CHAPTER_SIZE = 15000;

/** 章节标题的最大允许长度（字符数） */
const MAX_CHAPTER_LINE_LENGTH = 40;

/** 有效章节的平均字数下界 */
const MIN_AVG_CHAPTER_CHARS = 1000;

/** 有效章节的平均字数上界 */
const MAX_AVG_CHAPTER_CHARS = 50000;

/** 最少有效章节数量阈值 */
const MIN_VALID_CHAPTER_COUNT = 3;

/** TTS 分块时标点回退的搜索窗口大小（字符数） */
const PUNCTUATION_FALLBACK_WINDOW = 200;

/**
 * 标点回退切分的优先级列表。
 * 从最优（段落分隔）到最差（逗号）排列，
 * 搜索时按优先级顺序在窗口内从后向前查找。
 */
const SPLIT_PUNCTUATION_PRIORITY: string[] = [
  '\n\n', // 空行（段落分隔）——最优切分点
  '\n', // 单换行
  '。', // 句号
  '！', // 叹号
  '？', // 问号
  '；', // 分号
  '，', // 逗号——最差切分点
];

/** 默认 TTS 分块大小（字数） */
const DEFAULT_CHUNK_SIZE = 2500;

/** TTS 分块大小的最小值 */
const MIN_CHUNK_SIZE = 1000;

/** TTS 分块大小的最大值 */
const MAX_CHUNK_SIZE = 5000;

// ============================================================================
// 2. 章节检测核心算法
// ============================================================================

/**
 * 检测文本中的物理章节，使用正则初筛 + 四重后置校验。
 *
 * 算法流程：
 * 1. 正则初筛：使用 `CHAPTER_REGEX` 全局匹配所有候选章节行
 * 2. 行长度校验：候选行整行长度 ≤ 40 字符
 * 3. 物理空行校验：候选行前后必须有空行（或位于文本首尾）
 * 4. 序号单调递增校验：提取数字部分，确保严格递增
 * 5. 总数合理性校验：平均章节字数在 [1000, 50000] 范围内，且章节数 ≥ 3
 *
 * 若校验失败，调用 `splitVirtualChapters` 进行虚拟章节兜底切分。
 *
 * @param text - 已清洗的完整文本
 * @returns 检测到的章节数组（物理章节或虚拟章节）
 */
export function detectChapters(text: string): Chapter[] {
  // 步骤 1：正则初筛 —— 收集所有匹配的候选章节行及其位置
  const candidates: Array<{
    title: string;
    index: number;
    matchedKeyword: string;
  }> = [];

  // 重置正则的 lastIndex（因为使用了 g 标志）
  CHAPTER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHAPTER_REGEX.exec(text)) !== null) {
    const fullMatch = match[0];
    const leadingWhitespaceLength = fullMatch.length - fullMatch.trimStart().length;
    candidates.push({
      title: fullMatch.trim(), // 完整匹配行（去除首尾空白）
      index: match.index + leadingWhitespaceLength, // 匹配在全文中的真实字符偏移（排除前面的空白）
      matchedKeyword: match[1], // 捕获组：章节关键词部分（如 "第一章"、"序章"）
    });
  }

  // 步骤 2：行长度校验 —— 移除整行长度超过 40 字符的候选
  const lengthFiltered = candidates.filter(
    (c) => c.title.length <= MAX_CHAPTER_LINE_LENGTH,
  );

  // 步骤 3：物理空行校验 —— 章节行必须是独立段落
  // 条件：前面是文本起点或空行，后面是文本终点或空行
  const isolationFiltered = lengthFiltered.filter((c) => {
    // 检查前方：是否为文本开头，或者前面有空行（\n\n）
    const beforeText = text.substring(0, c.index);
    const isAtStart = c.index === 0;
    const hasPrecedingBlankLine =
      beforeText.endsWith('\n\n') || beforeText.trimEnd().length === 0;

    // 检查后方：是否为文本结尾，或者后面有空行（\n\n）
    const afterStart = c.index + c.title.length;
    const afterText = text.substring(afterStart);
    const isAtEnd = afterStart >= text.length;
    const hasFollowingBlankLine =
      afterText.startsWith('\n\n') || afterText.trimStart().length === 0;

    return (isAtStart || hasPrecedingBlankLine) &&
      (isAtEnd || hasFollowingBlankLine);
  });

  // 步骤 4：序号单调递增校验
  // 提取每个候选章节的数字部分并转为阿拉伯整数
  // 对于特殊关键词（序章、楔子等），不参与递增校验，直接通过
  const numberedChapters: Array<{
    title: string;
    index: number;
    chapterNum: number;
    isSpecial: boolean;
  }> = [];

  const specialKeywords = new Set([
    '序章',
    '楔子',
    '引子',
    '尾声',
    '后记',
    '番外',
    '番外篇',
  ]);

  for (const c of isolationFiltered) {
    if (specialKeywords.has(c.matchedKeyword)) {
      // 特殊关键词不需要数字校验，直接保留
      numberedChapters.push({
        title: c.title,
        index: c.index,
        chapterNum: -1, // 标记为特殊章节
        isSpecial: true,
      });
    } else {
      // 普通章节（如"第X章"）：提取并转换数字部分
      const num = chineseToNumber(c.matchedKeyword);
      numberedChapters.push({
        title: c.title,
        index: c.index,
        chapterNum: num,
        isSpecial: false,
      });
    }
  }

  // 对非特殊章节进行严格单调递增校验
  // 使用贪心策略：维护最后一个有效数字，只保留严格递增的章节
  const monotonicFiltered: typeof numberedChapters = [];
  let lastNum = -Infinity;

  for (const c of numberedChapters) {
    if (c.isSpecial) {
      // 特殊章节直接通过，不影响递增序列
      monotonicFiltered.push(c);
    } else if (c.chapterNum > lastNum) {
      // 数字严格大于上一个有效数字，通过校验
      monotonicFiltered.push(c);
      lastNum = c.chapterNum;
    }
    // 否则跳过（非递增的章节被剔除）
  }

  // 步骤 5：总数合理性校验
  const totalCharCount = getCleanCharCount(text);

  if (monotonicFiltered.length < MIN_VALID_CHAPTER_COUNT) {
    // 有效章节数不足 3，触发虚拟章节兜底
    return splitVirtualChapters(text);
  }

  const avgCharsPerChapter = totalCharCount / monotonicFiltered.length;
  if (
    avgCharsPerChapter < MIN_AVG_CHAPTER_CHARS ||
    avgCharsPerChapter > MAX_AVG_CHAPTER_CHARS
  ) {
    // 平均章节字数不在合理范围内，触发虚拟章节兜底
    return splitVirtualChapters(text);
  }

  // 步骤 6：构建 Chapter 数组
  // 每个章节的内容 = 从当前章节标题开始到下一章节标题（或文本末尾）
  const chapters: Chapter[] = [];
  for (let i = 0; i < monotonicFiltered.length; i++) {
    const current = monotonicFiltered[i];
    const nextIndex =
      i + 1 < monotonicFiltered.length
        ? monotonicFiltered[i + 1].index
        : text.length;

    // 章节内容从标题行后开始（跳过标题行本身后的换行符）
    const titleEnd = current.index + current.title.length;
    const content = text.substring(titleEnd, nextIndex).trim();

    chapters.push({
      title: current.title,
      startIndex: current.index,
      content,
    });
  }

  return chapters;
}

// ============================================================================
// 3. 虚拟章节兜底
// ============================================================================

/**
 * 将文本按约 15,000 字进行虚拟章节切分（兜底方案）。
 *
 * 当物理章节检测失败（有效章节数 < 3 或平均字数不在合理范围）时调用。
 * 在最接近 15,000 字处的段落换行符 `\n\n` 处断开，
 * 虚拟章节命名为 `"第 1 部分"`, `"第 2 部分"` 等。
 *
 * @param text - 已清洗的完整文本
 * @returns 虚拟章节数组
 */
export function splitVirtualChapters(text: string): Chapter[] {
  const chapters: Chapter[] = [];

  // 步骤 1：将文本按 Unicode 码点展开为数组，以便按"字数"（非字节数）精确定位
  const codePoints = Array.from(text);
  let partNumber = 1;
  let startIdx = 0; // 当前虚拟章节在原始 string 中的起始字符索引

  while (startIdx < text.length) {
    // 步骤 2：计算从 startIdx 开始的 VIRTUAL_CHAPTER_SIZE 个非空白码点对应的字符串位置
    let charCount = 0;
    let endIdx = startIdx;

    // 遍历字符，统计非空白码点数量
    for (let i = startIdx; i < text.length; i++) {
      // 使用 codePointAt 来正确处理代理对
      const char = text[i];
      if (!/\s/.test(char)) {
        charCount++;
      }
      endIdx = i + 1;

      if (charCount >= VIRTUAL_CHAPTER_SIZE) {
        break;
      }
    }

    // 步骤 3：如果还没到文本末尾，在 endIdx 附近寻找最近的 \n\n 作为切分点
    if (endIdx < text.length) {
      // 在 endIdx 前后寻找最近的段落分隔符 \n\n
      const searchWindow = text.substring(
        Math.max(startIdx, endIdx - 500),
        Math.min(text.length, endIdx + 500),
      );
      const windowStart = Math.max(startIdx, endIdx - 500);

      // 从预期切分位置向两侧搜索最近的 \n\n
      let bestSplitIdx = -1;
      let bestDistance = Infinity;

      let searchPos = 0;
      while (
        (searchPos = searchWindow.indexOf('\n\n', searchPos)) !== -1
      ) {
        const absolutePos = windowStart + searchPos + 2; // +2 跳过 \n\n 本身
        const distance = Math.abs(absolutePos - endIdx);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestSplitIdx = absolutePos;
        }
        searchPos++;
      }

      // 如果找到了段落分隔符，使用它作为切分点
      if (bestSplitIdx !== -1) {
        endIdx = bestSplitIdx;
      }
    } else {
      // 已经到达文本末尾
      endIdx = text.length;
    }

    // 步骤 4：提取章节内容并创建 Chapter 对象
    const content = text.substring(startIdx, endIdx).trim();
    if (content.length > 0) {
      chapters.push({
        title: `第 ${partNumber} 部分`,
        startIndex: startIdx,
        content,
      });
      partNumber++;
    }

    startIdx = endIdx;
  }

  // 边界情况：如果整个文本非常短，确保至少有一个章节
  if (chapters.length === 0 && text.trim().length > 0) {
    chapters.push({
      title: '第 1 部分',
      startIndex: 0,
      content: text.trim(),
    });
  }

  return chapters;
}

// ============================================================================
// 4. TTS 请求块切片
// ============================================================================

/**
 * 将单个章节切分为多个 TTS 请求分块。
 *
 * 在章节内部按 `chunkSize` 窗口进行切分，使用标点回退算法确保
 * 分块在自然断句处切割，以保证 TTS 合成的语音自然度。
 *
 * 标点回退算法：
 * 1. 从当前位置截取 chunkSize 个字符作为窗口
 * 2. 若窗口未到章节末尾，在窗口最后 200 字内从后向前查找最优标点
 * 3. 标点优先级：\n\n > \n > 。 > ！ > ？ > ； > ，
 * 4. 找到则在标点处断开；未找到则硬截断
 *
 * @param chapter - 待切分的章节
 * @param chapterIndex - 章节在全书中的序号（从 0 开始）
 * @param globalIndex - 全局分片起始序号（累计前序章节的分块数）
 * @param chunkSize - 每个分块的目标字数（默认 2500）
 * @returns 该章节生成的 TTSChunk 数组
 */
export function splitChapterIntoChunks(
  chapter: Chapter,
  chapterIndex: number,
  globalIndex: number,
  chunkSize: number,
): TTSChunk[] {
  const chunks: TTSChunk[] = [];
  const content = chapter.content;

  // 边界情况：空章节直接返回空数组
  if (!content || content.trim().length === 0) {
    return chunks;
  }

  let currentPos = 0; // 当前在章节内容中的字符位置
  let chunkIndex = globalIndex; // 全局分片序号

  while (currentPos < content.length) {
    // 步骤 1：截取 chunkSize 个字符作为窗口
    // 注意：这里使用的是码点级别的切分，通过 Array.from 确保不切断代理对
    const remaining = content.substring(currentPos);
    const remainingCodePoints = Array.from(remaining);

    if (remainingCodePoints.length <= chunkSize) {
      // 剩余内容不超过 chunkSize，整体作为最后一个分块
      const chunkText = remaining.trim();
      if (chunkText.length > 0) {
        chunks.push({
          index: chunkIndex,
          chapterIndex,
          chapterTitle: chapter.title,
          text: chunkText,
          charCount: getCleanCharCount(chunkText),
        });
        chunkIndex++;
      }
      break;
    }

    // 步骤 2：获取 chunkSize 个码点对应的字符串
    const windowText = remainingCodePoints.slice(0, chunkSize).join('');

    // 步骤 3：在窗口最后 PUNCTUATION_FALLBACK_WINDOW 字内从后向前查找最优标点
    let splitPos = windowText.length; // 默认：硬截断位置

    // 计算回退搜索窗口的起始位置
    const fallbackStart = Math.max(
      0,
      windowText.length - PUNCTUATION_FALLBACK_WINDOW,
    );
    const fallbackWindow = windowText.substring(fallbackStart);

    // 按优先级从高到低搜索标点
    let foundPunctuation = false;
    for (const punct of SPLIT_PUNCTUATION_PRIORITY) {
      // 从后向前查找该标点在回退窗口中的最后一次出现
      const lastIdx = fallbackWindow.lastIndexOf(punct);
      if (lastIdx !== -1) {
        // 找到标点：计算在 windowText 中的绝对位置
        // 切分点在标点之后（包含标点在当前分块中）
        splitPos = fallbackStart + lastIdx + punct.length;
        foundPunctuation = true;
        break; // 使用最高优先级的标点
      }
    }

    // 步骤 4：根据切分位置生成分块
    const chunkText = windowText.substring(0, splitPos).trim();
    if (chunkText.length > 0) {
      chunks.push({
        index: chunkIndex,
        chapterIndex,
        chapterTitle: chapter.title,
        text: chunkText,
        charCount: getCleanCharCount(chunkText),
      });
      chunkIndex++;
    }

    // 步骤 5：更新 currentPos，跳过已处理的字符
    // splitPos 是基于 windowText（码点 join 后的字符串）的位置
    currentPos += splitPos;
  }

  return chunks;
}

// ============================================================================
// 5. 完整处理管线
// ============================================================================

/**
 * 文本预处理完整管线入口。
 *
 * 执行流程：
 * 1. 编码检测与解码：将原始 Buffer 转为 UTF-8 字符串
 * 2. 文本清洗：过滤 HTML 标签、规范化换行符、压缩空白
 * 3. 章节检测：正则初筛 + 四重后置校验，失败时虚拟章节兜底
 * 4. TTS 分块：在每章内按 chunkSize 进行标点回退切分
 * 5. 返回结构化的 TTSChunk[] 数组
 *
 * @param buffer - 上传文件的原始字节 Buffer
 * @param chunkSize - TTS 分块大小（默认 2500 字，范围 1000~5000）
 * @returns 完整的 TTS 分块数组，可直接送入合成引擎
 *
 * @example
 * ```typescript
 * const buffer = fs.readFileSync('novel.txt');
 * const chunks = processText(buffer);
 * // chunks: TTSChunk[] — 每个元素包含 index, chapterIndex, chapterTitle, text, charCount
 * ```
 */
export function processText(
  buffer: Buffer,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): TTSChunk[] {
  // 步骤 1：校验并规范化 chunkSize 参数
  const normalizedChunkSize = Math.max(
    MIN_CHUNK_SIZE,
    Math.min(MAX_CHUNK_SIZE, chunkSize),
  );

  // 步骤 2：编码检测与解码 —— 将未知编码的 Buffer 转为 UTF-8 字符串
  const rawText = decodeBuffer(buffer);

  // 步骤 3：文本清洗 —— 过滤 HTML 标签、规范化换行符、压缩空白
  const cleanedText = sanitizeText(rawText);

  // 步骤 4：章节检测 —— 正则初筛 + 四重后置校验，或虚拟章节兜底
  const chapters = detectChapters(cleanedText);

  // 步骤 5：TTS 分块 —— 在每章内按 chunkSize 进行标点回退切分
  const allChunks: TTSChunk[] = [];
  let globalIndex = 0; // 全局分片序号计数器

  for (let i = 0; i < chapters.length; i++) {
    const chapterChunks = splitChapterIntoChunks(
      chapters[i],
      i,
      globalIndex,
      normalizedChunkSize,
    );
    allChunks.push(...chapterChunks);
    globalIndex += chapterChunks.length;
  }

  return allChunks;
}
