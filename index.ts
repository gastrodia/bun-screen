import Bun from 'bun';
import type {ServerWebSocket} from 'bun';

type MessageKeys =
  'join'
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

class Share {
  constructor() {
  }

  port = 443;

  messageHandlers: Partial<Record<
    MessageKeys,
    (ws: ServerWebSocket<string>, payload: Record<string, any>) => void
  >> = {
    join: (ws, payload) => {
      // 有用户加入房间
      const {roomId, userId, username} = payload;

      this.users.set(userId, {
        ws,
        name: username,
        roomId
      })

      if (!roomId) return;

      const room = this.rooms.get(roomId);

      if (!room) {
        this.sendMessage(ws, 'error', {
          message: '房间不存在或已关闭'
        })
        return
      }

      this.users.set(userId, {
        ws,
        name: username,
        roomId
      })

      room.clients.push(ws)

      this.sendMessage(room.host, 'joined', {
        userId,
        username
      })

      this.sendMessage(ws, 'success', {
        message: `加入房间 ${room.name} 成功`
      })

    },
    create: (ws, payload) => {
      const {roomId, roomName, cover} = payload;
      this.rooms.set(roomId, {
        host: ws,
        name: roomName,
        cover,
        clients: []
      })

      // 通知所有用户 有新房间
      for (const [userId, user] of this.users) {
        const {ws: userWs} = user;
        this.sendMessage(userWs, 'updateRooms', {
          roomId,
          type: 'create'
        })
      }

    },
    offer: (ws, payload) => {
      const {offer, userId, roomId} = payload
      const user = this.users.get(userId);
      if (!user) {
        this.sendMessage(ws, 'error', {
          message: '用户不存在'
        })
        return
      }
      const {ws: userWs} = user;
      this.sendMessage(userWs, 'offer', {
        offer,
        userId,
        roomId
      })
    },
    answer: (ws, payload) => {
      const {answer, userId, roomId} = payload
      const room = this.rooms.get(roomId);
      if (!room) {
        this.sendMessage(ws, 'error', {
          message: '房间不存在'
        })
        return
      }
      this.sendMessage(room.host, 'answer', {
        answer,
        userId,
        roomId
      })
    },
    icecandidate: (ws, payload) => {
      const {candidate, userId, roomId} = payload
      const user = this.users.get(userId);
      if (!user) {
        this.sendMessage(ws, 'error', {
          message: '用户不存在'
        })
        return
      }
      const {ws: userWs} = user;
      this.sendMessage(userWs, 'icecandidate', {
        candidate,
        userId,
        roomId
      })
    },
    danmaku: (ws, payload) => {
      const {roomId, admin, message, username, userId} = payload
      const room = this.rooms.get(roomId)
      if (!room) {
        this.sendMessage(ws, 'error', {
          message: '房间不存在或已关闭'
        })
        return
      }
      const vo = {
        admin,
        message,
        username,
        userId
      }
      for (const client of room.clients) {
        this.sendMessage(client, 'danmaku', vo)
      }
      const {host} = room;
      this.sendMessage(host, 'danmaku', vo)
    }
  }

  rooms = new Map<string, {
    host: ServerWebSocket<string>;
    name: string;
    cover: string;
    clients: ServerWebSocket<string>[];
  }>(); // 房间
  users = new Map<string, {
    name: string;
    ws: ServerWebSocket<string>;
    roomId: string;
  }>(); // 用户

  get roomData() {
    const data = []
    for (const [roomId, room] of this.rooms) {
      data.push({
        id: roomId,
        name: room.name,
        cover: room.cover
      })
    }
    return data
  }

  sendMessage(ws: ServerWebSocket<string>, type: MessageKeys, data: Record<string, any>) {
    ws.send(JSON.stringify({
      type,
      data
    }))
  }


  async start() {
    return Bun.serve<string>({
      port: this.port,
      fetch: async (request, server) => {
        const path = new URL(request.url).pathname
        if (path === "/") {
          const file = Bun.file("./src/index.html")
          const exists = await file.exists();
          if (exists) return new Response(file)
        }
        if (path === '/ws') {
          const success = server.upgrade(request)
          if (success) return new Response("Upgrading...")
        }
        if (path.startsWith("/src/")) {
          const filePath = path.replace("/src/", "./src/");
          const file = Bun.file(filePath)
          const exists = await file.exists();
          if (exists) return new Response(file)
        } else if (path.startsWith('/api/')) {
          if (path === '/api/rooms') {
            return new Response(JSON.stringify(this.roomData))
          }
        }
        return new Response(path);
      },
      websocket: {
        open() {
        },
        close: (ws, code, reason) => {
          // 用户离开 或者 关闭房间
          // 判断是用户离开还是关闭房间
          // 1. 如果从用户列表中找到用户，说明是用户离开 则需要通知房间内的其他用户 和 房主
          // 2. 如果从房间列表中找到房间，说明是房主关闭房间，则需要通知房间内的其他用户
          const user = Array.from(this.users).find(([userId, user]) => user.ws === ws);
          if (user) {
            const [userId, {ws, roomId, name}] = user;
            const room = this.rooms.get(roomId);
            if (room) {
              this.sendMessage(room.host, 'leave', {
                userId,
                username: name,
                message: `用户 ${name}(${userId}) 离开了房间`
              })
              room.clients = room.clients.filter(client => client !== ws)
            }
            this.users.delete(userId)
            return
          }

          const room = Array.from(this.rooms).find(([roomId, room]) => room.host === ws);
          if (room) {
            const [roomId, {name, clients}] = room;
            for (const client of clients) {
              this.sendMessage(client, 'close', {
                roomId,
                roomName: name,
                message: `房间 ${name}(${roomId}) 已关闭`
              })
            }
            this.rooms.delete(roomId)

            // 通知所有用户 有房间关闭
            for (const [userId, user] of this.users) {
              const {ws: userWs} = user;
              this.sendMessage(userWs, 'updateRooms', {
                roomId,
                type: 'close'
              })
            }
          }
        },
        message: (ws, message: string) => {
          const payload: {
            type: MessageKeys;
            data: Record<string, any>;
          } = JSON.parse(message);
          const {type, data} = payload;

          const handler = this.messageHandlers[type];
          handler?.(ws, data)
        }
      },
    })
    console.log(`bun server is running at http://localhost:${this.port}`)
  }
}

const share = new Share()
export default share.start()
