import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '../lib/api'
import { errorMessage } from '../lib/errors'
import { expectShape } from '../lib/contract'

export interface Player {
  id: string
  username: string
  isActive: boolean
  role: string
  balance?: number
  creditLimit?: number
  spendLimit?: number
  phone?: string
  createdAt?: string
}

export const usePlayersStore = defineStore('players', () => {
  const players = ref<Player[]>([])
  const loading = ref(false)
  const error = ref('')

  async function fetchPlayers() {
    loading.value = true
    error.value = ''
    try {
      const { data } = await api.get('/players')
      players.value = expectShape<Player[]>('players.list.public', data.data)
    } catch (e) {
      error.value = errorMessage(e, 'Could not load players.')
    } finally {
      loading.value = false
    }
  }

  function updateStatus(userId: string, isActive: boolean, deleted = false, restored = false) {
    if (deleted) {
      players.value = players.value.filter((player) => player.id !== userId)
      return
    }
    if (restored) {
      void fetchPlayers()
      return
    }
    const p = players.value.find((x) => x.id === userId)
    if (p) p.isActive = isActive
  }

  return { players, loading, error, fetchPlayers, updateStatus }
})
