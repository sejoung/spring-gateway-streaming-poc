import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// No dev-server proxy on purpose: the browser talks to each gateway directly so that
// Vite cannot add its own buffering to the measurement.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
