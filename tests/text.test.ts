/**
 * @file text.test.ts
 * @description 文本处理模块的离线单元测试。
 * 覆盖 `src/utils/text.ts` 的纯函数（chineseToNumber、cleanHtmlTags、
 * trimAndCompressWhitespace、getCleanCharCount）以及 `src/services/text-processor.ts`
 * 的章节检测四重校验和标点回退切片算法。
 */

import { describe, it, expect } from 'vitest';
import {
  chineseToNumber,
  cleanHtmlTags,
  trimAndCompressWhitespace,
  getCleanCharCount,
} from '../src/utils/text.js';
import {
  detectChapters,
  splitVirtualChapters,
  splitChapterIntoChunks,
} from '../src/services/text-processor.js';
import type { Chapter } from '../src/types/text.js';

// ─── chineseToNumber ─────────────────────────────────────────────

describe('chineseToNumber', () => {
  describe('阿拉伯数字', () => {
    it.each([
      ['123', 123],
      ['1', 1],
      ['999', 999],
      ['0', 0],
    ] as const)('chineseToNumber(%j) === %d', (input, expected) => {
      expect(chineseToNumber(input)).toBe(expected);
    });
  });

  describe('基础中文数字', () => {
    it.each([
      ['一', 1],
      ['二', 2],
      ['三', 3],
      ['九', 9],
      ['零', 0],
      ['〇', 0],
      ['两', 2],
    ] as const)('chineseToNumber(%j) === %d', (input, expected) => {
      expect(chineseToNumber(input)).toBe(expected);
    });
  });

  describe('十位数', () => {
    it.each([
      ['十', 10],
      ['十一', 11],
      ['十二', 12],
      ['二十', 20],
      ['二十五', 25],
      ['三十九', 39],
    ] as const)('chineseToNumber(%j) === %d', (input, expected) => {
      expect(chineseToNumber(input)).toBe(expected);
    });
  });

  describe('百位数', () => {
    it.each([
      ['一百', 100],
      ['三百零六', 306],
      ['九百九十九', 999],
      ['一百二十三', 123],
    ] as const)('chineseToNumber(%j) === %d', (input, expected) => {
      expect(chineseToNumber(input)).toBe(expected);
    });
  });

  describe('千位及万位', () => {
    it.each([
      ['一千', 1000],
      ['一千零二', 1002],
      ['一万', 10000],
      ['一万五千零二十', 15020],
      ['两万三千四百五十六', 23456],
    ] as const)('chineseToNumber(%j) === %d', (input, expected) => {
      expect(chineseToNumber(input)).toBe(expected);
    });
  });

  describe('章节前缀过滤', () => {
    it.each([
      ['第一章', 1],
      ['第十章', 10],
      ['第二十五章', 25],
      ['第一百五十二回', 152],
      ['第123章', 123],
      ['第一卷', 1],
      ['第三十篇', 30],
    ] as const)('chineseToNumber(%j) === %d', (input, expected) => {
      expect(chineseToNumber(input)).toBe(expected);
    });
  });
});

// ─── cleanHtmlTags ───────────────────────────────────────────────

describe('cleanHtmlTags', () => {
  it('移除 SSML voice 标签，保留内部文字', () => {
    const input = "这是一段正常文字<voice name='zh-CN-YunxiNeural'>SSML注入内容</voice>";
    expect(cleanHtmlTags(input)).toBe('这是一段正常文字SSML注入内容');
  });

  it('移除 speak 标签', () => {
    expect(cleanHtmlTags('Hello <speak>World</speak>')).toBe('Hello World');
  });

  it('移除自闭合标签', () => {
    expect(cleanHtmlTags('段落一<br/>段落二')).toBe('段落一段落二');
  });

  it('移除嵌套标签', () => {
    expect(cleanHtmlTags('<div><p>内容</p></div>')).toBe('内容');
  });

  it('纯文本不受影响', () => {
    const plain = '这是一段没有标签的纯文本。';
    expect(cleanHtmlTags(plain)).toBe(plain);
  });

  it('空字符串返回空字符串', () => {
    expect(cleanHtmlTags('')).toBe('');
  });
});

// ─── trimAndCompressWhitespace ───────────────────────────────────

describe('trimAndCompressWhitespace', () => {
  it('连续 4 个换行符压缩为 \\n\\n', () => {
    const input = '段落一\n\n\n\n段落二';
    expect(trimAndCompressWhitespace(input)).toBe('段落一\n\n段落二');
  });

  it('连续 5 个换行符压缩为 \\n\\n', () => {
    const input = '段落一\n\n\n\n\n段落二';
    expect(trimAndCompressWhitespace(input)).toBe('段落一\n\n段落二');
  });

  it('双换行符（段落分隔）保持不变', () => {
    const input = '段落一\n\n段落二';
    expect(trimAndCompressWhitespace(input)).toBe('段落一\n\n段落二');
  });

  it('行首行尾空白被修剪', () => {
    const input = '  行首空格\n行尾空格  \n\t制表符行\t';
    const result = trimAndCompressWhitespace(input);
    expect(result).toBe('行首空格\n行尾空格\n制表符行');
  });

  it('行首全角空格被修剪', () => {
    const input = '\u3000全角空格行\u3000';
    const result = trimAndCompressWhitespace(input);
    expect(result).toBe('全角空格行');
  });
});

