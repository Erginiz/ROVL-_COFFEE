import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const stationPort = Number(process.env.PORT || 8090)
const localOnly = {
  name: 'rovli-local-dev-server',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const address = String(req.socket?.remoteAddress || '')
        .replace(/^::ffff:/, '')
      if (address && address !== '127.0.0.1' && address !== '::1') {
        res.statusCode = 403
        res.end('Rovli Radyo gelistirme paneli yalnizca bu bilgisayarda acilabilir.')
        return
      }
      next()
    })
  }
}

export default defineConfig({
  plugins: [localOnly, react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${stationPort}`, '/live.mp3': `http://127.0.0.1:${stationPort}`, '/media': `http://127.0.0.1:${stationPort}` }
  }
})
