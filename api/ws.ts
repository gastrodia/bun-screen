// WebSocket 信令函数（Vercel Functions，公测中的 experimental_upgradeWebSocket）。
//
// ⚠️ experimental_upgradeWebSocket 是实验性 API：只在 Vercel 线上生效，且未来可能变动。
//    本地开发请用 `bun run index.ts`（内存版单机服务器），不要依赖 `vercel dev` 的 WS 升级。
//
// 路由约定见 lib/hub.ts 的 channels。服务端不保存 user 状态：每个 socket 的
// 角色 / 房间 / 用户信息存在本地 meta 里，断开时据此 publish leave / close。

import {experimental_upgradeWebSocket, type WebSocketData} from '@vercel/functions'
import {
  subscribe,
  unsubscribe,
  publish,
  addRoom,
  removeRoom,
  hasRoom,
  channels,
} from '../lib/hub'

interface Conn {
  send: (data: string) => void
  on: (event: 'message' | 'close' | 'error', cb: (...args: any[]) => void) => void
}

interface Meta {
  role?: 'host' | 'viewer'
  roomId?: string
  userId?: string
  username?: string
  channels: Set<string>
}

const metas = new WeakMap<Conn, Meta>()

function send(ws: Conn, type: string, data: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify({type, data}))
  } catch {
    // 忽略已关闭的 socket
  }
}

function listen(ws: Conn, channel: string) {
  subscribe(channel, ws)
  metas.get(ws)!.channels.add(channel)
}

export function GET() {
  return experimental_upgradeWebSocket((ws: Conn) => {
    // 同步注册，确保 open 后立刻发来的首帧不会丢
    metas.set(ws, {channels: new Set()})

    ws.on('message', async (raw: WebSocketData) => {
      let msg: {type?: string; data?: Record<string, any>} | null = null
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return send(ws, 'error', {message: '消息格式错误'})
      }
      const type = msg?.type
      const data = msg?.data ?? {}
      const m = metas.get(ws)!

      switch (type) {
        case 'create': {
          const {roomId, roomName, cover} = data
          if (!roomId || !roomName) return send(ws, 'error', {message: '房间信息不完整'})
          if (await hasRoom(roomId)) return send(ws, 'error', {message: '房间已存在'})
          await addRoom(roomId, roomName, cover)
          m.role = 'host'
          m.roomId = roomId
          listen(ws, channels.roomHost(roomId))
          listen(ws, channels.roomAll(roomId))
          publish(channels.rooms(), 'updateRooms', {roomId, type: 'create'})
          break
        }

        case 'join': {
          const {roomId, userId, username} = data
          if (!roomId || !userId) return send(ws, 'error', {message: '房间或用户信息缺失'})
          m.role = 'viewer'
          m.roomId = roomId
          m.userId = userId
          m.username = username || '匿名用户'
          // 即使房间暂不存在也先订阅，以便收到后续 create 广播再重连进入
          listen(ws, channels.rooms())
          listen(ws, channels.user(userId))
          if (!(await hasRoom(roomId))) return send(ws, 'error', {message: '房间不存在或已关闭'})
          listen(ws, channels.roomAll(roomId))
          publish(channels.roomHost(roomId), 'joined', {userId, username: m.username})
          send(ws, 'success', {message: '加入房间成功'})
          break
        }

        // 主播 → 指定观众
        case 'offer': {
          const {offer, userId, roomId} = data
          publish(channels.user(userId), 'offer', {offer, userId, roomId})
          break
        }

        // 观众 → 主播
        case 'answer': {
          const {answer, userId, roomId} = data
          publish(channels.roomHost(roomId), 'answer', {answer, userId, roomId})
          break
        }

        // 双向中转
        case 'icecandidate': {
          const {candidate, userId, roomId} = data
          if (m.role === 'host') {
            publish(channels.user(userId), 'icecandidate', {candidate, userId, roomId})
          } else {
            publish(channels.roomHost(roomId), 'icecandidate', {candidate, userId, roomId})
          }
          break
        }

        case 'danmaku': {
          const {roomId, admin, message, username, userId} = data
          publish(channels.roomAll(roomId), 'danmaku', {roomId, admin, message, username, userId})
          break
        }

        default:
          send(ws, 'error', {message: '不支持的消息类型'})
      }
    })

    const cleanup = async () => {
      const m = metas.get(ws)
      if (!m) return
      metas.delete(ws)
      for (const ch of m.channels) unsubscribe(ch, ws)

      if (m.role === 'host' && m.roomId) {
        await removeRoom(m.roomId)
        publish(channels.roomAll(m.roomId), 'close', {
          roomId: m.roomId,
          message: `房间 ${m.roomId} 已关闭`,
        })
        publish(channels.rooms(), 'updateRooms', {roomId: m.roomId, type: 'close'})
      } else if (m.role === 'viewer' && m.roomId && m.userId) {
        publish(channels.roomHost(m.roomId), 'leave', {
          userId: m.userId,
          username: m.username,
          message: `用户 ${m.username}(${m.userId}) 离开了房间`,
        })
      }
    }

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })
}
