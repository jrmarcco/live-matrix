import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // 以 file:// 加载打包产物，必须使用相对路径
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        overlay: resolve(__dirname, 'overlay.html'),
      },
    },
  },
});
