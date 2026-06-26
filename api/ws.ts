// WebSocket 信令函数（Vercel Functions，公测中的 experimental_upgradeWebSocket）。
//
// ⚠️ experimental_upgradeWebSocket 是实验性 API：只在 Vercel 线上生效，且未来可能变动。
//    本地开发请用 `bun run index.ts`（内存版单机服务器），不要依赖 `vercel dev` 的 WS 升级。
//
// 关键约束：Vercel 函数 ~60s 被回收，WS 必断。但 WebRTC 媒体是 P2P，断开后画面仍在，
// 因此 WS 只是「随时可断、可重连」的信令通道：
//   - WS 断开「不」判定离开，也「不」广播 close/leave（避免回收时误踢对端）。
//   - 在场用带 TTL 的 Redis key 表示，靠客户端心跳续期；真正离开后 TTL 到期才算走。
//   - 主播重连后按名册给「漏掉的」观众补发 offer；观众重连静默续期，不重复协商。

import {experimental_upgradeWebSocket, type WebSocketData} from '@vercel/functions'
import {
  subscribe,
  unsubscribe,
  publish,
  createRoom,
  deleteRoom,
  refreshRoom,
  roomExists,
  joinRoom,
  refreshViewer,
  listViewers,
  viewerAlive,
  dropViewer,
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
  hostToken?: string
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
        // 主播开播 / 重连续期（幂等，靠 hostToken 识别同一主播）
        case 'create': {
          const {roomId, roomName, cover, hostToken} = data
          if (!roomId || !roomName || !hostToken) return send(ws, 'error', {message: '房间信息不完整'})
          const res = await createRoom(roomId, roomName, cover, hostToken)
          if (!res.ok) return send(ws, 'error', {message: res.reason})
          m.role = 'host'
          m.roomId = roomId
          m.hostToken = hostToken
          listen(ws, channels.roomHost(roomId))
          listen(ws, channels.roomAll(roomId))
          if (res.created) publish(channels.rooms(), 'updateRooms', {roomId, type: 'create'})
          // 把当前在场名册发回，主播给「自己还没有 peer 的」观众补发 offer
          // （覆盖回收间隙里加入、joined 广播丢失的观众）
          send(ws, 'roster', {viewers: await listViewers(roomId)})
          break
        }

        // 观众进入 / 重连续期
        case 'join': {
          const {roomId, userId, username} = data
          if (!roomId || !userId) return send(ws, 'error', {message: '房间或用户信息缺失'})
          const name = username || '匿名用户'
          m.role = 'viewer'
          m.roomId = roomId
          m.userId = userId
          m.username = name
          listen(ws, channels.rooms())
          listen(ws, channels.user(userId))
          if (!(await roomExists(roomId))) return send(ws, 'error', {message: '房间不存在或已关闭'})
          listen(ws, channels.roomAll(roomId))
          const {resumed} = await joinRoom(roomId, userId, name)
          // 仅「首次进入」通知主播发 offer；重连续期不重复协商（P2P 仍在）
          if (!resumed) publish(channels.roomHost(roomId), 'joined', {userId, username: name})
          send(ws, 'success', {message: '加入房间成功'})
          break
        }

        // 心跳：续期在场 TTL，并探测对端是否真的离开
        case 'heartbeat': {
          if (m.role === 'host' && m.roomId) {
            await refreshRoom(m.roomId)
            for (const v of await listViewers(m.roomId)) {
              if (await viewerAlive(m.roomId, v.userId)) continue
              await dropViewer(m.roomId, v.userId) // 观众 TTL 过期 = 真离开
              send(ws, 'leave', {userId: v.userId, username: v.username, message: `${v.username}(${v.userId}) 离开房间`})
            }
          } else if (m.role === 'viewer' && m.roomId && m.userId) {
            await refreshViewer(m.roomId, m.userId)
            if (!(await roomExists(m.roomId))) {
              send(ws, 'close', {roomId: m.roomId, message: '房间已关闭'}) // 主播 TTL 过期 = 真关播
            }
          }
          break
        }

        // 主播主动关播
        case 'closeRoom': {
          const {roomId} = data
          if (!roomId) break
          await deleteRoom(roomId)
          publish(channels.roomAll(roomId), 'close', {roomId, message: `房间 ${roomId} 已关闭`})
          publish(channels.rooms(), 'updateRooms', {roomId, type: 'close'})
          break
        }

        // 观众主动离开
        case 'leaveRoom': {
          const {roomId, userId} = data
          if (!roomId || !userId) break
          await dropViewer(roomId, userId)
          publish(channels.roomHost(roomId), 'leave', {userId, username: m.username, message: `${m.username}(${userId}) 离开房间`})
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

    // WS 断开只清「本实例的本地路由订阅」，不做任何破坏性广播——
    // 断开默认视为「将要重连」，真正离开由 TTL 到期 + 心跳探测处理。
    const cleanup = () => {
      const m = metas.get(ws)
      if (!m) return
      metas.delete(ws)
      for (const ch of m.channels) unsubscribe(ch, ws)
    }

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })
}