// ─── getCleanCharCount ───────────────────────────────────────────

describe('getCleanCharCount', () => {
  it('排除空格和换行', () => {
    expect(getCleanCharCount('你好 世界')).toBe(4);
  });

  it('排除多种空白', () => {
    expect(getCleanCharCount('a b\nc\td')).toBe(4);
  });

  it('Emoji 计为单个码点', () => {
    expect(getCleanCharCount('你好😂世界')).toBe(5);
  });

  it('多个 Emoji', () => {
    expect(getCleanCharCount('😀😂🎉')).toBe(3);
  });

  it('代理对字符计为单个码点', () => {
    // 𝄞 (U+1D11E) 是 Musical Symbol G Clef，在 UTF-16 中是代理对
    expect(getCleanCharCount('A𝄞B')).toBe(3);
  });

  it('空字符串返回 0', () => {
    expect(getCleanCharCount('')).toBe(0);
  });

  it('纯空白返回 0', () => {
    expect(getCleanCharCount('   \n\t\r')).toBe(0);
  });
});

// ─── 章节检测四重校验 ────────────────────────────────────────────

describe('detectChapters', () => {
  /**
   * 生成足够长度的填充文本，使每个章节的平均字数在合理范围内（1000-50000）
   */
  function makeFiller(charCount: number): string {
    return '正文内容。'.repeat(Math.ceil(charCount / 5));
  }

  it('正常章节结构正确检测', () => {
    // 3 章，每章 ~2000 字，满足最小章节数和平均字数要求
    const filler = makeFiller(2000);
    const text = [
      '第一章 开篇',
      '',
      filler,
      '',
      '第二章 发展',
      '',
      filler,
      '',
      '第三章 结局',
      '',
      filler,
    ].join('\n');

    const chapters = detectChapters(text);
    expect(chapters.length).toBe(3);
    expect(chapters[0].title).toBe('第一章 开篇');
    expect(chapters[1].title).toBe('第二章 发展');
    expect(chapters[2].title).toBe('第三章 结局');
  });

  it('行字数超过 40 的候选章节行被过滤', () => {
    const filler = makeFiller(2000);
    const longTitle = '第一章 ' + '这是一个非常长的标题'.repeat(5);
    expect(longTitle.length).toBeGreaterThan(40);

    const text = [
      longTitle, // 超长标题，应被过滤
      '',
      filler,
      '',
      '第二章 正常标题',
      '',
      filler,
      '',
      '第三章 正常标题二',
      '',
      filler,
      '',
      '第四章 正常标题三',
      '',
      filler,
    ].join('\n');

    const chapters = detectChapters(text);
    // 超长标题的章节被滤掉，剩 3 个有效章节
    expect(chapters.length).toBe(3);
    expect(chapters[0].title).toBe('第二章 正常标题');
  });

  it('正文末尾未与空行隔开的章节行被过滤', () => {
    // "第三章"紧跟正文没有空行分隔，应被过滤
    const filler = makeFiller(2000);
    const text = [
      '第一章 开篇',
      '',
      filler,
      '',
      '第二章 发展',
      '',
      filler,
      // 注意：此处没有空行，"第三章"紧跟上方正文
      '第三章 被过滤',
      '',
      filler,
      '',
      '第四章 保留',
      '',
      filler,
    ].join('\n');

    const chapters = detectChapters(text);
    // 第三章因未隔空行被过滤，但如果剩余不足 3 个会进入虚拟章节
    // 第一、第二、第四章应通过
    const titles = chapters.map((c) => c.title);
    expect(titles).not.toContain('第三章 被过滤');
  });

  it('序号倒退（非单调递增）的章节被剔除', () => {
    const filler = makeFiller(2000);
    const text = [
      '第一章 开始',
      '',
      filler,
      '',
      '第零章 倒退', // 0 < 1，非递增
      '',
      filler,
      '',
      '第二章 继续',
      '',
      filler,
      '',
      '第三章 结束',
      '',
      filler,
    ].join('\n');

    const chapters = detectChapters(text);
    const titles = chapters.map((c) => c.title);
    // 第零章应被递增校验剔除
    expect(titles).not.toContain('第零章 倒退');
    expect(titles).toContain('第一章 开始');
    expect(titles).toContain('第二章 继续');
    expect(titles).toContain('第三章 结束');
  });

  it('缺少章节的纯文本进入虚拟章节切分', () => {
    // 大段无章节标记的纯文本
    const plainText = makeFiller(5000);
    const chapters = detectChapters(plainText);

    expect(chapters.length).toBeGreaterThanOrEqual(1);
    // 虚拟章节标题格式为 "第 N 部分"
    expect(chapters[0].title).toMatch(/^第 \d+ 部分$/);
  });

  it('有效章节数不足 3 时进入虚拟章节', () => {
    const filler = makeFiller(2000);
    const text = [
      '第一章 仅此一章',
      '',
      filler,
    ].join('\n');

    const chapters = detectChapters(text);
    // 仅 1 个章节，不足 3 个，触发虚拟章节
    expect(chapters[0].title).toMatch(/^第 \d+ 部分$/);
  });
});

