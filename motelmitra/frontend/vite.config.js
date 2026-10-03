import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// During development, /api calls are forwarded to Django on port 8000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/media': 'http://127.0.0.1:8000',
    },
  },
})
