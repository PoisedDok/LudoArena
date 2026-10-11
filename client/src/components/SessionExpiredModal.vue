<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { errorMessage } from '../lib/errors'
import Modal from './Modal.vue'
import PasswordInput from './PasswordInput.vue'

/**
 * Shown when a request answers 401 while a page is open. Signing in again happens in place, so a form
 * the person was filling in is still there afterwards.
 */
const auth = useAuthStore()
const router = useRouter()
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  if (!auth.user) return
  busy.value = true
  error.value = ''
  try {
    await auth.login(auth.user.username, password.value, true)
    password.value = ''
  } catch (e) {
    error.value = errorMessage(e, 'Could not sign in.')
  } finally {
    busy.value = false
  }
}

function otherAccount() {
  auth.discardSession()
  void router.push('/login')
}
</script>

<template>
  <Modal v-if="auth.sessionExpired && auth.user" title="Your session has ended" :subtitle="auth.user.username" size="sm" :dismissible="false" @close="() => undefined">
    <form id="relogin-form" class="space-y-4" @submit.prevent="submit">
      <p class="text-sm text-text-muted">Sign in again to continue where you were. Nothing you typed is lost.</p>
      <PasswordInput v-model="password" label="Password" required />
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="otherAccount">Other account</button>
        <button type="submit" form="relogin-form" class="btn-primary flex-1" :disabled="busy || !password">
          {{ busy ? 'Signing in…' : 'Sign in' }}
        </button>
      </div>
    </template>
  </Modal>
</template>
