# 技术设计文档 v3：基于 Fastify + Edge-TTS + FFmpeg 的高性能有声书（M4B）生成服务

> **v3 修订说明**（相对 v2）：
>
> 1. **修正磁盘配额公式**：`0.0003 MB/字` → `0.0016 MB/字`（v2 低估约 5 倍，90 万字实际 ~1.4GB，按旧公式挂 `/dev/shm` 会 OOM）。
> 2. **章节正则加固**：增加"行字数上限 + 前后空行 + 序号单调性 + 总数合理性"四重校验，避免正文行被误识别为章节标题。
> 3. **TTS 块默认大小下调**：`8000 字/块` → `2500 字/块`（可配置 1000~5000），降低单块失败的爆炸半径，让转码流水线更早启动。
> 4. **最终合并命令去掉 `-bsf:a aac_adtstoasc`**：per-chunk 已是标准 M4A 容器，无 ADTS 头，该 filter 是冗余。
> 5. **状态持久化分单机 / 分布式两套方案**：单机用 state.json + 本地磁盘；分布式上浮到 Redis + S3，明确切换边界。
> 6. **可观测性补一项关键指标**：`audiobook_tts_upstream_status_code{code}`，用于风控告警与代理池自适应。
> 7. **新增"已知问题"章节**：说明 AAC priming samples 在拼接处的取舍——苹果生态依赖 edit list 实现 gapless playback，对目标场景无感知，不做处理。
>
> v2 相对 v1 的核心变更（保留）：修正 `concat:` 协议误用、补齐 Edge-TTS 实际输出格式与 MP3→AAC 标准化阶段、补齐 M4B 章节元数据注入、同步 HTTP 改异步任务模式、增加 `-movflags +faststart`、`-bsf:a` 替代废弃的 `-absf`、新增断点续传与配额校验、补充安全与可观测性章节。

---

## 1. 概述（Overview）

### 1.1 背景与痛点

随着网文有声书需求的增长，将大体积文本（如 2MB 纯文本小说，约 90 万字）高效转化为高质量音频成为一个常见的技术挑战。传统的云端 TTS 商业 API 按字数计费，跑完一本大篇幅小说成本高昂；而利用微软 Edge 浏览器的大声朗读接口（Edge-TTS）虽然可以零成本调用，但在面对长文本时存在单次请求字数限制（建议单块 2,000~3,000 字内）和高并发触发 HTTP 429 / IP 封禁的风险。

此外，在后端处理大量音频碎片拼接时，若采用全量重编码（Re-encode）方案，会消耗大量 CPU 算力并阻塞 Node.js 事件循环，降低并发吞吐。

### 1.2 设计目标

* **极致性能（最终合并零重编码）**：在最终合并阶段，采用 FFmpeg concat demuxer + Stream Copy（`-c copy`）的无损 Remuxing，直接复制音频流，将最终合并阶段的 CPU 消耗降至最低（毫秒到秒级）。注：由于 Edge-TTS 不直接输出 AAC，**每个片段需要一次轻量的 MP3→AAC 转码**作为前置标准化（per-chunk、可并发），此步无法省略，但开销远低于一次性整体重编码。
* **异步任务、不阻塞 HTTP 连接**：长任务（90 万字约 20–40 分钟）通过任务 ID + 状态查询 + 文件下载三段式 API 解耦，避免反向代理超时。
* **内存与 I/O 友好**：最终文件落盘 `/dev/shm` 或可配置临时目录，通过 `fs.createReadStream` 流式推送，避免大文件常驻 Node.js 堆内存。
* **苹果生态完美适配**：输出 `.m4b`，写入 `moov` 元数据索引块并通过 `-movflags +faststart` 前置，写入标准 FFmetadata 章节列表，完美适配 Apple Books 的断点记忆、锁屏快进、原生章节目录功能。
* **可恢复性**：长任务任意环节失败可断点续传，已完成 chunk 不重复合成。

---

## 2. 系统架构与核心流程（Architecture & Data Flow）

整个系统生命周期分为五个核心阶段：**文本智能切片 → 异步任务调度 → TTS 合成 → 片段标准化（MP3→AAC）→ 容器无损合并 → 流式下载与异步清理**。

### 2.1 架构拓扑

