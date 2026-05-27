# High-Performance Audiobook (M4B) Generation Service Plan

This document outlines the design and implementation tasks to build a Fastify + Edge-TTS + FFmpeg based audiobook generation service, following the single-node architecture specified in `plan.md`.

---

## User Review Required

> [!IMPORTANT]
> **Key Architectural Decisions & Finalized Design Choices:**
> 1. **No External DB / State Store**: The service uses a simple filesystem-based `state.json` inside each task's directory for check-pointing and state restoration.
> 2. **Zero-Tolerance Retry & Resume**: A job fails if a chunk fails after 3 retries, but users can manually resume from the checkpoint using the Resume API.
> 3. **Immediate Cleanup**: The job directory and output files are deleted immediately after a successful full download to maximize disk space efficiency.
> 4. **Voice Whitelist**: Strictly restricted to core mainland Mandarin voices (`zh-CN-YunxiNeural`, `zh-CN-XiaoxiaoNeural`, `zh-CN-YunjianNeural`).
> 5. **Runtime-Only FFmpeg Check**: FFmpeg/FFprobe availability is checked on-demand during task run, not on server startup.
> 6. **Proportional Disk Space Pre-check**: Expected peak disk space scales dynamically based on requested bitrate (128k -> 2.0x, 32k -> 0.5x, 64k -> 1.0x).
> 7. **FFmpeg Transcode Thread Limit**: Added `-threads 1` to the per-chunk transcode command to optimize CPU resource allocation.
> 8. **Boot Recovery in Paused State**: On server startup, recovered jobs are loaded in `paused` state and require a manual resume call.
> 9. **Upload File Validation**: Strict validation of MIME-types and file extensions for both text (`.txt`, `text/plain`) and cover (`.jpg`/`.jpeg`/`.png`, `image/jpeg`/`image/png`).
> 10. **Code Comments**: Rich Chinese comments and JSDoc for all core files, complex split algorithms, and concurrency pools.

---

## Open Questions

None. All architectural decisions have been discussed and aligned with the user.

---

## Proposed Changes

We will create a structured TypeScript project in the `/Users/he/projects/tts` directory.

### Project Infrastructure & Config

#### [NEW] [package.json](file:///Users/he/projects/tts/package.json)
Initialize npm project with TypeScript, Fastify, Vitest, and other required npm libraries (`jschardet`, `iconv-lite`, `msedge-tts`, `https-proxy-agent`, `@fastify/multipart`, `fastify-sse-v2`).

#### [NEW] [tsconfig.json](file:///Users/he/projects/tts/tsconfig.json)
Standard Node.js TypeScript configuration.

#### [NEW] [.env.example](file:///Users/he/projects/tts/.env.example)
Define all required configuration environment variables (e.g., `PORT`, `HOST`, `TMP_ROOT`, `MAX_CONCURRENT_JOBS`, `CONCURRENT_TTS_LIMIT`, etc.) with default values.

---

### Core Library / Utilities

#### [NEW] [text.ts](file:///Users/he/projects/tts/src/utils/text.ts)
Contains:
1. Encoding detector (`jschardet`) and stream/buffer decoder (`iconv-lite`).
2. HTML/SSML tag cleaner to prevent SSML injection.
3. Clean word count calculator (Unicode code points excluding whitespace).
4. Chapter detection regex & 4-fold validation (row length, physical paragraph boundary, monotonic index increase, density check).
5. Virtual chapters fallback splitter (every 15,000 words).
6. TTS chunk splitter (splitting chapters into chunks <= `chunkSize` at sentence/punctuation boundaries).

#### [NEW] [ffmpeg.ts](file:///Users/he/projects/tts/src/utils/ffmpeg.ts)
FFmpeg wrapper:
1. `transcodeToM4A(rawPath, outPath, timeoutMs)`: MP3 to AAC standard (24kHz Mono 64k M4A) with timeout.
2. `getDuration(filePath)`: Parse duration using `ffprobe`.
3. `concatAndMux(fileListPath, ffmetaPath, coverPath, outPath, timeoutMs)`: Merges M4A files and writes tags/chapters.
4. `validateM4B(filePath)`: Container check, chapter count, and `moov` faststart atom placement verification.

