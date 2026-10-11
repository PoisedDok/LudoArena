import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '../lib/api'
import { errorMessage } from '../lib/errors'
import { expectShape } from '../lib/contract'
import { bindOnce, onResync } from '../lib/socket'

export interface Game {
  id: string
  internalRef: string
  gameType: string
  stake: number
  status: string
  winnerId?: string | null
  secondPlaceId?: string | null
  /** When the undo window of an agreed result ends (ms since epoch); null while votes are still open. */
  settlesAt?: number | null
  ludoRoomCode?: string | null
  createdAt: string
  finishedAt?: string | null
  players: Array<{ userId: string; team?: number | null; isDone: boolean; confirmedWinnerId?: string | null; user: { id: string; username: string } }>
  screenshots: Array<{ id: string; userId: string; filename: string }>
  ping: { fromUserId: string; fromUser: { id: string; username: string } }
}

/** The API sends settlesAt as an ISO string; the UI works in milliseconds. */
export function normalizeGame<T extends { settlesAt?: unknown }>(raw: T): T & { settlesAt: number | null } {
  const value = raw.settlesAt
  const ms = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : null
  return { ...raw, settlesAt: ms !== null && Number.isFinite(ms) ? ms : null }
}

export const OPEN_STATUSES = ['ACTIVE', 'PENDING_COMPLETION']

export const useGamesStore = defineStore('games', () => {
  const games = ref<Game[]>([])
  const activeGame = ref<Game | null>(null)
  const loading = ref(false)
  const error = ref('')

  async function fetchGames() {
    loading.value = true
    error.value = ''
    try {
      const { data } = await api.get('/games')
      games.value = expectShape<Game[]>('games.list', data.data).map(normalizeGame)
      activeGame.value = games.value.find((g) => OPEN_STATUSES.includes(g.status)) ?? null
    } catch (e) {
      error.value = errorMessage(e, 'Could not load your games.')
    } finally {
      loading.value = false
    }
  }

  async function fetchGame(id: string) {
    const { data } = await api.get(`/games/${id}`)
    const game = normalizeGame(expectShape<Game>('games.detail', data.data))
    activeGame.value = game
    return game
  }

  async function setRoomCode(gameId: string, ludoRoomCode: string) {
    const { data } = await api.patch(`/games/${gameId}/roomcode`, { ludoRoomCode })
    const game = normalizeGame(data.data as Game)
    if (activeGame.value?.id === gameId) activeGame.value = game
    return game
  }

  async function markDone(gameId: string) {
    await api.patch(`/games/${gameId}/done`)
    await fetchGames()
  }

  async function uploadScreenshot(gameId: string, file: File) {
    const form = new FormData()
    form.append('screenshot', file)
    const { data } = await api.post(`/games/${gameId}/screenshots`, form)
    return data.data
  }

  async function confirmResult(gameId: string, winnerId: string, secondPlaceId?: string) {
    const { data } = await api.post(`/games/${gameId}/confirm`, { winnerId, secondPlaceId })
    return data.data as { status: string; settlesAt?: number; undoWindowMs?: number }
  }

  async function retractVote(gameId: string) {
    await api.delete(`/games/${gameId}/confirm`)
  }

  function patch(gameId: string, update: Partial<Game>) {
    if (activeGame.value?.id === gameId) activeGame.value = { ...activeGame.value, ...update }
  }

  function clearForAccountSwitch() {
    games.value = []
    activeGame.value = null
    error.value = ''
  }

  function bindSocketEvents() {
    bindOnce('games', (socket) => {
      socket.on('game:roomcode', ({ gameId, ludoRoomCode }: { gameId: string; ludoRoomCode: string }) => patch(gameId, { ludoRoomCode }))
      socket.on('game:done', ({ gameId }: { gameId: string }) => patch(gameId, { status: 'PENDING_COMPLETION' }))
      socket.on('game:settling', ({ gameId, winnerId, secondPlaceId, settlesAt }: { gameId: string; winnerId: string; secondPlaceId: string | null; settlesAt: number }) => {
        patch(gameId, { status: 'PENDING_COMPLETION', winnerId, secondPlaceId, settlesAt })
      })
      socket.on('game:vote_cast', async ({ gameId }: { gameId: string }) => {
        if (activeGame.value?.id === gameId) await fetchGame(gameId).catch(() => undefined)
      })
      socket.on('game:vote_retracted', async ({ gameId }: { gameId: string }) => {
        if (activeGame.value?.id === gameId) await fetchGame(gameId).catch(() => undefined)
      })
      socket.on('game:completed', ({ gameId, winnerId }: { gameId: string; winnerId: string | null }) => {
        patch(gameId, { status: 'COMPLETED', winnerId, settlesAt: null })
        // Show the outcome for a moment, then drop the finished game from the "in progress" slot.
        setTimeout(() => {
          if (activeGame.value?.id === gameId) activeGame.value = null
          void fetchGames()
        }, 3000)
      })
      socket.on('game:disputed', ({ gameId }: { gameId: string }) => patch(gameId, { status: 'DISPUTED', settlesAt: null }))
      socket.on('ping:accepted', ({ game }: { game: Game }) => {
        activeGame.value = normalizeGame(game)
      })
      onResync(() => void fetchGames())
    })
  }

  return { games, activeGame, loading, error, fetchGames, fetchGame, setRoomCode, markDone, uploadScreenshot, confirmResult, retractVote, clearForAccountSwitch, bindSocketEvents }
})
