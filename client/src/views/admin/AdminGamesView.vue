<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { fileUrl, formatDateTime, formatPlain, gameTypeLabel, splitMessage, statusBadge, statusLabel } from '../../lib/format'
import { currentFromParams, usePeriodQuery } from '../../lib/period'
import { usePingsStore } from '../../stores/pings'
import { onResync } from '../../lib/socket'
import { expectShape } from '../../lib/contract'
import PeriodPicker from '../../components/PeriodPicker.vue'
import StateBlock from '../../components/StateBlock.vue'
import Modal from '../../components/Modal.vue'
import Lightbox from '../../components/Lightbox.vue'

interface GamePlayer { userId: string; team: number | null; user: { id: string; username: string } }
interface Game {
  id: string; internalRef: string; gameType: string; stake: number
  status: string; winnerId: string | null; ludoRoomCode: string | null
  createdAt: string; finishedAt: string | null
  players: GamePlayer[]; screenshots: Array<{ id: string; filename: string; userId: string }>
}

const route = useRoute()
const router = useRouter()
const pings = usePingsStore()
const { params, setPeriod, setRange, isSet, clear } = usePeriodQuery()

const games = ref<Game[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
const LIMIT = 20
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const status = computed(() => (typeof route.query.status === 'string' ? route.query.status : ''))
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / LIMIT)))

