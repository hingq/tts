/**
 * @file config.ts
 * @description 有声书生成服务的全局配置管理模块，负责从环境变量读取参数，执行类型安全转换，并设定合理的默认值。
 * 并在初始化时自动校验并递归创建临时工作目录。
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 加载环境变量
dotenv.config();

/**
 * 全局配置接口定义
 */
export interface Config {
  /** 运行环境标识（development | production | test 等） */
  NODE_ENV: string;
  /** 服务监听端口 */
  PORT: number;
  /** 服务绑定主机地址 */
  HOST: string;
  /** 临时工作空间根目录绝对路径 */
  TMP_ROOT: string;
  /** 允许上传的最大文本体积（单位: MB） */
  MAX_TEXT_SIZE_MB: number;
  /** 全局最大并发运行任务数 */
  MAX_CONCURRENT_JOBS: number;
  /** 微软 Edge TTS 引擎的并发请求上限 */
  CONCURRENT_TTS_LIMIT: number;
  /** FFmpeg 转码的并发线程上限 */
  CONCURRENT_TRANSCODE_LIMIT: number;
  /** 全局语音合成引擎（'edge-tts' | 'mimo-tts'），由服务端固定，前端不可选 */
  DEFAULT_TTS_ENGINE: string;
  /** edge-tts 引擎使用的音色（白名单内），默认 `zh-CN-YunxiNeural` */
  EDGE_VOICE: string;
  /** 单个子进程（如转码）执行的超时时间（单位: 毫秒） */
  SUBPROCESS_TIMEOUT_MS: number;
  /** 整个有声书生成任务的全局超时时间（单位: 毫秒） */
  GLOBAL_TASK_TIMEOUT_MS: number;
  /** 合成语音请求时使用的 HTTP 代理网关地址（可选） */
  TTS_PROXY?: string;
  /** 小米 MiMo 开放平台 API Key（mimo-tts 引擎认证用，留空则该引擎不可用） */
  MIMO_API_KEY: string;
  /** MiMo OpenAI 兼容接口基址，默认 `https://api.xiaomimimo.com/v1` */
  MIMO_BASE_URL: string;
  /** MiMo TTS 模型 ID，默认 `mimo-v2.5-tts`（预置音色） */
  MIMO_MODEL: string;
  /** mimo-tts 引擎缺省音色（白名单内），默认 `苏打` */
  MIMO_VOICE: string;
  /** MiMo 请求 messages 中 user 角色的风格指令，默认中性旁白语气 */
  MIMO_STYLE_PROMPT: string;
  /** FFmpeg 可执行二进制文件的系统路径 */
  FFMPEG_PATH: string;
  /** FFprobe 可执行二进制文件的系统路径 */
  FFPROBE_PATH: string;
  /** 腾讯云 COS 永久密钥 SecretId（为空则不启用 COS，下载退回本地流式） */
  COS_SECRET_ID: string;
  /** 腾讯云 COS 永久密钥 SecretKey */
  COS_SECRET_KEY: string;
  /** COS 存储桶名，格式 `name-appid`（为空则不启用 COS 卸载） */
  COS_BUCKET: string;
  /** COS 存储桶所在地域，如 `ap-guangzhou` */
  COS_REGION: string;
  /** COS 对象键前缀，成品 key 为 `${COS_KEY_PREFIX}${jobId}.m4b` */
  COS_KEY_PREFIX: string;
  /** 下载预签名 URL 的有效期（秒） */
  COS_PRESIGN_TTL_S: number;
  /** 上传是否走内网域名（同地域 ECS 置 true 免费且不占公网带宽；非同地域本地开发置 false 走公网） */
  COS_USE_INTERNAL_UPLOAD: boolean;
  /** 是否输出分片级（每个 chunk 的 TTS/转码）调试日志，默认 false，避免大任务刷屏 */
  LOG_VERBOSE: boolean;
}

/**
 * 安全解析数字类型的环境变量，如果非法或不存在则返回指定的默认值。
 *
 * @param envVal 环境变量的原始字符串值
 * @param defaultValue 当值缺失或无法解析时采用的默认数值
 * @returns 解析得到的安全整数数值
 */
function parseNumber(envVal: string | undefined, defaultValue: number): number {
  if (envVal === undefined) return defaultValue;
  const num = parseInt(envVal, 10);
  return isNaN(num) ? defaultValue : num;
}

// 解析临时根目录，如果环境变量未定义，则默认使用系统的临时文件夹下的 audiobook 子目录
const rawTmpRoot = process.env.TMP_ROOT || path.join(os.tmpdir(), 'audiobook');
const absoluteTmpRoot = path.resolve(rawTmpRoot);

