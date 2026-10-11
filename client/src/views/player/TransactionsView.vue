<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAuthStore } from '../../stores/auth'
import api from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { expectShape } from '../../lib/contract'
import { amountTone, fileUrl, formatAmount, formatDateTime, formatPlain, gameTypeLabel, statusBadge, statusLabel, txBadgeClass, txTypeLabel } from '../../lib/format'
import StateBlock from '../../components/StateBlock.vue'
import Modal from '../../components/Modal.vue'
import Lightbox from '../../components/Lightbox.vue'
import StatementButton from '../../components/StatementButton.vue'

const auth = useAuthStore()

interface Transaction {
  id: string; type: string; amount: number; description: string | null
  createdAt: string; gameId: string | null; screenshotFilename?: string | null; balanceAfter: number
}
interface GameDetail {
  id: string; internalRef: string; gameType: string; stake: number
  status: string; winnerId: string | null; ludoRoomCode: string | null
  createdAt: string; finishedAt: string | null
  players: Array<{ userId: string; user: { id: string; username: string }; team: number | null }>
  screenshots: Array<{ id: string; filename: string; userId: string }>
}

const transactions = ref<Transaction[]>([])
const truncated = ref(false)
const loading = ref(true)
const error = ref('')
const selectedGame = ref<GameDetail | null>(null)
const gameLoading = ref(false)
const gameError = ref('')
const lightbox = ref<string | null>(null)

const balance = computed(() => auth.user?.balance ?? 0)

