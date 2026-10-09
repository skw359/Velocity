import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // heic2any is lazy-loaded but ships as one large chunk.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/content': 'http://localhost:3000',
      '/drive': 'http://localhost:3000',
      '/login': 'http://localhost:3000',
      '/logout': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
