// 跨函数实例的信令中转层。
//
// Vercel 函数是无状态、可水平扩展的：主播和观众的 WebSocket 很可能落在不同
// 实例上，无法靠进程内 Map 互相转发。这里用 Redis 做中转：
//   - publish：把消息发布到某个频道
//   - psubscribe('relay:*')：每个实例只开「一条」订阅连接，按频道名路由到本实例上
//     真正持有对应 socket 的连接，再 ws.send 出去
//
// 连接复用 + 惰性初始化：每个函数实例只维护「1 个 pub + 1 个 sub」连接（挂在
// globalThis 上跨热调用复用），且只在「首次用到」时才建立——避免在模块 import
// 阶段就建连接（Serverless 冷启动期不该连，且顶层 const 引用在打包后易触发 TDZ）。

import Redis from 'ioredis'

// Serverless 友好的连接参数：连不上时快速失败、暴露真实错误，而不是闷在默认的
// 20 次离线重试里（那会表现为 MaxRetriesPerRequestError）。
const redisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  connectTimeout: 10000,
} as const

type Sender = {send: (data: string) => void}

const g = globalThis as unknown as {
  __pub?: Redis
  __sub?: Redis
  __routes?: Map<string, Set<Sender>>
}

// channel -> 本实例上关心该频道的 socket 集合
const routes = (g.__routes ??= new Map<string, Set<Sender>>())

function newClient(): Redis {
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error('REDIS_URL 未设置（Upstash 的 rediss://...:6379 连接串）')
  }
  const client = new Redis(url, redisOptions)
  client.on('error', (e: Error) => console.error('[redis]', e?.message || e))
  return client
}

// 命令用连接（发布 / 房间登记表读写），首次调用时惰性创建并复用
function getPub(): Redis {
  return (g.__pub ??= newClient())
}

// 订阅用连接：首次调用时创建并 psubscribe，再按频道名路由到本实例的 socket
function getSub(): Redis {
  if (g.__sub) return g.__sub
  const sub = (g.__sub = newClient())
  sub.psubscribe('relay:*')
  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const set = routes.get(channel)
    if (!set) return
    for (const ws of set) {
      try {
        ws.send(message)
      } catch {
        // socket 已关闭，等其 close 回调清理
      }
    }
  })
  return sub
}

export function subscribe(channel: string, ws: Sender) {
  getSub() // 确保本实例的订阅连接已就绪
  let set = routes.get(channel)
  if (!set) routes.set(channel, (set = new Set()))
  set.add(ws)
}

export function unsubscribe(channel: string, ws: Sender) {
  const set = routes.get(channel)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) routes.delete(channel)
}

export function publish(channel: string, type: string, data: Record<string, unknown>) {
  // 发布到 Redis：本实例与其它实例的 psubscribe 都会收到，再各自路由
  getPub().publish(channel, JSON.stringify({type, data}))
}

// ── 房间 / 在场登记（TTL 存在性，靠客户端心跳续期）──────────────────────────
//
// Vercel 函数 ~60s 就被回收，WS 必断；但 WebRTC 媒体是 P2P，断开后画面仍在。
// 所以「是否在场」不能用 WS 断开判定，改用带 TTL 的 Redis key：
//   - 客户端每 HEARTBEAT 秒续期一次；真正离开（关页面）后 TTL 到期才算走人。
//   - GRACE_SECONDS 要明显大于「回收间隔 + 重连耗时」，回收重连期间 key 不会过期。
const GRACE_SECONDS = 80

const ROOMS_KEY = 'rooms' // 房间 id 索引集合（懒清理）
const roomKey = (roomId: string) => `room:${roomId}`
const viewersKey = (roomId: string) => `viewers:${roomId}` // hash: userId -> username
const presenceKey = (roomId: string, userId: string) => `presence:${roomId}:${userId}`

interface RoomRecord {
  name: string
  cover?: string
  hostToken: string
}

// 主播开播 / 重连续期。hostToken 校验防止他人占用同名房间。
// 返回 created=首次创建，resumed=同一主播重连续期。
export async function createRoom(roomId: string, name: string, cover: string | undefined, hostToken: string) {
  const pub = getPub()
  const existing = await pub.get(roomKey(roomId))
  if (existing) {
    const rec = JSON.parse(existing) as RoomRecord
    if (rec.hostToken !== hostToken) return {ok: false as const, reason: '房间已存在'}
    await pub.set(roomKey(roomId), existing, 'EX', GRACE_SECONDS) // 续期，数据不变
    return {ok: true as const, resumed: true}
  }
  const rec: RoomRecord = {name, cover, hostToken}
  await pub.set(roomKey(roomId), JSON.stringify(rec), 'EX', GRACE_SECONDS)
  await pub.sadd(ROOMS_KEY, roomId)
  return {ok: true as const, created: true}
}

// 主播心跳：续期房间 TTL
export async function refreshRoom(roomId: string) {
  await getPub().expire(roomKey(roomId), GRACE_SECONDS)
}

export async function roomExists(roomId: string) {
  return (await getPub().exists(roomKey(roomId))) === 1
}

// 主播主动关播：删房 + 清在场
export async function deleteRoom(roomId: string) {
  const pub = getPub()
  await pub.del(roomKey(roomId), viewersKey(roomId))
  await pub.srem(ROOMS_KEY, roomId)
}

export async function listRooms() {
  const pub = getPub()
  const ids = await pub.smembers(ROOMS_KEY)
  const rooms: Array<{id: string; name: string; cover?: string}> = []
  for (const id of ids) {
    const raw = await pub.get(roomKey(id))
    if (!raw) {
      await pub.srem(ROOMS_KEY, id) // 已过期，懒清理
      continue
    }
    const {name, cover} = JSON.parse(raw) as RoomRecord
    rooms.push({id, name, cover})
  }
  return rooms
}

// 观众进入 / 重连续期。返回 resumed=presence 仍在（重连，主播已有连接，不必重新协商）。
export async function joinRoom(roomId: string, userId: string, username: string) {
  const pub = getPub()
  const existed = (await pub.exists(presenceKey(roomId, userId))) === 1
  await pub.set(presenceKey(roomId, userId), '1', 'EX', GRACE_SECONDS)
  await pub.hset(viewersKey(roomId), userId, username)
  return {resumed: existed}
}

// 观众心跳：续期 presence
export async function refreshViewer(roomId: string, userId: string) {
  await getPub().expire(presenceKey(roomId, userId), GRACE_SECONDS)
}

// 当前在场观众名册（供主播重连后补发 offer 给漏掉的观众）
export async function listViewers(roomId: string) {
  const all = await getPub().hgetall(viewersKey(roomId))
  return Object.entries(all).map(([userId, username]) => ({userId, username}))
}

export async function viewerAlive(roomId: string, userId: string) {
  return (await getPub().exists(presenceKey(roomId, userId))) === 1
}

export async function dropViewer(roomId: string, userId: string) {
  const pub = getPub()
  await pub.hdel(viewersKey(roomId), userId)
  await pub.del(presenceKey(roomId, userId))
}

// ── 频道命名 ────────────────────────────────────────────────────────────────
export const channels = {
  user: (userId: string) => `relay:user:${userId}`, // 观众私有：offer / icecandidate(来自主播) / close
  roomHost: (roomId: string) => `relay:roomhost:${roomId}`, // 主播：joined / leave / answer / icecandidate(来自观众)
  roomAll: (roomId: string) => `relay:roomall:${roomId}`, // 房间广播：弹幕
  rooms: () => 'relay:rooms', // 全局：房间列表增删
}
