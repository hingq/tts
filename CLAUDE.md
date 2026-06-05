# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Dev server with live reload (tsx watch)
npm run build        # Production build via esbuild
npm test             # Run all tests (vitest)
npm run lint         # ESLint
npm run format       # Prettier (write)
npm run format:check # Prettier (check only)

# Run a single test file
npx vitest run tests/services/job-pipeline.test.ts
```

## Architecture

This is a TypeScript/Node.js audiobook generation service. It converts uploaded text files into M4B audiobooks using Edge-TTS for speech synthesis and FFmpeg for audio assembly.

### Request flow

```
POST /jobs (multipart: text file + optional cover)
  → src/routes/jobs.ts         — validation, parameter whitelisting
  → src/services/job-manager.ts — slot reservation, text preprocessing, state init
  → src/services/job-pipeline.ts — background async execution
      ├─ TTS pool (p-limit): Edge-TTS → MP3 per chunk
      └─ Transcode pool (p-limit): FFmpeg MP3→M4A per chunk (overlaps with TTS)
  → src/services/audio-transcoder.ts — final M4B assembly with chapter metadata
  → GET /jobs/:id/events (SSE) — real-time progress to client
  → GET /jobs/:id/file — Range-header-capable download
```

### Key services (`src/services/`)

- **`job-manager.ts`** — Singleton. Manages job lifecycle (`pending→running→done|failed|canceled`), concurrency slots, disk verification, state persistence, and SSE event emission.
- **`job-pipeline.ts`** — Two independent `p-limit` pools: a TTS pool (serializes Edge-TTS requests to avoid 429) and a transcode pool (parallelizes FFmpeg CPU work). Chunks flow through both pools concurrently. Implements global 429 cooldown (30s pause shared across all chunks) and per-chunk retry with exponential backoff.
- **`text-processor.ts`** — Detects encoding (jschardet), sanitizes text (HTML removal), detects chapters via regex + 4-level validation (regex → line length ≤40 chars → blank line isolation → monotonic sequence), splits chapters into ~2500-char TTS chunks with punctuation backtracking.
- **`audio-transcoder.ts`** — FFmpeg subprocess wrapper: MP3→M4A transcoding, duration extraction via ffprobe, M4B assembly with chapter FFMETADATA and cover image, moov-atom faststart validation.
- **`gc.ts`** — Periodic cleanup: removes job directories after download (`.downloaded` marker).

### Provider (`src/providers/`)

- **`edge-tts.ts`** — Implements `TTSProvider` interface. Sanitizes voice/rate/pitch to prevent SSML injection. Throws `TTSThrottleError` on 429 for pipeline-level handling. Supports optional HTTPS proxy.

### Persistence and recovery

Each job's state is checkpointed to `${TMP_ROOT}/${jobId}/state.json` after every successful TTS and transcode step. On server restart, `job-manager.ts` recovers in-progress jobs by reloading state and re-running the pipeline — chunk processing is idempotent (skips chunks already marked `tts_done` or `transcode_done`).

### Configuration (`src/config.ts`)

All config from environment variables (see `.env.example`). Key vars: `TMP_ROOT`, `MAX_CONCURRENT_JOBS`, `CONCURRENT_TTS_LIMIT`, `CONCURRENT_TRANSCODE_LIMIT`, `SUBPROCESS_TIMEOUT_MS`, `GLOBAL_TASK_TIMEOUT_MS`, `FFMPEG_PATH`, `FFPROBE_PATH`, `TTS_PROXY`.

### Job state machine

```
Status:  pending → running → done | failed | canceled
Phases:  preprocess → tts → mux → validating → ready
Chunk:   pending → tts_done → transcode_done | failed
```
