<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { usePlayersStore } from '../../stores/players'
import { useGamesStore } from '../../stores/games'
import { usePingsStore } from '../../stores/pings'
import { useDepositsStore } from '../../stores/deposits'
import api from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { formatAmount, formatPlain, gameTypeLabel, splitMessage } from '../../lib/format'
import PingModal from '../../components/PingModal.vue'
import DepositModal from '../../components/DepositModal.vue'
import StateBlock from '../../components/StateBlock.vue'

const auth = useAuthStore()
const playersStore = usePlayersStore()
const gamesStore = useGamesStore()
const pingsStore = usePingsStore()
const depositsStore = useDepositsStore()

const showPingModal = ref(false)
const showDepositModal = ref(false)
const pingTarget = ref<{ id: string; username: string } | null>(null)
const pingBroadcast = ref(false)
const statusBusy = ref(false)
const actionError = ref('')
const ignored = ref<Set<string>>(new Set())
const joining = ref<string | null>(null)

const otherPlayers = computed(() => playersStore.players.filter((p) => p.id !== auth.user?.id && p.role === 'PLAYER'))
const activeCount = computed(() => otherPlayers.value.filter((p) => p.isActive).length)
const inGame = computed(() => !!gamesStore.activeGame)
const balance = computed(() => auth.user?.balance ?? 0)
const balanceClass = computed(() => (balance.value > 0 ? 'balance-positive' : balance.value < 0 ? 'balance-negative' : 'balance-zero'))
const broadcasts = computed(() => pingsStore.liveBroadcasts.map((b) => ({ ...b, parsed: splitMessage(b.message) })))
const hasJoined = (broadcast: (typeof pingsStore.liveBroadcasts)[number]) =>
  broadcast.recipients.some((recipient) => recipient.userId === auth.user?.id && recipient.response === 'ACCEPTED')
const acceptedPlayers = (broadcast: (typeof pingsStore.liveBroadcasts)[number]) =>
  broadcast._acceptedPlayers ?? broadcast.recipients.flatMap((recipient) =>
    recipient.response === 'ACCEPTED' && recipient.user
      ? [{ userId: recipient.userId, username: recipient.user.username }]
      : [],
  )

async function toggleActive() {
  if (!auth.user || statusBusy.value) return
  statusBusy.value = true
  actionError.value = ''
  const next = !auth.user.isActive
  try {
    await api.patch(`/players/${auth.user.id}/active`, { isActive: next })
    auth.user = { ...auth.user, isActive: next }
  } catch (e) {
    actionError.value = errorMessage(e, 'Could not change your status.')
  } finally {
    statusBusy.value = false
  }
}

function openDirectPing(player: { id: string; username: string }) {
  pingTarget.value = player
  pingBroadcast.value = false
  showPingModal.value = true
}

function openBroadcast() {
  pingTarget.value = null
  pingBroadcast.value = true
  showPingModal.value = true
}

async function join(pingId: string) {
  if (joining.value) return
  joining.value = pingId
  actionError.value = ''
  try {
    await pingsStore.respondToPing(pingId, 'ACCEPTED')
  } catch (e) {
    actionError.value = errorMessage(e, 'Could not join this game.')
  } finally {
    joining.value = null
  }
}

async function cancelJoin(pingId: string) {
  if (joining.value) return
  joining.value = pingId
  actionError.value = ''
  try {
    await pingsStore.respondToPing(pingId, 'DECLINED')
  } catch (e) {
    actionError.value = errorMessage(e, 'Could not cancel your join.')
  } finally {
    joining.value = null
  }
}

async function cancel(pingId: string) {
  actionError.value = ''
  try {
    await pingsStore.cancelPing(pingId)
  } catch (e) {
    actionError.value = errorMessage(e, 'Could not cancel the request.')
  }
}

const retryAll = () => void Promise.all([playersStore.fetchPlayers(), pingsStore.fetchPings(), gamesStore.fetchGames()])
</script>