```
[客户端]
   │
   │  ① POST /jobs  (text, voice, …)
   ▼
[Fastify API 网关] ──► 立即返回 { jobId }
   │
   │  ② 入队（内存队列 / BullMQ / 自实现）
   ▼
┌──────────────────── Worker（同进程或独立进程） ────────────────────┐
│                                                                    │
│   [文本智能切片]                                                   │
│       │                                                            │
│       ├─► 章节切片（用于元数据 / 目录）                            │
│       └─► TTS 块切片（默认 2500 字 / 块，可配置 1000~5000）       │
│                                                                    │
│   [TTS 调度器]  ── p-limit(2~3) ──► Edge-TTS WebSocket             │
│       │           随机延迟 1000–2500ms                             │
│       │           指数退避重试（429 / 网络抖动）                   │
│       ▼                                                            │
│   raw_001.mp3  raw_002.mp3  …  raw_N.mp3                           │
│       │                                                            │
│   [片段标准化]  per-chunk FFmpeg（并发 = CPU-1）                   │
│       │  MP3 → AAC(LC) 24kHz 64kbps mono，参数严格一致             │
│       ▼                                                            │
│   chunk_001.m4a  chunk_002.m4a  …  chunk_N.m4a                     │
│       │                                                            │
│   [章节时长汇总] ffprobe 各 chunk 时长 → 累加生成 chapters.ffmeta  │
│       │                                                            │
│   [FFmpeg 最终合并]  concat demuxer + -c copy + faststart          │
│       ▼                                                            │
│   output.m4b（含章节元数据，moov 在头部）                          │
│                                                                    │
│   state.json 实时更新进度，落盘检查点                              │
└────────────────────────────────────────────────────────────────────┘
   │
   │  ③ GET /jobs/:id  ──► { status, progress, downloadUrl }
   │  ④ GET /jobs/:id/file  ──► 流式下载 m4b
   │  ⑤ 下载完成 / 取消 → 清理临时目录
   ▼
[客户端]
```

---

## 3. 核心模块详细设计（Component Detail）

### 3.1 文本智能切片模块（Text Segmenter）

切片分为**两个独立维度**：

#### 3.1.1 章节切片（用于章节元数据）

* 用途：构造 M4B 的 `chapters.ffmeta`，让 Apple Books 显示原生章节目录。

* 基础正则（覆盖常见网文 / 出版书变体）：

  ```js
  /^\s*(?:序章|楔子|引子|尾声|后记|番外(?:篇)?|第\s*[一二三四五六七八九十百千万零\d]+\s*(?:章|回|卷|集|节|篇|部))(?:[\s\u3000]+\S[^\n]{0,40})?\s*$/m
  ```

* **正则单独不够，必须配合四重后置校验**（避免类似"第六章涉及的内容非常广泛……"的正文行被误识别为章节）：

  1. **行字数上限**：候选行整行长度 ≤ 40 个汉字。真正的章节标题极少超过此长度，而误命中的正文行往往很长。
  2. **前后空行边界**：候选行的**上一非空行**和**下一非空行**之间，候选行所在段落须为独立段落（即上下文必须存在 `\n\s*\n` 或文件首尾）。这是最强的判别条件——正文中嵌入的"第 X 章"短语不会独占一段。
  3. **序号单调递增**：提取候选章节中的序号（中文数字转阿拉伯数字后），跨整本书必须**严格单调递增**（允许个别空缺，但不允许倒退或大幅跳跃，如第 5 章后突然出现第 87 章）。出现非单调时，丢弃异常项。
  4. **总数合理性**：90 万字文本理论章节数应在 30~500 之间。若匹配出 < 3 章或 > 1000 章，触发兜底（见下）。

* **兜底**：若四重校验后剩余章节数 < 3，视为无章节结构，按"每 ~1.5 万字一章"生成虚拟章节（命名为"第 1 部分"、"第 2 部分"…），仅用于目录定位，不影响合成。

* **实现提示**：先用正则在全文上跑出所有候选 `{ lineNo, raw, charOffset, parsedIndex }`，然后依次施加 1→2→3→4 四道过滤，每一步打 debug 日志便于调试。

#### 3.1.2 TTS 请求块切片（用于 Edge-TTS 请求）

* 用途：将文本切成 ≤ 2,500 字（默认值，可配置 1000~5000）的 TTS 请求单元，绝对不可在句子中间切开。
* **为什么默认下调到 2500 字**（v3 修订）：
  1. **失败爆炸半径小**：单块失败重试代价从 ~10 分钟级降到 ~3 分钟级；
  2. **流水线启动早**：第一个 chunk TTS 合成完成后即可开始转码，CPU 在 TTS 仍在跑时就已经被压满，整体端到端时间反而更短；
  3. **进度条更平滑**：90 万字按 2500 字切，得到 ~360 块，前端进度条 360 档而非 113 档，用户体验更好；
  4. **WebSocket 单次请求时长更短**：降低长连接中途遭遇风控的概率。