---

### Provider System

#### [NEW] [tts.ts](file:///Users/he/projects/tts/src/types/tts.ts)
`TTSProvider`, `TTSOptions`, and `TTSResult` interface declarations.

#### [NEW] [edge-tts.ts](file:///Users/he/projects/tts/src/providers/edge-tts.ts)
`EdgeTTSProvider` implementing `TTSProvider` using `msedge-tts`. Configures WebSocket client and applies `TTS_PROXY` proxy configuration if provided.

---

### Queue & Worker Service

#### [NEW] [job-manager.ts](file:///Users/he/projects/tts/src/services/job-manager.ts)
1. Job states definitions and transitions.
2. Global concurrency lock (`MAX_CONCURRENT_JOBS`) and disk space checker.
3. Job workspace creator, state checkpointing (`state.json` updates).
4. Parallel Pipeline execution scheduler:
   - TTS worker pool (max size = `CONCURRENT_TTS_LIMIT`).
   - Transcode worker pool (max size = `CONCURRENT_TRANSCODE_LIMIT`).
5. Event emitters for SSE notifications.
6. Periodic Garbage Collection for completed/failed tasks (cleans up folders downloaded > 1 hour ago, or created > 2 hours ago).
7. Boot recovery scanner to resume interrupted tasks.

---

### Fastify Server & API Routing

#### [NEW] [jobs.ts](file:///Users/he/projects/tts/src/routes/jobs.ts)
Fastify route handlers:
- `POST /api/v1/audiobook/jobs` (receives multipart upload, strictly validates files/params, returns 503 if global limit is reached).
- `GET /api/v1/audiobook/jobs/:jobId` (checks progress/status).
- `POST /api/v1/audiobook/jobs/:jobId/resume` (resumes a paused or failed task; returns 404 if state files are missing, 400 if already running).
- `GET /api/v1/audiobook/jobs/:jobId/events` (SSE endpoint for real-time progress).
- `GET /api/v1/audiobook/jobs/:jobId/file` (pipes final M4B, supports range/resume, deletes the job workspace directory immediately upon successful full download stream close).
- `DELETE /api/v1/audiobook/jobs/:jobId` (cancels running job, terminates subprocesses, and cleans up directory).

#### [NEW] [server.ts](file:///Users/he/projects/tts/src/server.ts)
Fastify server configuration, plugin registration, custom error handlers, and listening port setup (localhost-only for testing, configurably bound for production). Graceful shutdown hook listener (`SIGTERM`/`SIGINT`) to clean up subprocesses and save checkpoints.

---

## Verification Plan

### Automated Tests
Run Vitest unit tests:
`npx vitest run`
- **Text Processing**: Test character count, chapter matching/filtering, and chunk splitting.
- **FFmpeg Wrappers**: Test M4A transcoding, metadata creation, and M4B validation (using brief mock audio files).

### Manual Verification
1. Start the server locally: `npm run dev` (running on `127.0.0.1:3000`).
2. Trigger job generation using a sample text file and cover image via `curl` multipart upload.
3. Listen to the SSE stream to inspect real-time progress.
4. Download the generated `.m4b` file and verify in Apple Books / VLC:
   - Check cover art display.
   - Check chapter navigation.
   - Check duration correctness.
5. Verify graceful shutdown by sending `SIGTERM` mid-process and validating resumption after restarting.

### Security Validation
1. **SSML Injection Prevention**: Pass input files containing `<voice>` and `<speak>` tags to verify sanitization.
2. **Command Injection Prevention**: Verify that special characters in `title` or `author` do not compromise FFmpeg execution (since parameters are mapped directly as spawn arguments rather than executed via shell).
3. **Path Traversal Prevention**: Verify that upload files cannot escape the designated `TMP_ROOT` directory.
4. **Server Binding**: Ensure the server listens on `127.0.0.1` by default when testing, preventing external access.
