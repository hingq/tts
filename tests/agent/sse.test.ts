/**
 * @file sse.test.ts
 * @description Agent SSE 路由的纯函数单元测试：覆盖把 LangChain 流式 chunk 提取为文本、
 * 以及 SSE 换行转义这两段决定前端拼接正确性的核心逻辑。
 */

import { describe, it, expect } from 'vitest';
import { extractChunkText, escapeSseText } from '../../src/routes/jobs.js';

describe('extractChunkText', () => {
  it('content 为字符串时直接返回', () => {
    expect(extractChunkText({ content: '你好' })).toBe('你好');
  });

  it('content 为 content blocks 数组时拼接 text 字段', () => {
    expect(
      extractChunkText({
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      }),
    ).toBe('第一段第二段');
  });

  it('content 数组含非文本块时跳过', () => {
    expect(
      extractChunkText({
        content: [
          { type: 'tool_use', id: 'x' },
          { type: 'text', text: 'ok' },
        ],
      }),
    ).toBe('ok');
  });

  it('缺 content / 空 chunk 返回空串', () => {
    expect(extractChunkText(undefined)).toBe('');
    expect(extractChunkText({})).toBe('');
    expect(extractChunkText(null)).toBe('');
  });
});

describe('escapeSseText', () => {
  it('换行转义为字面量反斜杠 n', () => {
    expect(escapeSseText('第一行\n第二行')).toBe('第一行\\n第二行');
  });

  it('多个换行全部转义', () => {
    expect(escapeSseText('a\n\nb')).toBe('a\\n\\nb');
  });

  it('无换行原样返回', () => {
    expect(escapeSseText('单行')).toBe('单行');
  });
});
