/**
 * @file text.ts
 * @description 文本预处理模块的纯函数工具集。
 *
 * 包含以下功能：
 * - 编码检测与解码（`detectEncoding` / `decodeBuffer`）
 * - SSML 防注入清洗（`cleanHtmlTags` / `normalizeLineEndings` / `trimAndCompressWhitespace` / `sanitizeText`）
 * - 精确 Unicode 字数统计（`getCleanCharCount`）
 * - 中文数字转阿拉伯数字（`chineseToNumber`）
 *
 * 所有函数均为纯函数（除 `decodeBuffer` 依赖 iconv-lite 解码），
 * 可独立进行单元测试。
 */

import jschardet from 'jschardet';
import iconv from 'iconv-lite';

// ============================================================================
// 1. 编码检测与解码
// ============================================================================

/**
 * 检测字节流的文本编码。
 *
 * 使用 `jschardet` 对输入 Buffer 的前 64KB 进行采样检测，
 * 当置信度不足或编码不被 `iconv-lite` 支持时，回退到 UTF-8。
 * 同时将常见的中文编码别名（GB2312、GBK）规范化为 `iconv-lite` 可识别的格式。
 *
 * @param buffer - 上传文件的完整字节 Buffer
 * @returns 规范化后的编码名称字符串（如 `"utf-8"`, `"gbk"`, `"gb18030"`）
 *
 * @example
 * ```typescript
 * const encoding = detectEncoding(fileBuffer);
 * // => "utf-8" | "gbk" | "gb18030" | ...
 * ```
 */
export function detectEncoding(buffer: Buffer): string {
  // 步骤 1：截取前 64KB 作为采样数据，避免对大文件全量检测浪费内存
  const SAMPLE_SIZE = 64 * 1024;
  const sample = buffer.subarray(0, Math.min(buffer.length, SAMPLE_SIZE));

  // 步骤 2：使用 jschardet 进行编码检测，返回 { encoding, confidence }
  const detected = jschardet.detect(sample);

  // 步骤 3：检查置信度是否满足阈值要求（0.8）
  if (!detected || !detected.encoding || detected.confidence < 0.8) {
    // 置信度不足，回退为 UTF-8（安全默认值）
    return 'utf-8';
  }

  // 步骤 4：将检测到的编码名称统一为大写以便进行映射比较
  const rawEncoding = detected.encoding.toUpperCase();

  // 步骤 5：规范化中文编码别名
  // jschardet 可能返回 "GB2312"，但 iconv-lite 更适合使用 "gb18030"（GB2312 的超集）
  // jschardet 返回 "GBK" 时直接映射为 "gbk"
  if (rawEncoding === 'GB2312') {
    return 'gb18030';
  }
  if (rawEncoding === 'GBK') {
    return 'gbk';
  }

  // 步骤 6：检查 iconv-lite 是否支持该编码
  const normalizedEncoding = detected.encoding.toLowerCase();
  if (!iconv.encodingExists(normalizedEncoding)) {
    // 不支持的编码，回退为 UTF-8
    return 'utf-8';
  }

  return normalizedEncoding;
}

/**
 * 将文件字节 Buffer 解码为 UTF-8 字符串。
 *
 * 首先调用 `detectEncoding` 检测编码，然后使用 `iconv-lite.decode` 进行解码转换。
 * 无论原始文件是什么编码，最终都返回标准的 TypeScript `string`（即 UTF-16 内部表示）。
 *
 * @param buffer - 上传文件的完整字节 Buffer
 * @returns 解码后的 UTF-8 字符串
 *
 * @example
 * ```typescript
 * const text = decodeBuffer(fs.readFileSync('novel.txt'));
 * ```
 */
export function decodeBuffer(buffer: Buffer): string {
  // 步骤 1：检测文件编码
  const encoding = detectEncoding(buffer);

  // 步骤 2：使用 iconv-lite 将完整 Buffer 按检测到的编码解码为字符串
  return iconv.decode(buffer, encoding);
}

