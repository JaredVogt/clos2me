import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, '..')
  const envRoot = loadEnv(mode, repoRoot, '')
  const envLocal = loadEnv(mode, __dirname, '')
  const env = { ...envRoot, ...envLocal, ...process.env }

  const apiPortRaw = env.API_PORT || env.PORT || '4121'
  const devPortRaw = env.DEV_PORT || env.VITE_PORT || '4120'
  const apiPort = Number.isFinite(Number(apiPortRaw)) ? apiPortRaw : '4121'
  const devPort = Number.isFinite(Number(devPortRaw)) ? devPortRaw : '4120'

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: parseInt(devPort, 10),
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true
        }
      }
    }
  }
})
