/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/mcp-server',
  base: './',
  build: {
    ssr: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        cli: resolve(__dirname, 'src/cli.ts'),
      },
      formats: ['es' as const, 'cjs' as const],
    },
  },
});