<template>
  <div class="page">
    <p v-if="actionError" class="field-error" role="alert">{{ actionError }}</p>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4">
      <section class="card flex items-center justify-between gap-3 min-w-0" aria-label="Your status">
        <div class="min-w-0">
          <div class="label mb-1">Your status</div>
          <div class="flex items-center gap-2">
            <span v-if="auth.user?.isActive" class="active-dot flex-shrink-0"></span>
            <span v-else class="w-2 h-2 rounded-full bg-muted flex-shrink-0"></span>
            <span class="font-medium text-sm">{{ auth.user?.isActive ? 'Active' : 'Offline' }}</span>
          </div>
        </div>
        <button v-if="!auth.user?.deletedAt" type="button" class="btn-ghost text-sm flex-shrink-0" :class="auth.user?.isActive ? 'border-active/30 text-active' : ''" :disabled="statusBusy" :aria-pressed="!!auth.user?.isActive" @click="toggleActive">
          {{ auth.user?.isActive ? 'Go offline' : "I'm active" }}
        </button>
      </section>

      <section class="card space-y-3 min-w-0" aria-label="Balance">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="label mb-1">Balance</div>
            <div class="text-2xl font-bold leading-tight break-all" :class="balanceClass">{{ formatAmount(balance, { signed: true }) }}</div>
            <div class="text-xs text-text-muted mt-1">
              Credit limit {{ formatPlain(auth.user?.creditLimit) }} · Max stake {{ formatPlain(auth.user?.spendLimit) }}
            </div>
          </div>
          <button v-if="!auth.user?.deletedAt" type="button" class="btn-ghost btn-sm border-active/30 text-active hover:bg-active/10 flex-shrink-0" @click="showDepositModal = true">Add funds</button>
        </div>
        <ul v-if="depositsStore.myDeposits.length" class="border-t border-border pt-2 space-y-1">
          <li v-for="d in depositsStore.myDeposits.slice(0, 2)" :key="d.id" class="flex items-center justify-between gap-3 text-xs">
            <span class="text-text-muted truncate">+{{ formatPlain(d.amount) }} deposit</span>
            <span class="font-medium flex-shrink-0" :class="d.status === 'APPROVED' ? 'text-active' : d.status === 'REJECTED' ? 'text-danger' : 'text-amber-400'">
              {{ d.status === 'APPROVED' ? 'Credited' : d.status === 'REJECTED' ? 'Rejected' : 'Pending' }}
            </span>
          </li>
        </ul>
      </section>
    </div>

    <section v-if="gamesStore.activeGame" class="card border-accent/30 bg-accent/5" aria-label="Game in progress">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-xs text-accent uppercase tracking-wide mb-1">Game in progress</div>
          <div class="text-sm font-medium truncate">{{ gameTypeLabel(gamesStore.activeGame.gameType) }} · Stake {{ formatPlain(gamesStore.activeGame.stake) }}</div>
          <div class="text-xs text-text-muted mt-0.5 truncate">
            vs {{ gamesStore.activeGame.players.filter((p) => p.userId !== auth.user?.id).map((p) => p.user.username).join(', ') }}
          </div>
        </div>
        <RouterLink :to="`/game/${gamesStore.activeGame.id}`" class="btn-primary text-sm flex-shrink-0">Open</RouterLink>
      </div>
    </section>

    <section v-if="broadcasts.length && !auth.user?.deletedAt" class="space-y-2" aria-label="Open game requests">
      <div class="flex items-center justify-between gap-3">
        <h2 class="section-title text-accent">Open game requests</h2>
        <span class="text-xs text-text-muted">{{ broadcasts.length }} live</span>
      </div>
      <article v-for="b in broadcasts" :key="b.id" class="card border-accent/20 bg-accent/5 min-w-0" :class="ignored.has(b.id) ? 'opacity-60' : ''">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium truncate">{{ b.fromUser?.username }} wants to play</div>
            <div class="text-xs text-text-muted mt-0.5">
              {{ gameTypeLabel(b.gameType) }} · Stake <span class="amount text-accent font-semibold">{{ formatPlain(b.stake) }}</span>
              <span v-if="b.parsed.note"> · “{{ b.parsed.note }}”</span>
            </div>
            <div v-if="b.parsed.room" class="text-xs mt-0.5">Room <span class="amount font-bold text-accent tracking-widest">{{ b.parsed.room }}</span></div>
          </div>
          <span v-if="b.fromUserId === auth.user?.id" class="text-xs text-text-muted flex-shrink-0">
            {{ b._acceptedCount !== undefined ? `${b._acceptedCount}/${b._required}` : acceptedPlayers(b).length ? `${acceptedPlayers(b).length} joined` : 'Waiting…' }}
          </span>
        </div>
        <p v-if="b.fromUserId === auth.user?.id && acceptedPlayers(b).length" class="text-xs text-text-muted mt-2">
          Joined: {{ acceptedPlayers(b).map((player) => player.username).join(', ') }}
        </p>
        <div class="flex gap-2 mt-3">
          <template v-if="b.fromUserId === auth.user?.id">
            <button type="button" class="btn-ghost text-sm text-danger flex-1" @click="cancel(b.id)">Cancel request</button>
          </template>
          <template v-else-if="hasJoined(b)">
            <span class="text-xs text-active self-center flex-1">You joined · waiting for players</span>
            <button type="button" class="btn-ghost text-sm text-danger" :disabled="joining === b.id" @click="cancelJoin(b.id)">
              {{ joining === b.id ? 'Cancelling…' : 'Cancel join' }}
            </button>
          </template>
          <template v-else-if="ignored.has(b.id)">
            <span class="text-xs text-text-muted self-center flex-1">Ignored</span>
            <button type="button" class="btn-ghost btn-sm" @click="ignored.delete(b.id)">Undo</button>
          </template>
          <template v-else-if="!inGame && !auth.user?.deletedAt">
            <button type="button" class="btn-ghost text-sm" @click="ignored.add(b.id)">Ignore</button>
            <button type="button" class="btn-primary text-sm flex-1" :disabled="joining === b.id" @click="join(b.id)">
              {{ joining === b.id ? 'Joining…' : 'Join game' }}
            </button>
          </template>
        </div>
      </article>
    </section>

    <section aria-label="Players" class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="section-title">Players</h2>
        <button v-if="!auth.user?.deletedAt" type="button" class="btn-ghost btn-sm" :disabled="inGame" @click="openBroadcast">
          Broadcast <span v-if="activeCount" class="badge-active">{{ activeCount }}</span>
        </button>
      </div>

      <StateBlock :loading="playersStore.loading && !playersStore.players.length" :error="playersStore.error" :empty="!otherPlayers.length" empty-text="No other players yet." @retry="retryAll">
        <ul class="space-y-2">
          <li v-for="player in otherPlayers" :key="player.id" class="list-card flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <span class="avatar w-9 h-9 text-sm">{{ player.username[0] }}</span>
              <div class="min-w-0">
                <div class="text-sm font-medium truncate">{{ player.username }}</div>
                <div class="text-xs flex items-center gap-1.5" :class="player.isActive ? 'text-active' : 'text-text-muted'">
                  <span v-if="player.isActive" class="active-dot"></span>
                  {{ player.isActive ? 'Active now' : 'Offline' }}
                </div>
              </div>
            </div>
            <button v-if="player.isActive" type="button" class="btn-ghost text-sm flex-shrink-0" :disabled="inGame" @click="openDirectPing(player)">Ping</button>
          </li>
        </ul>
      </StateBlock>
    </section>
  </div>

  <PingModal v-if="showPingModal" :target="pingTarget" :is-broadcast="pingBroadcast" @close="showPingModal = false" />
  <DepositModal v-if="showDepositModal" @close="showDepositModal = false" />
</template>
