<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import api from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { formatAmount, formatDay, formatPlain, gameTypeLabel, statusBadge, statusLabel } from '../../lib/format'
import { usePeriodQuery } from '../../lib/period'
import { expectShape } from '../../lib/contract'
import { usePingsStore } from '../../stores/pings'
import PeriodPicker from '../../components/PeriodPicker.vue'
import StateBlock from '../../components/StateBlock.vue'

interface Totals {
  games: number; volume: number; commission: number; depositsApproved: number; depositsAmount: number
  playersInPeriod: number; completedGames: number; disputedGames: number
}
interface Stats {
  period: { key: string; kind: string; from: string; to: string; granularity: 'day' | 'month'; days: number; timezone: string }
  totals: Totals
  previous: { period: { key: string }; totals: Totals } | null
  chart: Array<{ date: string; games: number; volume: number; commission: number }>
  topPlayers: Array<{ userId: string; username: string; wins: number; net: number }>
  live: { activePlayers: number; disputedGames: number; pendingDeposits: number; totalPlayerBalance: number }
  now: { month: string; date: string }
}
interface RecentGame { id: string; status: string; gameType: string; stake: number; createdAt: string; players: Array<{ user: { username: string } }> }

const pings = usePingsStore()
const { params, setPeriod, setRange } = usePeriodQuery()

const stats = ref<Stats | null>(null)
const recent = ref<RecentGame[]>([])
const loading = ref(true)
const error = ref('')
let requestId = 0

async function load() {
  const mine = ++requestId
  loading.value = true
  error.value = ''
  try {
    const [statsRes, gamesRes] = await Promise.all([
      api.get('/admin/stats', { params: params.value }),
      api.get('/admin/games', { params: { ...params.value, limit: 8 } }),
    ])
    if (mine !== requestId) return
    // A response in a different shape ends in the error state below, never in a half-drawn page.
    stats.value = expectShape<Stats>('admin.stats', statsRes.data.data)
    recent.value = expectShape<{ games: RecentGame[] }>('admin.games', gamesRes.data.data).games
  } catch (e) {
    if (mine !== requestId) return
    error.value = errorMessage(e, 'Could not load the dashboard.')
  } finally {
    if (mine === requestId) loading.value = false
  }
}

onMounted(() => {
  void pings.fetchAdminBroadcasts()
  void load()
})
watch(params, load)

const totals = computed(() => stats.value?.totals)
const peak = computed(() => ({
  volume: Math.max(...(stats.value?.chart.map((d) => d.volume) ?? []), 1),
  games: Math.max(...(stats.value?.chart.map((d) => d.games) ?? []), 1),
}))
const bucketLabel = (key: string) => (stats.value?.period.granularity === 'month' ? key : key.slice(5))

/** "+12%" / "-5%" against the previous period; null when there is nothing to compare to. */
function delta(now: number, before: number | undefined): { text: string; tone: string } | null {
  if (before === undefined || stats.value?.previous === null) return null
  if (before === 0) return now === 0 ? null : { text: 'new', tone: 'text-active' }
  const pct = Math.round(((now - before) / before) * 100)
  return { text: `${pct > 0 ? '+' : ''}${pct}%`, tone: pct > 0 ? 'text-active' : pct < 0 ? 'text-danger' : 'text-text-muted' }
}

const cards = computed(() => {
  const t = totals.value
  const p = stats.value?.previous?.totals
  if (!t) return []
  return [
    { label: 'Games', value: String(t.games), tone: 'text-text-primary', delta: delta(t.games, p?.games), note: `${t.completedGames} settled` },
    { label: 'Volume', value: formatPlain(t.volume), tone: 'text-accent', delta: delta(t.volume, p?.volume), note: 'total stake' },
    { label: 'Commission', value: formatAmount(t.commission), tone: 'text-accent', delta: delta(t.commission, p?.commission), note: 'earned' },
    { label: 'Deposits', value: formatPlain(t.depositsAmount), tone: 'text-active', delta: delta(t.depositsAmount, p?.depositsAmount), note: `${t.depositsApproved} approved` },
    { label: 'Players', value: String(t.playersInPeriod), tone: 'text-text-primary', delta: delta(t.playersInPeriod, p?.playersInPeriod), note: 'played in period' },
  ]
})
const gamesQuery = computed(() => ({ ...params.value }))
</script>

