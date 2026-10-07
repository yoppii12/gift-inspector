import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // ローカル開発では API に中継する（本番は OpenResty が /api を中継する）
    proxy: {'/api': 'http://127.0.0.1:3000'},
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev'),
  },
});