* 算法（滑动窗口 + 边界回退）：

  1. 从当前位置向后取 `chunkSize` 字（默认 2500）；
  2. 在窗口尾部 200 字范围内，按优先级回退到边界：`\n\n` > `\n` > `。` > `！` > `？` > `；` > `，`；
  3. 若 200 字内找不到任何边界，强制在 `chunkSize` 字处切。

* 章节与 TTS 块的关系：**记录每个 TTS 块属于哪个章节**，便于后续累加每章实际音频时长。一个长章可能跨多个 TTS 块；多个短章节也可能落在同一个 TTS 块内（这种情况下章节时长由文本字数比例近似分摊）。

### 3.2 TTS 调度与防封模块（TTS Scheduler）

* **并发控制**：`p-limit(2)`（保守）或 `p-limit(3)`（激进），可配置。

* **随机延迟**：每个请求成功后，`setTimeout(random(1000, 2500))` 后释放并发名额。

* **重试策略**：指数退避 `delay = 500 * 2^attempt + random(0, 500)`，最多 3 次。429 触发时额外冷却 30s。

* **音频格式请求参数**：

  ```
  X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3
  ```

  > **重要更正**：Edge-TTS 服务端**不直接输出 AAC/M4A**，可用格式集中在 MP3 / Opus / Siren / PCM。本设计选 MP3 是因为其后续转 AAC 工具链最稳定、苹果兼容最好。社区库 `msedge-tts` / `edge-tts`（Python）均按此约定。

* **持久化**：每块成功后立即写入 `state.json` 的 `completedChunks[]`，失败重启可跳过。

### 3.3 片段标准化模块（Per-Chunk Transcoder）

**目标**：把 N 个 MP3 块统一转成参数完全一致的 AAC/M4A，使后续最终合并能真正 `-c copy`。

每个 chunk 独立 FFmpeg 进程，可并发（建议 `Math.max(1, os.cpus().length - 1)`）：

```bash
ffmpeg -hide_banner -loglevel error \
  -i /tmp/job_<id>/raw_<n>.mp3 \
  -c:a aac -profile:a aac_low \
  -b:a 64k -ar 24000 -ac 1 \
  -movflags +faststart \
  /tmp/job_<id>/chunk_<n>.m4a -y
```

参数说明：

| 参数                   | 含义                                          |
| ---------------------- | --------------------------------------------- |
| `-c:a aac`             | 使用 FFmpeg 内置 AAC 编码器                   |
| `-profile:a aac_low`   | AAC-LC，最佳兼容性                            |
| `-b:a 64k`             | 64 kbps，语音足够；可配置                     |
| `-ar 24000`            | 24 kHz 采样率，与 Edge-TTS 源一致，避免重采样 |
| `-ac 1`                | 单声道                                        |
| `-movflags +faststart` | moov 前置（per-chunk 也加上，无副作用）       |

**所有 chunk 必须使用同一组参数**，这是最终 `-c copy` 成立的前提。

转码完成后，立即 `ffprobe` 拿到精确时长（毫秒），写入 `state.json`：

```bash
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 chunk_<n>.m4a
```

### 3.4 FFmpeg 最终合并模块（Remuxer + Chapter Injection）

#### 3.4.1 生成 `filelist.txt`

```
file '/tmp/job_<id>/chunk_001.m4a'
file '/tmp/job_<id>/chunk_002.m4a'
file '/tmp/job_<id>/chunk_003.m4a'
…
```

> 路径中含单引号需转义为 `'\''`；建议直接用 UUID 作为 jobId，避免路径包含特殊字符。

#### 3.4.2 生成 `chapters.ffmeta`

```ini
;FFMETADATA1
title=大国重工
artist=齐橙
album=大国重工
genre=Audiobook

[CHAPTER]
TIMEBASE=1/1000
START=0
END=1823000
title=第一章 工业党

[CHAPTER]
TIMEBASE=1/1000
START=1823000
END=3651420
title=第二章 老熟人

…
```

时长累加方式：

```
chapter_start_ms = sum(chunk.duration_ms for chunk in 前面所有章节的所有 chunk)
chapter_end_ms   = chapter_start_ms + sum(chunk.duration_ms for chunk in 当前章节的所有 chunk)
```

跨 chunk 的章节按 chunk 内的字符占比近似分摊（误差通常 < 1 秒，Apple Books 跳转无感）。

#### 3.4.3 最终合并命令