<template>
  <div class="page-wide">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-sub truncate">
          <template v-if="stats">{{ stats.period.days }} {{ stats.period.days === 1 ? 'day' : 'days' }} · {{ stats.period.timezone }}</template>
          <template v-else>Loading…</template>
        </p>
      </div>
      <div class="sm:w-80">
        <PeriodPicker :current="stats ? stats.period : null" :current-month="stats?.now.month" :params="params" @select="setPeriod" @range="setRange" />
      </div>
    </div>

    <StateBlock :loading="loading && !stats" :error="error" :rows="3" @retry="load">
      <template v-if="stats && totals">
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 md:gap-4" :class="loading ? 'opacity-60 transition-opacity' : ''">
          <section v-for="c in cards" :key="c.label" class="card min-w-0 space-y-1" :aria-label="c.label">
            <div class="label mb-0">{{ c.label }}</div>
            <div class="text-2xl font-bold amount truncate" :class="c.tone">{{ c.value }}</div>
            <div class="flex items-center gap-2 text-xs min-w-0">
              <span v-if="c.delta" class="font-semibold flex-shrink-0" :class="c.delta.tone" :title="stats.previous ? `vs ${stats.previous.period.key}` : ''">{{ c.delta.text }}</span>
              <span class="text-text-muted truncate">{{ c.note }}</span>
            </div>
          </section>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
          <RouterLink to="/admin/games?status=DISPUTED" class="card min-w-0 block" :class="stats.live.disputedGames > 0 ? 'border-danger/40 bg-danger/5' : ''">
            <div class="label mb-0" :class="stats.live.disputedGames > 0 ? 'text-danger' : ''">Disputed now</div>
            <div class="text-2xl font-bold amount" :class="stats.live.disputedGames > 0 ? 'text-danger' : ''">{{ stats.live.disputedGames }}</div>
            <div class="text-xs text-text-muted">{{ stats.live.disputedGames > 0 ? 'need resolution' : 'no disputes' }}</div>
          </RouterLink>
          <RouterLink to="/admin/deposits" class="card min-w-0 block" :class="stats.live.pendingDeposits > 0 ? 'border-amber-400/40' : ''">
            <div class="label mb-0">Pending deposits</div>
            <div class="text-2xl font-bold amount" :class="stats.live.pendingDeposits > 0 ? 'text-amber-400' : ''">{{ stats.live.pendingDeposits }}</div>
            <div class="text-xs text-text-muted">waiting for review</div>
          </RouterLink>
          <div class="card min-w-0">
            <div class="label mb-0 flex items-center gap-2">Active now <span class="active-dot"></span></div>
            <div class="text-2xl font-bold amount text-active">{{ stats.live.activePlayers }}</div>
            <div class="text-xs text-text-muted truncate">players · balances {{ formatAmount(stats.live.totalPlayerBalance) }}</div>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          <section v-for="chart in [{ key: 'volume', title: 'Volume', note: 'total stake', color: 'bg-accent/60 hover:bg-accent', total: stats.chart.reduce((s, d) => s + d.volume, 0) }, { key: 'games', title: 'Games', note: 'games played', color: 'bg-active/50 hover:bg-active', total: stats.chart.reduce((s, d) => s + d.games, 0) }] as const" :key="chart.key" class="card min-w-0" :aria-label="`${chart.title} per ${stats.period.granularity}`">
            <div class="flex items-center justify-between gap-3 mb-4">
              <div class="min-w-0">
                <div class="text-sm font-medium">{{ chart.title }}</div>
                <div class="text-xs text-text-muted mt-0.5">{{ chart.note }} per {{ stats.period.granularity }}</div>
              </div>
              <span class="text-xs amount font-bold flex-shrink-0">{{ formatPlain(chart.total) }}</span>
            </div>
            <div class="flex items-end gap-px h-28" role="img" :aria-label="`${chart.title}: ${formatPlain(chart.total)} in total`">
              <div v-for="day in stats.chart" :key="day.date" class="flex-1 rounded-sm relative group min-w-[2px]"
                :style="{ height: `${Math.max((day[chart.key] / peak[chart.key]) * 100, day[chart.key] > 0 ? 4 : 0)}%` }"
                :class="day[chart.key] > 0 ? `${chart.color} cursor-default` : 'bg-border/30'" :title="`${bucketLabel(day.date)}: ${formatPlain(day[chart.key])}`" />
            </div>
            <div class="flex justify-between text-xs text-text-muted mt-2">
              <span>{{ bucketLabel(stats.chart[0]?.date ?? '') }}</span>
              <span>{{ bucketLabel(stats.chart[stats.chart.length - 1]?.date ?? '') }}</span>
            </div>
            <details class="mt-3 text-xs">
              <summary class="cursor-pointer text-text-muted min-h-[32px] flex items-center">Table view</summary>
              <div class="max-h-48 overflow-y-auto mt-2">
                <table class="w-full">
                  <caption class="sr-only">{{ chart.title }} per {{ stats.period.granularity }}</caption>
                  <thead><tr class="text-text-muted text-left"><th class="py-1 font-medium">{{ stats.period.granularity === 'month' ? 'Month' : 'Day' }}</th><th class="py-1 font-medium text-right">{{ chart.title }}</th></tr></thead>
                  <tbody class="divide-y divide-border">
                    <tr v-for="d in stats.chart" :key="d.date"><td class="py-1">{{ d.date }}</td><td class="py-1 text-right amount">{{ formatPlain(d[chart.key]) }}</td></tr>
                  </tbody>
                </table>
              </div>
            </details>
          </section>
        </div>

        <section v-if="stats.topPlayers.length" class="card min-w-0" aria-label="Top players">
          <div class="text-sm font-medium mb-3">Top players <span class="text-xs text-text-muted font-normal">by net result</span></div>
          <ol class="divide-y divide-border">
            <li v-for="(p, i) in stats.topPlayers" :key="p.userId" class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 min-w-0">
              <span class="avatar w-7 h-7 text-xs">{{ i + 1 }}</span>
              <span class="text-sm font-medium truncate flex-1 min-w-0">{{ p.username }}</span>
              <span class="text-xs text-text-muted flex-shrink-0">{{ p.wins }} {{ p.wins === 1 ? 'win' : 'wins' }}</span>
              <span class="amount text-sm font-semibold flex-shrink-0" :class="p.net >= 0 ? 'text-active' : 'text-danger'">{{ formatAmount(p.net, { signed: true }) }}</span>
            </li>
          </ol>
        </section>

        <section v-if="pings.liveBroadcasts.length" class="card border-accent/20 bg-accent/5 min-w-0" aria-label="Live game requests">
          <div class="flex items-center justify-between gap-3 mb-3">
            <div class="text-sm font-medium text-accent">Live game requests</div>
            <span class="text-xs amount font-bold text-accent">{{ pings.liveBroadcasts.length }} open</span>
          </div>
          <ul class="divide-y divide-border">
            <li v-for="b in pings.liveBroadcasts" :key="b.id" class="flex items-center gap-3 py-3 first:pt-0 last:pb-0 min-w-0">
              <span class="active-dot flex-shrink-0"></span>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">{{ b.fromUser?.username }}</div>
                <div class="text-xs text-text-muted truncate">{{ gameTypeLabel(b.gameType) }} · Stake <span class="amount text-accent">{{ formatPlain(b.stake) }}</span></div>
              </div>
              <span class="text-xs text-text-muted flex-shrink-0">{{ b._acceptedCount !== undefined ? `${b._acceptedCount}/${b._required}` : 'waiting' }}</span>
            </li>
          </ul>
        </section>

        <section class="card min-w-0" aria-label="Games in this period">
          <div class="flex items-center justify-between gap-3 mb-3">
            <div class="text-sm font-medium">Games in this period</div>
            <RouterLink :to="{ path: '/admin/games', query: gamesQuery }" class="text-xs text-accent hover:text-amber-400 py-2">View all →</RouterLink>
          </div>
          <p v-if="recent.length === 0" class="text-sm text-text-muted text-center py-6">No games in this period.</p>
          <ul v-else class="divide-y divide-border">
            <li v-for="g in recent" :key="g.id" class="flex items-center gap-3 py-3 first:pt-0 last:pb-0 min-w-0">
              <span :class="statusBadge(g.status)" class="w-[5.5rem] flex-shrink-0">{{ statusLabel(g.status) }}</span>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">{{ g.players.map((p) => p.user.username).join(' vs ') }}</div>
                <div class="text-xs text-text-muted truncate">{{ gameTypeLabel(g.gameType) }} · Stake {{ formatPlain(g.stake) }}</div>
              </div>
              <span class="text-xs text-text-muted flex-shrink-0">{{ formatDay(g.createdAt) }}</span>
            </li>
          </ul>
        </section>
      </template>
    </StateBlock>
  </div>
</template>