// ============================================================================
// 2. 文本防注入清洗
// ============================================================================

/**
 * 过滤文本中的所有 HTML/XML 标签。
 *
 * 防止 SSML 注入攻击：Edge-TTS 的 WebSocket 通信使用 SSML XML 格式，
 * 若用户文本中夹杂 `<speak>`、`<voice>` 等标签，会干扰底层 XML 生成。
 * 使用贪婪正则匹配 `<...>` 结构并移除。
 *
 * @param text - 待清洗的原始文本
 * @returns 移除所有 HTML/XML 标签后的纯文本
 *
 * @example
 * ```typescript
 * cleanHtmlTags('Hello <speak>World</speak>');
 * // => 'Hello World'
 * ```
 */
export function cleanHtmlTags(text: string): string {
  // 使用正则匹配所有 < 到 > 之间的内容（包括自闭合标签如 <br/>）
  return text.replace(/<[^>]*>/g, '');
}

/**
 * 规范化换行符，将 Windows 风格的 `\r\n` 统一替换为 Unix 风格的 `\n`。
 *
 * 确保后续所有文本处理逻辑只需处理单一换行符格式，
 * 避免在章节检测和分块时因混合换行符导致的偏移计算错误。
 *
 * @param text - 待处理的文本
 * @returns 换行符统一为 `\n` 的文本
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * 行首行尾空白修剪与连续空行压缩。
 *
 * 执行两个清洗操作：
 * 1. 移除每一行首尾的无意义空白字符（包括全角空格 `\u3000`、半角空格、制表符 `\t`）
 * 2. 将连续 3 个及以上的换行符（即 2+ 连续空行）压缩为恰好 2 个换行符 `\n\n`
 *
 * @param text - 待处理的文本
 * @returns 修剪并压缩空白后的文本
 */
export function trimAndCompressWhitespace(text: string): string {
  // 步骤 1：按行拆分，对每行进行首尾空白修剪
  // 匹配行首和行尾的空格（半角）、全角空格（\u3000）和制表符（\t）
  const trimmedLines = text
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''));

  // 步骤 2：重新拼合
  let result = trimmedLines.join('\n');

  // 步骤 3：将连续 3 个及以上的换行符压缩为 2 个（保留段落间的单空行分隔）
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

/**
 * 文本统一清洗入口，依次执行：
 * 1. HTML/XML 标签过滤（防 SSML 注入）
 * 2. 换行符规范化（`\r\n` → `\n`）
 * 3. 行首行尾空白修剪 + 连续空行压缩
 *
 * @param text - 原始文本
 * @returns 完全清洗后的安全文本
 */
export function sanitizeText(text: string): string {
  // 管线式调用：每一步的输出作为下一步的输入
  let cleaned = cleanHtmlTags(text);
  cleaned = normalizeLineEndings(cleaned);
  cleaned = trimAndCompressWhitespace(cleaned);
  return cleaned;
}

// ============================================================================
// 3. 精确字数统计
// ============================================================================

/**
 * 计算文本的精确字数（基于 Unicode 码点，剔除所有空白符）。
 *
 * JavaScript 的 `String.prototype.length` 基于 UTF-16 编码单元计数，
 * 遇到 Emoji 或其他辅助平面字符（代理对 Surrogate Pairs）时会被计为 2。
 * 本函数使用 `Array.from()` 将字符串按 Unicode 码点展开，
 * 然后过滤掉所有空白字符（空格、换行、制表符等），返回真实的字符计数。
 *
 * @param text - 待统计的文本
 * @returns 剔除空白后的 Unicode 码点数量
 *
 * @example
 * ```typescript
 * getCleanCharCount('你好 世界');  // => 4
 * getCleanCharCount('你好😀世界'); // => 5（Emoji 计为 1 个码点）
 * ```
 */
