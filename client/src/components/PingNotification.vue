<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePingsStore } from '../stores/pings'
import { errorMessage } from '../lib/errors'
import { formatPlain, gameTypeLabel, splitMessage } from '../lib/format'
import Modal from './Modal.vue'

const pings = usePingsStore()
const ping = computed(() => pings.incomingPing!)
const busy = ref(false)
const error = ref('')

const parsed = computed(() => splitMessage(ping.value?.message))
const minutesLeft = computed(() => Math.max(0, Math.ceil((new Date(ping.value.expiresAt).getTime() - Date.now()) / 60000)))

async function respond(response: 'ACCEPTED' | 'DECLINED') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await pings.respondToPing(ping.value.id, response)
    pings.clearIncoming()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Game request" size="sm" :dismissible="false" @close="() => undefined">
    <div class="space-y-4">
      <div class="flex items-center gap-3 min-w-0">
        <span class="avatar w-10 h-10 text-sm">{{ ping.fromUser?.username?.[0] }}</span>
        <div class="min-w-0">
          <div class="font-semibold text-sm truncate">{{ ping.fromUser?.username }}</div>
          <div class="text-xs text-text-muted">{{ ping.isBroadcast ? 'is looking for players' : 'wants to play with you' }}</div>
        </div>
      </div>

      <dl class="bg-bg rounded p-3 space-y-2 text-sm">
        <div class="flex justify-between gap-4"><dt class="text-text-muted">Game</dt><dd class="font-medium">{{ gameTypeLabel(ping.gameType) }}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-text-muted">Stake</dt><dd class="amount font-bold text-accent">{{ formatPlain(ping.stake) }}</dd></div>
        <div v-if="parsed.note" class="flex justify-between gap-4"><dt class="text-text-muted flex-shrink-0">Note</dt><dd class="text-right text-xs min-w-0">{{ parsed.note }}</dd></div>
        <div v-if="parsed.room" class="flex justify-between gap-4"><dt class="text-text-muted">Room</dt><dd class="amount font-bold text-accent tracking-widest">{{ parsed.room }}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-text-muted">Expires in</dt><dd class="text-xs text-text-muted">{{ minutesLeft }} min</dd></div>
      </dl>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-danger flex-1" :disabled="busy" @click="respond('DECLINED')">{{ ping.isBroadcast ? 'Ignore' : 'Decline' }}</button>
        <button type="button" class="btn-primary flex-1" :disabled="busy" @click="respond('ACCEPTED')">{{ ping.isBroadcast ? 'Join' : 'Accept' }}</button>
      </div>
    </template>
  </Modal>
</template>
