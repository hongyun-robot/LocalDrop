import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isDev = process.argv.includes('--dev')
const port = Number(process.env.PORT || 4173)
const host = process.env.HOST || '0.0.0.0'

const app = express()
const server = http.createServer(app)
const sockets = new Map()

if (isDev) {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'spa',
  })
  app.use(vite.middlewares)
} else {
  const distDir = path.join(rootDir, 'dist')
  app.use(express.static(distDir))
  app.use((request, response, next) => {
    if (request.method !== 'GET' || !request.accepts('html')) return next()
    response.sendFile(path.join(distDir, 'index.html'))
  })
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 })

function createId() {
  return Math.random().toString(36).slice(2, 8)
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function broadcastDevices() {
  const devices = [...sockets.entries()]
    .filter(([, client]) => client.readyState === WebSocket.OPEN && client.device)
    .map(([id, client]) => ({ id, ...client.device }))

  for (const client of sockets.values()) send(client, { type: 'devices', devices })
}

wss.on('connection', (socket) => {
  const id = createId()
  sockets.set(id, socket)
  send(socket, { type: 'welcome', id })

  socket.on('message', (raw, isBinary) => {
    if (isBinary) return

    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (message.type === 'hello') {
      const fallbackName = `设备 ${id.toUpperCase()}`
      socket.device = {
        name: String(message.name || fallbackName).slice(0, 32),
        deviceType: message.deviceType === 'mobile' ? 'mobile' : 'desktop',
        webRtc: message.webRtc === true,
      }
      broadcastDevices()
      return
    }

    if (message.type === 'rename' && socket.device) {
      socket.device.name = String(message.name || socket.device.name).slice(0, 32)
      broadcastDevices()
      return
    }

    if (message.type === 'signal' && typeof message.targetId === 'string') {
      const target = sockets.get(message.targetId)
      if (target) {
        send(target, {
          type: 'signal',
          fromId: id,
          sessionId: message.sessionId,
          signal: message.signal,
        })
      }
      return
    }

    if (message.type === 'relay' && typeof message.targetId === 'string') {
      const target = sockets.get(message.targetId)
      if (target) {
        send(target, {
          type: 'relay',
          fromId: id,
          sessionId: message.sessionId,
          payload: message.payload,
        })
      }
    }
  })

  socket.on('close', () => {
    sockets.delete(id)
    broadcastDevices()
  })
})

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && address.family === 'IPv4' && !address.internal)
    .map((address) => `http://${address.address}:${port}`)
}

server.listen(port, host, () => {
  const addresses = localAddresses()
  console.log(`\n  LocalDrop is ready\n`)
  console.log(`  Local:   http://localhost:${port}`)
  for (const address of addresses) console.log(`  Network: ${address}`)
  console.log('')
})
