import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/share-login', name: 'share-login', component: () => import('../views/ShareLoginView.vue'), meta: { public: true, shareLogin: true } },
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('../views/player/PlayerLayout.vue'),
      meta: { role: 'PLAYER' },
      children: [
        { path: '', name: 'dashboard', component: () => import('../views/player/DashboardView.vue') },
        { path: 'game/:id', name: 'game', component: () => import('../views/player/GameView.vue') },
        { path: 'transactions', name: 'transactions', component: () => import('../views/player/TransactionsView.vue') },
      ],
    },
    {
      path: '/admin',
      component: () => import('../views/admin/AdminLayout.vue'),
      meta: { role: 'ADMIN' },
      children: [
        { path: '', name: 'admin-dashboard', component: () => import('../views/admin/AdminDashboardView.vue') },
        { path: 'players', name: 'admin-players', component: () => import('../views/admin/AdminPlayersView.vue') },
        { path: 'games', name: 'admin-games', component: () => import('../views/admin/AdminGamesView.vue') },
        { path: 'transactions', name: 'admin-transactions', component: () => import('../views/admin/AdminTransactionsView.vue') },
        { path: 'deposits', name: 'admin-deposits', component: () => import('../views/admin/AdminDepositsView.vue') },
        { path: 'settings', name: 'admin-settings', component: () => import('../views/admin/AdminSettingsView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

// The session is looked up once per page load; after that the store is the source of truth
// (login, logout and the "session ended" dialog keep it current).
let sessionChecked = false

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!sessionChecked) {
    sessionChecked = true
    await auth.init()
  }

  if (to.meta.shareLogin) return true

  // Redirect already-authenticated users away from /login
  if (to.meta.public) {
    if (auth.user) return auth.user.role === 'ADMIN' ? '/admin' : '/'
    return true
  }

  if (!auth.user) return '/login'
  if (to.meta.role === 'ADMIN' && auth.user.role !== 'ADMIN') return '/'
  if (to.meta.role === 'PLAYER' && auth.user.role === 'ADMIN') return '/admin'
  return true
})

export default router
