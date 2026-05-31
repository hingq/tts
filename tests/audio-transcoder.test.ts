/**
 * @file audio-transcoder.test.ts
 * @description 有声书音频转码服务的离线单元测试。
 * 覆盖 `runCommandAsync`、元数据生成（转义 + 时间轴计算）、faststart 检测、
 * filelist 路径转义以及混合逻辑的参数构建。
 *
 * 所有 `spawn` / `fs` 调用均通过 `vi.mock` 替换为内存 mock，无需外部二进制依赖。
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import fs from 'fs';

// ─── mock child_process.spawn ────────────────────────────────────

/**
 * 创建一个可控的 mock ChildProcess。
 * 调用方可以通过 emitStdout / emitStderr / emitClose 驱动事件。
 */
function createMockChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const child = new EventEmitter() as cp.ChildProcess & {
    stdout: Readable;
    stderr: Readable;
    kill: MockInstance;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof cp>('child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// mock config 使其不依赖 .env / 文件系统
vi.mock('../src/config.js', () => ({
  config: {
    FFMPEG_PATH: 'ffmpeg',
    FFPROBE_PATH: 'ffprobe',
    SUBPROCESS_TIMEOUT_MS: 60000,
  },
}));

// ─── 导入被测模块（必须在 mock 之后） ───────────────────────────

import {
  runCommandAsync,
  escapeMetadataValue,
  escapeFilelistPath,
  writeChaptersMetadata,
  writeFileList,
  validateFaststart,
  transcodeSegment,
  extractDurationMs,
} from '../src/services/audio-transcoder.js';

// ─── runCommandAsync ─────────────────────────────────────────────

describe('runCommandAsync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with stdout/stderr/exitCode on success', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    const promise = runCommandAsync('echo', ['hello'], 5000);

    process.nextTick(() => {
      // 模拟标准输出并关闭
      child.stdout.push(Buffer.from('hello world\n'));
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit('close', 0);
    });

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stderr).toBe('');
  });

  it('rejects when process exits with non-zero code', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    const promise = runCommandAsync('fail', [], 5000);

    child.stdout.push(null);
    child.stderr.push(Buffer.from('error msg'));
    child.stderr.push(null);
    child.emit('close', 1);

    await expect(promise).rejects.toThrow('Command failed with exit code 1');
  });

  it('rejects on spawn error', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    const promise = runCommandAsync('nonexistent', [], 5000);

    child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('ENOENT');
  });

  it('rejects with timeout and calls SIGKILL', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    // 使用非常短的超时
    const promise = runCommandAsync('hang', [], 50);

    // 不发任何 close 事件 → 触发超时
    await expect(promise).rejects.toThrow('Command timed out after 50ms');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('spawn is called with shell: false', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    const promise = runCommandAsync('ffmpeg', ['-version'], 5000);

    child.stdout.push(Buffer.from('ffmpeg version 6.0'));
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit('close', 0);

    await promise;

    expect(cp.spawn).toHaveBeenCalledWith(
      'ffmpeg',
      ['-version'],
      expect.objectContaining({ shell: false }),
    );
  });
});

// ─── escapeMetadataValue ─────────────────────────────────────────

describe('escapeMetadataValue', () => {
  const cases: Array<[string, string]> = [
    ['plain text', 'plain text'],
    ['back\\slash', 'back\\\\slash'],
    ['equals=sign', 'equals\\=sign'],
    ['semi;colon', 'semi\\;colon'],
    ['hash#tag', 'hash\\#tag'],
    ['all\\=;#', 'all\\\\\\=\\;\\#'],
    ['', ''],
  ];

  it.each(cases)('escapeMetadataValue(%j) === %j', (input, expected) => {
    expect(escapeMetadataValue(input)).toBe(expected);
  });
});

// ─── escapeFilelistPath ──────────────────────────────────────────

describe('escapeFilelistPath', () => {
  const cases: Array<[string, string]> = [
    ['/path/to/file.m4a', '/path/to/file.m4a'],
    ["/path/it's/file.m4a", "/path/it'\\''s/file.m4a"],
    ["path with 'quotes' inside", "path with '\\''quotes'\\'' inside"],
    ['no special chars', 'no special chars'],
  ];

  it.each(cases)('escapeFilelistPath(%j) === %j', (input, expected) => {
    expect(escapeFilelistPath(input)).toBe(expected);
  });
});

// ─── writeChaptersMetadata ───────────────────────────────────────

describe('writeChaptersMetadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('generates correct FFMETADATA1 with chapters', async () => {
    let writtenContent = '';
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(
      async (_path, data) => {
        writtenContent = data as string;
      },
    );

    await writeChaptersMetadata(
      {
        title: 'Book=Title',
        artist: 'Author;Name',
        chapters: [
          { title: 'Chapter 1', durationMs: 5000 },
          { title: 'Chapter #2', durationMs: 3000 },
        ],
      },
      '/tmp/chapters.ffmeta',
    );

    // 验证头部
    expect(writtenContent).toContain(';FFMETADATA1');
    expect(writtenContent).toContain('title=Book\\=Title');
    expect(writtenContent).toContain('artist=Author\\;Name');
    expect(writtenContent).toContain('genre=Audiobook');

    // 验证章节 1 时间轴
    expect(writtenContent).toContain('START=0');
    expect(writtenContent).toContain('END=5000');
    expect(writtenContent).toContain('title=Chapter 1');

    // 验证章节 2 时间轴（累积偏移）
    expect(writtenContent).toContain('START=5000');
    expect(writtenContent).toContain('END=8000');
    expect(writtenContent).toContain('title=Chapter \\#2');
  });
});

