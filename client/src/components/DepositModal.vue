<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useDepositsStore } from '../stores/deposits'
import { idempotencyKey } from '../lib/api'
import { errorMessage } from '../lib/errors'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const deposits = useDepositsStore()

const MAX_BYTES = 10 * 1024 * 1024
const amount = ref('')
const file = ref<File | null>(null)
const preview = ref<string | null>(null)
const error = ref('')
const loading = ref(false)
const success = ref(false)
// One key for this attempt: a double tap, or a retry after a lost answer, creates one request.
let key = idempotencyKey()

function setPreview(next: string | null) {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = next
}

function onFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
    error.value = 'Only JPEG, PNG or WebP images are allowed.'
    return
  }
  if (f.size > MAX_BYTES) {
    error.value = 'The image must be under 10 MB.'
    return
  }
  error.value = ''
  file.value = f
  key = idempotencyKey()
  setPreview(URL.createObjectURL(f))
}

async function submit() {
  if (loading.value) return
  error.value = ''
  const text = amount.value.trim()
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
    error.value = 'Enter an amount above 0 with at most 2 decimals.'
    return
  }
  if (!file.value) {
    error.value = 'Attach the payment screenshot.'
    return
  }
  loading.value = true
  try {
    await deposits.submitDeposit(Number(text), file.value, key)
    success.value = true
  } catch (e) {
    error.value = errorMessage(e, 'Could not submit the deposit request.')
  } finally {
    loading.value = false
  }
}

onBeforeUnmount(() => setPreview(null))
</script>

<template>
  <Modal title="Add funds" size="sm" @close="emit('close')">
    <div v-if="success" class="text-center py-4 space-y-3">
      <div class="text-3xl text-active" aria-hidden="true">✓</div>
      <p class="font-semibold text-active">Deposit request sent</p>
      <p class="text-sm text-text-muted">The admin will check your payment and credit your balance.</p>
    </div>

    <form v-else id="deposit-form" class="space-y-4" @submit.prevent="submit">
      <div>
        <label class="label" for="deposit-amount">Amount you paid</label>
        <input id="deposit-amount" v-model="amount" class="input amount" type="text" inputmode="decimal" autocomplete="off" placeholder="e.g. 500" required />
      </div>
      <div>
        <span class="label">Payment screenshot</span>
        <img v-if="preview" :src="preview" alt="Selected screenshot" class="max-h-40 w-full object-contain rounded border border-border bg-bg mb-2" />
        <label class="btn-ghost w-full cursor-pointer">
          <span class="truncate">{{ file ? file.name : 'Choose screenshot' }}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" @change="onFileChange" />
        </label>
      </div>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </form>

    <template #footer>
      <button v-if="success" type="button" class="btn-primary w-full" @click="emit('close')">Done</button>
      <div v-else class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="emit('close')">Cancel</button>
        <button type="submit" form="deposit-form" class="btn-primary flex-1" :disabled="loading">{{ loading ? 'Sending…' : 'Send request' }}</button>
      </div>
    </template>
  </Modal>
</template>
