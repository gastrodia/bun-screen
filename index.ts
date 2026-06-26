import type {ServerWebSocket} from 'bun'
import {join, normalize, sep} from 'node:path'

type MessageType =
  | 'join'
  | 'create'
  | 'offer'
  | 'answer'
  | 'icecandidate'
  | 'error'
  | 'success'
  | 'leave'
  | 'close'
  | 'joined'
  | 'danmaku'
  | 'updateRooms'

type Socket = ServerWebSocket<undefined>

interface Room {
  host: Socket
  name: string
  cover?: string
  clients: Set<Socket>
}

interface User {
  ws: Socket
  name: string
  roomId: string
}

// 本地单机开发服务器（内存版，无需 Redis）。
// 生产部署走 Vercel：api/ws.ts + api/rooms.ts + lib/hub.ts（Redis 中转）。
const PUBLIC_DIR = join(import.meta.dir, 'public')

class Share {
  port = Bun?.env?.PORT || 3000

  rooms = new Map<string, Room>()
  users = new Map<string, User>()

  messageHandlers: Partial<Record<MessageType, (ws: Socket, payload: Record<string, any>) => void>> = {
    create: (ws, payload) => {
      const {roomId, roomName, cover} = payload
      if (!roomId || !roomName) {
        return this.sendMessage(ws, 'error', {message: '房间信息不完整'})
      }
      if (this.rooms.has(roomId)) {
        return this.sendMessage(ws, 'error', {message: '房间已存在'})
      }
      this.rooms.set(roomId, {host: ws, name: roomName, cover, clients: new Set()})
      this.broadcastRooms(roomId, 'create')
    },

    join: (ws, payload) => {
      const {roomId, userId, username} = payload
      if (!roomId || !userId) {
        return this.sendMessage(ws, 'error', {message: '房间或用户信息缺失'})
      }

      const room = this.rooms.get(roomId)
      if (!room) {
        return this.sendMessage(ws, 'error', {message: '房间不存在或已关闭'})
      }

      this.users.set(userId, {ws, name: username || '匿名用户', roomId})
      room.clients.add(ws)

      this.sendMessage(room.host, 'joined', {userId, username})
      this.sendMessage(ws, 'success', {message: `加入房间 ${room.name} 成功`})
    },

    // 主播 → 指定观众
    offer: (ws, payload) => {
      const {offer, userId, roomId} = payload
      const user = this.users.get(userId)
      if (!user) {
        return this.sendMessage(ws, 'error', {message: '用户不存在'})
      }
      this.sendMessage(user.ws, 'offer', {offer, userId, roomId})
    },

    // 观众 → 主播
    answer: (ws, payload) => {
      const {answer, userId, roomId} = payload
      const room = this.rooms.get(roomId)
      if (!room) {
        return this.sendMessage(ws, 'error', {message: '房间不存在'})
      }
      this.sendMessage(room.host, 'answer', {answer, userId, roomId})
    },

    // 双向中转：主播 → 观众；观众 → 主播
    icecandidate: (ws, payload) => {
      const {candidate, userId, roomId} = payload
      const room = this.rooms.get(roomId)
      if (!room) return

      if (ws === room.host) {
        const user = this.users.get(userId)
        if (user) this.sendMessage(user.ws, 'icecandidate', {candidate, userId, roomId})
      } else {
        this.sendMessage(room.host, 'icecandidate', {candidate, userId, roomId})
      }
    },

    danmaku: (ws, payload) => {
      const {roomId, admin, message, username, userId} = payload
      const room = this.rooms.get(roomId)
      if (!room) {
        return this.sendMessage(ws, 'error', {message: '房间不存在或已关闭'})
      }
      const vo = {admin, message, username, userId}
      for (const client of room.clients) this.sendMessage(client, 'danmaku', vo)
      this.sendMessage(room.host, 'danmaku', vo)
    },
  }

  get roomData() {
    return Array.from(this.rooms, ([id, room]) => ({
      id,
      name: room.name,
      cover: room.cover,
    }))
  }

  broadcastRooms(roomId: string, type: 'create' | 'close') {
    for (const {ws} of this.users.values()) {
      this.sendMessage(ws, 'updateRooms', {roomId, type})
    }
  }

  sendMessage(ws: Socket, type: MessageType, data: Record<string, any>) {
    ws.send(JSON.stringify({type, data}))
  }

  safeParse(message: string) {
    try {
      return JSON.parse(message) as {type: MessageType; data: Record<string, any>}
    } catch {
      return null
    }
  }

  // 把请求解析到 public 下的磁盘路径，并防止路径穿越逃出 PUBLIC_DIR
  resolveStatic(pathname: string): string | null {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const resolved = normalize(join(PUBLIC_DIR, relative))
    if (resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + sep)) return resolved
    return null
  }

  handleClose(ws: Socket) {
    // 1. 观众离开：通知房主，移出房间与用户表
    for (const [userId, user] of this.users) {
      if (user.ws !== ws) continue
      const room = this.rooms.get(user.roomId)
      if (room) {
        room.clients.delete(ws)
        this.sendMessage(room.host, 'leave', {
          userId,
          username: user.name,
          message: `用户 ${user.name}(${userId}) 离开了房间`,
        })
      }
      this.users.delete(userId)
      return
    }

    // 2. 房主关闭房间：通知房内观众，清理房间与该房用户表
    for (const [roomId, room] of this.rooms) {
      if (room.host !== ws) continue
      for (const client of room.clients) {
        this.sendMessage(client, 'close', {
          roomId,
          roomName: room.name,
          message: `房间 ${room.name}(${roomId}) 已关闭`,
        })
      }
      for (const [userId, user] of this.users) {
        if (user.roomId === roomId) this.users.delete(userId)
      }
      this.rooms.delete(roomId)
      this.broadcastRooms(roomId, 'close')
      return
    }
  }

  async start() {
    Bun.serve<undefined>({
      port: this.port,
      fetch: async (request, server) => {
        const {pathname} = new URL(request.url)

        if (pathname === '/api/ws') {
          return server.upgrade(request) ? undefined : new Response('Upgrade failed', {status: 400})
        }

        if (pathname === '/api/rooms') {
          return Response.json(this.roomData)
        }

        if (pathname === '/' || pathname.startsWith('/src/')) {
          const filePath = this.resolveStatic(pathname)
          if (filePath) {
            const file = Bun.file(filePath)
            if (await file.exists()) return new Response(file)
          }
        }

        return new Response('Not Found', {status: 404})
      },
      websocket: {
        open() {},
        close: (ws) => this.handleClose(ws),
        message: (ws, message: string) => {
          const payload = this.safeParse(message)
          if (!payload) {
            return this.sendMessage(ws, 'error', {message: '消息格式错误'})
          }
          const handler = this.messageHandlers[payload.type]
          if (!handler) {
            return this.sendMessage(ws, 'error', {message: '不支持的消息类型'})
          }
          handler(ws, payload.data)
        },
      },
    })
    console.log(`bun server is running at http://localhost:${this.port}`)
  }
}

const share = new Share()
await share.start()