// 自动初始化工作根目录：在模块加载时同步检查并创建，确保后续文件写入操作的畅通（Fail-fast 机制）
if (!fs.existsSync(absoluteTmpRoot)) {
  try {
    fs.mkdirSync(absoluteTmpRoot, { recursive: true });
  } catch (error) {
    // 捕获目录创建异常并打印详细的诊断信息，以便排查权限等问题
    // eslint-disable-next-line no-console
    console.error(`Failed to initialize TMP_ROOT directory at ${absoluteTmpRoot}:`, error);
    throw error;
  }
}

/**
 * 全局只读配置对象实例
 */
export const config: Config = {
  // 运行环境标识，默认 development
  NODE_ENV: process.env.NODE_ENV || 'development',

  // 服务监听端口，默认 3000
  PORT: parseNumber(process.env.PORT, 3000),

  // 服务绑定主机，默认 127.0.0.1
  HOST: process.env.HOST || '127.0.0.1',

  // 临时工作空间根目录，已解析为绝对路径并在初始化时自动递归创建
  TMP_ROOT: absoluteTmpRoot,

  // 单次任务允许上传的最大文本体积（单位: MB），默认 5
  MAX_TEXT_SIZE_MB: parseNumber(process.env.MAX_TEXT_SIZE_MB, 5),

  // 全局最大并发运行任务数，默认 2
  MAX_CONCURRENT_JOBS: parseNumber(
    process.env.MAX_CONCURRENT_JOBS,
    Math.max(1, os.cpus().length - 1),
  ),

  // 微软 Edge TTS 引擎的并发请求上限，默认 2
  CONCURRENT_TTS_LIMIT: parseNumber(process.env.CONCURRENT_TTS_LIMIT, 3),

  // FFmpeg 转码并发线程数上限，默认使用 CPU 核心数减一
  CONCURRENT_TRANSCODE_LIMIT: parseNumber(
    process.env.CONCURRENT_TRANSCODE_LIMIT,
    Math.max(1, os.cpus().length - 1),
  ),

  // 全局语音合成引擎（前端不可选），默认 edge-tts
  DEFAULT_TTS_ENGINE: process.env.DEFAULT_TTS_ENGINE || 'mimo-tts',

  // edge-tts 引擎使用的音色，默认 zh-CN-YunxiNeural
  EDGE_VOICE: process.env.EDGE_VOICE || 'zh-CN-YunxiNeural',

  // 单个子进程（如转码）执行超时时间（单位: 毫秒），默认 60000（1分钟）
  SUBPROCESS_TIMEOUT_MS: parseNumber(process.env.SUBPROCESS_TIMEOUT_MS, 60000),

  // 整个有声书生成任务全局超时时间（单位: 毫秒），默认 3600000（1小时）
  GLOBAL_TASK_TIMEOUT_MS: parseNumber(process.env.GLOBAL_TASK_TIMEOUT_MS, 3600000),

  // 合成语音请求时使用的 HTTP 代理网关地址，非必填
  TTS_PROXY: process.env.TTS_PROXY || undefined,

  // 小米 MiMo 开放平台配置（MIMO_API_KEY 为空则 mimo-tts 引擎不可用）
  MIMO_API_KEY: process.env.MIMO_API_KEY || '',
  MIMO_BASE_URL: process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1',
  MIMO_MODEL: process.env.MIMO_MODEL || 'mimo-v2.5-tts',
  MIMO_VOICE: process.env.MIMO_VOICE || '苏打',
  MIMO_STYLE_PROMPT: process.env.MIMO_STYLE_PROMPT || '平稳、自然、清晰的旁白朗读语气',

  // FFmpeg 可执行二进制路径，默认 'ffmpeg'
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',

  // FFprobe 可执行二进制路径，默认 'ffprobe'
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',

  // 腾讯云 COS 凭证与桶信息（COS_BUCKET 为空时整个 COS 卸载禁用，下载退回本地流式）
  COS_SECRET_ID: process.env.COS_SECRET_ID || '',
  COS_SECRET_KEY: process.env.COS_SECRET_KEY || '',
  COS_BUCKET: process.env.COS_BUCKET || '',
  COS_REGION: process.env.COS_REGION || '',

  // 对象键前缀，默认 'audiobooks/'
  COS_KEY_PREFIX: process.env.COS_KEY_PREFIX || 'audiobooks/',

  // 下载预签名 URL 有效期（秒），默认 3600（1小时）
  COS_PRESIGN_TTL_S: parseNumber(process.env.COS_PRESIGN_TTL_S, 3600),

  // 上传是否走内网域名，默认 true（生产同地域 ECS）；本地非同地域开发置 'false' 走公网
  COS_USE_INTERNAL_UPLOAD: (process.env.COS_USE_INTERNAL_UPLOAD || 'true') !== 'false',

  // 是否输出分片级调试日志（每个 chunk 的 TTS/转码开始与完成），默认关闭，避免数百分片刷屏
  LOG_VERBOSE: true,
};
