# 5. FFmpeg / ffprobe 音频转码及校验封装 (Audio Transcoder & Muxer) 详细执行步骤

本模块负责通过包装 Node.js `child_process.spawn` 实现对 FFmpeg/FFprobe 的子进程调用。由于需要传入用户指定的书名、作者等输入，必须实施严格的防 Shell 注入安全策略。

> [!IMPORTANT]
> **代码注释约束**：
> 必须为本模块定义的 `runCommandAsync` 进程管理器（包括超时强杀定时器清理逻辑）、片段 AAC 标准化转码、FFprobe 精确时长获取、`chapters.ffmeta` 结构生成逻辑、文件路径安全转义及最终的二进制 `moov` 原子前置校验算法编写规范的 JSDoc 和步骤行内注释。

---

## 5.1 安全执行规范与子进程管理

### 5.1.1 绝对禁止使用 `exec`
在调用命令行时，绝对禁止使用 `child_process.exec`，因为其会在系统 Shell 中解释命令，导致重大命令注入隐患。
* **规则**：统一使用 `child_process.spawn`，且**不开启** `{ shell: true }` 选项。所有命令行参数作为严格的 `string[]` 数组传入，由操作系统内核直接创建子进程。

### 5.1.2 带有超时守护的进程执行器
为防止 FFmpeg 进程由于文件损坏、异常锁定或死锁而挂起僵死，必须编写带有超时机制的子进程执行函数：

```typescript
import { spawn } from 'child_process';

export function runCommandAsync(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // 超时后强行杀掉
      reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

---

## 5.2 单个片段标准化转码

每个 Chunk 在 TTS 合成成功后，触发标准化转码，统一转换成高质量 AAC (M4A) 音频。

* **命令参数映射**：
  - 输入：`raw_<n>.mp3`
  - 输出：`chunk_<n>.m4a`
  - 音频编码：`aac`
  - 码率：`64k`
  - 采样率：`24000Hz`
  - 声道：`1` (Mono)
  - 标记：`-movflags +faststart`
* **执行参数定义**：
  ```typescript
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', rawPath,
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-b:a', '64k',
    '-ar', '24000',
    '-ac', '1',
    '-movflags', '+faststart',
    outPath
  ];
  ```

---

## 5.3 精确时长提取 (FFprobe)

需要使用 `ffprobe` 解析标准化后的 `chunk_<n>.m4a` 时长，该数据用于后续计算章节时间戳。

* **提取命令参数**：
  ```typescript
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  ```
* **数据精度转换**：
  `ffprobe` 输出为浮点秒数（如 `123.456789`）。解析此输出并乘以 `1000` 得到毫秒数（取整，保存至 `state.json`）。

---

## 5.4 生成 `chapters.ffmeta` 结构

有声书的章节信息通过 FFmpeg 的 metadata 格式进行注入。需要根据全书每个章节包含的 Chunk 的时长，精确计算每个章节的绝对起始和结束毫秒数：

$$\text{StartMillisecond} = \sum_{j < i} \text{Duration}(\text{Chapter}_j)$$

### `chapters.ffmeta` 模板与格式规范：
```ini
;FFMETADATA1
title=书名 (由 title 参数传入，转义特殊字符)
artist=作者 (由 author 参数传入，转义特殊字符)
genre=Audiobook

[CHAPTER]
TIMEBASE=1/1000
START=0
END=24500
title=第一章 章节名字

[CHAPTER]
TIMEBASE=1/1000
START=24500
END=48920
title=第二章 章节名字
```

* **安全注意**：在写入 metadata 文本值（如 `title`、`artist`）时，对反斜杠 `\`、等号 `=`、分号 `;`、井号 `#` 进行前置反斜杠转义，以防破坏 `ffmeta` 结构。

---

## 5.5 最终合并与封面注入 (Muxing)

### 5.5.1 生成 `filelist.txt`
利用 concat demuxer 进行合并时，生成一个临时列表文件。
* **路径转义规则**：
  列表文件中每一行指向一个 M4A 文件，如果路径中包含单引号 `'`，必须将其替换为 `'\''` 并在两端包裹单引号：
  ```typescript
  const escapedPath = m4aPath.replace(/'/g, "'\\''");
  const line = `file '${escapedPath}'\n`;
  ```

### 5.5.2 合并命令参数
* **如果提供了封面图片 (`cover.jpg` / `cover.png`)**：
  需要将图像作为视频流映射到 M4B 文件（即 `attached_pic`）：
  ```typescript
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', fileListPath, // 输入 0：合并列表
    '-i', ffmetaPath,                                  // 输入 1：章节元数据
    '-i', coverPath,                                   // 输入 2：封面图像
    '-map', '0:a',                                     // 映射输入 0 的音频
    '-map_metadata', '1',                              // 映射输入 1 的元数据
    '-map', '2:v',                                     // 映射输入 2 的视频（封面）
    '-disposition:v:0', 'attached_pic',                 // 标记视频为附加图像（封面）
    '-c:a', 'copy',                                    // 音频直接复制 (零重编码)
    '-c:v', 'copy',                                    // 图像直接复制
    '-movflags', '+faststart',                         // 头文件前置（适合流式下载）
    '-f', 'mp4',                                       // 封装为 mp4 容器 (m4b)
    outputPath
  ];
  ```

* **若无封面**：
  ```typescript
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', fileListPath,
    '-i', ffmetaPath,
    '-map', '0:a',
    '-map_metadata', '1',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    outputPath
  ];
  ```

---

## 5.6 输出文件完整性与 Moov 前置校验

在任务标记为完成前，必须执行最终文件审计校验，发现损坏立即置任务为 `failed`。

### 5.6.1 容器合法性校验
运行 `ffprobe -v error -show_format outputPath`。若进程返回值不为 `0`，则文件损毁。

### 5.6.2 章节数量一致性校验
解析合并后文件的章节结构，确保章节总数与 `chapters.ffmeta` 中写入的行数完全一致。

### 5.6.3 `moov` 原子头部前置校验 (Faststart)
M4B（基于 MP4 容器）头部应依次包含 `ftyp` 和 `moov` 原子。如果 `moov` 原子位于文件尾部，客户端下载时将无法在线 Seek。
* **校验算法**：
  读取生成的 M4B 文件的前 `128KB` 的 Buffer：
  ```typescript
  import fs from 'fs';
  
  export function checkFastStart(filePath: string): boolean {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(131072); // 128KB
    fs.readSync(fd, buffer, 0, 131072, 0);
    fs.closeSync(fd);
    
    const mdatIndex = buffer.indexOf('mdat');
    const moovIndex = buffer.indexOf('moov');
    
    // 如果没有找到 moov，或者 moov 在 mdat 之后，则校验失败
    if (moovIndex === -1) return false;
    if (mdatIndex !== -1 && moovIndex > mdatIndex) return false;
    return true;
  }
  ```
