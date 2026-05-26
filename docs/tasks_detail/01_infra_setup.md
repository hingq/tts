# 1. 基础环境搭建与配置 (Infrastructure & Setup) 详细执行步骤

本篇文档定义了有声书生成服务的基础骨架、依赖包配置及配置项解析模块的实现细节。

---

## 1.1 初始化 `package.json`

在项目根目录下创建 `package.json`，并配置 ES Modules (ESM) 开发模式、脚本和依赖。

### 依赖库说明：
* **核心框架**：使用 `fastify`（高性能 Web 框架），搭配 `@fastify/multipart`（处理客户端大文件流式上传）及 `fastify-sse-v2`（支持流式推送进度）。
* **TTS/网络**：`msedge-tts`（Node.js 端微软 Edge 语音合成库），`https-proxy-agent`（代理网关适配器）。
* **文本处理**：`jschardet`（编码检测），`iconv-lite`（流式/Buffer文本重解码）。
* **并发控制**：`p-limit`（使用用户指定的 p-limit 控制并发）。
* **开发与测试**：`typescript`，`ts-node`（直接运行 TS），`vitest`（高速单元测试框架）。

### 文件路径：[package.json](file:///Users/he/projects/tts/package.json)
```json
{
  "name": "audiobook-generation-service",
  "version": "1.0.0",
  "description": "High-Performance Audiobook Generation Service using Fastify, Edge-TTS, and FFmpeg",
  "main": "dist/server.js",
  "type": "module",
  "scripts": {
    "dev": "ts-node-esm src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "lint": "eslint src/**/*.ts",
    "format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\" \"tests/**/*.ts\""
  },
  "dependencies": {
    "@fastify/multipart": "^8.2.0",
    "fastify": "^4.26.2",
    "fastify-sse-v2": "^3.1.2",
    "https-proxy-agent": "^7.0.4",
    "iconv-lite": "^0.6.3",
    "jschardet": "^3.0.0",
    "msedge-tts": "^1.4.1",
    "p-limit": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.24",
    "eslint": "^9.1.1",
    "eslint-config-prettier": "^9.1.0",
    "globals": "^15.1.0",
    "prettier": "^3.2.5",
    "ts-node": "^10.9.2",
    "typescript": "^5.3.3",
    "typescript-eslint": "^7.7.1",
    "vitest": "^1.3.1"
  }
}
```

---

## 1.2 配置 TypeScript 编译选项 `tsconfig.json`

由于项目采用标准的 ES Modules (`import/export`) 语法以兼容最新版本的库（例如 `p-limit` 的最新版仅支持 ESM），`tsconfig.json` 必须选用 `NodeNext` 或 `Node16` 的解析模式。

### 文件路径：[tsconfig.json](file:///Users/he/projects/tts/tsconfig.json)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests/**/*"]
}
```

---

## 1.3 编写配置管理模块 `src/config.ts`

需要编写健壮的配置管理，负责从环境变量读取参数，执行类型安全转换，并设定合理的容错边界值。

### 详细规范：
1. **类型校验**：转换端口、最大体积、并发限制和超时时间为 `number` 类型。若格式非法，抛出解析异常阻止服务启动。
2. **默认值兜底**：遵循计划书规范，对不存在的配置自动赋默认值。
3. **工作路径创建**：在加载配置时，如果 `TMP_ROOT` 目录不存在，利用 `fs.mkdirSync(..., { recursive: true })` 自动创建，确保运行时写操作畅通。

### 代码结构定义：
```typescript
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config();

export interface Config {
  PORT: number;
  HOST: string;
  TMP_ROOT: string;
  MAX_TEXT_SIZE_MB: number;
  MAX_CONCURRENT_JOBS: number;
  CONCURRENT_TTS_LIMIT: number;
  CONCURRENT_TRANSCODE_LIMIT: number;
  DEFAULT_TTS_ENGINE: string;
  SUBPROCESS_TIMEOUT_MS: number;
  GLOBAL_TASK_TIMEOUT_MS: number;
  TTS_PROXY?: string;
  FFMPEG_PATH: string;
  FFPROBE_PATH: string;
}

