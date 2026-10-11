import { io, Socket } from 'socket.io-client'

/**
 * The real-time channel. It authenticates with the same httpOnly session cookie as the API (nothing is
 * passed from JavaScript) and talks to the page's own origin. Handlers are attached once per socket
 * (`once`), and after a reconnect every subscriber is asked to refetch, spread over a short random delay
 * so a server restart does not make every phone fetch in the same instant.
 */

let socket: Socket | null = null
const bound = new WeakMap<Socket, Set<string>>()
const resyncHandlers = new Set<() => void>()
let everConnected = false

const RESYNC_JITTER_MS = 1_500

export function connectSocket(): Socket {
  if (socket && (socket.connected || socket.active)) return socket
  socket?.disconnect()
  everConnected = false
  socket = io({
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 15_000,
    randomizationFactor: 0.5,
  })
  socket.on('connect', () => {
    if (everConnected) {
      // Events may have been missed while offline.
      setTimeout(() => resyncHandlers.forEach((fn) => fn()), Math.random() * RESYNC_JITTER_MS)
    }
    everConnected = true
  })
  socket.on('system:data-reset', () => window.location.reload())
  return socket
}

export function disconnectSocket(): void {
  socket?.disconnect()
  socket = null
  everConnected = false
}

export function getSocket(): Socket | null {
  return socket
}

/** Runs `attach` once for this socket and this key, however many times a layout mounts. */
export function bindOnce(key: string, attach: (socket: Socket) => void): void {
  const current = socket
  if (!current) return
  let keys = bound.get(current)
  if (!keys) {
    keys = new Set()
    bound.set(current, keys)
  }
  if (keys.has(key)) return
  keys.add(key)
  attach(current)
}

/** Subscribe to "the connection came back": refetch what the screen shows. Returns an unsubscribe. */
export function onResync(handler: () => void): () => void {
  resyncHandlers.add(handler)
  return () => resyncHandlers.delete(handler)
}
