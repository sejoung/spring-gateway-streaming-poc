import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The browser talks to each gateway directly so that no dev-server proxy sits in the measured path.
// Only the test runner's API goes through the proxy (same path as the nginx config in the container).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/runner-api': {
        target: 'http://localhost:8070',
        rewrite: (path) => path.replace(/^\/runner-api/, '/api'),
      },
    },
  },
})
