import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { withKey } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { expectShape } from '../lib/contract'
import { bindOnce, onResync } from '../lib/socket'

export interface Ping {
  id: string
  fromUserId: string
  fromUser: { id: string; username: string }
  gameType: string
  stake: number
  message?: string | null
  status: string
  expiresAt: string
  createdAt?: string
  isBroadcast?: boolean
  recipients: Array<{ userId: string; response: string; user?: { id: string; username: string } }>
  game?: { id: string } | null
  // live tracking fields (client-only, filled by socket events)
  _acceptedCount?: number
  _required?: number
}

export interface PendingGame {
  id: string
  [key: string]: unknown
}

export const usePingsStore = defineStore('pings', () => {
  const pings = ref<Ping[]>([])
  const incomingPing = ref<Ping | null>(null)
  const pendingGame = ref<PendingGame | null>(null)
  const loading = ref(false)
  const error = ref('')

  // Open broadcasts: the sender's own and everybody else's that are still waiting for players.
  const liveBroadcasts = ref<Ping[]>([])

  async function fetchPings() {
    loading.value = true
    error.value = ''
    try {
      const { data } = await api.get('/pings')
      const checked = expectShape<Ping[]>('pings.list', data.data)
      pings.value = checked
      liveBroadcasts.value = checked.filter((p) => p.isBroadcast && p.status === 'PENDING' && new Date(p.expiresAt).getTime() > Date.now())
    } catch (e) {
      error.value = errorMessage(e, 'Could not load game requests.')
    } finally {
      loading.value = false
    }
  }

  async function sendPing(payload: { gameType: string; stake: number; message?: string; recipientIds?: string[]; isBroadcast?: boolean }, key: string) {
    const { data } = await api.post('/pings', payload, withKey(key))
    const ping = expectShape<Ping>('pings.create', data.data)
    pings.value = [ping, ...pings.value.filter((p) => p.id !== ping.id)]
    if (ping.isBroadcast && !liveBroadcasts.value.some((p) => p.id === ping.id)) liveBroadcasts.value = [ping, ...liveBroadcasts.value]
    return ping
  }

  async function respondToPing(pingId: string, response: 'ACCEPTED' | 'DECLINED') {
    const { data } = await api.patch(`/pings/${pingId}/respond`, { response })
    await fetchPings()
    return data.data as { status: string; acceptedCount?: number; required?: number; started: boolean }
  }

  async function cancelPing(pingId: string) {
    await api.delete(`/pings/${pingId}`)
    removeLiveBroadcast(pingId)
  }

  function removeLiveBroadcast(pingId: string) {
    liveBroadcasts.value = liveBroadcasts.value.filter((p) => p.id !== pingId)
    if (incomingPing.value?.id === pingId) incomingPing.value = null
  }

  function updateCount(pingId: string, acceptedCount: number, required: number) {
    const b = liveBroadcasts.value.find((p) => p.id === pingId)
    if (b) {
      b._acceptedCount = acceptedCount
      b._required = required
    }
  }

  function bindSocketEvents() {
    bindOnce('pings', (socket) => {
      // Direct pings only: broadcasts arrive as ping:broadcast_new.
      socket.on('ping:received', ({ ping, from }: { ping: Ping; from: Ping['fromUser'] }) => {
        incomingPing.value = { ...ping, fromUser: from, isBroadcast: false }
      })
      socket.on('ping:broadcast_new', ({ ping, from }: { ping: Ping; from: Ping['fromUser'] }) => {
        if (!liveBroadcasts.value.some((p) => p.id === ping.id)) {
          liveBroadcasts.value = [{ ...ping, fromUser: from, isBroadcast: true }, ...liveBroadcasts.value]
        }
      })
      socket.on('ping:broadcast_update', ({ pingId, acceptedCount, required }: { pingId: string; acceptedCount: number; required: number }) => {
        updateCount(pingId, acceptedCount, required)
      })
      socket.on('ping:partially_accepted', ({ pingId, acceptedCount, required }: { pingId: string; acceptedCount: number; required: number }) => {
        updateCount(pingId, acceptedCount, required)
      })
      socket.on('ping:broadcast_resolved', ({ pingId }: { pingId: string }) => removeLiveBroadcast(pingId))
      socket.on('ping:accepted', ({ pingId, game }: { pingId: string; game: PendingGame }) => {
        pendingGame.value = game
        incomingPing.value = null
        removeLiveBroadcast(pingId)
      })
      socket.on('ping:declined', () => void fetchPings())
      socket.on('ping:expired', () => void fetchPings())
      onResync(() => void fetchPings())
    })
  }

  /** Admin screens only watch broadcasts; they never answer them. */
  function bindAdminSocketEvents() {
    bindOnce('pings-admin', (socket) => {
      socket.on('ping:broadcast_new', ({ ping, from }: { ping: Ping; from: Ping['fromUser'] }) => {
        if (!liveBroadcasts.value.some((p) => p.id === ping.id)) {
          liveBroadcasts.value = [{ ...ping, fromUser: from, isBroadcast: true, _acceptedCount: 0 }, ...liveBroadcasts.value]
        }
      })
      socket.on('ping:broadcast_update', ({ pingId, acceptedCount, required }: { pingId: string; acceptedCount: number; required: number }) => {
        updateCount(pingId, acceptedCount, required)
      })
      socket.on('ping:broadcast_resolved', ({ pingId }: { pingId: string }) => removeLiveBroadcast(pingId))
    })
  }

  async function fetchAdminBroadcasts() {
    try {
      const { data } = await api.get('/admin/broadcasts')
      liveBroadcasts.value = expectShape<Ping[]>('admin.broadcasts', data.data)
    } catch {
      // The live list is a convenience; the dashboard numbers do not depend on it.
    }
  }

  const clearIncoming = () => { incomingPing.value = null }
  const clearPendingGame = () => { pendingGame.value = null }

  return {
    pings, incomingPing, pendingGame, liveBroadcasts, loading, error,
    fetchPings, sendPing, respondToPing, cancelPing, fetchAdminBroadcasts,
    bindSocketEvents, bindAdminSocketEvents, clearIncoming, clearPendingGame,
  }
})
