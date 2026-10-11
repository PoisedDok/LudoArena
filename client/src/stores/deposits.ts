import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { withKey } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { expectShape } from '../lib/contract'
import { bindOnce, onResync } from '../lib/socket'
import { useAuthStore } from './auth'

export interface DepositRequest {
  id: string
  userId: string
  amount: number
  screenshotFilename: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  adminNote?: string | null
  reviewedAt?: string | null
  createdAt: string
  user?: { id: string; username: string; balance?: number }
}

export const useDepositsStore = defineStore('deposits', () => {
  const myDeposits = ref<DepositRequest[]>([])
  const adminDeposits = ref<DepositRequest[]>([])
  const adminLoading = ref(false)
  const adminError = ref('')
  let adminFilter: string | undefined

  async function fetchMyDeposits() {
    try {
      const { data } = await api.get('/deposits')
      myDeposits.value = expectShape<DepositRequest[]>('deposits.mine', data.data)
    } catch {
      // The balance card shows the last known list; the next event or visit refreshes it.
    }
  }

  /** `key` is one idempotency key per submit action: a double tap creates one request. */
  async function submitDeposit(amount: number, screenshot: File, key: string): Promise<DepositRequest> {
    const form = new FormData()
    form.append('amount', String(amount))
    form.append('screenshot', screenshot)
    const { data } = await api.post('/deposits', form, withKey(key))
    const created = expectShape<DepositRequest>('deposits.create', data.data)
    myDeposits.value = [created, ...myDeposits.value.filter((d) => d.id !== created.id)]
    return created
  }

  async function fetchAdminDeposits(status?: string) {
    adminFilter = status
    adminLoading.value = true
    adminError.value = ''
    try {
      const { data } = await api.get('/deposits/admin', { params: status ? { status } : {} })
      adminDeposits.value = expectShape<DepositRequest[]>('deposits.admin', data.data)
    } catch (e) {
      adminError.value = errorMessage(e, 'Could not load deposit requests.')
    } finally {
      adminLoading.value = false
    }
  }

  async function reviewDeposit(id: string, action: 'APPROVED' | 'REJECTED', adminNote?: string) {
    const { data } = await api.patch(`/deposits/admin/${id}`, { action, adminNote })
    const reviewed = expectShape<DepositRequest>('deposits.review', data.data)
    const idx = adminDeposits.value.findIndex((d) => d.id === id)
    if (idx !== -1) adminDeposits.value[idx] = reviewed
    return reviewed
  }

  function bindSocketEvents() {
    bindOnce('deposits', (socket) => {
      const auth = useAuthStore()
      socket.on('deposit:approved', ({ depositId, newBalance, adminNote }: { depositId: string; newBalance: number; adminNote?: string }) => {
        const d = myDeposits.value.find((x) => x.id === depositId)
        if (d) {
          d.status = 'APPROVED'
          d.adminNote = adminNote
        }
        if (auth.user) auth.user = { ...auth.user, balance: newBalance }
      })
      socket.on('deposit:rejected', ({ depositId, adminNote }: { depositId: string; adminNote?: string }) => {
        const d = myDeposits.value.find((x) => x.id === depositId)
        if (d) {
          d.status = 'REJECTED'
          d.adminNote = adminNote
        }
      })
      onResync(() => void fetchMyDeposits())
    })
  }

  function bindAdminSocketEvents() {
    bindOnce('deposits-admin', (socket) => {
      socket.on('deposit:new', ({ deposit }: { deposit: DepositRequest }) => {
        if (!adminDeposits.value.some((d) => d.id === deposit.id) && (!adminFilter || adminFilter === 'PENDING')) {
          adminDeposits.value = [deposit, ...adminDeposits.value]
        }
      })
      onResync(() => void fetchAdminDeposits(adminFilter))
    })
  }

  return {
    myDeposits, adminDeposits, adminLoading, adminError,
    fetchMyDeposits, submitDeposit, fetchAdminDeposits, reviewDeposit,
    bindSocketEvents, bindAdminSocketEvents,
  }
})
