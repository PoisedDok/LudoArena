<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { amountTone, formatAmount, formatDateTime, txBadgeClass, txTypeLabel } from '../../lib/format'
import { currentFromParams, usePeriodQuery } from '../../lib/period'
import { usePlayersStore } from '../../stores/players'
import { expectShape } from '../../lib/contract'
import PeriodPicker from '../../components/PeriodPicker.vue'
import StateBlock from '../../components/StateBlock.vue'

interface Transaction {
  id: string; type: string; amount: number; description: string | null
  createdAt: string; userId: string; user: { id: string; username: string }
}

const route = useRoute()
const router = useRouter()
const players = usePlayersStore()
const { params, setPeriod, setRange, isSet, clear } = usePeriodQuery()

const transactions = ref<Transaction[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
const LIMIT = 25

const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const typeFilter = computed(() => (typeof route.query.type === 'string' ? route.query.type : ''))
const userFilter = computed(() => (typeof route.query.userId === 'string' ? route.query.userId : ''))
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / LIMIT)))
const pageNet = computed(() => transactions.value.reduce((sum, tx) => sum + Math.round(tx.amount * 100), 0) / 100)

const typeOptions = [
  { value: '', label: 'All types' },
  { value: 'GAME_WIN', label: 'Game win' },
  { value: 'GAME_LOSS', label: 'Game loss' },
  { value: 'COMMISSION', label: 'Commission' },
  { value: 'ADMIN_CREDIT', label: 'Credit (deposit or adjustment)' },
  { value: 'ADMIN_DEBIT', label: 'Debit' },
]

let requestId = 0
async function load() {
  const mine = ++requestId
  loading.value = true
  error.value = ''
  try {
    const query: Record<string, string | number> = { ...params.value, page: page.value, limit: LIMIT }
    if (typeFilter.value) query.type = typeFilter.value
    if (userFilter.value) query.userId = userFilter.value
    const { data } = await api.get('/admin/transactions', { params: query })
    if (mine !== requestId) return
    const checked = expectShape<{ transactions: Transaction[]; total: number }>('admin.transactions', data.data)
    transactions.value = checked.transactions
    total.value = checked.total
  } catch (e) {
    if (mine !== requestId) return
    error.value = errorMessage(e, 'Could not load transactions.')
  } finally {
    if (mine === requestId) loading.value = false
  }
}

onMounted(() => {
  if (!players.players.length) void players.fetchPlayers()
})
watch(() => route.query, load, { immediate: true })

const setQuery = (patch: Record<string, string | undefined>) => router.replace({ query: { ...route.query, ...patch, page: undefined } })
const goPage = (n: number) => router.replace({ query: { ...route.query, page: n > 1 ? String(n) : undefined } })
const playerOptions = computed(() => players.players.filter((p) => p.role === 'PLAYER'))
</script>

<template>
  <div class="page-wide">
    <div class="space-y-3">
      <div class="min-w-0">
        <h1 class="page-title">Transactions</h1>
        <p class="page-sub">{{ total }} {{ isSet ? 'in this period' : 'in total' }}</p>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 items-center">
        <PeriodPicker :current="currentFromParams(params)" :params="params" @select="setPeriod" @range="setRange" />
        <div>
          <label class="sr-only" for="tx-user">Player</label>
          <select id="tx-user" class="input" :value="userFilter" @change="setQuery({ userId: ($event.target as HTMLSelectElement).value || undefined })">
            <option value="">All players</option>
            <option v-for="p in playerOptions" :key="p.id" :value="p.id">{{ p.username }}</option>
          </select>
        </div>
        <div>
          <label class="sr-only" for="tx-type">Type</label>
          <select id="tx-type" class="input" :value="typeFilter" @change="setQuery({ type: ($event.target as HTMLSelectElement).value || undefined })">
            <option v-for="o in typeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <button v-if="isSet" type="button" class="btn-ghost btn-sm justify-self-start" @click="clear">All time</button>
      </div>
    </div>

    <StateBlock :loading="loading && !transactions.length" :error="error" :empty="!loading && !transactions.length" empty-text="No transactions found." @retry="load">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-text-muted bg-surface border border-border rounded px-4 py-3">
        <span>Showing <span class="text-text-primary font-medium">{{ transactions.length }}</span> of {{ total }}</span>
        <span>Page net
          <span class="amount font-semibold" :class="amountTone(pageNet)">{{ formatAmount(pageNet, { signed: true }) }}</span>
        </span>
      </div>

      <ul class="space-y-2 md:hidden" :class="loading ? 'opacity-60' : ''">
        <li v-for="tx in transactions" :key="tx.id" class="list-card">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium truncate">{{ tx.user?.username ?? tx.userId.slice(0, 8) }}</span>
            <span class="amount text-sm font-semibold flex-shrink-0" :class="amountTone(tx.amount)">{{ formatAmount(tx.amount, { signed: true }) }}</span>
          </div>
          <div class="flex items-center gap-2 mt-1.5 min-w-0">
            <span :class="txBadgeClass(tx.type)" class="flex-shrink-0">{{ txTypeLabel(tx.type) }}</span>
            <span class="text-xs text-text-muted truncate flex-1 min-w-0">{{ tx.description || '—' }}</span>
          </div>
          <div class="text-xs text-text-muted mt-1">{{ formatDateTime(tx.createdAt) }}</div>
        </li>
      </ul>

      <div class="card p-0 overflow-x-auto hidden md:block">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-text-muted uppercase tracking-wide">
              <th class="px-4 py-3 font-medium">Player</th><th class="px-4 py-3 font-medium">Type</th>
              <th class="px-4 py-3 font-medium">Description</th><th class="px-4 py-3 font-medium text-right">Amount</th><th class="px-4 py-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="tx in transactions" :key="tx.id" class="hover:bg-border/20 transition-colors">
              <td class="px-4 py-3 text-sm font-medium">{{ tx.user?.username ?? tx.userId.slice(0, 8) }}</td>
              <td class="px-4 py-3"><span :class="txBadgeClass(tx.type)">{{ txTypeLabel(tx.type) }}</span></td>
              <td class="px-4 py-3 text-xs text-text-muted max-w-[260px] truncate">{{ tx.description || '—' }}</td>
              <td class="px-4 py-3 text-right amount text-sm font-semibold" :class="amountTone(tx.amount)">{{ formatAmount(tx.amount, { signed: true }) }}</td>
              <td class="px-4 py-3 text-xs text-text-muted whitespace-nowrap">{{ formatDateTime(tx.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalPages > 1" class="flex items-center justify-between gap-3 text-xs text-text-muted">
        <span>Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-2">
          <button type="button" class="btn-ghost btn-sm" :disabled="page === 1" @click="goPage(page - 1)">← Prev</button>
          <button type="button" class="btn-ghost btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">Next →</button>
        </div>
      </div>
    </StateBlock>
  </div>
</template>