```bash
ffmpeg -hide_banner -loglevel error \
  -f concat -safe 0 -i /tmp/job_<id>/filelist.txt \
  -i /tmp/job_<id>/chapters.ffmeta \
  -map 0:a -map_metadata 1 \
  -c copy \
  -movflags +faststart \
  -f mp4 \
  /tmp/job_<id>/output.m4b -y
```

参数大白话解析：

* `-f concat -safe 0 -i filelist.txt`：**concat demuxer** 模式（不是已被误用的 `concat:` 协议！`concat:` 协议仅支持 MPEG-TS / MP3 / AAC 裸流，**不支持 MP4 容器**）。`-safe 0` 允许绝对路径。
* `-i chapters.ffmeta` + `-map_metadata 1`：将第 2 个输入（章节文件）作为元数据源，写入输出。
* `-map 0:a`：仅映射第 1 个输入的音频流。
* `-c copy`：**最终合并的核心**——直接 stream copy，零重编码，整本 90 万字小说合并通常在 1–3 秒内完成（视磁盘 IO）。
* `-movflags +faststart`：将 `moov` box 重写到文件头部。FFmpeg 会先把文件写完（moov 在尾部），再回头把 moov 搬到前面。这意味着**不能边合并边推流**——必须等 FFmpeg 退出后再 `createReadStream`。好处是客户端拿到响应头后立刻就能解析章节、跳转、显示总时长。

> **v3 说明：为何删除 `-bsf:a aac_adtstoasc`**
> 该 bitstream filter 的作用是把 ADTS 头转为 MPEG-4 AudioSpecificConfig 格式。在 v2 中作为"保险"保留，但实际上：
>
> 1. 3.3 节的 per-chunk 标准化已经把 MP3 转成了标准的 M4A 容器（输出是 MP4 AudioSpecificConfig，没有 ADTS 头）；
> 2. 此时再加 `aac_adtstoasc` 是冗余的——FFmpeg 会输出 `Bitstream filter aac_adtstoasc not supported for the codec, ignoring` 警告或静默跳过；
> 3. 命令越简洁越易维护。
>
> 但有一个**例外场景**：如果未来切换 TTS 引擎，让其直接产出 ADTS-AAC 裸流（如未来用 Azure 正式 TTS 的某些 raw 格式），跳过 per-chunk 容器化阶段，**那时必须重新加上此 filter**。

#### 3.4.4 事件循环隔离

调用方式使用 `child_process.spawn`（或 `execa`），FFmpeg 完全运行在独立 OS 进程的 C 代码空间内，Node.js 主线程仅监听 `exit` / `error` 事件，对事件循环零阻塞。

---

## 4. API 接口规范（API Specifications）

### 4.1 创建任务

* **请求**：`POST /api/v1/audiobook/jobs`

* **Content-Type**：`application/json`

* **Payload**：

  ```json
  {
    "title": "大国重工",
    "author": "齐橙",
    "voice": "zh-CN-YunxiNeural",
    "rate": "+0%",
    "pitch": "+0Hz",
    "bitrate": "64k",
    "text": "第一章 工业党..."
  }
  ```

* **响应**：`201 Created`

  ```json
  {
    "jobId": "8a1f0c9e-2c1a-4f8a-b5d7-6e3a9c5e2f10",
    "statusUrl": "/api/v1/audiobook/jobs/8a1f0c9e-.../",
    "estimatedSeconds": 1800
  }
  ```

### 4.2 查询任务状态

* **请求**：`GET /api/v1/audiobook/jobs/:jobId`

* **响应**：

  ```json
  {
    "jobId": "...",
    "status": "running",          // pending | running | done | failed | canceled
    "progress": {
      "ttsChunks":       { "done": 45, "total": 113 },
      "transcodeChunks": { "done": 30, "total": 113 },
      "phase": "tts"              // tts | transcode | mux | ready
    },
    "downloadUrl": null,          // status=done 时为 "/api/v1/audiobook/jobs/:jobId/file"
    "error": null,
    "startedAt": "2026-05-25T07:11:23Z",
    "finishedAt": null
  }
  ```

### 4.3 流式下载

* **请求**：`GET /api/v1/audiobook/jobs/:jobId/file`

* **响应头**：

  ```
  HTTP/1.1 200 OK
  Content-Type: audio/mp4
  Content-Disposition: attachment; filename="daguozhonggong.m4b"
  Content-Length: 234567890
  Accept-Ranges: bytes
  ```

* 由于已 `+faststart`，支持 `Range` 请求与断点下载（Fastify 内置支持）。

* 响应结束（`close` 事件）后异步清理临时目录。

