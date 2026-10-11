<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import api, { idempotencyKey, withKey } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { amountTone, fileUrl, formatAmount, formatDateTime, formatPlain, txBadgeClass, txTypeLabel } from '../../lib/format'
import { expectShape } from '../../lib/contract'
import StateBlock from '../../components/StateBlock.vue'
import Modal from '../../components/Modal.vue'
import Lightbox from '../../components/Lightbox.vue'
import PasswordInput from '../../components/PasswordInput.vue'
import StatementButton from '../../components/StatementButton.vue'

interface Player {
  id: string; username: string; phone?: string | null; role: string
  balance: number; creditLimit: number; spendLimit: number; isActive: boolean
}
interface DeletedPlayer extends Player { deletedAt: string }
interface Tx {
  id: string; type: string; amount: number; description: string | null; createdAt: string
  screenshotFilename?: string | null; balanceAfter: number
}

const players = ref<Player[]>([])
const deletedPlayers = ref<DeletedPlayer[]>([])
const loading = ref(true)
const loadError = ref('')
const deletedLoadError = ref('')
const search = ref('')
const shareBusyId = ref<string | null>(null)
const shareError = ref('')
const shareResult = ref<{ playerId: string; username: string; url: string; expiresAt: string } | null>(null)
const shareExpired = ref(false)
let shareExpiryTimer: ReturnType<typeof setTimeout> | undefined

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await api.get('/players')
    players.value = expectShape<Player[]>('players.list.admin', data.data).filter((p) => p.role === 'PLAYER')
  } catch (e) {
    loadError.value = errorMessage(e, 'Could not load players.')
  } finally {
    loading.value = false
  }
}

async function loadDeleted() {
  deletedLoadError.value = ''
  try {
    const { data } = await api.get('/players/deleted')
    deletedPlayers.value = expectShape<DeletedPlayer[]>('players.deleted', data.data)
  } catch (e) {
    deletedLoadError.value = errorMessage(e, 'Could not load deleted players.')
  }
}
onMounted(() => { void load(); void loadDeleted() })
onBeforeUnmount(() => { if (shareExpiryTimer) clearTimeout(shareExpiryTimer) })

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return players.value
  return players.value.filter((p) => p.username.toLowerCase().includes(q) || (p.phone ?? '').toLowerCase().includes(q))
})

// ---- dialogs ----
type Dialog = 'add' | 'edit' | 'balance' | 'delete' | 'ledger' | 'purge' | null
const dialog = ref<Dialog>(null)
const target = ref<Player | null>(null)
const formError = ref('')
const busy = ref(false)
const lightbox = ref<string | null>(null)
let actionKey = idempotencyKey()

function open(kind: Exclude<Dialog, null>, player: Player | null = null) {
  dialog.value = kind
  target.value = player
  formError.value = ''
  busy.value = false
  actionKey = idempotencyKey()
  if (kind === 'add') add.value = { username: '', phone: '', password: '', balance: '', creditLimit: '500', spendLimit: '1000' }
  if (kind === 'edit' && player) edit.value = { username: player.username, phone: player.phone ?? '', password: '', creditLimit: String(player.creditLimit), spendLimit: String(player.spendLimit) }
  if (kind === 'balance') {
    adjust.value = { amount: '', description: '' }
    proof.value = null
  }
  if (kind === 'ledger' && player) void loadLedger(player)
}
const close = () => {
  dialog.value = null
  target.value = null
}

const MONEY = /^-?\d{1,7}(\.\d{1,2})?$/
const isMoney = (v: string) => MONEY.test(v.trim())

// add
const add = ref({ username: '', phone: '', password: '', balance: '', creditLimit: '500', spendLimit: '1000' })
async function submitAdd() {
  if (busy.value) return
  const a = add.value
  if (a.balance.trim() !== '' && !isMoney(a.balance)) return void (formError.value = 'Initial balance must be a number with at most 2 decimals.')
  if (!isMoney(a.creditLimit) || !isMoney(a.spendLimit)) return void (formError.value = 'Limits must be numbers with at most 2 decimals.')
  busy.value = true
  formError.value = ''
  try {
    await api.post('/players', {
      username: a.username.trim(),
      phone: a.phone.trim() || undefined,
      password: a.password,
      balance: a.balance.trim() === '' ? 0 : a.balance.trim(),
      creditLimit: a.creditLimit.trim(),
      spendLimit: a.spendLimit.trim(),
    }, withKey(actionKey))
    close()
    await load()
  } catch (e) {
    formError.value = errorMessage(e, 'Could not add the player.')
  } finally {
    busy.value = false
  }
}

