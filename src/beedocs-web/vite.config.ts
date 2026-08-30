import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Subpath hosting: set BEEDOCS_UI_PATH_BASE=/beedocs (or VITE_BASE) when building
// for a reverse proxy that serves the app under a URL prefix.
function resolveBase(): string {
  const raw = (process.env.BEEDOCS_UI_PATH_BASE || process.env.VITE_BASE || '/').trim()
  if (!raw || raw === '/') return '/'
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.endsWith('/') ? withSlash : `${withSlash}/`
}

// Same override the start scripts use, so `API_PORT=5081 pnpm dev` proxies to
// the API it actually started.
const apiTarget = process.env.BEEDOCS_API_URL || `http://localhost:${process.env.API_PORT || '5080'}`

export default defineConfig({
  base: resolveBase(),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
