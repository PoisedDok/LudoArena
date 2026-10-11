<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useGamesStore, type Game } from '../../stores/games'
import api from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { fileUrl, formatAmount, formatPlain, gameTypeLabel, statusBadge, statusLabel } from '../../lib/format'
import StateBlock from '../../components/StateBlock.vue'
import Lightbox from '../../components/Lightbox.vue'

const route = useRoute()
const auth = useAuthStore()
const gamesStore = useGamesStore()

const game = ref<Game | null>(null)
const loadError = ref('')
const roomCodeInput = ref('')
const settingRoomCode = ref(false)
const file = ref<File | null>(null)
const preview = ref<string | null>(null)
const selectedWinnerId = ref('')
const selectedSecondPlaceId = ref('')
const uploading = ref(false)
const confirming = ref(false)
const undoing = ref(false)
const error = ref('')
const message = ref('')
const payout = ref<{ amount: number; win: boolean } | null>(null)
const copied = ref(false)
const lightbox = ref<string | null>(null)
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

const me = computed(() => game.value?.players.find((p) => p.userId === auth.user?.id))
const myScreenshot = computed(() => game.value?.screenshots.find((s) => s.userId === auth.user?.id))
const isInitiator = computed(() => game.value?.ping.fromUserId === auth.user?.id)
const isFourPlayer = computed(() => game.value?.gameType === 'FOUR_PLAYER')
const settling = computed(() => game.value?.status === 'PENDING_COMPLETION' && !!game.value.settlesAt)
const countdown = computed(() => (game.value?.settlesAt ? Math.max(0, Math.ceil((game.value.settlesAt - now.value) / 1000)) : 0))
const waitingFor = computed(() => game.value?.players.filter((p) => !p.isDone).map((p) => p.user.username) ?? [])

async function load() {
  loadError.value = ''
  try {
    const loaded = await gamesStore.fetchGame(route.params.id as string)
    game.value = loaded
    if (loaded.status === 'COMPLETED') await showPayout()
  } catch (e) {
    loadError.value = errorMessage(e, 'Could not load this game.')
  }
}

async function showPayout() {
  if (!game.value || payout.value || !auth.user) return
  try {
    const { data } = await api.get(`/players/${auth.user.id}/transactions`)
    const net = (data.data as Array<{ gameId: string | null; amount: number }>)
      .filter((t) => t.gameId === game.value?.id)
      .reduce((sum, t) => sum + Math.round(t.amount * 100), 0) / 100
    payout.value = { amount: net, win: net > 0 }
    message.value = net > 0 ? `You won. ${formatAmount(net, { signed: true })} added to your balance.` : net < 0 ? `Game complete. ${formatAmount(net)} taken from your balance.` : 'Game complete. No balance change.'
  } catch {
    // The balance card updates through the socket anyway.
  }
}

onMounted(async () => {
  await load()
  tick = setInterval(() => (now.value = Date.now()), 250)
})
onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
  if (preview.value) URL.revokeObjectURL(preview.value)
})

// Live updates land in the store's active game; mirror the ones for this page.
watch(
  () => gamesStore.activeGame,
  async (updated) => {
    if (!updated || !game.value || updated.id !== game.value.id) return
    game.value = { ...game.value, ...updated }
    if (updated.status === 'COMPLETED') await showPayout()
    if (updated.status === 'DISPUTED') message.value = 'The result is disputed. The admin will resolve it.'
  },
  { deep: true },
)

const gameLabel = computed(() => (game.value ? gameTypeLabel(game.value.gameType) : ''))

async function setRoomCode() {
  const code = roomCodeInput.value.trim()
  if (!code || !game.value || settingRoomCode.value) return
  settingRoomCode.value = true
  error.value = ''
  try {
    game.value = await gamesStore.setRoomCode(game.value.id, code)
    roomCodeInput.value = ''
  } catch (e) {
    error.value = errorMessage(e, 'Could not share the room code.')
  } finally {
    settingRoomCode.value = false
  }
}

