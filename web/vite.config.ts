import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = (env.VITE_API_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '')

  return {
  // Work around an Oxc TSX parse regression on this large module.
  oxc: { exclude: [/SignalsTradePanel\\.tsx$/] },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  plugins: [react()],
  server: {
    port: 5173,
    // If 5173 is taken (another tab, old Vite, another app), use the next free port instead of exiting.
    strictPort: false,
    // Web calls `/api/*` on the Vite origin; this forwards to the local API. Start API with `npm run dev -w api` or root `npm run dev`.
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // Avoid the dev UI hanging forever when the API handler or upstream stalls.
        timeout: 60_000,
      },
    },
  },
  }
})