### 4.4 取消任务

* **请求**：`DELETE /api/v1/audiobook/jobs/:jobId`
* **响应**：`204 No Content`，杀掉 worker、清理临时文件。

### 4.5 进度推送（可选）

* `GET /api/v1/audiobook/jobs/:jobId/events` → `text/event-stream`（SSE）
* 每完成一个 chunk 推送一帧，前端可显示实时进度条。

---

## 5. 性能与安全设计（Performance & Security）

### 5.1 事件循环隔离

所有重活（FFmpeg 转码、合并、ffprobe）均通过 `child_process.spawn` 派生独立进程；Node.js 主线程仅做协调、I/O 注册、状态读写。Fastify 路由处理函数永远不会同步阻塞。

### 5.2 磁盘垃圾自动回收

* **临时目录隔离**：每个 job 一个独立子目录 `/{tmpRoot}/job_<jobId>/`，便于整体删除。
* **生命周期闭环**：
  * 任务 done 且下载流 `close` → 删除整个 job 目录
  * 任务 failed / canceled → 立即清理
  * 任务 done 但 24 小时未下载 → 定时器扫描清理（保留 state.json 一份做归档）
* **tmpRoot 可配置**：默认 `/tmp`，内存充裕时可指向 `/dev/shm`（tmpfs）；指向 tmpfs 前需启动期校验剩余容量（见 5.4）。

### 5.3 断点续传与状态持久化

系统支持**单机模式**与**分布式模式**两种部署，状态持久化方案随之切换。在配置文件中通过 `deployment.mode: "single" | "distributed"` 显式声明，不允许隐式推断，避免误用。

#### 5.3.1 单机模式（默认）

适用于个人 / 小团队部署，单台机器跑 API + worker。

* **状态载体**：`/{tmpRoot}/job_<jobId>/state.json`

* **片段载体**：`/{tmpRoot}/job_<jobId>/chunk_*.m4a`

* **最终产物**：`/{tmpRoot}/job_<jobId>/output.m4b`

* **状态 schema**：

  ```json
  {
    "jobId": "...",
    "version": 3,
    "mode": "single",
    "totalChunks": 360,
    "ttsCompleted":       [0, 1, 2, ..., 145],
    "transcodeCompleted": [0, 1, ..., 130],
    "chunkDurationsMs":   { "0": 5234, "1": 5871, ... },
    "chapters": [
      { "title": "第一章 工业党", "chunkRange": [0, 2], "chars": 2421 }
    ]
  }
  ```

* **写入策略**：`write-file-atomic`（先写 `.tmp` 再 rename），避免半截文件。

* **恢复**：进程重启后扫描 `tmpRoot` 下所有 `state.json`，按 `ttsCompleted` / `transcodeCompleted` 跳过已完成 chunk，仅补跑缺口。

#### 5.3.2 分布式模式

适用于多 worker 横向扩展。**单机模式下的本地文件方案在此完全失效**——其他机器读不到本机的 `state.json`，必须把状态与文件都上浮到共享层。

* **状态载体**：Redis Hash，key = `audiobook:job:<jobId>`
  * field：`status`、`progress`、`ttsCompleted`（Redis Bitmap 或 Set）、`transcodeCompleted`、`chunkDurationsMs`（Hash 嵌套或单独 key）、`chapters`（JSON 字符串）
  * 配合 **BullMQ** 的 job state 管理任务生命周期，BullMQ 自带重试 / 死信 / 进度推送
* **片段载体**：对象存储（S3 / MinIO / R2 兼容），key = `audiobook/<jobId>/chunk_<n>.m4a`
* **最终产物**：对象存储，key = `audiobook/<jobId>/output.m4b`，下载时返回**预签名 URL**（默认 24 小时有效），CDN 直连
* **本地磁盘**：每个 worker 仍使用 `/{tmpRoot}/job_<jobId>/` 做**临时工作目录**，但**进程退出后立即清空**，无持久化语义
* **路由**：相同 jobId 的多个 chunk 任务**不要求**落到同一台 worker（BullMQ 默认行为即可），但**最终合并阶段**必须由单台 worker 完成——这一步需先把所有 chunk 从 S3 拉到本地临时目录、生成 filelist.txt、跑 FFmpeg、再把 output.m4b 推回 S3。可在 BullMQ 中用单独的 `merge` queue（concurrency=1 per worker）实现
* **故障转移**：worker 崩溃，BullMQ 自动把任务重新入队；新 worker 从 Redis 读 `ttsCompleted` / `transcodeCompleted`，跳过已完成 chunk

