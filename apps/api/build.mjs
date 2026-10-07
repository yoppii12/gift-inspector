// API を1ファイルにまとめる。VPS では npm install もビルドもしない（docs/vps-setup.md）。
import {build} from 'esbuild';

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
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
});
