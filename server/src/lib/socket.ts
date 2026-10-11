import { Server, Socket } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { authenticateToken, COOKIE_NAME, readCookie } from './session'
import { getEnv } from '../config/env'
import { log } from './logger'

let io: Server | undefined

export const userRoom = (userId: string) => `user:${userId}`
export const ADMIN_ROOM = 'admin'

/**
 * Real time channel. The session is the same httpOnly cookie the REST API uses (no token ever reaches
 * page JavaScript), re-validated against the database at connect. A socket can only be in its own
 * `user:<id>` room (and `admin` for admins): there is no client-driven join, and the server pushes to
 * rooms, so one player never receives another's events.
 */
export function initSocket(server: HttpServer): Server {
  const { clientOrigin, isProduction } = getEnv()
  io = new Server(server, {
    // Browsers do not apply CORS to WebSocket upgrades, so the Origin header is checked here.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin
      callback(null, !origin || !isProduction || origin === clientOrigin)
    },
    cors: { origin: isProduction ? clientOrigin : true, credentials: true },
    maxHttpBufferSize: 10_000,
    serveClient: false,
  })

  io.use(async (socket, next) => {
    try {
      const session = await authenticateToken(readCookie(socket.handshake.headers.cookie, COOKIE_NAME))
      if (!session) {
        next(new Error('Unauthorized'))
        return
      }
      socket.data.userId = session.userId
      socket.data.role = session.role
      socket.data.sid = session.sid
      next()
    } catch (error) {
      log.error('socket auth failed', { err: error })
      next(new Error('Unauthorized'))
    }
  })

  io.on('connection', (socket: Socket) => {
    const { userId, role, sid } = socket.data as { userId: string; role: 'ADMIN' | 'PLAYER'; sid: string }
    void socket.join(userRoom(userId))
    void socket.join(`session:${sid}`)
    if (role === 'ADMIN') void socket.join(ADMIN_ROOM)
  })

  return io
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.io not initialized')
  return io
}

/** Emit helpers never throw: a missing socket server must not fail a committed request. */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(userRoom(userId)).emit(event, payload)
}

export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  for (const id of new Set(userIds)) emitToUser(id, event, payload)
}

export function emitToAdmin(event: string, payload: unknown): void {
  io?.to(ADMIN_ROOM).emit(event, payload)
}

export function emitToAll(event: string, payload: unknown): void {
  io?.emit(event, payload)
}

/** Ends every live connection of a user (password reset, account deletion). */
export function disconnectUser(userId: string): void {
  io?.in(userRoom(userId)).disconnectSockets(true)
}

/** Ends the live connection(s) of one signed-in browser (sign out). */
export function disconnectSession(sid: string): void {
  io?.in(`session:${sid}`).disconnectSockets(true)
}

export function closeSocket(): void {
  io = undefined
}
