# 3. 文本清洗与切片模块 (Text Preprocessor & Splitter) 详细执行步骤

本模块负责将用户上传的未知编码原始文本转换为标准 UTF-8，过滤有害标签，精确切分章节和 TTS 请求块，并提供精确的字数统计。

> [!IMPORTANT]
> **代码注释约束**：
> 必须为本模块定义的所有函数（如字符集检测、繁简判定、字数统计等）以及核心算法（如 `chineseToNumber` 中文数字转换、基于正则与四重后置校验的章节匹配、标点回退切片等）编写详细的 JSDoc 以及步骤级行内注释。

---

## 3.1 文本编码检测与解码

用户上传的 `.txt` 文件可能是 UTF-8、GBK、GB18030 等各种编码。为保证系统内部处理的一致性，必须流式读取前 64KB 的字节流作为样本进行检测，并使用 `iconv-lite` 对整体进行正确解码。

### 详细步骤：
1. **采样检测**：
   - 读取上传文件的前 64KB 字节数据。
   - 使用 `jschardet.detect(buffer)` 得到 `{ encoding, confidence }`。
2. **规范化判断**：
   - 若 `confidence < 0.8` 或编码无法被 `iconv-lite` 识别，则默认采用 `utf-8`。
   - 若判定编码为 `GB2312` 或 `GBK`，则映射为 `gbk` / `gb18030` 解码。
3. **解码转换**：
   - 使用 `iconv-lite.decode(fullBuffer, detectedEncoding)` 将完整文件解析为标准的 TypeScript `string`。

---

## 3.2 文本防注入清洗

因为 Edge-TTS 的 WebSocket 通信使用的是 SSML (Speech Synthesis Markup Language) XML 格式，如果用户文本中夹杂了 `<speak>`、`<voice>` 等标签，会干扰底层的 XML 生成，导致服务出错甚至发生 SSML 注入攻击。

### 清洗规则：
1. **过滤 XML 标签**：使用正则表达式过滤掉所有 HTML/XML 标签：
   ```typescript
   function cleanHtmlTags(text: string): string {
     return text.replace(/<[^>]*>/g, '');
   }
   ```
2. **换行符规范化**：将所有的 `\r\n` 替换为 `\n`。
3. **空行与空白压缩**：
   - 过滤行首、行尾的无意义空白字符（包括全角/半角空格和 `\t`）。
   - 将连续 3 个及以上的换行符（即连续空行）压缩为双换行 `\n\n`，保证排版整洁。

---

## 3.3 精确字数统计

在系统所有统计口径中，“字数”指**剔除空白符（空格、换行、制表符等）后的 Unicode 码点 (Code Point) 数量**。
* 注意：JavaScript 的 `.length` 遇到 Emoji 或某些特殊字符时（如代理对/Surrogate Pairs）会计算为两个字符，所以必须使用 `[...text]` 或 `Array.from` 展开。

### 核心实现：
```typescript
export function getCleanCharCount(text: string): number {
  return [...text].filter(char => !/\s/.test(char)).length;
}
```

---

## 3.4 章节检测与四重校验算法

为了获得 100% 精确的章节时间戳，必须正确地从小说中提取出真实的物理章节。算法由**正则初筛**和**四重后置校验**构成。

### 2.4.1 正则初筛
使用以下正则匹配作为候选章节行（开启 `m` 多行模式，且确保它是独立的一行）：
```typescript
const CHAPTER_REGEX = /^\s*(序章|楔子|引子|尾声|后记|番外(?:篇)?|第\s*[一二三四五六七八九十百千万零\d]+\s*(?:章|回|卷|集|节|篇|部))(?:[\s\u3000]+\S[^\n]{0,40})?\s*$/m;
```

### 2.4.2 四重后置校验

