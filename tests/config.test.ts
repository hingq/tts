import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config.js';

describe('environment configuration parsing', () => {
  it('applies existing defaults and leaves optional values absent', () => {
    const parsed = parseEnv({});

    expect(parsed).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      COS_USE_INTERNAL_UPLOAD: true,
      COS_UPLOAD_ENABLED: false,
      DEEPSEEK_TIMEOUT_MS: 300_000,
    });
    expect(parsed).not.toHaveProperty('TTS_PROXY');
    expect(parsed).not.toHaveProperty('AGENT_LLM_BASE_URL');
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['FALSE', false],
  ])('normalizes boolean spelling %s', (value, expected) => {
    expect(parseEnv({ AGENT_ENABLED: value }).AGENT_ENABLED).toBe(expected);
  });

  it('normalizes finite numbers and falls back for invalid numeric input', () => {
    expect(parseEnv({ PORT: '8080', MAX_TEXT_SIZE_MB: '2.5' })).toMatchObject({
      PORT: 8080,
      MAX_TEXT_SIZE_MB: 2.5,
    });
    expect(parseEnv({ PORT: 'not-a-number', MAX_TEXT_SIZE_MB: 'Infinity' })).toMatchObject({
      PORT: 3000,
      MAX_TEXT_SIZE_MB: 5,
    });
  });

  it('falls back for unsupported boolean values and non-string inputs', () => {
    expect(parseEnv({ AGENT_ENABLED: 'sometimes', COS_USE_INTERNAL_UPLOAD: 0 })).toMatchObject({
      AGENT_ENABLED: false,
      COS_USE_INTERNAL_UPLOAD: true,
    });
  });

  it('preserves optional strings and strips unrelated environment keys', () => {
    const parsed = parseEnv({
      TTS_PROXY: 'http://proxy.example',
      AGENT_LLM_BASE_URL: 'https://llm.example',
      UNRELATED: 'ignored',
    });

    expect(parsed.TTS_PROXY).toBe('http://proxy.example');
    expect(parsed.AGENT_LLM_BASE_URL).toBe('https://llm.example');
    expect(parsed).not.toHaveProperty('UNRELATED');
  });

  it('throws an actionable error when a final value violates the schema', () => {
    expect(() => parseEnv({ HOST: 42 })).toThrow(
      /Invalid environment configuration: .*\/HOST.*string/i,
    );
  });
});
