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

// ── 房间登记表（供 /api/rooms 列表 + 存在性校验）────────────────────────────
const ROOMS_KEY = 'rooms'

export async function addRoom(roomId: string, name: string, cover?: string) {
  await getPub().hset(ROOMS_KEY, roomId, JSON.stringify({name, cover}))
}

export async function removeRoom(roomId: string) {
  await getPub().hdel(ROOMS_KEY, roomId)
}

export async function hasRoom(roomId: string) {
  return (await getPub().hexists(ROOMS_KEY, roomId)) === 1
}

export async function listRooms() {
  const all = await getPub().hgetall(ROOMS_KEY)
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
