import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built output is served by the Fastify backend itself at /dashboard (see
// server.js), same origin as /api/admin/* - no CORS, no base-path games in
// production. The dev server proxies /api to a locally running backend so
// `npm run dev` works without a separate CORS setup.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
})