// edit
const edit = ref({ username: '', phone: '', password: '', creditLimit: '', spendLimit: '' })
async function submitEdit() {
  if (busy.value || !target.value) return
  const e = edit.value
  if (!isMoney(e.creditLimit) || !isMoney(e.spendLimit)) return void (formError.value = 'Limits must be numbers with at most 2 decimals.')
  busy.value = true
  formError.value = ''
  try {
    await api.put(`/players/${target.value.id}`, {
      username: e.username.trim(),
      phone: e.phone.trim(),
      creditLimit: e.creditLimit.trim(),
      spendLimit: e.spendLimit.trim(),
      ...(e.password ? { password: e.password } : {}),
    })
    close()
    await load()
  } catch (err) {
    formError.value = errorMessage(err, 'Could not save the player.')
  } finally {
    busy.value = false
  }
}

// balance adjustment
const adjust = ref({ amount: '', description: '' })
const proof = ref<File | null>(null)
async function submitBalance() {
  if (busy.value || !target.value) return
  if (!isMoney(adjust.value.amount) || Number(adjust.value.amount) === 0) return void (formError.value = 'Enter an amount other than 0, with at most 2 decimals.')
  busy.value = true
  formError.value = ''
  try {
    const form = new FormData()
    form.append('amount', adjust.value.amount.trim())
    form.append('description', adjust.value.description.trim())
    if (proof.value) form.append('screenshot', proof.value)
    await api.patch(`/players/${target.value.id}/balance`, form, withKey(actionKey))
    close()
    await load()
  } catch (e) {
    formError.value = errorMessage(e, 'Could not adjust the balance.')
  } finally {
    busy.value = false
  }
}

// delete
async function submitDelete() {
  if (busy.value || !target.value) return
  busy.value = true
  formError.value = ''
  try {
    await api.delete(`/players/${target.value.id}`)
    close()
    await Promise.all([load(), loadDeleted()])
  } catch (e) {
    formError.value = errorMessage(e, 'Could not delete the player.')
  } finally {
    busy.value = false
  }
}

async function restorePlayer(player: DeletedPlayer) {
  try {
    await api.post(`/players/${player.id}/restore`)
    await Promise.all([load(), loadDeleted()])
  } catch (e) {
    deletedLoadError.value = errorMessage(e, 'Could not restore the player.')
  }
}

async function shareLoginLink(player: Player) {
  if (shareBusyId.value) return
  shareBusyId.value = player.id
  shareError.value = ''
  try {
    const { data } = await api.post(`/players/${player.id}/share-link`)
    const result = expectShape<{ token: string; expiresAt: string }>('players.shareLoginLink', data.data)
    const url = new URL('/share-login', window.location.origin)
    url.hash = result.token
    shareResult.value = { playerId: player.id, username: player.username, url: url.toString(), expiresAt: result.expiresAt }
    shareExpired.value = false
    if (shareExpiryTimer) clearTimeout(shareExpiryTimer)
    shareExpiryTimer = setTimeout(() => { shareExpired.value = true }, Math.max(0, Date.parse(result.expiresAt) - Date.now()))
    await copyShareLink()
  } catch (e) {
    shareError.value = errorMessage(e, 'Could not create the sign-in link.')
  } finally {
    shareBusyId.value = null
  }
}

async function copyShareLink() {
  if (!shareResult.value) return
  if (Date.parse(shareResult.value.expiresAt) <= Date.now()) {
    shareExpired.value = true
    shareError.value = 'This link has expired. Generate a new one to sign in.'
    return
  }
  try {
    await navigator.clipboard.writeText(shareResult.value.url)
    shareError.value = 'Sign-in link copied. It can be used once and expires in five minutes.'
  } catch {
    shareError.value = 'The link is ready below, but could not be copied automatically. Copy it manually.'
  }
}

