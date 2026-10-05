import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// During development, /api calls are forwarded to Django on port 8000.
export default defineConfig({
  plugins: [react()],
  // APP_VERSION comes from the .env next to start_app.bat (the server reads the same file)
  envDir: '..',
  envPrefix: ['VITE_', 'APP_'],
  server: {
    port: 5173,
    proxy: {
      // changeOrigin: Django sees 127.0.0.1, so phones/tablets on WiFi work without editing ALLOWED_HOSTS
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})