// ─── writeFileList ───────────────────────────────────────────────

describe('writeFileList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('generates correct filelist.txt with escaped paths', async () => {
    let writtenContent = '';
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(
      async (_path, data) => {
        writtenContent = data as string;
      },
    );

    await writeFileList(
      ['/audio/ch1.m4a', "/audio/it's ch2.m4a"],
      '/tmp/filelist.txt',
    );

    const lines = writtenContent.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("file '/audio/ch1.m4a'");
    expect(lines[1]).toBe("file '/audio/it'\\''s ch2.m4a'");
  });
});

// ─── validateFaststart ───────────────────────────────────────────

describe('validateFaststart', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when moov appears before mdat', async () => {
    // 构造一个 buffer：[...padding...moov...padding...mdat...]
    const buf = Buffer.alloc(256);
    buf.write('moov', 20, 'ascii');
    buf.write('mdat', 100, 'ascii');

    const mockFd = {
      stat: vi.fn().mockResolvedValue({ size: 256 }),
      read: vi.fn().mockImplementation(
        async (buffer: Buffer, _offset: number, length: number, _pos: number) => {
          buf.copy(buffer, 0, 0, length);
          return { bytesRead: length, buffer };
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(fs.promises, 'open').mockResolvedValueOnce(mockFd as unknown as fs.promises.FileHandle);

    expect(await validateFaststart('/test.m4b')).toBe(true);
  });

  it('returns false when mdat appears before moov', async () => {
    const buf = Buffer.alloc(256);
    buf.write('mdat', 20, 'ascii');
    buf.write('moov', 100, 'ascii');

    const mockFd = {
      stat: vi.fn().mockResolvedValue({ size: 256 }),
      read: vi.fn().mockImplementation(
        async (buffer: Buffer, _offset: number, length: number, _pos: number) => {
          buf.copy(buffer, 0, 0, length);
          return { bytesRead: length, buffer };
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(fs.promises, 'open').mockResolvedValueOnce(mockFd as unknown as fs.promises.FileHandle);

    expect(await validateFaststart('/test.m4b')).toBe(false);
  });

  it('returns false when moov is missing', async () => {
    const buf = Buffer.alloc(256);
    buf.write('mdat', 20, 'ascii');

    const mockFd = {
      stat: vi.fn().mockResolvedValue({ size: 256 }),
      read: vi.fn().mockImplementation(
        async (buffer: Buffer, _offset: number, length: number, _pos: number) => {
          buf.copy(buffer, 0, 0, length);
          return { bytesRead: length, buffer };
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(fs.promises, 'open').mockResolvedValueOnce(mockFd as unknown as fs.promises.FileHandle);

    expect(await validateFaststart('/test.m4b')).toBe(false);
  });

  it('returns true when moov present but mdat is not in first 128KB', async () => {
    const buf = Buffer.alloc(256);
    buf.write('moov', 20, 'ascii');

    const mockFd = {
      stat: vi.fn().mockResolvedValue({ size: 256 }),
      read: vi.fn().mockImplementation(
        async (buffer: Buffer, _offset: number, length: number, _pos: number) => {
          buf.copy(buffer, 0, 0, length);
          return { bytesRead: length, buffer };
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(fs.promises, 'open').mockResolvedValueOnce(mockFd as unknown as fs.promises.FileHandle);

    expect(await validateFaststart('/test.m4b')).toBe(true);
  });
});

// ─── transcodeSegment ────────────────────────────────────────────

describe('transcodeSegment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls ffmpeg with correct AAC encoding arguments', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    const promise = transcodeSegment('/input.mp3', '/output.m4a');

    child.stdout.push(null);
    child.stderr.push(null);
    child.emit('close', 0);

    await promise;

    expect(cp.spawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining([
        '-y',
        '-i', '/input.mp3',
        '-c:a', 'aac',
        '-profile:a', 'aac_low',
        '-b:a', '64k',
        '-ar', '24000',
        '-ac', '1',
        '-movflags', '+faststart',
        '/output.m4a',
      ]),
      expect.objectContaining({ shell: false }),
    );
  });
});

// ─── extractDurationMs ──────────────────────────────────────────

describe('extractDurationMs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses ffprobe output and returns duration in ms', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    const promise = extractDurationMs('/audio.m4a');

    process.nextTick(() => {
      // ffprobe outputs duration as a float string
      child.stdout.push(Buffer.from('12.345678\n'));
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit('close', 0);
    });

    const result = await promise;
    expect(result).toBe(12346); // Math.round(12.345678 * 1000)
  });

  it('throws on non-numeric ffprobe output', async () => {
    const child = createMockChild();
    vi.mocked(cp.spawn).mockReturnValueOnce(child);

    const promise = extractDurationMs('/bad.m4a');

    process.nextTick(() => {
      child.stdout.push(Buffer.from('N/A\n'));
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit('close', 0);
    });

    await expect(promise).rejects.toThrow('Failed to parse duration');
  });
});
