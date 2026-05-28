/**
 * @file text.ts
 * @description 文本预处理模块的核心类型定义。
 * 定义了 TTS 分块（TTSChunk）和章节（Chapter）的数据契约，
 * 供文本清洗、章节检测、分块切片等模块共享使用。
 */

/**
 * TTS 请求分块的数据结构。
 * 每个 Chunk 代表一段可直接送入 Edge-TTS 合成引擎的文本单元，
 * 且严格对齐到所属章节——任何分块绝不跨越章节边界。
 */
export interface TTSChunk {
  /** 全局唯一分片序号，从 0 开始，在整本书的所有分片中严格递增 */
  index: number;
  /** 所属章节序号（从 0 开始），标识该分片归属于哪一个物理/虚拟章节 */
  chapterIndex: number;
  /** 所属章节标题（如 "第一章 初入江湖" 或虚拟章节 "第 1 部分"） */
  chapterTitle: string;
  /** 待合成的文本内容（已经过编码转换和安全清洗） */
  text: string;
  /** 当前分片的精确字数（基于 Unicode 码点，剔除空白符） */
  charCount: number;
}

/**
 * 章节的内部数据结构。
 * 由章节检测算法产出，作为 TTS 分块阶段的输入。
 * 可以是正则检测到的物理章节，也可以是兜底方案产出的虚拟章节。
 */
export interface Chapter {
  /** 章节标题（如 "第一章 初入江湖" 或 "第 1 部分"） */
  title: string;
  /** 章节在全文中的起始字符索引（基于 string 的 index 位置） */
  startIndex: number;
  /** 章节的完整文本内容 */
  content: string;
}
