import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

const extraHosts = process.env.VITE_ALLOWED_HOSTS
  ? process.env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
  : []
const target = process.env.PROXY_TARGET || 'http://localhost:4002'

export default defineConfig({
  plugins: [vue()],
  build: {
    // Lazy route chunks keep the first load small; one vendor chunk is cached across deploys.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('socket.io') || id.includes('engine.io')) return 'realtime'
            if (id.includes('vue') || id.includes('pinia')) return 'vue'
            if (id.includes('axios')) return 'http'
          }
          return undefined
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5867,
    allowedHosts: extraHosts.length ? extraHosts : undefined,
    // One origin in development too: the session cookie and the socket behave exactly as in production.
    proxy: {
      '/api': { target, changeOrigin: false },
      '/socket.io': { target, changeOrigin: false, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