async function permanentlyCleanPlayer() {
  if (busy.value || !target.value) return
  busy.value = true
  formError.value = ''
  try {
    await api.delete(`/players/${target.value.id}/permanent-cleanup`)
    close()
    await loadDeleted()
  } catch (e) {
    formError.value = errorMessage(e, 'Could not permanently clean up the player.')
  } finally {
    busy.value = false
  }
}

// ledger
const ledger = ref<Tx[]>([])
const ledgerLoading = ref(false)
const ledgerError = ref('')
async function loadLedger(player: Player) {
  ledger.value = []
  ledgerLoading.value = true
  ledgerError.value = ''
  try {
    const { data } = await api.get(`/players/${player.id}/transactions`)
    ledger.value = expectShape<Tx[]>('players.transactions', data.data)
  } catch (e) {
    ledgerError.value = errorMessage(e, 'Could not load the ledger.')
  } finally {
    ledgerLoading.value = false
  }
}
</script>

<template>
  <div class="page-wide">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="page-title">Players</h1>
        <p class="page-sub">{{ players.length }} registered</p>
      </div>
      <div class="flex flex-col sm:flex-row gap-2 sm:items-center min-w-0">
        <label class="sr-only" for="player-search">Search players</label>
        <input id="player-search" v-model="search" class="input sm:w-56" type="search" placeholder="Search players" autocomplete="off" />
        <button type="button" class="btn-primary" @click="open('add')">Add player</button>
      </div>
    </div>

    <StateBlock :loading="loading && !players.length" :error="loadError" :empty="!filtered.length" empty-text="No players found." @retry="load">
      <!-- Phone: a card per player -->
      <ul class="space-y-3 md:hidden">
        <li v-for="p in filtered" :key="p.id" class="card space-y-3 min-w-0">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <span class="avatar w-10 h-10 text-sm">{{ p.username[0] }}</span>
              <div class="min-w-0">
                <div class="font-medium text-sm truncate">{{ p.username }}</div>
                <div v-if="p.phone" class="text-xs text-text-muted truncate">{{ p.phone }}</div>
                <div class="text-xs flex items-center gap-1.5 mt-0.5" :class="p.isActive ? 'text-active' : 'text-text-muted'">
                  <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="p.isActive ? 'bg-active' : 'bg-border'"></span>{{ p.isActive ? 'Online' : 'Offline' }}
                </div>
              </div>
            </div>
            <div class="text-right flex-shrink-0">
              <div class="amount text-base font-bold" :class="amountTone(p.balance)">{{ formatAmount(p.balance, { signed: true }) }}</div>
              <div class="text-[11px] text-text-muted">Limit {{ formatPlain(p.creditLimit) }} · Max {{ formatPlain(p.spendLimit) }}</div>
            </div>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-border pt-3">
            <button type="button" class="btn-ghost btn-sm text-accent" @click="open('balance', p)">Balance</button>
            <button type="button" class="btn-ghost btn-sm" @click="open('ledger', p)">Ledger</button>
            <button type="button" class="btn-ghost btn-sm" @click="open('edit', p)">Edit</button>
            <button type="button" class="btn-ghost btn-sm" :disabled="shareBusyId !== null" @click="shareLoginLink(p)">
              {{ shareBusyId === p.id ? 'Creating…' : shareResult?.playerId === p.id ? 'Rotate link' : 'Share login' }}
            </button>
          </div>
          <div class="flex items-center justify-between gap-2">
            <StatementButton :player-id="p.id" :player-name="p.username" variant="link" />
            <button type="button" class="text-xs text-danger py-2 px-1" @click="open('delete', p)">Delete</button>
          </div>
        </li>
      </ul>

      <!-- Desktop: table -->
      <div class="card p-0 overflow-x-auto hidden md:block">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-text-muted uppercase tracking-wide">
              <th class="px-4 py-3 font-medium">Player</th><th class="px-4 py-3 font-medium text-right">Balance</th>
              <th class="px-4 py-3 font-medium text-right">Credit limit</th><th class="px-4 py-3 font-medium text-right">Spend limit</th>
              <th class="px-4 py-3 font-medium">Status</th><th class="px-4 py-3"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="p in filtered" :key="p.id" class="hover:bg-border/20 transition-colors">
              <td class="px-4 py-3 max-w-[16rem]">
                <div class="font-medium text-sm truncate">{{ p.username }}</div>
                <div v-if="p.phone" class="text-xs text-text-muted truncate">{{ p.phone }}</div>
              </td>
              <td class="px-4 py-3 amount text-sm font-semibold text-right" :class="amountTone(p.balance)">{{ formatAmount(p.balance, { signed: true }) }}</td>
              <td class="px-4 py-3 text-xs text-text-muted amount text-right">{{ formatPlain(p.creditLimit) }}</td>
              <td class="px-4 py-3 text-xs text-text-muted amount text-right">{{ formatPlain(p.spendLimit) }}</td>
              <td class="px-4 py-3">
                <span class="flex items-center gap-1.5 text-xs" :class="p.isActive ? 'text-active' : 'text-text-muted'">
                  <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="p.isActive ? 'bg-active' : 'bg-border'"></span>{{ p.isActive ? 'Online' : 'Offline' }}
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-3 justify-end whitespace-nowrap">
                  <button type="button" class="text-xs text-accent hover:text-amber-400" @click="open('balance', p)">Balance</button>
                  <button type="button" class="text-xs text-text-muted hover:text-text-primary" @click="open('ledger', p)">Ledger</button>
                  <StatementButton :player-id="p.id" :player-name="p.username" variant="link" />
                  <button type="button" class="text-xs text-accent hover:text-amber-400" :disabled="shareBusyId !== null" @click="shareLoginLink(p)">
                    {{ shareBusyId === p.id ? 'Creating…' : shareResult?.playerId === p.id ? 'Rotate link' : 'Share login' }}
                  </button>
                  <button type="button" class="text-xs text-text-muted hover:text-text-primary" @click="open('edit', p)">Edit</button>
                  <button type="button" class="text-xs text-danger hover:text-red-400" @click="open('delete', p)">Delete</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>

    <section v-if="shareResult" class="card mt-4 space-y-3" aria-live="polite">
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div class="min-w-0">
          <h2 class="font-medium">Sign-in link for {{ shareResult.username }}</h2>
          <p v-if="shareExpired" class="field-error mt-1" role="status">This link has expired. Generate a new one before sharing.</p>
          <p v-else class="text-xs text-text-muted mt-1">
            Single-use; expires {{ formatDateTime(shareResult.expiresAt) }}. Anyone with it can sign in and stay signed in on that device for up to 30 days.
            Creating another link invalidates this one.
          </p>
        </div>
        <button type="button" class="btn-ghost btn-sm flex-shrink-0" :disabled="shareExpired" @click="copyShareLink">Copy link</button>
      </div>
      <label class="sr-only" for="player-share-link">Share sign-in link</label>
      <input id="player-share-link" class="input text-xs" readonly :value="shareResult.url" @focus="($event.target as HTMLInputElement).select()" />
      <p v-if="shareError" class="text-xs text-text-muted" role="status">{{ shareError }}</p>
    </section>
    <p v-else-if="shareError" class="field-error mt-4" role="alert">{{ shareError }}</p>

    <details class="card">
      <summary class="cursor-pointer font-medium">Deleted players ({{ deletedPlayers.length }})</summary>
      <p v-if="deletedLoadError" class="field-error mt-3" role="alert">{{ deletedLoadError }}</p>
      <p v-else-if="!deletedPlayers.length" class="text-sm text-text-muted mt-3">No deleted players.</p>
      <ul v-else class="divide-y divide-border mt-3">
        <li v-for="p in deletedPlayers" :key="p.id" class="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="font-medium truncate">{{ p.username }}</div>
            <div class="text-xs text-text-muted">Deleted {{ formatDateTime(p.deletedAt) }} · Balance {{ formatPlain(p.balance) }}</div>
          </div>
          <div class="flex gap-2 flex-shrink-0">
            <button type="button" class="btn-ghost btn-sm" @click="restorePlayer(p)">Restore</button>
            <button type="button" class="btn-ghost btn-sm text-danger" @click="open('purge', p)">Permanent cleanup</button>
          </div>
        </li>
      </ul>
    </details>
  </div>

  <Lightbox v-if="lightbox" :src="lightbox" @close="lightbox = null" />

  <!-- Add -->
  <Modal v-if="dialog === 'add'" title="Add player" size="md" @close="close">
    <form id="add-form" class="grid grid-cols-2 gap-3" @submit.prevent="submitAdd">
      <div class="col-span-2">
        <label class="label" for="add-username">Username</label>
        <input id="add-username" v-model="add.username" class="input" required autocomplete="off" autocapitalize="none" minlength="3" maxlength="32" />
      </div>
      <div class="col-span-2">
        <label class="label" for="add-phone">Phone <span class="normal-case font-normal">(optional)</span></label>
        <input id="add-phone" v-model="add.phone" class="input" type="tel" inputmode="tel" autocomplete="off" placeholder="+91 98765 43210" />
      </div>
      <div class="col-span-2"><PasswordInput v-model="add.password" label="Password" autocomplete="new-password" required /></div>
      <div class="col-span-2 sm:col-span-1">
        <label class="label" for="add-balance">Opening balance</label>
        <input id="add-balance" v-model="add.balance" class="input amount" inputmode="decimal" placeholder="0" />
      </div>
      <div>
        <label class="label" for="add-credit">Credit limit</label>
        <input id="add-credit" v-model="add.creditLimit" class="input amount" inputmode="decimal" required />
      </div>
      <div>
        <label class="label" for="add-spend">Max stake</label>
        <input id="add-spend" v-model="add.spendLimit" class="input amount" inputmode="decimal" required />
      </div>
      <p v-if="formError" class="field-error col-span-2" role="alert">{{ formError }}</p>
    </form>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="close">Cancel</button>
        <button type="submit" form="add-form" class="btn-primary flex-1" :disabled="busy">{{ busy ? 'Adding…' : 'Add player' }}</button>
      </div>
    </template>
  </Modal>

  <!-- Edit -->
  <Modal v-if="dialog === 'edit' && target" title="Edit player" :subtitle="target.username" size="md" @close="close">
    <form id="edit-form" class="grid grid-cols-2 gap-3" @submit.prevent="submitEdit">
      <div class="col-span-2">
        <label class="label" for="edit-username">Username</label>
        <input id="edit-username" v-model="edit.username" class="input" required autocapitalize="none" />
      </div>
      <div class="col-span-2">
        <label class="label" for="edit-phone">Phone <span class="normal-case font-normal">(optional)</span></label>
        <input id="edit-phone" v-model="edit.phone" class="input" type="tel" inputmode="tel" />
      </div>
      <div class="col-span-2">
        <PasswordInput v-model="edit.password" label="New password (leave empty to keep)" autocomplete="new-password" />
        <p class="text-xs text-text-muted mt-1">Changing the password signs the player out everywhere.</p>
      </div>
      <div>
        <label class="label" for="edit-credit">Credit limit</label>
        <input id="edit-credit" v-model="edit.creditLimit" class="input amount" inputmode="decimal" required />
      </div>
      <div>
        <label class="label" for="edit-spend">Max stake</label>
        <input id="edit-spend" v-model="edit.spendLimit" class="input amount" inputmode="decimal" required />
      </div>
      <p v-if="formError" class="field-error col-span-2" role="alert">{{ formError }}</p>
    </form>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="close">Cancel</button>
        <button type="submit" form="edit-form" class="btn-primary flex-1" :disabled="busy">{{ busy ? 'Saving…' : 'Save changes' }}</button>
      </div>
    </template>
  </Modal>

  <!-- Balance -->
  <Modal v-if="dialog === 'balance' && target" title="Adjust balance" :subtitle="`${target.username} · now ${formatAmount(target.balance)}`" size="sm" @close="close">
    <form id="balance-form" class="space-y-4" @submit.prevent="submitBalance">
      <div>
        <label class="label" for="adj-amount">Amount <span class="normal-case font-normal">(+ credit, - debit)</span></label>
        <input id="adj-amount" v-model="adjust.amount" class="input amount" inputmode="decimal" placeholder="e.g. 100 or -50" required />
      </div>
      <div>
        <label class="label" for="adj-reason">Reason</label>
        <input id="adj-reason" v-model="adjust.description" class="input" maxlength="200" placeholder="e.g. Cash deposit" required />
      </div>
      <div>
        <span class="label">Payment proof <span class="normal-case font-normal">(optional)</span></span>
        <label class="btn-ghost btn-sm w-full cursor-pointer">
          <span class="truncate">{{ proof ? proof.name : 'Attach screenshot' }}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" @change="proof = ($event.target as HTMLInputElement).files?.[0] ?? null" />
        </label>
      </div>
      <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
    </form>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="close">Cancel</button>
        <button type="submit" form="balance-form" class="btn-primary flex-1" :disabled="busy">{{ busy ? 'Applying…' : 'Apply' }}</button>
      </div>
    </template>
  </Modal>

  <!-- Delete -->
  <Modal v-if="dialog === 'delete' && target" title="Delete player" size="sm" @close="close">
    <div class="space-y-3">
      <p class="text-sm text-text-muted">
        Move <span class="font-medium text-text-primary">{{ target.username }}</span> to the deleted players list?
        They will no longer appear to other players or be able to join or start games, but can still sign in to view their game and account history.
        Deletion is blocked while they have a game active or awaiting completion. Their financial and game history is preserved.
      </p>
      <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
    </div>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="close">Cancel</button>
        <button type="button" class="btn-danger flex-1" :disabled="busy" @click="submitDelete">{{ busy ? 'Deleting…' : 'Delete' }}</button>
      </div>
    </template>
  </Modal>

  <Modal v-if="dialog === 'purge' && target" title="Permanently clean up player" :subtitle="target.username" size="sm" @close="close">
    <div class="space-y-3">
      <p class="text-sm text-text-muted">
        Permanently remove this account's phone number, login credentials, sessions, and idempotency data?
        This cannot be undone. Historical games, ledger entries, deposits, and the username retained in those records will remain.
      </p>
      <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
    </div>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="close">Cancel</button>
        <button type="button" class="btn-danger flex-1" :disabled="busy" @click="permanentlyCleanPlayer">
          {{ busy ? 'Cleaning up…' : 'Permanently clean up' }}
        </button>
      </div>
    </template>
  </Modal>

  <!-- Ledger -->
  <Modal v-if="dialog === 'ledger' && target" title="Ledger" :subtitle="target.username" size="md" @close="close">
    <StateBlock :loading="ledgerLoading" :error="ledgerError" :empty="!ledger.length" empty-text="No transactions." :rows="4" @retry="loadLedger(target)">
      <ul class="divide-y divide-border">
        <li v-for="tx in ledger" :key="tx.id" class="py-3 first:pt-0 last:pb-0">
          <div class="flex items-center justify-between gap-3 min-w-0">
            <div class="flex items-center gap-2 min-w-0">
              <span :class="txBadgeClass(tx.type)" class="flex-shrink-0">{{ txTypeLabel(tx.type) }}</span>
              <div class="min-w-0">
                <div class="text-xs font-medium truncate">{{ tx.description || txTypeLabel(tx.type) }}</div>
                <div class="text-xs text-text-muted">{{ formatDateTime(tx.createdAt) }}</div>
              </div>
            </div>
            <div class="text-right flex-shrink-0">
              <div class="text-xs amount font-semibold" :class="amountTone(tx.amount)">{{ formatAmount(tx.amount, { signed: true }) }}</div>
              <div class="text-[11px] amount text-text-muted">{{ formatAmount(tx.balanceAfter) }}</div>
            </div>
          </div>
          <button v-if="tx.screenshotFilename" type="button" class="block w-full mt-2" @click="lightbox = fileUrl(tx.screenshotFilename!)">
            <img :src="fileUrl(tx.screenshotFilename)" alt="Payment proof" loading="lazy" class="max-h-20 w-full object-contain rounded border border-border bg-bg cursor-zoom-in" />
          </button>
        </li>
      </ul>
    </StateBlock>
    <template #footer>
      <div class="flex justify-end"><StatementButton :player-id="target.id" :player-name="target.username" /></div>
    </template>
  </Modal>
</template>
