<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { errorMessage } from '../lib/errors'
import PasswordInput from '../components/PasswordInput.vue'

const auth = useAuthStore()
const router = useRouter()
const username = ref('')
const password = ref('')
// Off: the session ends with the browser (and after a day at most). On: it lasts 30 days on this device.
const remember = ref(false)
const error = ref('')

async function submit() {
  if (auth.loading) return
  error.value = ''
  try {
    await auth.login(username.value.trim(), password.value, remember.value)
    password.value = ''
    await router.push(auth.user?.role === 'ADMIN' ? '/admin' : '/')
  } catch (e) {
    error.value = errorMessage(e, 'Sign in failed.')
  }
}
</script>

<template>
  <main class="min-h-screen-dvh bg-bg flex items-center justify-center px-4 py-8">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center gap-2 mb-3">
          <div class="w-9 h-9 bg-accent rounded-lg flex items-center justify-center">
            <span class="text-bg font-bold text-base mono leading-none">L</span>
          </div>
          <span class="text-xl font-semibold tracking-tight">Ludo Arena</span>
        </div>
        <p class="text-text-muted text-sm">Sign in to your account</p>
      </div>

      <form class="space-y-4" novalidate @submit.prevent="submit">
        <div>
          <label for="login-username" class="label">Username or phone</label>
          <input
            id="login-username"
            v-model="username"
            class="input"
            type="text"
            inputmode="text"
            autocomplete="username"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            placeholder="Enter username or phone"
            required
          />
        </div>

        <PasswordInput v-model="password" label="Password" placeholder="Your password" required />

        <label class="flex items-center gap-3 min-h-[44px] cursor-pointer select-none">
          <input v-model="remember" type="checkbox" class="w-5 h-5 rounded border-border bg-bg text-accent focus:ring-accent" />
          <span class="text-sm">
            Remember me
            <span class="block text-xs text-text-muted">Stay signed in on this device for 30 days</span>
          </span>
        </label>

        <p v-if="error" class="field-error" role="alert">{{ error }}</p>

        <button type="submit" class="btn-primary w-full py-3" :disabled="auth.loading || !username || !password">
          {{ auth.loading ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>

      <p class="text-center text-xs text-text-muted mt-8">Contact your admin to get access.</p>
    </div>
  </main>
</template>
