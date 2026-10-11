<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { RouterView, RouterLink, useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { usePingsStore } from '../../stores/pings'
import { useDepositsStore } from '../../stores/deposits'
const auth = useAuthStore()
const pings = usePingsStore()
const depositsStore = useDepositsStore()
const router = useRouter()
const route = useRoute()

const sidebarOpen = ref(false)
const sidebarCollapsed = ref(false)

onMounted(() => {
  pings.bindAdminSocketEvents()
  depositsStore.bindAdminSocketEvents()
  // Restore the collapse state (a per-device convenience; the page works without storage).
  try {
    if (localStorage.getItem('admin-sidebar-collapsed') === 'true') sidebarCollapsed.value = true
  } catch {
    // Storage can be blocked (private mode); the sidebar simply starts expanded.
  }
})

// Close mobile overlay on route change
watch(() => route.path, () => { sidebarOpen.value = false })

function toggleCollapse() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try {
    localStorage.setItem('admin-sidebar-collapsed', String(sidebarCollapsed.value))
  } catch {
    // Not persisted when storage is blocked; the toggle still works for this visit.
  }
}

async function logout() {
  await auth.logout().catch(() => undefined)
  await router.push('/login')
}

const navItems = [
  { to: '/admin',              label: 'Dashboard',    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6', exact: true },
  { to: '/admin/players',      label: 'Players',      icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z', exact: false },
  { to: '/admin/games',        label: 'Games',        icon: 'M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z', exact: false },
  { to: '/admin/transactions', label: 'Transactions', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2', exact: false },
  { to: '/admin/deposits',     label: 'Deposits',     icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', exact: false },
  { to: '/admin/settings',     label: 'Settings',     icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zm8.2 4a8.2 8.2 0 01-.1 1.3l1.5 1.2-1.5 2.6-1.8-.7a8 8 0 01-2.2 1.3l-.3 1.9h-3l-.3-1.9a8 8 0 01-2.2-1.3l-1.8.7-1.5-2.6 1.5-1.2a8.2 8.2 0 010-2.6L7 9.5l1.5-2.6 1.8.7a8 8 0 012.2-1.3l.3-1.9h3l.3 1.9a8 8 0 012.2 1.3l1.8-.7 1.5 2.6-1.5 1.2c.1.4.1.8.1 1.3z', exact: false },
]

function isActive(item: { to: string; exact: boolean }) {
  return item.exact ? route.path === item.to : route.path.startsWith(item.to)
}
</script>

<template>
  <div class="min-h-screen-dvh bg-bg flex">
    <!-- Mobile overlay backdrop -->
    <Transition name="fade">
      <div
        v-if="sidebarOpen"
        class="fixed inset-0 bg-black/60 z-40 md:hidden"
        @click="sidebarOpen = false"
      />
    </Transition>

    <!-- Sidebar -->
    <aside
      :class="[
        'flex flex-col bg-surface border-r border-border transition-all duration-200 flex-shrink-0 z-50',
        'fixed inset-y-0 left-0 md:relative md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        sidebarCollapsed ? 'md:w-14' : 'md:w-56',
        'w-56'
      ]"
    >
      <!-- Logo + collapse toggle -->
      <div class="px-3 h-14 flex items-center border-b border-border flex-shrink-0" :class="sidebarCollapsed ? 'justify-center' : 'gap-3 justify-between'">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-7 h-7 bg-accent rounded flex items-center justify-center flex-shrink-0">
            <span class="text-bg font-black text-xs mono tracking-tighter">LA</span>
          </div>
          <Transition name="slide-fade">
            <div v-if="!sidebarCollapsed" class="min-w-0 overflow-hidden">
              <div class="font-semibold text-sm leading-none truncate">Ludo Arena</div>
              <div class="text-xs text-text-muted mt-0.5">Admin Console</div>
            </div>
          </Transition>
        </div>
        <!-- Collapse toggle — desktop only -->
        <button
          @click="toggleCollapse"
          class="hidden md:flex w-6 h-6 items-center justify-center rounded hover:bg-border text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
          :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        >
          <svg class="w-3.5 h-3.5 transition-transform duration-200" :class="sidebarCollapsed ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7"/>
          </svg>
        </button>
      </div>

      <!-- Nav -->
      <nav class="flex-1 p-2 space-y-0.5 overflow-y-auto">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2.5 px-2.5 py-2.5 rounded text-sm transition-all duration-100 group relative"
          :class="[
            isActive(item) ? 'bg-accent/10 text-accent font-medium' : 'text-text-muted hover:bg-border hover:text-text-primary',
            sidebarCollapsed ? 'justify-center' : ''
          ]"
        >
          <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon"/>
          </svg>
          <Transition name="slide-fade">
            <span v-if="!sidebarCollapsed" class="truncate">{{ item.label }}</span>
          </Transition>
          <!-- Tooltip for collapsed state -->
          <div v-if="sidebarCollapsed"
            class="absolute left-full ml-2 px-2 py-1 bg-surface border border-border rounded text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 hidden md:block">
            {{ item.label }}
          </div>
        </RouterLink>
      </nav>

      <!-- User footer -->
      <div class="p-2 border-t border-border space-y-1">
        <div class="flex items-center gap-2 px-2 py-1.5" :class="sidebarCollapsed ? 'justify-center' : ''">
          <div class="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0">
            <span class="text-accent text-xs font-bold">{{ auth.user?.username?.[0]?.toUpperCase() }}</span>
          </div>
          <Transition name="slide-fade">
            <div v-if="!sidebarCollapsed" class="min-w-0 overflow-hidden">
              <div class="text-xs font-medium truncate">{{ auth.user?.username }}</div>
              <div class="text-xs text-text-muted">Admin</div>
            </div>
          </Transition>
        </div>
        <button @click="logout"
          class="w-full flex items-center gap-2.5 px-2.5 py-2 text-xs text-text-muted hover:text-danger transition-colors rounded hover:bg-danger/5"
          :class="sidebarCollapsed ? 'justify-center' : ''"
          :title="sidebarCollapsed ? 'Sign out' : undefined"
        >
          <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>
          <Transition name="slide-fade">
            <span v-if="!sidebarCollapsed">Sign out</span>
          </Transition>
        </button>
      </div>
    </aside>

    <!-- Main content -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <!-- Mobile top bar -->
      <header class="md:hidden bg-surface border-b border-border px-4 h-14 flex items-center gap-3 flex-shrink-0 sticky top-0 z-30">
        <button
          @click="sidebarOpen = true"
          class="icon-btn -ml-1" aria-label="Open menu"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
          </svg>
        </button>
        <div class="flex items-center gap-2">
          <div class="w-6 h-6 bg-accent rounded flex items-center justify-center">
            <span class="text-bg font-black text-xs mono">LA</span>
          </div>
          <span class="font-semibold text-sm">Admin Console</span>
        </div>
      </header>

      <main class="flex-1 overflow-auto min-w-0">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.slide-fade-enter-active { transition: all 0.15s ease; }
.slide-fade-leave-active { transition: all 0.1s ease; }
.slide-fade-enter-from { opacity: 0; transform: translateX(-6px); }
.slide-fade-leave-to { opacity: 0; transform: translateX(-6px); }
</style>
