<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePingsStore } from '../stores/pings'
import { useAuthStore } from '../stores/auth'
import { idempotencyKey } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { formatPlain } from '../lib/format'
import Modal from './Modal.vue'

const props = defineProps<{
  target: { id: string; username: string } | null
  isBroadcast: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const pings = usePingsStore()
const auth = useAuthStore()

const GAME_TYPES = [
  { value: 'ONE_V_ONE', label: 'Solo', hint: 'The first player to join starts the game.' },
  { value: 'TWO_V_TWO', label: 'Teams', hint: 'Starts when 3 players have joined; teams are set automatically.' },
  { value: 'FOUR_PLAYER', label: '4v2', hint: 'Starts when 3 players have joined; 1st and 2nd place are paid.' },
]

// Direct pings are always Solo; only a broadcast can be another type.
const gameType = ref('ONE_V_ONE')
const stake = ref('')
const message = ref('')
const ludoCode = ref('')
const error = ref('')
const loading = ref(false)
// One key per open dialog: pressing "Send" twice sends one request.
const key = idempotencyKey()

const maxStake = computed(() => auth.user?.spendLimit ?? 0)
const stakeNumber = computed(() => Number(stake.value))
const stakeValid = computed(() => /^\d{1,7}(\.\d{1,2})?$/.test(stake.value.trim()) && stakeNumber.value > 0)
const overLimit = computed(() => stakeValid.value && stakeNumber.value > maxStake.value)
const hint = computed(() => GAME_TYPES.find((t) => t.value === gameType.value)?.hint ?? '')

async function send() {
  if (loading.value) return
  error.value = ''
  if (!stakeValid.value) {
    error.value = 'Enter a stake above 0 with at most 2 decimals.'
    return
  }
  if (overLimit.value) {
    error.value = `The stake is above your limit (${formatPlain(maxStake.value)}).`
    return
  }
  loading.value = true
  try {
    const code = ludoCode.value.trim().toUpperCase()
    const fullMessage = [message.value.trim(), code ? `[Room: ${code}]` : ''].filter(Boolean).join(' · ') || undefined
    await pings.sendPing(
      {
        gameType: gameType.value,
        stake: stakeNumber.value,
        message: fullMessage,
        recipientIds: props.isBroadcast ? undefined : props.target ? [props.target.id] : [],
        isBroadcast: props.isBroadcast,
      },
      key,
    )
    emit('close')
  } catch (e) {
    error.value = errorMessage(e, 'Could not send the request.')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <Modal :title="isBroadcast ? 'Broadcast a game' : `Ping ${target?.username ?? ''}`" size="sm" @close="emit('close')">
    <form id="ping-form" class="space-y-4" @submit.prevent="send">
      <fieldset v-if="isBroadcast">
        <legend class="label">Game type</legend>
        <div class="grid grid-cols-3 gap-2">
          <label v-for="t in GAME_TYPES" :key="t.value"
            class="btn-ghost cursor-pointer px-2 py-3 text-sm"
            :class="gameType === t.value ? 'border-accent text-accent bg-accent/5' : 'text-text-muted'">
            <input v-model="gameType" type="radio" name="game-type" :value="t.value" class="sr-only" />
            {{ t.label }}
          </label>
        </div>
        <p class="text-xs text-text-muted mt-2">{{ hint }}</p>
      </fieldset>
      <div v-else class="bg-bg rounded px-3 py-2 flex items-center justify-between gap-3">
        <span class="label mb-0">Game type</span>
        <span class="text-sm font-medium text-accent">Solo</span>
      </div>

      <div>
        <label class="label" for="ping-stake">Stake</label>
        <input id="ping-stake" v-model="stake" class="input amount text-base" type="text" inputmode="decimal" autocomplete="off" placeholder="0"
          :class="overLimit ? 'border-danger' : ''" :aria-invalid="overLimit" aria-describedby="ping-stake-hint" required />
        <p id="ping-stake-hint" class="text-xs mt-1" :class="overLimit ? 'text-danger' : 'text-text-muted'">
          {{ overLimit ? 'Above your limit' : 'Your limit' }}: {{ formatPlain(maxStake) }}
        </p>
      </div>

      <div>
        <label class="label" for="ping-message">Message <span class="normal-case font-normal">(optional)</span></label>
        <input id="ping-message" v-model="message" class="input" type="text" maxlength="160" placeholder="e.g. Classic board" />
      </div>

      <div v-if="isBroadcast">
        <label class="label" for="ping-room">Ludo King room code <span class="normal-case font-normal">(optional)</span></label>
        <input id="ping-room" v-model="ludoCode" class="input amount uppercase" type="text" maxlength="10" autocapitalize="characters" autocomplete="off" placeholder="e.g. AB3K7P" />
      </div>

      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </form>

    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="emit('close')">Cancel</button>
        <button type="submit" form="ping-form" class="btn-primary flex-1" :disabled="loading">
          {{ loading ? 'Sending…' : isBroadcast ? 'Broadcast' : 'Send ping' }}
        </button>
      </div>
    </template>
  </Modal>
</template>
