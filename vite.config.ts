import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error server.mjs is an ES module
import { handleApiRequest, initDatabase } from './backend/server.mjs'

function apiPlugin(): Plugin {
  return {
    name: 'labflow-backend-api',
    configureServer(server) {
      initDatabase().catch(() => {})
      server.middlewares.use(async (req, res, next) => {
        try {
          const handled = await handleApiRequest(req, res)
          if (!handled) next()
        } catch (err) {
          console.error('API Error in Vite middleware:', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ message: 'Internal error' }))
        }
      })
    }
  }
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/labflow/' : '/',
  plugins: [react(), apiPlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
})
