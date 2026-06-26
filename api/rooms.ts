// GET /api/rooms —— 返回当前房间列表（从 Redis 登记表读取）
import {listRooms} from '../lib/hub'

export async function GET() {
  const rooms = await listRooms()
  return Response.json(rooms)
}