const statusOptions = [
  { value: '', label: 'All statuses' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PENDING_COMPLETION', label: 'Pending' },
  { value: 'DISPUTED', label: 'Disputed' },
  { value: 'COMPLETED', label: 'Completed' },
]

let requestId = 0
async function load() {
  const mine = ++requestId
  loading.value = true
  error.value = ''
  try {
    const query: Record<string, string | number> = { ...params.value, page: page.value, limit: LIMIT }
    if (status.value) query.status = status.value
    const { data } = await api.get('/admin/games', { params: query })
    if (mine !== requestId) return
    const checked = expectShape<{ games: Game[]; total: number }>('admin.games', data.data)
    games.value = checked.games
    total.value = checked.total
  } catch (e) {
    if (mine !== requestId) return
    error.value = errorMessage(e, 'Could not load games.')
  } finally {
    if (mine === requestId) loading.value = false
  }
}

onMounted(() => {
  void pings.fetchAdminBroadcasts()
  onResync(() => {
    void load()
    void pings.fetchAdminBroadcasts()
  })
})
watch(() => route.query, load, { immediate: true })

const setQuery = (patch: Record<string, string | undefined>) => router.replace({ query: { ...route.query, ...patch, page: undefined } })
const goPage = (n: number) => router.replace({ query: { ...route.query, page: n > 1 ? String(n) : undefined } })

const winnerName = (g: Game) => g.players.find((p) => p.userId === g.winnerId)?.user.username ?? '—'
const refOf = (g: Game) => `#${g.internalRef.slice(-6).toUpperCase()}`
const canResolve = (g: Game) => g.status !== 'COMPLETED'

// --- Detail / resolve ---
const selected = ref<Game | null>(null)
const lightbox = ref<string | null>(null)
const winnerId = ref('')
const secondId = ref('')
const voidGame = ref(false)
const voidConfirm = ref(false)
const resolving = ref(false)
const resolveError = ref('')

function openGame(g: Game) {
  selected.value = g
  winnerId.value = ''
  secondId.value = ''
  voidGame.value = false
  voidConfirm.value = false
  resolveError.value = ''
}

const isFour = computed(() => selected.value?.gameType === 'FOUR_PLAYER')
const canSubmit = computed(() => {
  if (resolving.value) return false
  if (voidGame.value) return voidConfirm.value
  return !!winnerId.value && (!isFour.value || (!!secondId.value && secondId.value !== winnerId.value))
})

async function resolve() {
  if (!selected.value || !canSubmit.value) return
  resolving.value = true
  resolveError.value = ''
  try {
    await api.patch(`/admin/games/${selected.value.id}/resolve`, {
      winnerId: voidGame.value ? undefined : winnerId.value,
      secondPlaceId: !voidGame.value && isFour.value ? secondId.value : undefined,
      void: voidGame.value,
    })
    selected.value = null
    await load()
  } catch (e) {
    resolveError.value = errorMessage(e, 'Could not resolve the game.')
  } finally {
    resolving.value = false
  }
}

const acceptedOf = (b: (typeof pings.liveBroadcasts)[number]) => b._acceptedCount ?? b.recipients.filter((r) => r.response === 'ACCEPTED').length
</script>

<template>
  <div class="page-wide">
    <div class="space-y-3">
      <div class="min-w-0">
        <h1 class="page-title">Games</h1>
        <p class="page-sub">{{ total }} {{ isSet ? 'in this period' : 'in total' }}</p>
      </div>
      <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div class="sm:w-80 min-w-0">
          <PeriodPicker :current="currentFromParams(params)" :params="params" @select="setPeriod" @range="setRange" />
        </div>
        <label class="sr-only" for="games-status">Status</label>
        <select id="games-status" class="input sm:w-44" :value="status" @change="setQuery({ status: ($event.target as HTMLSelectElement).value || undefined })">
          <option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <button v-if="isSet" type="button" class="btn-ghost btn-sm" @click="clear">All time</button>
      </div>
    </div>

    <section v-if="pings.liveBroadcasts.length" class="card border-accent/20 bg-accent/5 space-y-3 min-w-0" aria-label="Live broadcasts">
      <div class="flex items-center justify-between gap-3">
        <div class="text-sm font-semibold text-accent">Live broadcasts</div>
        <span class="text-xs amount text-accent font-bold">{{ pings.liveBroadcasts.length }} open</span>
      </div>
      <ul class="divide-y divide-border/60">
        <li v-for="b in pings.liveBroadcasts" :key="b.id" class="py-3 first:pt-0 last:pb-0 space-y-2 min-w-0">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium truncate">{{ b.fromUser?.username }}</div>
              <div class="text-xs text-text-muted">
                {{ gameTypeLabel(b.gameType) }} · Stake <span class="amount text-accent font-semibold">{{ formatPlain(b.stake) }}</span>
                <template v-if="splitMessage(b.message).note"> · “{{ splitMessage(b.message).note }}”</template>
              </div>
              <div v-if="splitMessage(b.message).room" class="text-xs mt-0.5">Room <span class="amount font-bold text-accent tracking-widest">{{ splitMessage(b.message).room }}</span></div>
            </div>
            <span class="text-xs text-text-muted flex-shrink-0 whitespace-nowrap">{{ acceptedOf(b) }}/{{ b._required ?? '?' }}</span>
          </div>
          <div class="bg-border/40 rounded-full h-1.5 overflow-hidden" role="progressbar" :aria-valuenow="acceptedOf(b)" :aria-valuemax="b._required ?? 1">
            <div class="bg-accent h-full rounded-full transition-all duration-300" :style="{ width: `${Math.min(100, (acceptedOf(b) / (b._required ?? 1)) * 100)}%` }"></div>
          </div>
        </li>
      </ul>
    </section>

    <StateBlock :loading="loading && !games.length" :error="error" :empty="!loading && !games.length" empty-text="No games found." @retry="load">
      <!-- Phone: one card per game -->
      <ul class="space-y-2 md:hidden" :class="loading ? 'opacity-60' : ''">
        <li v-for="g in games" :key="g.id">
          <button type="button" class="list-card w-full text-left space-y-2 hover:border-accent/40 transition-colors" @click="openGame(g)">
            <div class="flex items-center justify-between gap-2">
              <span class="amount text-xs text-text-muted">{{ refOf(g) }}</span>
              <span :class="statusBadge(g.status)">{{ statusLabel(g.status) }}</span>
            </div>
            <div class="text-sm font-medium truncate">{{ g.players.map((p) => p.user.username).join(' vs ') }}</div>
            <div class="flex items-center justify-between gap-2 text-xs text-text-muted">
              <span class="truncate">{{ gameTypeLabel(g.gameType) }} · Stake <span class="amount text-accent font-medium">{{ formatPlain(g.stake) }}</span></span>
              <span class="flex-shrink-0">{{ formatDateTime(g.createdAt) }}</span>
            </div>
            <div class="flex items-center justify-between gap-2 text-xs">
              <span :class="g.winnerId ? 'text-active' : 'text-text-muted'" class="truncate">Winner: {{ winnerName(g) }}</span>
              <span class="text-accent flex-shrink-0">{{ canResolve(g) ? 'Resolve →' : 'View →' }}</span>
            </div>
          </button>
        </li>
      </ul>

      <!-- Desktop: table -->
      <div class="card p-0 overflow-x-auto hidden md:block">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-text-muted uppercase tracking-wide">
              <th class="px-4 py-3 font-medium">Ref</th><th class="px-4 py-3 font-medium">Type</th><th class="px-4 py-3 font-medium">Players</th>
              <th class="px-4 py-3 font-medium text-right">Stake</th><th class="px-4 py-3 font-medium">Status</th><th class="px-4 py-3 font-medium">Winner</th>
              <th class="px-4 py-3 font-medium">Date</th><th class="px-4 py-3"><span class="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="g in games" :key="g.id" class="hover:bg-border/20 transition-colors cursor-pointer" @click="openGame(g)">
              <td class="px-4 py-3 amount text-xs text-text-muted">{{ refOf(g) }}</td>
              <td class="px-4 py-3 text-xs">{{ gameTypeLabel(g.gameType) }}</td>
              <td class="px-4 py-3 text-xs text-text-muted max-w-[200px] truncate">{{ g.players.map((p) => p.user.username).join(', ') }}</td>
              <td class="px-4 py-3 amount text-xs text-accent font-medium text-right">{{ formatPlain(g.stake) }}</td>
              <td class="px-4 py-3"><span :class="statusBadge(g.status)">{{ statusLabel(g.status) }}</span></td>
              <td class="px-4 py-3 text-xs" :class="g.winnerId ? 'text-active' : 'text-text-muted'">{{ winnerName(g) }}</td>
              <td class="px-4 py-3 text-xs text-text-muted whitespace-nowrap">{{ formatDateTime(g.createdAt) }}</td>
              <td class="px-4 py-3 text-xs text-accent whitespace-nowrap">{{ canResolve(g) ? 'Resolve →' : 'View →' }}</td>
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

  <Lightbox v-if="lightbox" :src="lightbox" @close="lightbox = null" />

  <Modal v-if="selected" title="Game detail" :subtitle="refOf(selected)" size="lg" @close="selected = null">
    <div class="space-y-5">
      <div class="flex items-center gap-2"><span :class="statusBadge(selected.status)">{{ statusLabel(selected.status) }}</span></div>
      <dl class="grid grid-cols-2 gap-3">
        <div class="bg-bg rounded p-3 min-w-0"><dt class="label">Type</dt><dd class="text-sm font-medium truncate">{{ gameTypeLabel(selected.gameType) }}</dd></div>
        <div class="bg-bg rounded p-3 min-w-0"><dt class="label">Stake</dt><dd class="text-sm font-bold amount text-accent">{{ formatPlain(selected.stake) }}</dd></div>
        <div class="bg-bg rounded p-3 min-w-0"><dt class="label">Room code</dt><dd class="text-sm amount break-all whitespace-normal">{{ selected.ludoRoomCode || '—' }}</dd></div>
        <div class="bg-bg rounded p-3 min-w-0"><dt class="label">Date</dt><dd class="text-sm">{{ formatDateTime(selected.createdAt) }}</dd></div>
      </dl>
      <div>
        <div class="label mb-2">Players</div>
        <ul class="space-y-1.5">
          <li v-for="p in selected.players" :key="p.userId" class="flex items-center gap-2 py-2 px-3 bg-bg rounded min-w-0">
            <span class="font-medium text-sm truncate">{{ p.user.username }}</span>
            <span v-if="p.team" class="text-xs text-text-muted flex-shrink-0">Team {{ p.team }}</span>
            <span v-if="selected.winnerId === p.userId" class="badge-active ml-auto flex-shrink-0">Winner</span>
          </li>
        </ul>
      </div>
      <div v-if="selected.screenshots.length">
        <div class="label mb-2">Screenshots ({{ selected.screenshots.length }})</div>
        <div class="flex gap-2 flex-wrap">
          <button v-for="ss in selected.screenshots" :key="ss.id" type="button" @click="lightbox = fileUrl(ss.filename)">
            <img :src="fileUrl(ss.filename)" alt="Game screenshot" loading="lazy" class="h-24 w-32 object-cover rounded border border-border hover:border-accent transition-colors" />
          </button>
        </div>
      </div>

      <section v-if="canResolve(selected)" class="border border-danger/20 bg-danger/5 rounded-lg p-4 space-y-4" aria-label="Resolve game">
        <div class="text-sm font-semibold" :class="selected.status === 'DISPUTED' ? 'text-danger' : ''">
          {{ selected.status === 'DISPUTED' ? 'Resolve dispute' : 'Settle by hand' }}
        </div>
        <p v-if="selected.status !== 'DISPUTED'" class="text-xs text-text-muted">Use this when a game is stuck. The result is paid out immediately.</p>

        <label class="flex items-center gap-3 cursor-pointer select-none min-h-[44px]">
          <input v-model="voidGame" type="checkbox" class="w-5 h-5 rounded border-border bg-bg" @change="winnerId = ''; secondId = ''; voidConfirm = false; resolveError = ''" />
          <span class="text-sm">Void game (no balance changes)</span>
        </label>
        <div v-if="voidGame" class="bg-danger/10 rounded p-3 space-y-2">
          <p class="text-xs text-danger font-medium">This voids the game and cannot be undone.</p>
          <label class="flex items-center gap-3 cursor-pointer min-h-[44px]">
            <input v-model="voidConfirm" type="checkbox" class="w-5 h-5 rounded border-border bg-bg" />
            <span class="text-xs">I understand, void this game</span>
          </label>
        </div>

        <fieldset v-if="!voidGame" class="space-y-1.5">
          <legend class="label">Winner</legend>
          <label v-for="p in selected.players" :key="p.userId" class="flex items-center gap-3 cursor-pointer p-3 rounded border min-h-[48px] min-w-0 transition-colors"
            :class="winnerId === p.userId ? 'border-accent bg-accent/5' : 'border-border hover:border-text-muted'">
            <input v-model="winnerId" type="radio" name="resolve-winner" :value="p.userId" class="accent-amber-500 w-4 h-4 flex-shrink-0" @change="secondId = ''" />
            <span class="text-sm font-medium truncate">{{ p.user.username }}</span>
          </label>
        </fieldset>
        <fieldset v-if="!voidGame && isFour && winnerId" class="space-y-1.5">
          <legend class="label">2nd place <span class="normal-case font-normal">(stake back minus 10%)</span></legend>
          <label v-for="p in selected.players.filter((x) => x.userId !== winnerId)" :key="p.userId" class="flex items-center gap-3 cursor-pointer p-3 rounded border min-h-[48px] min-w-0 transition-colors"
            :class="secondId === p.userId ? 'border-active bg-active/5' : 'border-border hover:border-text-muted'">
            <input v-model="secondId" type="radio" name="resolve-second" :value="p.userId" class="accent-green-500 w-4 h-4 flex-shrink-0" />
            <span class="text-sm font-medium truncate">{{ p.user.username }}</span>
          </label>
        </fieldset>

        <p v-if="resolveError" class="field-error" role="alert">{{ resolveError }}</p>
        <button type="button" class="w-full" :class="voidGame ? 'btn-danger' : 'btn-primary'" :disabled="!canSubmit" @click="resolve">
          {{ resolving ? 'Working…' : voidGame ? 'Void game' : 'Declare winner' }}
        </button>
      </section>
    </div>
  </Modal>
</template>
