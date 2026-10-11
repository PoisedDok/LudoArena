<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { errorMessage } from '../lib/errors'

const auth = useAuthStore()
const router = useRouter()
const error = ref('')

onMounted(async () => {
  const token = window.location.hash.slice(1)
  await router.replace({ name: 'share-login' })
  if (!/^[a-f0-9]{64}$/.test(token)) {
    error.value = 'This sign-in link is invalid or has expired. Ask the admin to create a new one.'
    return
  }

  try {
    await auth.loginWithShareLink(token)
    await router.replace(auth.user?.role === 'ADMIN' ? '/admin' : '/')
  } catch (e) {
    error.value = errorMessage(e, 'This sign-in link is invalid or has expired. Ask the admin to create a new one.')
  }
})
</script>

<template>
  <main class="min-h-screen-dvh bg-bg flex items-center justify-center px-4 py-8">
    <div class="card w-full max-w-sm text-center">
      <div class="inline-flex items-center justify-center gap-2 mb-5">
        <div class="w-9 h-9 bg-accent rounded-lg flex items-center justify-center">
          <span class="text-bg font-bold text-base mono leading-none">L</span>
        </div>
        <span class="text-xl font-semibold tracking-tight">Ludo Arena</span>
      </div>
      <p v-if="auth.loading" class="text-sm text-text-muted" role="status">Signing you in securely…</p>
      <template v-else-if="error">
        <h1 class="text-lg font-semibold mb-2">Could not sign you in</h1>
        <p class="text-sm text-text-muted">{{ error }}</p>
        <RouterLink to="/login" class="btn-primary inline-flex mt-5">Go to sign in</RouterLink>
      </template>
    </div>
  </main>
</template>