#### 5.3.3 模式切换边界

| 维度         | 单机模式         | 分布式模式                      |
| ------------ | ---------------- | ------------------------------- |
| 部署成本     | 低（一个进程）   | 高（Redis + 对象存储）          |
| 适用任务量   | < 50 任务/天     | > 100 任务/天 或要求高可用      |
| 状态丢失风险 | 单机宕机即丢失   | Redis 持久化 + 对象存储         |
| 横向扩展     | ✗                | ✓                               |
| 实现复杂度   | 单 worker 类即可 | 需引入 BullMQ + S3 SDK + 分队列 |

代码层面通过抽象 `StateStore` 与 `BlobStore` 接口隔离两种实现，业务逻辑无需关心。

### 5.4 资源配额与限流

* **文本上限**：请求体 `text` 字段硬上限 5MB（约 250 万字），可配置；超出直接 413。

* **任务并发**：单实例并行任务数限制（默认 3），超出排队。

* **磁盘预估**（v3 修正公式）：提交任务时按下式估算最终 m4b 大小：

  ```
  estimated_mb = text_char_count × 0.0016 × 1.2
  ```

  推导：64 kbps 码率 = 8 KB/s；中文朗读约 5 字/秒（300 字/分钟）→ 每字约 1.6 KB ≈ **0.0016 MB/字**。1.2 是预留缓冲系数。

  **峰值占用**还需考虑临时文件：MP3 原始片段 + M4A 标准化片段 + 最终 m4b ≈ 2.5 × 最终大小。

  ```
  peak_mb = estimated_mb × 2.5
  ```

  示例：90 万字 → estimated ≈ 1.44 GB，peak ≈ 3.6 GB。

  > **v3 修订说明**：v2 公式 `0.0003 MB/字` 严重低估约 5 倍（按其推算 90 万字仅 270 MB，实际 1.44 GB）。若 `tmpRoot` 指向 `/dev/shm`（默认为物理内存一半），按旧公式预估会直接 OOM。**这是 v2 的致命 bug**。

  若 `tmpRoot` 剩余空间 < `peak_mb`，拒绝任务并返回 `507 Insufficient Storage`。

* **IP 限流**：`@fastify/rate-limit`，默认每 IP 每小时 5 个任务。

* **鉴权**：建议 API Key（Header `X-API-Key`）或 JWT；公网部署不可裸跑。

### 5.5 SSRF / 注入防护

* `text` 字段在送入 Edge-TTS 前**剥离所有 SSML 标签**（`<...>`），防止用户注入 `<voice>`、`<lexicon src="...">` 等导致服务端发起外部请求。
* `voice` / `rate` / `pitch` 用白名单校验：voice 必须在已知 voice 列表，rate / pitch 必须匹配 `^[+-]?\d{1,3}(%|Hz)$`。

### 5.6 可观测性

* 结构化日志（pino，Fastify 内置）：每 chunk 输出 `{ jobId, chunkIndex, phase, durationMs, attempts, bytes, upstreamStatus }`。
* Prometheus 指标：
  * `audiobook_jobs_total{status}` — 任务总数（按 done / failed / canceled 维度）
  * `audiobook_chunk_duration_seconds{phase}` (histogram) — 单 chunk 耗时（按 tts / transcode / mux 维度）
  * `audiobook_tts_retries_total{reason}` — 重试次数（按 429 / 5xx / network / parse 维度）
  * `audiobook_active_jobs` — 当前并行任务数
  * `audiobook_tts_upstream_status_code{code}` (counter) — **Edge-TTS 接口返回的原始状态码**（200 / 429 / 503 / 1006 / …）。**v3 新增**，用于：
    1. 监控 429 比例自动降并发；
    2. 监控 5xx / WebSocket 1006 比例触发代理池切换告警；
    3. 长期统计分析微软风控策略变化。
* 健康检查：`GET /healthz` 检查 FFmpeg 可执行、tmpRoot 可写、剩余磁盘。

---

## 6. 已知问题与设计取舍（Known Issues）

本节记录设计中明确**不修复**的问题及理由，避免后续被反复挑战。

### 6.1 AAC 拼接处的 priming samples / encoder delay

**问题描述**：AAC-LC 编码器在每个独立文件开头会写入约 2112 个 priming samples（约 44 ms @ 24 kHz），这是 AAC 算法的暖机数据，应当被解码器跳过。当 `-c copy` 拼接多个 AAC 片段时，每个 chunk 的 priming samples 会被当作正常音频播放，理论上会在 chunk 边界产生轻微的"咔哒"声。

**为何不修复**：

