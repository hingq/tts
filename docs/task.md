# Audiobook Generation Service - Task List

## 1. 基础环境搭建与配置 (Infrastructure & Setup)
- [ ] 初始化 `package.json` 并配置基本字段与运行脚本 (npm init)
- [ ] 配置 TypeScript 编译选项 `tsconfig.json`
- [ ] 配置 ESLint (v9 Flat Config) 与 Prettier 格式化规则
- [ ] 安装核心依赖项（`fastify`, `msedge-tts`, `jschardet`, `iconv-lite`, `https-proxy-agent`, `@fastify/multipart`, `fastify-sse-v2`, `p-limit`）
- [ ] 安装开发与测试依赖项（`typescript`, `ts-node`, `vitest`, `eslint`, `prettier` 等）
- [ ] 编写配置模块 `src/config.ts` 解析环境变量，并编写 `.env.example` 模板

## 2. Fastify 服务端与路由 API 编写 (API & Web Server)
- [ ] 初始化 Fastify 实例并集成默认 pino 日志格式
- [ ] 注册 `@fastify/multipart` 插件，添加大文件流式接收控制
- [ ] 定义任务状态及 `JobManager` / `Job` 的最小接口契约（Interface Stub）
- [ ] 在 `src/services/job-manager.ts` 中实现一个简易的内存 Mock 队列，模拟任务生命周期的状态转变（`pending -> running -> done`）
- [ ] 编写 `POST /api/v1/audiobook/jobs` 接口 (解析 multipart 数据，校验参数，执行基础 Mock 流转)
- [ ] 编写 `GET /api/v1/audiobook/jobs/:jobId` 接口 (获取 Mock 进度与状态)
- [ ] 编写 `GET /api/v1/audiobook/jobs/:jobId/events` 接口 (测试 SSE 实时进度推送流)
- [ ] 编写 `GET /api/v1/audiobook/jobs/:jobId/file` 接口 (支持 Range 响应的流式下载)
- [ ] 编写 `DELETE /api/v1/audiobook/jobs/:jobId` 接口 (强杀该任务的子进程并移除目录)
- [ ] 编写 `POST /api/v1/audiobook/jobs/:jobId/resume` 接口 (恢复暂停或失败的任务)
- [ ] 编写服务优雅停机处理机制 (监听 SIGTERM/SIGINT，停止新连接，保存当前运行进度)

## 3. 文本清洗与切片模块 (Text Preprocessor & Splitter)
- [ ] 编写文本编码检测与解码工具 (利用 `jschardet` 和 `iconv-lite`)
- [ ] 编写文本清洗逻辑 (过滤 HTML/SSML 标签防止注入，规范化换行，压缩多余空行)
- [ ] 编写字符计数工具 (以 Unicode Code Point 过滤空白字符统计字数)
- [ ] 编写章节检测算法 (支持正则提取，配合行数、空行边界、序号单调递增、密度四重过滤校验)
- [ ] 编写虚拟章节分割模块 (无明显章节时，按环境变量设定的字数上限分割为虚拟章节)
- [ ] 编写 TTS 请求分块切割算法 (限制单块字数 <= chunkSize，在章节边界强制对齐，且尽量在标点边界处回退切割)

## 4. TTS 服务提供者实现 (TTS Provider)
- [ ] 定义 `TTSProvider` 接口契约与 `TTSOptions` 类型声明 (`src/types/tts.ts`)
- [ ] 实现基于 `msedge-tts` 的默认 `EdgeTTSProvider` 类 (`src/providers/edge-tts.ts`)
- [ ] 在 `EdgeTTSProvider` 中添加代理支持 (集成 `https-proxy-agent`)
- [ ] 实现发音人白名单校验以及语速、音高参数规范化校验逻辑

## 5. FFmpeg / ffprobe 音频转码及校验封装 (Audio Transcoder & Muxer)
- [ ] 编写单个音频片段转码函数 `transcodeToM4A` (将 MP3 转换为 AAC/M4A，支持 timeout 守护)
- [ ] 编写片段时长获取函数 `getDuration` (使用 `ffprobe` 提取精确毫秒级时长)
- [ ] 编写音频拼接与 Muxing 函数 `concatAndMux` (生成 filelist.txt 和 ffmeta Chapters，合成并支持写入 cover图片)
- [ ] 编写容器与格式校验函数 `validateM4B` (验证封装完整性、章节数一致性、faststart moov 前置)

## 6. 流水线任务管理器 (Pipeline & Job Manager)
- [ ] 规划真实 Job 状态数据结构与基于 `state.json` 的断点续传检查点读写
- [ ] 实现可用磁盘空间检查逻辑 (根据待处理字数，预估 Expected Peak Space * 1.2 倍)
- [ ] 设计双池流水线核心调度器 (集成 `p-limit` 限制 TTS 并发为 2，转码并发为 CPU-1)
- [ ] 实现全局活跃任务数限制逻辑 (`MAX_CONCURRENT_JOBS` 并发锁)
- [ ] 编写定时垃圾回收任务 (定期扫描清理已下载 1 小时或创建超 2 小时的临时工作空间)
- [ ] 编写服务重启后的任务重建与断点续传恢复逻辑

## 7. 自动化测试 (Unit Testing)
- [ ] 针对文本预处理、编码解码、章节提取和 TTS 分块算法编写单元测试 (`tests/text.test.ts`)
- [ ] 针对任务状态转换、磁盘预检、断点续传状态重建逻辑编写单元测试 (`tests/job-manager.test.ts`)
- [ ] 针对 FFmpeg 各种子进程执行包装方法编写集成测试 (`tests/ffmpeg.test.ts`)
- [ ] 针对 Web API 及 SSE 进度流编写 Fastify 注入集成测试 (`tests/api.test.ts`)