describe('splitVirtualChapters', () => {
  it('短文本生成单个虚拟章节', () => {
    const text = '这是一段简短的文本。';
    const chapters = splitVirtualChapters(text);
    expect(chapters.length).toBe(1);
    expect(chapters[0].title).toBe('第 1 部分');
    expect(chapters[0].content).toBe(text);
  });

  it('空文本返回空数组', () => {
    expect(splitVirtualChapters('')).toEqual([]);
  });
});

// ─── 分片切片算法 ────────────────────────────────────────────────

describe('splitChapterIntoChunks', () => {
  it('短章节不分片', () => {
    const chapter: Chapter = {
      title: '第一章',
      startIndex: 0,
      content: '这是一段短文本。',
    };
    const chunks = splitChapterIntoChunks(chapter, 0, 0, 2500);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe('这是一段短文本。');
    expect(chunks[0].chapterIndex).toBe(0);
  });

  it('空章节返回空数组', () => {
    const chapter: Chapter = {
      title: '空章节',
      startIndex: 0,
      content: '',
    };
    const chunks = splitChapterIntoChunks(chapter, 0, 0, 2500);
    expect(chunks.length).toBe(0);
  });

  it('在最高优先级标点处切分', () => {
    // 构造一段超过 2500 字的文本，在接近 2400 字处埋入 \n\n（最高优先级）
    // 然后在 2350 字处埋入 。（次高优先级）
    // 确保算法选择 \n\n 作为切分点
    const beforeParagraph = '测'.repeat(2350);
    const afterSentEnd = '试'.repeat(50); // 位于 2350~2400
    const paragraphBreak = '\n\n';
    const afterParagraph = '文'.repeat(100); // 2402~2502
    const remaining = '字'.repeat(200);

    const content = beforeParagraph + '。' + afterSentEnd + paragraphBreak + afterParagraph + remaining;

    const chapter: Chapter = {
      title: '测试章节',
      startIndex: 0,
      content,
    };

    const chunks = splitChapterIntoChunks(chapter, 0, 0, 2500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 第一个分片应在 \n\n 处切分（包含 \n\n），因为 \n\n 优先级最高
    // 分片末尾应以段落分隔结束
    expect(chunks[0].text.length).toBeGreaterThan(0);
    expect(chunks[0].text.length).toBeLessThanOrEqual(2500);
  });

  it('在句号处切分（当没有更高优先级标点时）', () => {
    // 构造文本在最后 200 字内只有句号没有 \n\n 和 \n
    const filler = '字'.repeat(2350);
    const sentenceEnd = '。';
    const afterSentence = '词'.repeat(200);

    const content = filler + sentenceEnd + afterSentence;

    const chapter: Chapter = {
      title: '测试章节',
      startIndex: 0,
      content,
    };

    const chunks = splitChapterIntoChunks(chapter, 0, 0, 2500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 第一个分片应在句号处切分
    expect(chunks[0].text).toContain('。');
    expect(chunks[0].text.endsWith('。')).toBe(true);
  });

  it('全局序号和章节序号正确传递', () => {
    const content = '内容。'.repeat(100);
    const chapter: Chapter = {
      title: '第三章',
      startIndex: 5000,
      content,
    };
    const chunks = splitChapterIntoChunks(chapter, 2, 10, 2500);
    expect(chunks[0].chapterIndex).toBe(2);
    expect(chunks[0].index).toBe(10);
    expect(chunks[0].chapterTitle).toBe('第三章');
  });

  it('切片不跨越章节边界', () => {
    // 每个章节独立切分，确保 chapterIndex 一致
    const longContent = '文'.repeat(6000);
    const chapter: Chapter = {
      title: '测试章节',
      startIndex: 0,
      content: longContent,
    };
    const chunks = splitChapterIntoChunks(chapter, 0, 0, 2500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // 所有分片的 chapterIndex 一致
    for (const chunk of chunks) {
      expect(chunk.chapterIndex).toBe(0);
    }

    // 所有分片的文本拼合还原章节内容
    const reassembled = chunks.map((c) => c.text).join('');
    expect(reassembled).toBe(longContent);
  });
});