function onFileSelect(e: Event) {
  const picked = (e.target as HTMLInputElement).files?.[0]
  if (!picked) return
  if (preview.value) URL.revokeObjectURL(preview.value)
  file.value = picked
  preview.value = URL.createObjectURL(picked)
}

async function uploadScreenshot() {
  if (!file.value || !game.value || uploading.value) return
  uploading.value = true
  error.value = ''
  try {
    await gamesStore.uploadScreenshot(game.value.id, file.value)
    game.value = await gamesStore.fetchGame(game.value.id)
    file.value = null
    if (preview.value) URL.revokeObjectURL(preview.value)
    preview.value = null
  } catch (e) {
    // The file stays selected so the person can retry without choosing it again.
    error.value = errorMessage(e, 'Upload failed. Tap Upload to retry.')
  } finally {
    uploading.value = false
  }
}

async function markDone() {
  if (!game.value) return
  error.value = ''
  try {
    await gamesStore.markDone(game.value.id)
    game.value = await gamesStore.fetchGame(game.value.id)
  } catch (e) {
    error.value = errorMessage(e, 'Could not mark the game as done.')
  }
}

async function confirmResult() {
  if (!selectedWinnerId.value || !game.value || confirming.value) return
  if (isFourPlayer.value && !selectedSecondPlaceId.value) {
    error.value = 'Choose 2nd place as well.'
    return
  }
  confirming.value = true
  error.value = ''
  try {
    const result = await gamesStore.confirmResult(game.value.id, selectedWinnerId.value, isFourPlayer.value ? selectedSecondPlaceId.value : undefined)
    if (result.status === 'settling') message.value = 'All votes are in. The result is paid out when the countdown ends.'
    else if (result.status === 'waiting_for_others') message.value = 'Your vote is recorded. Waiting for the others.'
    else if (result.status === 'disputed') message.value = 'The votes differ. The admin will resolve the result.'
    game.value = await gamesStore.fetchGame(game.value.id)
  } catch (e) {
    error.value = errorMessage(e, 'Could not confirm the result.')
  } finally {
    confirming.value = false
  }
}

async function retractVote() {
  if (!game.value || undoing.value) return
  undoing.value = true
  error.value = ''
  try {
    await gamesStore.retractVote(game.value.id)
    message.value = ''
    selectedWinnerId.value = ''
    selectedSecondPlaceId.value = ''
    game.value = await gamesStore.fetchGame(game.value.id)
  } catch (e) {
    error.value = errorMessage(e, 'Could not undo your vote.')
  } finally {
    undoing.value = false
  }
}

async function copyCode(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    error.value = 'Could not copy. Select the code and copy it by hand.'
  }
}
</script>

