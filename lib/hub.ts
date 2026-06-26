// 跨函数实例的信令中转层。
//
// Vercel 函数是无状态、可水平扩展的：主播和观众的 WebSocket 很可能落在不同
// 实例上，无法靠进程内 Map 互相转发。这里用 Redis 做中转：
//   - publish：把消息发布到某个频道
//   - psubscribe('relay:*')：每个实例只开「一条」订阅连接，按频道名路由到本实例上
//     真正持有对应 socket 的连接，再 ws.send 出去
//
// 连接复用：每个函数实例只维护「1 个 pub + 1 个 sub」连接（挂在 globalThis 上，
// 跨热调用复用），避免每个 socket 各开一条 TCP 撞 Upstash 免费版的连接数上限。

import Redis from 'ioredis'

const url = process.env.REDIS_URL
if (!url) {
  throw new Error('REDIS_URL 未设置（Upstash 的 rediss://...:6379 连接串）')
}

type Sender = {send: (data: string) => void}

const g = globalThis as unknown as {
  __pub?: Redis
  __sub?: Redis
  __routes?: Map<string, Set<Sender>>
  __subInit?: boolean
  __errInit?: boolean
}

// Serverless 友好的连接参数：
//   - maxRetriesPerRequest: 不再用默认的 20 次离线重试（连不上时会卡成
//     MaxRetriesPerRequestError），改为请求级快速失败/不限制，配合 connectTimeout。
//   - enableReadyCheck: false —— Upstash 不需要，省一次往返。
//   - connectTimeout —— 连不上时尽快暴露真实错误，而不是闷在重试里。
//   - 监听 error，把真正的连接错误打到日志（否则只看到 MaxRetriesPerRequestError）。
const redisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  connectTimeout: 10000,
} as const

const pub = (g.__pub ??= new Redis(url, redisOptions))
const sub = (g.__sub ??= new Redis(url, redisOptions))

if (!g.__errInit) {
  g.__errInit = true
  pub.on('error', (e) => console.error('[redis pub]', e?.message || e))
  sub.on('error', (e) => console.error('[redis sub]', e?.message || e))
}

// channel -> 本实例上关心该频道的 socket 集合
const routes = (g.__routes ??= new Map<string, Set<Sender>>())

if (!g.__subInit) {
  g.__subInit = true
  // 一条订阅连接覆盖所有频道，按 channel 精确路由
  sub.psubscribe('relay:*')
  sub.on('pmessage', (_pattern, channel, message) => {
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
}

export function subscribe(channel: string, ws: Sender) {
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
  pub.publish(channel, JSON.stringify({type, data}))
}

// ── 房间登记表（供 /api/rooms 列表 + 存在性校验）────────────────────────────
const ROOMS_KEY = 'rooms'

export async function addRoom(roomId: string, name: string, cover?: string) {
  await pub.hset(ROOMS_KEY, roomId, JSON.stringify({name, cover}))
}

export async function removeRoom(roomId: string) {
  await pub.hdel(ROOMS_KEY, roomId)
}

export async function hasRoom(roomId: string) {
  return (await pub.hexists(ROOMS_KEY, roomId)) === 1
}

export async function listRooms() {
  const all = await pub.hgetall(ROOMS_KEY)
  return Object.entries(all).map(([id, raw]) => {
    const {name, cover} = JSON.parse(raw) as {name: string; cover?: string}
    return {id, name, cover}
  })
}

// ── 频道命名 ────────────────────────────────────────────────────────────────
export const channels = {
  user: (userId: string) => `relay:user:${userId}`, // 观众私有：offer / icecandidate(来自主播) / close
  roomHost: (roomId: string) => `relay:roomhost:${roomId}`, // 主播：joined / leave / answer / icecandidate(来自观众)
  roomAll: (roomId: string) => `relay:roomall:${roomId}`, // 房间广播：弹幕
  rooms: () => 'relay:rooms', // 全局：房间列表增删
}
