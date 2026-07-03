/**
 * @file build.mjs
 * @description esbuild 生产构建脚本。将 src/ 下所有 .ts 文件编译为 dist/ 下对应的 .js 文件，
 * 保留目录结构，输出 ESM 格式，所有 node_modules 依赖标记为 external。
 */

import { build } from 'esbuild';
import { glob } from 'node:fs/promises';
import fs from 'node:fs';
fs.rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/server.ts'],
  outdir: 'dist',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  // 所有 node_modules 依赖保持 external，避免 native addon / 动态 require 问题
  packages: 'external',
  // 保留 src/ 的目录结构映射到 dist/
  outbase: 'src',
  minify: true,
  logLevel: 'info',
  bundle: true,
  splitting: true,
});