1. **行长度校验**：候选章节行的整行长度（包含“第 X 章”及标题名字）必须 `≤ 40` 个字符（防止将一段很长的正文错配为章节）。
2. **物理空行校验**：章节行的上一非空行和下一非空行之间，章节行本身必须是一个独立的物理段落（前有空行，后有空行，或位于文本的起点与终点）。
3. **序号严格单调递增校验**：
   - 从章节字符串中提取出“数字”部分，转换为阿拉伯整数。
   - 对全书章节的阿拉伯整数进行递增校验。若某章数字非递增（例如“第一章” -> “第二章” -> “第一章重新叙述”），则将其剔除。

#### 中文数字转阿拉伯数字算法实现：
在 `src/utils/text.ts` 中手写一个不依赖外部库的轻量转换工具：

```typescript
export function chineseToNumber(chineseStr: string): number {
  const numberMap: Record<string, number> = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9
  };
  const unitMap: Record<string, number> = {
    '十': 10, '百': 100, '千': 1000, '万': 10000
  };

  // 清洗非中文字符，仅保留数字字眼
  const cleanStr = chineseStr.replace(/[第章节回卷集节篇部\s]/g, '');
  
  // 优先处理纯阿拉伯数字
  if (/^\d+$/.test(cleanStr)) {
    return parseInt(cleanStr, 10);
  }

  let total = 0;
  let section = 0; // 当前万级以内的部分
  let number = 0;  // 临时存储数字

  for (let i = 0; i < cleanStr.length; i++) {
    const char = cleanStr[i];
    if (numberMap[char] !== undefined) {
      number = numberMap[char];
      if (i === cleanStr.length - 1) {
        section += number;
      }
    } else if (unitMap[char] !== undefined) {
      const unit = unitMap[char];
      if (unit === 10000) {
        section += number;
        if (section === 0) section = 1; // 兼容“万”字开头
        total += section * 10000;
        section = 0;
        number = 0;
      } else if (unit === 10) {
        if (number === 0 && section === 0) {
          number = 1; // 兼容“十”、“第十”开头的情况
        }
        section += number * unit;
        number = 0;
      } else {
        section += number * unit;
        number = 0;
      }
    }
  }
  return total + section;
}
```

4. **总数合理性校验与虚拟章节划分兜底**：
   - 提取校验后得到有效章节数。若：
     $$\text{全文字数} / \text{有效章节数} \notin [1000, 50000]$$
     或者有效章节数 `< 3`，则认为此文无规范的章节排版。
   - **兜底方案**：执行**虚拟章节划分**，按照每 `15,000` 字作为一个虚拟章节强制切开。在最接近 15,000 字处的段落换行符 `\n\n` 处断开。虚拟章节分别自动命名为 `"第 1 部分"`, `"第 2 部分"` 等。

---

## 3.5 TTS 请求块切片（强制章节对齐 & 标点回退）

在已划分出的物理/虚拟章节内部，因为章节内容可能超过 `chunkSize`（默认 2500 字，可配置 1000~5000），需要再次进行细分分块（即 TTS 请求的 Chunk 单元），分块时必须遵循以下算法：

1. **绝对对齐**：任何分块绝不允许跨越章节。每个分块都属于唯一的一章。
2. **回退切分算法**：
   - 在当前章节内，从起始位置截取 `chunkSize` 字数的窗口。
   - 若窗口末尾未达到章节末尾，则在窗口最后的 `200` 字内，**从后向前**检索最合适的句末停顿符号切开。
   - 匹配符号优先级顺序：`\n\n`（空行） > `\n`（单换行） > `。`（句号） > `！`（叹号） > `？`（问号） > `；`（分号） > `，`（逗号）。
   - 若检索到符号，在此符号位置断开分块，下一分块从符号的后一位开始。
   - 若在最后 200 字内未找到任何上述符号，则**硬截断**（在 `chunkSize` 边界处直接截开）。
3. **输出定义**：
   每个 Chunk 实例的数据结构应该为：
   ```typescript
   export interface TTSChunk {
     index: number;        // 全局唯一分片序号，从 0 开始
     chapterIndex: number; // 所属章节序号
     chapterTitle: string; // 所属章节标题
     text: string;         // 待合成的文本内容（已清洗）
     charCount: number;    // 当前分片字数
   }
   ```
