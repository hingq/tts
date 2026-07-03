import { describe, expect, it } from 'vitest';
import { Check, Default } from 'typebox/value';
import {
  CharacterProfileSchema,
  ScriptLineSchema,
  ScriptManifestSchema,
} from '../src/types/orchestrator.js';

describe('orchestrator TypeBox schemas', () => {
  it('accepts valid data, optional fields, and extra object properties', () => {
    const line = {
      index: 0,
      speaker: 'narrator',
      text: '正文',
      emotion: 'neutral',
      speedModifier: 1,
      ssml: '<speak>正文</speak>',
      extra: 'preserved compatibility',
    };

    expect(Check(ScriptLineSchema, line)).toBe(true);
    expect(
      Check(ScriptManifestSchema, {
        chapterIndex: 0,
        lines: [line],
      }),
    ).toBe(true);
    expect(
      Check(CharacterProfileSchema, {
        id: '角色',
        voiceId: 'voice',
        gender: '女性',
        ageGroup: '青年',
        tags: ['calm'],
        embedding: [0.1],
      }),
    ).toBe(true);
  });

  it.each([
    { index: -1, speaker: 'narrator', text: '正文', emotion: 'neutral', speedModifier: 1 },
    { index: 0.5, speaker: 'narrator', text: '正文', emotion: 'neutral', speedModifier: 1 },
    { index: 0, speaker: '', text: '正文', emotion: 'neutral', speedModifier: 1 },
    { index: 0, speaker: 'narrator', text: '正文', emotion: '', speedModifier: 1 },
    { index: 0, speaker: 'narrator', text: '正文', emotion: 'neutral', speedModifier: 0 },
  ])('rejects invalid script line %#', (line) => {
    expect(Check(ScriptLineSchema, line)).toBe(false);
  });

  it('applies schema defaults before validation', () => {
    const value = Default(ScriptLineSchema, {
      index: 0,
      speaker: 'narrator',
      text: '正文',
    });

    expect(value).toMatchObject({ emotion: 'neutral', speedModifier: 1 });
    expect(Check(ScriptLineSchema, value)).toBe(true);
  });
});