<template>
  <div class="page">
    <StateBlock :loading="!game && !loadError" :error="loadError" @retry="load">
      <template v-if="game">
        <div class="flex items-center gap-2 flex-wrap">
          <RouterLink to="/" class="text-text-muted hover:text-text-primary text-sm min-h-[44px] flex items-center pr-1">← Back</RouterLink>
          <h1 class="text-sm font-semibold">Game</h1>
          <span :class="statusBadge(game.status)">{{ settling ? 'Settling' : statusLabel(game.status) }}</span>
        </div>

        <section class="card space-y-4" aria-label="Game details">
          <dl class="grid grid-cols-3 gap-3 text-sm">
            <div class="min-w-0"><dt class="label">Type</dt><dd class="font-medium truncate">{{ gameLabel }}</dd></div>
            <div class="min-w-0"><dt class="label">Stake</dt><dd class="amount font-bold text-accent">{{ formatPlain(game.stake) }}</dd></div>
            <div class="min-w-0"><dt class="label">Started</dt><dd class="text-sm truncate">{{ new Date(game.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</dd></div>
          </dl>
          <div>
            <div class="label mb-2">Players</div>
            <ul class="flex flex-wrap gap-2">
              <li v-for="p in game.players" :key="p.userId" class="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-bg border border-border min-w-0 max-w-full">
                <span class="font-medium truncate">{{ p.user.username }}</span>
                <span v-if="p.team" class="text-text-muted flex-shrink-0">T{{ p.team }}</span>
                <span v-if="p.userId === auth.user?.id" class="text-accent flex-shrink-0">you</span>
              </li>
            </ul>
          </div>
        </section>

        <section class="card" aria-label="Room code">
          <div class="label mb-2">Ludo King room code</div>
          <div v-if="game.ludoRoomCode" class="flex items-center justify-between gap-3">
            <span class="amount text-2xl font-bold tracking-widest text-accent break-all whitespace-normal">{{ game.ludoRoomCode }}</span>
            <button type="button" class="btn-ghost btn-sm flex-shrink-0" :class="copied ? 'text-active border-active/30' : ''" @click="copyCode(game.ludoRoomCode!)">{{ copied ? 'Copied' : 'Copy' }}</button>
          </div>
          <div v-else>
            <p class="text-sm text-text-muted mb-3">
              <template v-if="isInitiator">Create a room in Ludo King, then enter its code so the others can join.</template>
              <template v-else>Waiting for {{ game.ping.fromUser.username }} to share the room code…</template>
            </p>
            <form v-if="isInitiator && game.status === 'ACTIVE'" class="flex gap-2" @submit.prevent="setRoomCode">
              <label class="sr-only" for="room-code">Room code</label>
              <input id="room-code" v-model="roomCodeInput" class="input amount uppercase flex-1 min-w-0" placeholder="e.g. ABCD1234" maxlength="32" autocapitalize="characters" autocomplete="off" />
              <button type="submit" class="btn-primary flex-shrink-0" :disabled="settingRoomCode || !roomCodeInput.trim()">Share</button>
            </form>
          </div>
        </section>

        <section v-if="game.status === 'ACTIVE'" class="card">
          <div class="label mb-2">Game finished?</div>
          <p class="text-sm text-text-muted mb-3">When the game ends on Ludo King, start the result process.</p>
          <button type="button" class="btn-primary w-full sm:w-auto" @click="markDone">Game is done</button>
        </section>

        <template v-if="game.status === 'PENDING_COMPLETION' || game.status === 'DISPUTED'">
          <section v-if="!me?.isDone && game.status === 'PENDING_COMPLETION'" class="card space-y-4" aria-label="Declare the result">
            <fieldset>
              <legend class="label mb-1">Who won?</legend>
              <div class="space-y-2">
                <label v-for="p in game.players" :key="p.userId" class="flex items-center gap-3 cursor-pointer p-3 rounded border min-h-[48px] transition-colors min-w-0"
                  :class="selectedWinnerId === p.userId ? 'border-accent bg-accent/5' : 'border-border hover:border-text-muted'">
                  <input v-model="selectedWinnerId" type="radio" name="winner" :value="p.userId" class="accent-amber-500 w-4 h-4 flex-shrink-0" />
                  <span class="text-sm truncate">{{ p.user.username }}<span v-if="p.userId === auth.user?.id" class="text-text-muted"> (you)</span></span>
                </label>
              </div>
            </fieldset>

            <fieldset v-if="isFourPlayer">
              <legend class="label mb-1">2nd place <span class="normal-case font-normal">(gets the stake back minus 10%)</span></legend>
              <div class="space-y-2">
                <label v-for="p in game.players.filter((x) => x.userId !== selectedWinnerId)" :key="p.userId"
                  class="flex items-center gap-3 cursor-pointer p-3 rounded border min-h-[48px] transition-colors min-w-0"
                  :class="selectedSecondPlaceId === p.userId ? 'border-active bg-active/5' : 'border-border hover:border-text-muted'">
                  <input v-model="selectedSecondPlaceId" type="radio" name="second" :value="p.userId" class="accent-green-500 w-4 h-4 flex-shrink-0" />
                  <span class="text-sm truncate">{{ p.user.username }}<span v-if="p.userId === auth.user?.id" class="text-text-muted"> (you)</span></span>
                </label>
              </div>
            </fieldset>

            <div v-if="selectedWinnerId === auth.user?.id">
              <div class="label mb-1">Win screenshot</div>
              <p class="text-sm text-text-muted mb-3">You chose yourself as the winner. Upload a Ludo King screenshot as proof.</p>
              <p v-if="myScreenshot" class="text-sm text-active">Screenshot uploaded</p>
              <div v-else class="space-y-2">
                <img v-if="preview" :src="preview" alt="Selected screenshot" class="max-h-40 rounded border border-border object-contain" />
                <div class="flex gap-2">
                  <label class="btn-ghost text-sm cursor-pointer flex-1 min-w-0">
                    <span class="truncate">{{ file ? file.name : 'Choose screenshot' }}</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" @change="onFileSelect" />
                  </label>
                  <button v-if="file" type="button" class="btn-primary text-sm flex-shrink-0" :disabled="uploading" @click="uploadScreenshot">{{ uploading ? 'Uploading…' : 'Upload' }}</button>
                </div>
              </div>
            </div>

            <button type="button" class="btn-primary w-full" :disabled="!selectedWinnerId || (isFourPlayer && !selectedSecondPlaceId) || confirming || (selectedWinnerId === auth.user?.id && !myScreenshot)" @click="confirmResult">
              {{ confirming ? 'Confirming…' : 'Confirm result' }}
            </button>
          </section>

          <section v-else-if="me?.isDone && !settling && game.status === 'PENDING_COMPLETION'" class="card border-accent/20 bg-accent/5" aria-live="polite">
            <p class="text-sm font-medium text-accent mb-1">Your vote is recorded</p>
            <p class="text-xs text-text-muted">Waiting for: <span class="font-medium text-text-primary">{{ waitingFor.join(', ') || 'everyone' }}</span></p>
            <button type="button" class="btn-danger btn-sm mt-3" :disabled="undoing" @click="retractVote">Undo my vote</button>
          </section>

          <section v-if="settling" class="card border-accent/30 bg-accent/5" aria-live="polite">
            <div class="flex items-center justify-between gap-3 mb-2">
              <div class="text-sm font-medium text-accent">All votes are in</div>
              <div class="amount text-2xl font-bold" :class="countdown <= 3 ? 'text-danger' : 'text-accent'">{{ countdown }}s</div>
            </div>
            <p class="text-xs text-text-muted mb-3">Made a mistake? Undo before the time runs out.</p>
            <button type="button" class="btn-danger btn-sm" :disabled="undoing || !me?.isDone" @click="retractVote">Undo my vote</button>
          </section>

          <section v-if="game.status === 'DISPUTED'" class="card border-danger/30 bg-danger/5" role="status">
            <p class="text-sm font-medium text-danger">The result is disputed</p>
            <p class="text-xs text-text-muted mt-1">The votes differ or a balance could not cover the stake. The admin will resolve this.</p>
          </section>
        </template>

        <p v-if="error" class="field-error" role="alert">{{ error }}</p>

        <section v-if="message" class="card" :class="payout?.win ? 'border-active/30 bg-active/5' : payout ? 'border-danger/30 bg-danger/5' : 'border-accent/20 bg-accent/5'" aria-live="polite">
          <p class="text-sm font-medium">{{ message }}</p>
          <RouterLink v-if="game.status === 'COMPLETED'" to="/" class="btn-ghost btn-sm mt-3">Back to dashboard</RouterLink>
        </section>

        <section v-if="game.screenshots.length" class="card">
          <div class="label mb-3">Screenshots</div>
          <div class="grid grid-cols-2 gap-3">
            <button v-for="ss in game.screenshots" :key="ss.id" type="button" class="text-left min-w-0" @click="lightbox = fileUrl(ss.filename)">
              <span class="block text-xs text-text-muted mb-1 truncate">{{ game.players.find((p) => p.userId === ss.userId)?.user.username }}</span>
              <img :src="fileUrl(ss.filename)" alt="Game screenshot" loading="lazy" class="w-full h-28 sm:h-40 rounded border border-border object-cover hover:border-accent transition-colors" />
            </button>
          </div>
        </section>
      </template>
    </StateBlock>
  </div>

  <Lightbox v-if="lightbox" :src="lightbox" @close="lightbox = null" />
</template>