1. **现代播放器原生处理 gapless**：FFmpeg 6+ 输出 M4A 时默认写入 edit list（`elst` box），告知播放器跳过 priming samples。Apple Books / Apple Music / iOS 系统媒体框架完全支持 gapless playback，在目标场景（苹果生态）下**实测无感知**。
2. **可选的修复方案均破坏核心设计**：
   - 用 `afade` 给每个 chunk 尾部加淡出：会强制重编码，破坏"最终合并零重编码"的核心设计；且两个 chunk 之间会出现音量凹陷的"呼吸感"，比咔哒声更糟。
   - 用 `acrossfade` 做交叉淡入淡出：同样要重编码，且需要文本上 1~2 字重叠，增加切片复杂度。
   - 自己计算 priming samples 数量、用 `aresample=async=1` 重对齐：要重编码，性价比低。
3. **简陋第三方播放器**（如部分 Android 应用）可能感知到，但**不在目标用户群内**。

**结论**：保留 stream copy 零重编码方案，依赖 edit list + 现代播放器的 gapless 支持。若未来要兼容低端 Android 播放器，再切换到 acrossfade 重编码方案。

### 6.2 章节时长跨 chunk 分摊误差

**问题描述**：当一个 TTS chunk 内同时存在多个短章节的切换点（如 chunk 内有 "...上一章结尾。第二章 标题\n第二章正文..."），无法精确知道章节切换点在音频中的毫秒位置，只能按"字符占比"近似分摊。

**误差范围**：单次分摊误差约 ±500 ms。Apple Books 的章节跳转用户感知阈值约为 ±2 秒，故对体验影响极小。

**为何不修复**：精确做法是把每个章节都切成独立 TTS 请求，但这会大幅增加 TTS 请求数（90 万字 100 章 → 100 个独立请求，且每个请求的字数差异极大，浪费并发名额）。性价比不值。

### 6.3 边合并边推流不可同时与 `+faststart` 共存

**问题描述**：`-movflags +faststart` 要求 FFmpeg 写完文件后回头改写 moov box，所以**必须等 FFmpeg 退出才能开始推流**。这与"边合并边推流"的理想目标冲突。

**为何不修复**：

1. 最终合并阶段本身极快（90 万字约 1~3 秒，纯 IO）；
2. 不加 faststart 会让客户端 seek / 章节解析必须等下载完成，对体验影响远大于多等 3 秒；
3. TTS 阶段才是耗时大头（分钟级），客户端是异步任务模式，不在 HTTP 长连接里等待。

---

## 7. 关键风险与缓解

| 风险                             | 影响           | 缓解                                                         |
| -------------------------------- | -------------- | ------------------------------------------------------------ |
| Edge-TTS 接口变更 / 鉴权策略调整 | 整体不可用     | 抽象 TTS 接口层，预留接入 Azure 正式 TTS / 本地 Coqui 等的口子 |
| 长任务进行中实例崩溃             | 用户体验差     | 断点续传：单机模式 state.json + 本地磁盘；分布式模式 Redis + S3（详见 5.3） |
| 高峰期 IP 被微软封禁             | 大批任务失败   | 出站走代理池；`audiobook_tts_upstream_status_code` 监控 429 / 1006 比率自动降并发 |
| `/dev/shm` 写满                  | OOM 风险       | 启动期 + 任务开始期双重容量校验（公式见 5.4）；优先回退到 `/tmp` |
| moov 在尾部导致客户端无法 seek   | iOS 播放体验差 | 强制 `-movflags +faststart`，验证 ftyp/moov/mdat 顺序        |
| 章节时长累加误差累积             | 章节跳转偏移   | 用 ffprobe 实测每 chunk 时长（毫秒级精度），不用估算         |
| 误把正文当章节标题               | 章节目录错乱   | 3.1.1 四重校验：字数 + 双空行 + 单调性 + 总数合理性          |

---

## 8. 部署建议

* **运行时**：Node.js ≥ 20 LTS；FFmpeg ≥ 6.0（提供稳定的 concat demuxer 与 AAC 编码器）。
* **容器化**：Dockerfile 基础镜像 `node:20-bookworm-slim` + `apt-get install -y ffmpeg`。
* **资源**：单实例建议 2 vCPU / 4GB RAM 起步；`/dev/shm` ≥ 1GB。
* **横向扩展**：worker 与 API 分离，任务队列接 Redis / BullMQ；多 worker 共享对象存储（S3 兼容）存放 output.m4b。
* **CDN**：m4b 文件可上传 S3 后返回带签名的 CDN 直链，进一步卸载 Node.js 出口带宽。