function parseNumber(envVal: string | undefined, defaultValue: number): number {
  if (envVal === undefined) return defaultValue;
  const num = parseInt(envVal, 10);
  return isNaN(num) ? defaultValue : num;
}

const rawTmpRoot = process.env.TMP_ROOT || path.join(os.tmpdir(), 'audiobook');
const absoluteTmpRoot = path.resolve(rawTmpRoot);

// 自动初始化工作根目录
if (!fs.existsSync(absoluteTmpRoot)) {
  fs.mkdirSync(absoluteTmpRoot, { recursive: true });
}

export const config: Config = {
  PORT: parseNumber(process.env.PORT, 3000),
  HOST: process.env.HOST || '127.0.0.1',
  TMP_ROOT: absoluteTmpRoot,
  MAX_TEXT_SIZE_MB: parseNumber(process.env.MAX_TEXT_SIZE_MB, 5),
  MAX_CONCURRENT_JOBS: parseNumber(process.env.MAX_CONCURRENT_JOBS, 2),
  CONCURRENT_TTS_LIMIT: parseNumber(process.env.CONCURRENT_TTS_LIMIT, 2),
  CONCURRENT_TRANSCODE_LIMIT: parseNumber(
    process.env.CONCURRENT_TRANSCODE_LIMIT,
    Math.max(1, os.cpus().length - 1)
  ),
  DEFAULT_TTS_ENGINE: process.env.DEFAULT_TTS_ENGINE || 'edge-tts',
  SUBPROCESS_TIMEOUT_MS: parseNumber(process.env.SUBPROCESS_TIMEOUT_MS, 60000),
  GLOBAL_TASK_TIMEOUT_MS: parseNumber(process.env.GLOBAL_TASK_TIMEOUT_MS, 3600000),
  TTS_PROXY: process.env.TTS_PROXY || undefined,
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
};
```

### 文件路径：[.env.example](file:///Users/he/projects/tts/.env.example)
```env
PORT=3000
HOST=127.0.0.1
TMP_ROOT=/tmp/audiobook
MAX_TEXT_SIZE_MB=5
MAX_CONCURRENT_JOBS=2
CONCURRENT_TTS_LIMIT=2
CONCURRENT_TRANSCODE_LIMIT=3
DEFAULT_TTS_ENGINE=edge-tts
SUBPROCESS_TIMEOUT_MS=60000
GLOBAL_TASK_TIMEOUT_MS=3600000
# TTS_PROXY=http://127.0.0.1:7890
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

---

## 1.4 配置 ESLint (v9 Flat Config)

ESLint 用于代码规范与最佳实践检测。这里采用最新的 v9 `eslint.config.js` 扁平配置文件。

### 文件路径：[eslint.config.js](file:///Users/he/projects/tts/eslint.config.js)
```javascript
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'warn'
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'vitest.config.ts'],
  }
);
```

---

## 1.5 配置 Prettier

Prettier 负责代码的自动格式化，与 ESLint 独立配合以保证规则不产生冲突。

### 文件路径：[.prettierrc](file:///Users/he/projects/tts/.prettierrc)
```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "semi": true,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### 文件路径：[.prettierignore](file:///Users/he/projects/tts/.prettierignore)
```text
node_modules/
dist/
package-lock.json
```

---

## 1.6 代码规范与注释约束

为了保证代码的高可维护性与可读性，所有文件的开发必须严格遵守以下注释与规范要求：

1. **JSDoc 核心注释**：
   - 必须为所有核心的类、公共函数以及对外暴露的 API/路由编写规范的 JSDoc 注释。
   - JSDoc 必须描述函数的功能、所有参数的类型和意义（`@param`）、返回值的类型和意义（`@returns`），以及可能抛出的异常情况（`@throws`）。
2. **逻辑行内注释**：
   - 针对复杂的算法内部逻辑（如正则校验、权值合并、子进程管道控制等），必须编写行内注释说明具体处理的“为什么”和边界处理意图。
3. **保持同步**：
   - 当修改函数逻辑时，必须确保对应的注释同步更新，防止出现“过期注释”混淆代码理解。


