<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { usePlayersStore } from '../../stores/players'
import { usePingsStore } from '../../stores/pings'
import { useGamesStore } from '../../stores/games'
import { useDepositsStore } from '../../stores/deposits'
import PingNotification from '../../components/PingNotification.vue'
import GameReadyModal from '../../components/GameReadyModal.vue'

const auth = useAuthStore()
const players = usePlayersStore()
const pings = usePingsStore()
const games = useGamesStore()
const deposits = useDepositsStore()
const router = useRouter()

onMounted(() => {
  pings.bindSocketEvents()
  games.bindSocketEvents()
  deposits.bindSocketEvents()
  void Promise.all([players.fetchPlayers(), pings.fetchPings(), games.fetchGames(), deposits.fetchMyDeposits()])
})

async function logout() {
  await auth.logout().catch(() => undefined)
  await router.push('/login')
}
</script>

<template>
  <div class="min-h-screen-dvh bg-bg flex flex-col">
    <header class="bg-surface border-b border-border px-4 h-14 flex items-center justify-between gap-3 flex-shrink-0 sticky top-0 z-30">
      <div class="flex items-center gap-2 min-w-0">
        <div class="w-7 h-7 bg-accent rounded flex items-center justify-center flex-shrink-0">
          <span class="text-bg font-bold text-xs mono leading-none">L</span>
        </div>
        <span class="font-semibold text-sm tracking-tight truncate">Ludo Arena</span>
      </div>

      <nav class="hidden sm:flex items-center gap-1" aria-label="Main">
        <RouterLink to="/" class="px-3 py-1.5 text-sm rounded hover:bg-border transition-colors" active-class="text-accent" exact-active-class="text-accent">Dashboard</RouterLink>
        <RouterLink to="/transactions" class="px-3 py-1.5 text-sm rounded hover:bg-border transition-colors" active-class="text-accent">My games</RouterLink>
      </nav>

      <div class="flex items-center gap-1 min-w-0">
        <span class="hidden sm:inline text-sm text-text-muted truncate max-w-[10rem]">{{ auth.user?.username }}</span>
        <button type="button" class="btn-ghost btn-sm border-transparent text-text-muted" @click="logout">Sign out</button>
      </div>
    </header>

    <main class="flex-1 min-w-0 main-content">
      <RouterView />
    </main>

    <nav class="sm:hidden fixed bottom-0 inset-x-0 bg-surface/95 backdrop-blur-sm border-t border-border z-30 flex" style="padding-bottom: env(safe-area-inset-bottom)" aria-label="Main">
      <RouterLink to="/" exact-active-class="!text-accent" class="flex-1 min-h-[56px] flex flex-col items-center justify-center gap-1 text-text-muted transition-colors">
        <svg class="w-[22px] h-[22px]" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
        </svg>
        <span class="text-[11px] font-semibold tracking-wide uppercase">Home</span>
      </RouterLink>
      <RouterLink to="/transactions" active-class="!text-accent" class="flex-1 min-h-[56px] flex flex-col items-center justify-center gap-1 text-text-muted transition-colors">
        <svg class="w-[22px] h-[22px]" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
        </svg>
        <span class="text-[11px] font-semibold tracking-wide uppercase">My games</span>
      </RouterLink>
    </nav>

    <PingNotification v-if="pings.incomingPing && !pings.incomingPing.isBroadcast" />
    <GameReadyModal v-if="pings.pendingGame" />
  </div>
</template>
