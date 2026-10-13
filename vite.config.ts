import { defineConfig } from 'vite'

export default defineConfig({
  // 相対パスで配る（どこに置いても動くように）
  base: './',
  build: { outDir: 'dist' },
  test: { include: ['src/**/*.test.ts'] },
})
