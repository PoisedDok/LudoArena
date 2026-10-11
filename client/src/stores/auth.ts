import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { setUnauthorizedHandler } from '../lib/api'
import { bindOnce, connectSocket, disconnectSocket, onResync } from '../lib/socket'
import { expectShape } from '../lib/contract'
import { usePlayersStore } from './players'

export interface User {
  id: string
  username: string
  phone?: string | null
  role: 'ADMIN' | 'PLAYER'
  balance: number
  isActive: boolean
  creditLimit: number
  spendLimit: number
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)
  /** True when a data call answered 401: the page stays as it is and a dialog asks for the password. */
  const sessionExpired = ref(false)

  setUnauthorizedHandler(() => {
    if (user.value) sessionExpired.value = true
  })

  function startRealtime() {
    const socket = connectSocket()
    bindOnce('auth', (s) => {
      const players = usePlayersStore()
      s.on('player:status', ({ userId, isActive }: { userId: string; isActive: boolean }) => {
        players.updateStatus(userId, isActive)
        if (user.value?.id === userId) user.value = { ...user.value, isActive }
      })
      // The server pushes the receiver's own balance after settlements, adjustments and deposits.
      s.on('balance:updated', ({ balance }: { balance: number }) => {
        if (user.value && typeof balance === 'number') user.value = { ...user.value, balance }
      })
      s.on('game:completed', ({ balance }: { balance?: number }) => {
        if (user.value && typeof balance === 'number') user.value = { ...user.value, balance }
      })
      // The session was ended on the server (password reset): find out with one call.
      s.on('connect_error', (error: Error) => {
        if (error.message === 'Unauthorized') void fetchMe()
      })
      onResync(() => void fetchMe())
    })
    return socket
  }

  async function fetchMe() {
    try {
      const { data } = await api.get('/auth/me')
      user.value = expectShape<User>('auth.me', data.data)
      sessionExpired.value = false
      startRealtime()
    } catch {
      if (user.value) sessionExpired.value = true
      else user.value = null
    }
  }

  async function login(username: string, password: string, remember = false) {
    loading.value = true
    try {
      const { data } = await api.post('/auth/login', { username, password, remember })
      user.value = expectShape<User>('auth.login', data.data)
      sessionExpired.value = false
      startRealtime()
    } finally {
      loading.value = false
    }
  }

  async function init() {
    await fetchMe()
  }

  async function logout() {
    try {
      await api.post('/auth/logout')
    } finally {
      user.value = null
      sessionExpired.value = false
      disconnectSocket()
    }
  }

  /** Leaves a dead session behind and returns to the sign-in page. */
  function discardSession() {
    user.value = null
    sessionExpired.value = false
    disconnectSocket()
  }

  return { user, loading, sessionExpired, login, logout, init, fetchMe, discardSession }
})
