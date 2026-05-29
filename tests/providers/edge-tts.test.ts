/**
 * @file edge-tts.test.ts
 * @description EdgeTTSProvider 参数清洗纯函数的离线单元测试（无网络）。
 * 覆盖 sanitizeVoice 的白名单/回退、sanitizeRate 的合法透传/小数换算/非法重置、
 * sanitizePitch 的 Hz/% 透传与非法重置。
 */

import { describe, it, expect } from 'vitest';
import { sanitizeVoice, sanitizeRate, sanitizePitch } from '../../src/providers/edge-tts.js';

describe('sanitizeVoice', () => {
  // [输入, 期望输出]
  const cases: Array<[string, string]> = [
    // 白名单内全部原样透传
    ['zh-CN-YunxiNeural', 'zh-CN-YunxiNeural'],
    ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoxiaoNeural'],
    ['zh-CN-YunjianNeural', 'zh-CN-YunjianNeural'],
    ['zh-CN-XiaoyiNeural', 'zh-CN-XiaoyiNeural'],
    ['zh-HK-HiuMaanNeural', 'zh-HK-HiuMaanNeural'],
    ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoChenNeural'],
    // 非白名单一律回退默认音色
    ['en-US-AriaNeural', 'zh-CN-YunxiNeural'],
    ['', 'zh-CN-YunxiNeural'],
    ['<inject>', 'zh-CN-YunxiNeural'],
    ['zh-cn-yunxineural', 'zh-CN-YunxiNeural'], // 大小写敏感，不命中
  ];

  it.each(cases)('sanitizeVoice(%j) === %j', (input, expected) => {
    expect(sanitizeVoice(input)).toBe(expected);
  });
});

describe('sanitizeRate', () => {
  const cases: Array<[string, string]> = [
    // 合法带符号百分比：原样透传
    ['+0%', '+0%'],
    ['+15%', '+15%'],
    ['-20%', '-20%'],
    // 裸小数：按相对倍率换算为带符号百分比
    ['1.2', '+20%'],
    ['0.8', '-20%'],
    ['1', '+0%'],
    ['0.5', '-50%'],
    ['2', '+100%'],
    // 非法输入：重置为 +0%
    ['fast', '+0%'],
    ['15%', '+0%'], // 缺符号，不匹配 RATE_RE，也非裸小数
    ['', '+0%'],
    ['+%', '+0%'],
    ['abc1.2', '+0%'],
  ];

  it.each(cases)('sanitizeRate(%j) === %j', (input, expected) => {
    expect(sanitizeRate(input)).toBe(expected);
  });
});

describe('sanitizePitch', () => {
  const cases: Array<[string, string]> = [
    // 合法 Hz 透传
    ['+0Hz', '+0Hz'],
    ['+5Hz', '+5Hz'],
    ['-10Hz', '-10Hz'],
    // 合法百分比透传
    ['+10%', '+10%'],
    ['-25%', '-25%'],
    // 非法输入：重置为 +0Hz
    ['high', '+0Hz'],
    ['5Hz', '+0Hz'], // 缺符号
    ['+5', '+0Hz'], // 缺单位
    ['', '+0Hz'],
    ['+5st', '+0Hz'], // 半音单位不支持
  ];

  it.each(cases)('sanitizePitch(%j) === %j', (input, expected) => {
    expect(sanitizePitch(input)).toBe(expected);
  });
});
