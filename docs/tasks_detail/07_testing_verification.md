# 7. 自动化测试 (Unit Testing & Verification) 详细执行步骤

本模块负责编写针对文本分析、中文数字转换、音频转码、队列管理和完整性校验的自动化测试及集成测试。项目采用 Vitest 进行测试。

---

## 7.1 测试环境配置 `vitest.config.ts`

在根目录下创建 `vitest.config.ts`，配置测试文件的匹配范围和执行环境。

### 文件路径：[vitest.config.ts](file:///Users/he/projects/tts/vitest.config.ts)
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/']
    }
  }
});
```

---

## 7.2 单元测试用例设计

### 7.2.1 文本处理单元测试 `tests/text.test.ts`
1. **中文数字转换 (`chineseToNumber`)**：
   - 测试阿拉伯数字："123" -> `123`
   - 测试常规中文数字："一" -> `1`, "十" -> `10`, "十一" -> `11`, "二十五" -> `25`, "三百零六" -> `306`
   - 测试万位数字："一千零二" -> `1002`, "一万五千零二十" -> `15020`
   - 测试章节常用前缀过滤："第一章" -> `1`, "第一百五十二回" -> `152`
2. **防注入与清洗 (`cleanHtmlTags`)**：
   - 输入：`"这是一段正常文字<voice name='zh-CN-YunxiNeural'>SSML注入内容</voice>"`
   - 断言输出：`"这是一段正常文字SSML注入内容"`
   - 空行压缩断言：连续 4 个换行符过滤压缩为 `\n\n`。
3. **字符统计 (`getCleanCharCount`)**：
   - 输入中包含空格和换行符，断言统计排除空白。
   - 输入中包含 Emoji 表情（如 `😂`）和代理对字符，断言字数能正确计算为单个码点。
4. **章节匹配与四重校验**：
   - 编写多行小说文本：
     - 行字数超过 40 的误配行，断言被过滤。
     - 正文末尾未与空行隔开的章节行，断言被过滤。
     - 序号倒退（“第一章”后接“第零章”）的干扰项，断言递增校验自动剔除不递增章节。
     - 缺少章节的纯文本，断言进入兜底切分并生成虚拟章节。
5. **分片切片算法**：
   - 构造超过 2500 字的章节正文，并在不同深度（如 2400 字处）分别埋入 `\n\n`, `。`, `，`。
   - 断言算法能在最高优先级标点符号处正确退回并切断。
   - 验证切片必定落在章节边界处（不跨章节）。

---

### 7.2.2 任务管理单元测试 `tests/job-manager.test.ts`
1. **任务状态机变化**：
   - 触发任务状态从 `pending` -> `running` -> `done` 的切换。
   - 验证每个阶段变更能实时在工作目录的 `state.json` 中写出，且文件未损坏。
2. **全局任务并发锁**：
   - Mock 运行中的 Job 实例。
   - 模拟调用达到 `MAX_CONCURRENT_JOBS` 限制，断言新任务请求抛出 503 异常。
3. **磁盘预检**：
   - Mock `fs.statfs` 返回的剩余空间大小。
   - 分别测试“剩余磁盘充足”和“磁盘不足（小于字数估算大小）”的临界状态，断言分别返回 true 和抛出 507 异常。

---

### 7.2.3 音频转码单元测试 `tests/ffmpeg.test.ts`
1. **转码命令映射**：
   - 使用 Vitest Spies (或 Mock `child_process.spawn`) 拦截 FFmpeg 的 spawn 调用。
   - 断言传入的参数数组中没有开启 `shell`，且 `-c:a aac -b:a 64k -ar 24000 -ac 1` 等流参数完整存在。
2. **Moov 前置校验算法 (`checkFastStart`)**：
   - 编写二进制 Mock 文件：
     - 头部不包含 `moov` 原子的字节流，断言返回 false。
     - `mdat` 处于头部，而 `moov` 处于尾部的字节流，断言返回 false。
     - 符合标准的头部（`moov` 在 `mdat` 之前），断言返回 true。

---

## 7.3 API 集成测试 `tests/api.test.ts`

利用 Fastify 内置的高速测试工具 `fastify.inject()` 对 API 进行集成模拟，无需绑定真实网卡端口。

### 集成测试大纲：
1. **创建任务接口测试**：
   - 使用 `inject` 模拟发送 `POST /api/v1/audiobook/jobs` 并携带 multipart 表单数据。
   - 验证响应码为 201，且能返回正确的 `jobId` 格式。
2. **SSE 进度监控测试**：
   - 模拟调用 `GET /api/v1/audiobook/jobs/:jobId/events`，断言响应头包含 `text/event-stream`，且能正确收取 `handshake` 消息。
3. **断点下载测试**：
   - 模拟发送 `GET /api/v1/audiobook/jobs/:jobId/file` 并带上 `Range: bytes=0-1023` 请求头。
   - 断言状态码返回 `206 Partial Content`，且包含了 `Content-Range` 和 `Accept-Ranges` 响应头。
4. **清理机制测试**：
   - 触发任务取消接口 `DELETE /api/v1/audiobook/jobs/:jobId`。
   - 校验对应工作目录是否被成功递归删除。