async function load() {
  if (!auth.user) return
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get(`/players/${auth.user.id}/transactions`)
    transactions.value = expectShape<Transaction[]>('players.transactions', data.data)
    truncated.value = !!data.meta?.truncated
  } catch (e) {
    error.value = errorMessage(e, 'Could not load your history.')
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function openGame(tx: Transaction) {
  if (!tx.gameId) return
  gameLoading.value = true
  gameError.value = ''
  selectedGame.value = null
  try {
    const { data } = await api.get(`/games/${tx.gameId}`)
    selectedGame.value = expectShape<GameDetail>('games.detail', data.data)
  } catch (e) {
    gameError.value = errorMessage(e, 'Could not load this game.')
  } finally {
    gameLoading.value = false
  }
}

function closeGame() {
  selectedGame.value = null
  gameLoading.value = false
  gameError.value = ''
}

const winnerName = (g: GameDetail) => g.players.find((p) => p.userId === g.winnerId)?.user.username ?? '—'
</script>

<template>
  <div class="page">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="page-title">My games</h1>
        <p class="page-sub">History and balance</p>
      </div>
      <div class="card py-2 px-3 text-right flex-shrink-0">
        <div class="text-xs text-text-muted">Balance</div>
        <div class="text-base font-bold amount" :class="amountTone(balance)">{{ formatAmount(balance, { signed: true }) }}</div>
      </div>
    </div>

    <div v-if="auth.user" class="flex">
      <StatementButton :player-id="auth.user.id" :player-name="auth.user.username" />
    </div>

    <StateBlock :loading="loading" :error="error" :empty="!transactions.length" empty-text="No transactions yet." @retry="load">
      <ul class="card p-0 overflow-hidden divide-y divide-border">
        <li v-for="tx in transactions" :key="tx.id">
          <component :is="tx.gameId ? 'button' : 'div'" :type="tx.gameId ? 'button' : undefined"
            class="w-full text-left px-4 py-3 min-h-[56px] block"
            :class="tx.gameId ? 'hover:bg-border/20 active:bg-border/30 transition-colors' : ''"
            @click="tx.gameId ? openGame(tx) : undefined">
            <div class="flex items-center gap-3">
              <span :class="txBadgeClass(tx.type)" class="flex-shrink-0 w-[4.75rem]">{{ txTypeLabel(tx.type) }}</span>
              <div class="flex-1 min-w-0">
                <div class="text-sm truncate">{{ tx.description || txTypeLabel(tx.type) }}</div>
                <div class="text-xs text-text-muted mt-0.5">{{ formatDateTime(tx.createdAt) }}</div>
              </div>
              <div class="text-right flex-shrink-0">
                <div class="amount font-bold text-sm" :class="amountTone(tx.amount)">{{ formatAmount(tx.amount, { signed: true }) }}</div>
                <div class="amount text-[11px] text-text-muted">{{ formatAmount(tx.balanceAfter) }}</div>
              </div>
            </div>
          </component>
          <div v-if="tx.screenshotFilename" class="px-4 pb-3">
            <button type="button" class="block w-full" @click="lightbox = fileUrl(tx.screenshotFilename!)">
              <img :src="fileUrl(tx.screenshotFilename)" alt="Payment proof" loading="lazy" class="max-h-24 w-full object-contain rounded border border-border bg-bg cursor-zoom-in" />
            </button>
            <p class="text-xs text-text-muted mt-1 text-center">Payment proof · tap to enlarge</p>
          </div>
        </li>
      </ul>
      <p v-if="truncated" class="text-xs text-text-muted text-center">Showing the latest {{ transactions.length }} entries. The statement has the full history.</p>
    </StateBlock>
  </div>

  <Lightbox v-if="lightbox" :src="lightbox" @close="lightbox = null" />

  <Modal v-if="selectedGame || gameLoading || gameError" title="Game detail" :subtitle="selectedGame ? `#${selectedGame.internalRef.slice(-6).toUpperCase()}` : undefined" size="md" @close="closeGame">
    <p v-if="gameLoading" class="py-6 text-center text-sm text-text-muted">Loading game…</p>
    <p v-else-if="gameError" class="field-error" role="alert">{{ gameError }}</p>
    <div v-else-if="selectedGame" class="space-y-4">
      <dl class="grid grid-cols-2 gap-3">
        <div class="bg-bg rounded p-3 min-w-0"><dt class="label">Type</dt><dd class="text-sm font-medium truncate">{{ gameTypeLabel(selectedGame.gameType) }}</dd></div>
        <div class="bg-bg rounded p-3 min-w-0"><dt class="label">Stake</dt><dd class="text-sm font-bold amount text-accent">{{ formatPlain(selectedGame.stake) }}</dd></div>
        <div class="bg-bg rounded p-3 min-w-0">
          <dt class="label">Winner</dt>
          <dd class="text-sm font-medium truncate" :class="selectedGame.winnerId === auth.user?.id ? 'text-active' : ''">{{ winnerName(selectedGame) }}</dd>
        </div>
        <div class="bg-bg rounded p-3 min-w-0"><dt class="label">Played</dt><dd class="text-sm">{{ formatDateTime(selectedGame.createdAt) }}</dd></div>
      </dl>
      <div class="flex items-center gap-2"><span :class="statusBadge(selectedGame.status)">{{ statusLabel(selectedGame.status) }}</span></div>
      <div>
        <div class="label mb-2">Players</div>
        <ul class="space-y-1.5">
          <li v-for="p in selectedGame.players" :key="p.userId" class="flex items-center gap-2 py-2 px-3 bg-bg rounded min-w-0">
            <span class="text-sm font-medium truncate">{{ p.user.username }}<span v-if="p.userId === auth.user?.id" class="text-xs text-text-muted"> (you)</span></span>
            <span v-if="p.team" class="text-xs text-text-muted flex-shrink-0">Team {{ p.team }}</span>
            <span v-if="selectedGame.winnerId === p.userId" class="badge-active ml-auto flex-shrink-0">Winner</span>
          </li>
        </ul>
      </div>
      <div v-if="selectedGame.screenshots.length">
        <div class="label mb-2">Screenshots ({{ selectedGame.screenshots.length }})</div>
        <div class="flex gap-2 flex-wrap">
          <button v-for="ss in selectedGame.screenshots" :key="ss.id" type="button" @click="lightbox = fileUrl(ss.filename)">
            <img :src="fileUrl(ss.filename)" alt="Game screenshot" loading="lazy" class="h-20 w-28 object-cover rounded border border-border hover:border-accent transition-colors" />
          </button>
        </div>
      </div>
      <div v-if="selectedGame.ludoRoomCode" class="bg-bg rounded p-3">
        <div class="label">Room code</div>
        <div class="amount font-bold text-accent tracking-widest text-lg break-all whitespace-normal">{{ selectedGame.ludoRoomCode }}</div>
      </div>
    </div>
  </Modal>
</template>
