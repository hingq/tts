# 4. TTS 服务提供者实现 (TTS Provider) 详细执行步骤

本模块负责抽象 TTS 引擎并实现基于微软 Edge 大声朗读服务（Edge-TTS）的合成器。

> [!IMPORTANT]
> **代码注释约束**：
> 必须为本模块定义的 `TTSProvider` 接口契约、`EdgeTTSProvider` 实现类（包括构造器中代理网关初始化、语速音高参数合法化清洗正则），以及底层的网络指数退避重试和 429 风控退避控制逻辑编写详细的 JSDoc 与行内注释。

---

## 4.1 定义 Provider 接口契约

为了保持系统可扩展度并规避引擎变更带来的耦合风险，必须定义严格的 TS 接口和参数规范。

### 文件路径：[src/types/tts.ts](file:///Users/he/projects/tts/src/types/tts.ts)
```typescript
export interface TTSOptions {
  voice: string;     // 发音人标识，例如 "zh-CN-YunxiNeural"
  rate: string;      // 语速，必须符合格式要求，如 "+0%" 或 "+15%"
  pitch: string;     // 音高，必须符合格式要求，如 "+0Hz" 或 "-5Hz"
  bitrate: string;   // 码率，只允许 "32k" | "64k" | "128k"
}

export interface TTSResult {
  audioPath: string; // 本地暂存音频文件的绝对路径
  format: string;    // 输出音频格式扩展名，固定为 "mp3"
}

export interface TTSProvider {
  /**
   * 将文本片段合成为本地临时音频文件
   * @param text 经过清洗的纯文本数据
   * @param options 音频控制参数
   * @param outPathWithoutExt 暂存文件路径（由 Provider 拼接后缀名，如 .mp3）
   */
  synthesize(text: string, options: TTSOptions, outPathWithoutExt: string): Promise<TTSResult>;
}
```

---

## 4.2 实现 `EdgeTTSProvider`

使用 Node.js 原生的 `msedge-tts` 库，基于官方的 WebSocket 接口向微软发起请求，并输出 MP3 格式文件。

### 3.2.1 构造函数与代理注入
在类初始化时，通过解析配置项中的 `TTS_PROXY` 环境变量来配置 WebSocket 代理：

```typescript
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { TTSProvider, TTSOptions, TTSResult } from '../types/tts.js';
import { config } from '../config.js';

export class EdgeTTSProvider implements TTSProvider {
  private agent?: HttpsProxyAgent<string>;

  constructor() {
    if (config.TTS_PROXY) {
      // 实例化 HTTPS 代理代理 WebSocket
      this.agent = new HttpsProxyAgent(config.TTS_PROXY);
    }
  }
  
  // ... 实现 synthesize
}
```

### 3.2.2 严格的参数校验与安全过滤
微软的 Edge-TTS 接口参数直接写在 SSML 的 XML 中，为防止非法的输入导致连接中断或发生 SSML 逃逸，在发送请求前必须做强类型与格式校验：

1. **发音人白名单验证**：
   只允许系统内置的可信中文声音列表。非名单内的发音人，一律强制退回为 `zh-CN-YunxiNeural`。
   * 白名单列表：
     - `zh-CN-YunxiNeural` (推荐，男声)
     - `zh-CN-XiaoxiaoNeural` (推荐，女声)
     - `zh-CN-YunjianNeural` (男声)
     - `zh-CN-XiaoyiNeural` (女声)
     - `zh-HK-HiuMaanNeural` (粤语女声)
     - `zh-TW-HsiaoChenNeural` (国语女声)
2. **语速与音高正则清洗**：
   - 语速（`rate`）：必须符合正则 `/^[+-]\d+%$/`。如果为其他格式（如小数 `1.2`），则将其转换为符合规范的 `+20%` 格式；如果不匹配则重置为 `+0%`。
   - 音高（`pitch`）：必须符合正则 `/^[+-]\d+(?:Hz|%)$/`，如果不匹配则重置为 `+0Hz`。
3. **输出音频格式映射**：
   对于有声书，`msedge-tts` 的输出格式统一设置为：
   `audio-24khz-48kbitrate-mono-mp3` (最契合人声的高性噪比单声道格式)。

### 3.2.3 网络重试与 429 风控退避机制
调用公网 API 在大长文本合成时极易遭遇 WebSocket 网络中断或并发 429 风控限流。`synthesize` 函数中应编写指数退避重试逻辑：

* **暂时性网络错误 (如 WebSocket 异常断开/超时)**：
  - 设定最大重试次数为 `3`。
  - 每次重试时，等待时间公式：
    $$\text{WaitTime} = 2^{\text{retryCount}} \times 1000 \text{ ms} + \text{Random}(0, 500) \text{ ms}$$
* **429 (Too Many Requests) 风控退避**：
  - 如果捕获的错误包含 `429` 或 `Too Many Requests`：
    - 抛出自定义 `TTSThrottleError`。
    - 该错误将被 Pipeline 捕获，触发全局 TTS 冷却锁，在 30 秒内暂停派发新的 TTS 请求。
* **文件落盘完整性校验**：
  - 合成结束后，检查文件是否存在且大小大于 `0`，否则抛出写入错误。