export function getCleanCharCount(text: string): number {
  // 步骤 1：使用 Array.from 将字符串按 Unicode 码点展开为数组
  // 这确保了代理对（如 Emoji）被正确识别为单个元素
  // 步骤 2：过滤掉所有匹配 \s 的空白字符（空格、\n、\t、\r 等）
  // 步骤 3：返回过滤后的数组长度即为精确字数
  return Array.from(text).filter((char) => !/\s/.test(char)).length;
}

// ============================================================================
// 4. 中文数字转阿拉伯数字
// ============================================================================

/**
 * 将中文数字字符串转换为阿拉伯数字整数。
 *
 * 支持以下格式：
 * - 纯阿拉伯数字：`"123"` → `123`
 * - 简单中文数字：`"三"` → `3`
 * - 复合中文数字：`"二十三"` → `23`、`"一百零五"` → `105`
 * - 带"十"开头的简写：`"十二"` → `12`（省略前缀"一"）
 * - 万级数字：`"一万两千三百"` → `12300`
 *
 * 输入字符串中的 `第`、`章`、`节`、`回`、`卷`、`集`、`篇`、`部` 等
 * 章节标记字符会被自动清除，仅保留数字相关字眼进行解析。
 *
 * @param chineseStr - 包含中文或阿拉伯数字的章节标记字符串（如 `"第二十三章"`）
 * @returns 转换后的阿拉伯整数（如 `23`）
 *
 * @example
 * ```typescript
 * chineseToNumber('第一百零五章');  // => 105
 * chineseToNumber('第十二回');       // => 12
 * chineseToNumber('第123章');       // => 123
 * ```
 */
export function chineseToNumber(chineseStr: string): number {
  // 数字字符映射表：中文数字和阿拉伯数字均映射到对应的整数值
  const numberMap: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    '0': 0,
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
  };

  // 单位字符映射表：十、百、千、万对应的乘法因子
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
  };

  // 步骤 1：清洗非数字字符，移除章节标记关键字和空白
  const cleanStr = chineseStr.replace(/[第章节回卷集篇部\s]/g, '');

  // 步骤 2：优先处理纯阿拉伯数字的情况（如 "123"），直接 parseInt 返回
  if (/^\d+$/.test(cleanStr)) {
    return parseInt(cleanStr, 10);
  }

  // 步骤 3：逐字符解析中文数字
  let total = 0; // 万级以上的累计总和
  let section = 0; // 当前万级以内的部分累计
  let number = 0; // 临时存储当前待处理的数字值

  for (let i = 0; i < cleanStr.length; i++) {
    const char = cleanStr[i];

    if (numberMap[char] !== undefined) {
      // 当前字符是数字：暂存到 number，等待后续的单位字符来决定乘法
      number = numberMap[char];

      // 特殊情况：如果是最后一个字符且没有后续单位，直接累加到 section
      // 例如 "二十三" 中的 "三" 是末尾数字，直接加到 section
      if (i === cleanStr.length - 1) {
        section += number;
      }
    } else if (unitMap[char] !== undefined) {
      const unit = unitMap[char];

      if (unit === 10000) {
        // "万"级单位：将当前 section + number 乘以 10000 累加到 total
        section += number;
        if (section === 0) section = 1; // 兼容 "万" 字开头（表示一万）
        total += section * 10000;
        section = 0;
        number = 0;
      } else if (unit === 10) {
        // "十"级单位：特殊处理省略前缀"一"的情况
        // 例如 "十二" 等价于 "一十二"，此时 number 为 0 且 section 也为 0
        if (number === 0 && section === 0) {
          number = 1; // 隐含的"一"
        }
        section += number * unit;
        number = 0;
      } else {
        // "百"或"千"级单位：number × unit 累加到 section
        section += number * unit;
        number = 0;
      }
    }
    // 忽略不在映射表中的字符（如意外混入的标点）
  }

  // 步骤 4：返回万级累计 + 万以内累计的最终结果
  return total + section;
}