---

## 附录 A：v1 → v2 变更摘要

| #    | v1 写法                                                     | v2 修订                                                  | 原因                               |
| ---- | ----------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| 1    | `ffmpeg -i "concat:a.m4a\|b.m4a" -c copy`                   | `ffmpeg -f concat -safe 0 -i filelist.txt -c copy`       | `concat:` 协议不支持 MP4/M4A 容器  |
| 2    | Edge-TTS 输出 `audio-24khz-48kbps-...-mp4a`（不存在的格式） | 输出 `audio-24khz-48kbitrate-mono-mp3`，per-chunk 转 AAC | 真实接口不支持                     |
| 3    | 未提及章节元数据                                            | 引入 FFmetadata + `-map_metadata 1`                      | Apple Books 章节目录依赖此         |
| 4    | 同步 POST 直接 200 流式下载                                 | 异步任务三段式 API                                       | 反向代理超时、长任务可观测性       |
| 5    | `-absf aac_adtstoasc`                                       | `-bsf:a aac_adtstoasc`                                   | `-absf` 已废弃                     |
| 6    | 无 `-movflags +faststart`                                   | 必加                                                     | 客户端 seek / 章节解析时机         |
| 7    | 章节切片与 TTS 块切片混用一套正则                           | 分两个独立维度                                           | 章节用于元数据，TTS 块用于请求限制 |
| 8    | 无断点续传                                                  | state.json 检查点                                        | 20–40 分钟长任务必备               |
| 9    | 未提及配额 / 鉴权 / 限流                                    | 完整安全章节                                             | 公网部署底线                       |
| 10   | 章节正则只覆盖"第 X 章/回/卷/集/节"                         | 增加序章 / 楔子 / 番外 / 数字章节变体                    | 覆盖网文与出版书                   |

---

## 附录 B：v2 → v3 变更摘要

| #    | v2 写法                               | v3 修订                                                      | 原因                                                         | 严重度 |
| ---- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------ |
| 1    | 磁盘公式 `text.length × 0.0003 MB/字` | `text.length × 0.0016 × 1.2 MB`，峰值 × 2.5                  | 64kbps / 5 字每秒推导出每字 1.6 KB，v2 低估 5 倍，挂 /dev/shm 直接 OOM | 🔴 致命 |
| 2    | 默认 TTS 块 8000 字                   | 默认 2500 字（可配 1000~5000）                               | 失败爆炸半径小、流水线启动早、进度更细                       | 🟠 重要 |
| 3    | 章节正则单条匹配 + 数量 < 3 兜底      | 正则 + 四重后置校验（字数 / 双空行 / 单调 / 总数）           | 避免"第六章涉及的……"类正文行被误识别                         | 🟠 重要 |
| 4    | 最终合并保留 `-bsf:a aac_adtstoasc`   | 删除该 filter                                                | per-chunk 已是 M4A 容器无 ADTS 头，filter 冗余               | 🟡 一般 |
| 5    | state.json 单一方案                   | 单机 / 分布式两套方案，配置 `deployment.mode` 显式切换       | v2 中 5.3（state.json）与 7（横向扩展）冲突                  | 🟠 重要 |
| 6    | Prometheus 指标 4 项                  | 增加 `audiobook_tts_upstream_status_code{code}`              | 监控微软风控、驱动代理池切换                                 | 🟡 一般 |
| 7    | 未说明 AAC 拼接处咔哒声               | 新增第 6 章"已知问题"，记录 priming samples / edit list / gapless 的取舍 | 避免被反复挑战、明确不修复理由                               | 🟡 一般 |

### 拒绝采纳的审稿建议

| 建议                                             | 拒绝理由                                                     |
| ------------------------------------------------ | ------------------------------------------------------------ |
| 片段标准化改输出裸 AAC（`.aac`）而非 M4A         | 裸 AAC 文件无容器，ffprobe 拿不到精确时长，章节元数据精度会下降；M4A 容器开销 < 5KB/chunk 可忽略 |
| 用 `afade` 给每个 chunk 尾部加 0.05 秒淡出防爆音 | 会强制重编码破坏核心设计；且两 chunk 间会有音量凹陷的"呼吸感"，比咔哒声更糟；目标平台（Apple Books）依赖 edit list 实现 gapless，本就无感知 |
| 章节正则用"无标点"作为判别条件                   | 网文章节标题经常带标点（"第三章：决战！"），按无标点过滤会漏掉真章节，v3 改用"字数 + 双空行 + 单调 + 总数"四重校验更稳 |
