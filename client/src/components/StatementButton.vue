<script setup lang="ts">
import { ref } from 'vue'
import api from '../lib/api'
import { errorMessage } from '../lib/errors'
import { validateRange } from '../lib/period'
import Modal from './Modal.vue'

/**
 * "Statement (PDF)" for one player. The file is fetched with the session cookie as a blob and saved
 * through an anchor, so an error (too many entries, a busy server, a lapsed session) is shown here
 * instead of replacing the page with JSON.
 */
const props = withDefaults(defineProps<{
  playerId: string
  playerName: string
  variant?: 'button' | 'link'
}>(), { variant: 'button' })

type Choice = 'this-month' | 'last-month' | 'all' | 'custom'

const open = ref(false)
const choice = ref<Choice>('this-month')
const from = ref('')
const to = ref('')
const busy = ref(false)
const error = ref('')

const OPTIONS: Array<{ value: Choice; label: string }> = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
]

function show() {
  error.value = ''
  open.value = true
}

function fileNameFrom(header: string | undefined): string {
  const match = header ? /filename="([^"]+)"/.exec(header) : null
  return match?.[1] ?? `ludo-statement-${props.playerName}.pdf`
}

async function download() {
  error.value = ''
  const params: Record<string, string> = {}
  if (choice.value === 'custom') {
    const problem = validateRange(from.value, to.value)
    if (problem) {
      error.value = problem
      return
    }
    params.from = from.value
    params.to = to.value
  } else if (choice.value !== 'this-month') {
    params.period = choice.value
  }
  busy.value = true
  try {
    const res = await api.get(`/players/${props.playerId}/statement.pdf`, { params, responseType: 'blob', timeout: 60_000 })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileNameFrom(res.headers['content-disposition'] as string | undefined)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    open.value = false
  } catch (e) {
    // An error body is a Blob too: read the server's sentence out of it.
    const blob = (e as { response?: { data?: unknown } }).response?.data
    if (blob instanceof Blob) {
      try {
        const body = JSON.parse(await blob.text()) as { error?: string }
        error.value = body.error ?? errorMessage(e)
      } catch {
        error.value = errorMessage(e)
      }
    } else {
      error.value = errorMessage(e, 'Could not create the statement.')
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button v-if="variant === 'link'" type="button" class="text-xs text-text-muted hover:text-text-primary transition-colors py-2 px-1" @click="show">Statement</button>
  <button v-else type="button" class="btn-ghost btn-sm" @click="show">
    <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
    Statement (PDF)
  </button>

  <Modal v-if="open" title="Account statement" :subtitle="playerName" size="sm" @close="open = false">
    <form id="statement-form" class="space-y-4" @submit.prevent="download">
      <fieldset class="space-y-2">
        <legend class="label">Period</legend>
        <label v-for="o in OPTIONS" :key="o.value"
          class="flex items-center gap-3 p-3 rounded border cursor-pointer min-h-[44px]"
          :class="choice === o.value ? 'border-accent bg-accent/5' : 'border-border'">
          <input v-model="choice" type="radio" name="statement-period" :value="o.value" class="accent-amber-500" />
          <span class="text-sm">{{ o.label }}</span>
        </label>
      </fieldset>
      <div v-if="choice === 'custom'" class="grid grid-cols-2 gap-2">
        <div>
          <label class="label" for="statement-from">From</label>
          <input id="statement-from" v-model="from" type="date" class="input" required />
        </div>
        <div>
          <label class="label" for="statement-to">To</label>
          <input id="statement-to" v-model="to" type="date" class="input" required />
        </div>
      </div>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="open = false">Cancel</button>
        <button type="submit" form="statement-form" class="btn-primary flex-1" :disabled="busy">
          {{ busy ? 'Preparing…' : 'Download PDF' }}
        </button>
      </div>
    </template>
  </Modal>
</template>
