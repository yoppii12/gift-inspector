// API を1ファイルにまとめる。VPS では npm install もビルドもしない（docs/vps-setup.md）。
import {build} from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // ESM で require を使う依存（mysql2 など）のための shim
  banner: {
    js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
};

await build({...common, entryPoints: ['src/server.ts'], outfile: 'dist/server.js'});
// AI の計測（VPS 上で api.env を読み込んで実行する。docs/ops.md「AI の計測」）
await build({...common, entryPoints: ['scripts/bench-ai.ts'], outfile: 'dist/bench-ai.js'});
