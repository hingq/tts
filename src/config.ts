import dotenv from 'dotenv';
import { Type, type Static } from 'typebox';
import { Check, Errors } from 'typebox/value';

dotenv.config();

export const EnvSchema = Type.Object({
  NODE_ENV: Type.String(),

  PORT: Type.Number(),
  HOST: Type.String(),

  TMP_ROOT: Type.String(),

  MAX_TEXT_SIZE_MB: Type.Number(),
  MAX_CONCURRENT_JOBS: Type.Number(),
  CONCURRENT_TTS_LIMIT: Type.Number(),
  CONCURRENT_TRANSCODE_LIMIT: Type.Number(),

  DEFAULT_TTS_ENGINE: Type.String(),
  EDGE_VOICE: Type.String(),

  SUBPROCESS_TIMEOUT_MS: Type.Number(),
  GLOBAL_TASK_TIMEOUT_MS: Type.Number(),

  TTS_PROXY: Type.Optional(Type.String()),

  MIMO_API_KEY: Type.String(),
  MIMO_BASE_URL: Type.String(),
  MIMO_MODEL: Type.String(),
  MIMO_VOICE: Type.String(),
  MIMO_STYLE_PROMPT: Type.String(),

  FFMPEG_PATH: Type.String(),
  FFPROBE_PATH: Type.String(),

  COS_SECRET_ID: Type.String(),
  COS_SECRET_KEY: Type.String(),
  COS_BUCKET: Type.String(),
  COS_REGION: Type.String(),
  COS_KEY_PREFIX: Type.String(),
  COS_PRESIGN_TTL_S: Type.Number(),

  COS_USE_INTERNAL_UPLOAD: Type.Boolean(),
  COS_UPLOAD_ENABLED: Type.Boolean(),

  LOG_VERBOSE: Type.Boolean(),

  AGENT_LLM_PROVIDER: Type.String(),
  AGENT_LLM_MODEL: Type.String(),
  AGENT_LLM_API_KEY: Type.String(),
  AGENT_LLM_BASE_URL: Type.Optional(Type.String()),
  AGENT_MAX_STEPS: Type.Number(),

  ORCHESTRATOR_ENABLED: Type.Boolean(),

  DEEPSEEK_MODEL: Type.String(),
  DEEPSEEK_API_KEY: Type.String(),
  DEEPSEEK_BASE_URL: Type.String(),
  DEEPSEEK_TIMEOUT_MS: Type.Number(),
});

export type Config = Static<typeof EnvSchema>;

function booleanValue(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return defaultValue;

  switch (value.toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true;
    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false;
    default:
      return defaultValue;
  }
}

function numberValue(value: unknown, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : defaultValue;
}

function stringValue(value: unknown, defaultValue: string): unknown {
  return value === undefined || value === '' ? defaultValue : value;
}

export function parseEnv(env: Record<string, unknown>): Config {
  const candidate = {
    NODE_ENV: stringValue(env.NODE_ENV, 'development'),
    PORT: numberValue(env.PORT, 3000),
    HOST: stringValue(env.HOST, '127.0.0.1'),
    TMP_ROOT: stringValue(env.TMP_ROOT, ''),
    MAX_TEXT_SIZE_MB: numberValue(env.MAX_TEXT_SIZE_MB, 5),
    MAX_CONCURRENT_JOBS: numberValue(env.MAX_CONCURRENT_JOBS, 2),
    CONCURRENT_TTS_LIMIT: numberValue(env.CONCURRENT_TTS_LIMIT, 3),
    CONCURRENT_TRANSCODE_LIMIT: numberValue(env.CONCURRENT_TRANSCODE_LIMIT, 2),
    DEFAULT_TTS_ENGINE: stringValue(env.DEFAULT_TTS_ENGINE, 'mimo-tts'),
    EDGE_VOICE: stringValue(env.EDGE_VOICE, 'zh-CN-YunxiNeural'),
    SUBPROCESS_TIMEOUT_MS: numberValue(env.SUBPROCESS_TIMEOUT_MS, 60_000),
    GLOBAL_TASK_TIMEOUT_MS: numberValue(env.GLOBAL_TASK_TIMEOUT_MS, 3_600_000),
    ...(env.TTS_PROXY === undefined ? {} : { TTS_PROXY: env.TTS_PROXY }),
    MIMO_API_KEY: stringValue(env.MIMO_API_KEY, ''),
    MIMO_BASE_URL: stringValue(env.MIMO_BASE_URL, 'https://api.xiaomimimo.com/v1'),
    MIMO_MODEL: stringValue(env.MIMO_MODEL, 'mimo-v2.5-tts'),
    MIMO_VOICE: stringValue(env.MIMO_VOICE, '苏打'),
    MIMO_STYLE_PROMPT: stringValue(env.MIMO_STYLE_PROMPT, '平稳、自然、清晰的旁白朗读语气'),
    FFMPEG_PATH: stringValue(env.FFMPEG_PATH, 'ffmpeg'),
    FFPROBE_PATH: stringValue(env.FFPROBE_PATH, 'ffprobe'),
    COS_SECRET_ID: stringValue(env.COS_SECRET_ID, ''),
    COS_SECRET_KEY: stringValue(env.COS_SECRET_KEY, ''),
    COS_BUCKET: stringValue(env.COS_BUCKET, ''),
    COS_REGION: stringValue(env.COS_REGION, ''),
    COS_KEY_PREFIX: stringValue(env.COS_KEY_PREFIX, 'audiobooks/'),
    COS_PRESIGN_TTL_S: numberValue(env.COS_PRESIGN_TTL_S, 3600),
    COS_USE_INTERNAL_UPLOAD: booleanValue(env.COS_USE_INTERNAL_UPLOAD, true),
    COS_UPLOAD_ENABLED: booleanValue(env.COS_UPLOAD_ENABLED, false),
    LOG_VERBOSE: booleanValue(env.LOG_VERBOSE, false),
    AGENT_LLM_PROVIDER: stringValue(env.AGENT_LLM_PROVIDER, 'deepseek'),
    AGENT_LLM_MODEL: stringValue(env.AGENT_LLM_MODEL, 'deepseek-v4-flash'),
    AGENT_LLM_API_KEY: stringValue(env.AGENT_LLM_API_KEY, ''),
    ...(env.AGENT_LLM_BASE_URL === undefined ? {} : { AGENT_LLM_BASE_URL: env.AGENT_LLM_BASE_URL }),
    AGENT_MAX_STEPS: numberValue(env.AGENT_MAX_STEPS, 8),
    ORCHESTRATOR_ENABLED: booleanValue(env.ORCHESTRATOR_ENABLED, false),
    DEEPSEEK_MODEL: stringValue(env.DEEPSEEK_MODEL, 'deepseek-v4-flash'),
    DEEPSEEK_API_KEY: stringValue(env.DEEPSEEK_API_KEY, ''),
    DEEPSEEK_BASE_URL: stringValue(env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com/v1'),
    DEEPSEEK_TIMEOUT_MS: numberValue(env.DEEPSEEK_TIMEOUT_MS, 300_000),
  };

  if (!Check(EnvSchema, candidate)) {
    const details = [...Errors(EnvSchema, candidate)]
      .map((error) => `${error.instancePath || '/'}: ${error.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return candidate;
}

export const config = parseEnv(process.env);
