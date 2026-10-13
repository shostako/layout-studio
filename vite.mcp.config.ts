import { defineConfig } from 'vite'

// MCP サーバー（mcp/server.ts）を Node で動く 1 つのファイル mcp/dist/server.js にまとめる。アプリの dist/ とは別に作る
export default defineConfig({
  build: {
    ssr: 'mcp/server.ts',
    outDir: 'mcp/dist',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: { output: { entryFileNames: 'server.js', format: 'es' } },
  },
})
