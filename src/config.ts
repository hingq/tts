import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const bool = (defaultValue: boolean) =>
  z.preprocess((value) => {
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
  }, z.boolean());

const number = (defaultValue: number) =>
  z.preprocess((value) => {
    if (value === undefined) return defaultValue;

    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
  }, z.number());

const string = (defaultValue: string) =>
  z.preprocess((value) => (value === undefined || value === '' ? defaultValue : value), z.string());

export const EnvSchema = z.object({
  NODE_ENV: string('development'),

  PORT: number(3000),
  HOST: string('127.0.0.1'),

  TMP_ROOT: string(''),

  MAX_TEXT_SIZE_MB: number(5),
  MAX_CONCURRENT_JOBS: number(2),
  CONCURRENT_TTS_LIMIT: number(3),
  CONCURRENT_TRANSCODE_LIMIT: number(2),

  DEFAULT_TTS_ENGINE: string('mimo-tts'),
  EDGE_VOICE: string('zh-CN-YunxiNeural'),

  SUBPROCESS_TIMEOUT_MS: number(60_000),
  GLOBAL_TASK_TIMEOUT_MS: number(3_600_000),

  TTS_PROXY: z.string().optional(),

  MIMO_API_KEY: string(''),
  MIMO_BASE_URL: string('https://api.xiaomimimo.com/v1'),
  MIMO_MODEL: string('mimo-v2.5-tts'),
  MIMO_VOICE: string('苏打'),
  MIMO_STYLE_PROMPT: string('平稳、自然、清晰的旁白朗读语气'),

  FFMPEG_PATH: string('ffmpeg'),
  FFPROBE_PATH: string('ffprobe'),

  COS_SECRET_ID: string(''),
  COS_SECRET_KEY: string(''),
  COS_BUCKET: string(''),
  COS_REGION: string(''),
  COS_KEY_PREFIX: string('audiobooks/'),
  COS_PRESIGN_TTL_S: number(3600),

  COS_USE_INTERNAL_UPLOAD: bool(true),
  COS_UPLOAD_ENABLED: bool(false),

  LOG_VERBOSE: bool(false),

  AGENT_ENABLED: bool(false),
  AGENT_LLM_PROVIDER: string('anthropic'),
  AGENT_LLM_MODEL: string(''),
  AGENT_LLM_API_KEY: string(''),
  AGENT_LLM_BASE_URL: z.string().optional(),
  AGENT_MAX_STEPS: number(8),

  ORCHESTRATOR_ENABLED: bool(false),

  DEEPSEEK_MODEL: string('deepseek-v4-flash'),
  DEEPSEEK_API_KEY: string(''),
  DEEPSEEK_BASE_URL: string('https://api.deepseek.com/v1'),
});

export const config = EnvSchema.parse(process.env);

export type Config = z.infer<typeof EnvSchema>;
