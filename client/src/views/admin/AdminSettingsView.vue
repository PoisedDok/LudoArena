<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import api from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { expectShape } from '../../lib/contract'
import StateBlock from '../../components/StateBlock.vue'

type GameType = 'ONE_V_ONE' | 'TWO_V_TWO' | 'FOUR_PLAYER'
interface CommissionSetting {
  gameType: GameType
  tierThresholdCents: number | null
  highRateBps: number | null
  lowRateBps: number | null
  fourPlayerSecondBps: number | null
  updatedAt: string
  updatedBy: { id: string; username: string } | null
}
interface Draft {
  tierThreshold: string
  highRate: string
  lowRate: string
  secondPlaceRate: string
}

const settings = ref<CommissionSetting[] | null>(null)
const drafts = reactive<Record<GameType, Draft>>({
  ONE_V_ONE: { tierThreshold: '', highRate: '', lowRate: '', secondPlaceRate: '' },
  TWO_V_TWO: { tierThreshold: '', highRate: '', lowRate: '', secondPlaceRate: '' },
  FOUR_PLAYER: { tierThreshold: '', highRate: '', lowRate: '', secondPlaceRate: '' },
})
const loading = ref(true)
const loadError = ref('')
const formErrors = reactive<Record<GameType, string>>({
  ONE_V_ONE: '',
  TWO_V_TWO: '',
  FOUR_PLAYER: '',
})
const savedMessages = reactive<Record<GameType, string>>({
  ONE_V_ONE: '',
  TWO_V_TWO: '',
  FOUR_PLAYER: '',
})
const saving = reactive<Record<GameType, boolean>>({
  ONE_V_ONE: false,
  TWO_V_TWO: false,
  FOUR_PLAYER: false,
})
const resetConfirmation = ref('')
const resetting = ref(false)
const resetError = ref('')
const resetMessage = ref('')

function rateInput(bps: number | null): string {
  if (bps === null) return ''
  return (bps / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function centsInput(cents: number | null): string {
  if (cents === null) return ''
  const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
  return amount.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function fillDraft(setting: CommissionSetting) {
  drafts[setting.gameType] = {
    tierThreshold: centsInput(setting.tierThresholdCents),
    highRate: rateInput(setting.highRateBps),
    lowRate: rateInput(setting.lowRateBps),
    secondPlaceRate: rateInput(setting.fourPlayerSecondBps),
  }
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await api.get('/admin/settings/commission')
    const response = expectShape<{ settings: CommissionSetting[] }>('admin.commissionSettings.list', data.data)
    settings.value = response.settings
    response.settings.forEach(fillDraft)
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load commission settings.')
  } finally {
    loading.value = false
  }
}

function parseCents(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0)
  return cents <= 100_000_000 ? cents : null
}

function parseBasisPoints(value: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0)
  return bps <= 10_000 ? bps : null
}

function gameLabel(gameType: GameType): string {
  if (gameType === 'ONE_V_ONE') return 'Solo (1v1)'
  if (gameType === 'TWO_V_TWO') return 'Teams (2v2)'
  return 'Four-player (4-player)'
}

function updatedLabel(setting: CommissionSetting): string {
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(setting.updatedAt))
  return setting.updatedBy ? `Last saved by ${setting.updatedBy.username} · ${date}` : `Last updated · ${date}`
}

async function save(gameType: GameType) {
  if (saving[gameType]) return
  const draft = drafts[gameType]
  const tierThresholdCents = gameType === 'FOUR_PLAYER' ? null : parseCents(draft.tierThreshold)
  const highRateBps = gameType === 'FOUR_PLAYER' ? null : parseBasisPoints(draft.highRate)
  const lowRateBps = gameType === 'FOUR_PLAYER' ? null : parseBasisPoints(draft.lowRate)
  const fourPlayerSecondBps = gameType === 'FOUR_PLAYER' ? parseBasisPoints(draft.secondPlaceRate) : null

  if ((gameType !== 'FOUR_PLAYER' && (tierThresholdCents === null || highRateBps === null || lowRateBps === null))
    || (gameType === 'FOUR_PLAYER' && fourPlayerSecondBps === null)) {
    formErrors[gameType] = gameType === 'FOUR_PLAYER'
      ? 'Enter a commission rate from 0% to 100%, with at most 2 decimal places.'
      : 'Enter a valid stake threshold and both rates from 0% to 100%, with at most 2 decimal places.'
    savedMessages[gameType] = ''
    return
  }

  saving[gameType] = true
  formErrors[gameType] = ''
  savedMessages[gameType] = ''
  try {
    const payload = gameType === 'FOUR_PLAYER'
      ? { fourPlayerSecondBps }
      : { tierThresholdCents, highRateBps, lowRateBps }
    const { data } = await api.put(`/admin/settings/commission/${gameType}`, payload)
    const response = expectShape<{ setting: CommissionSetting }>('admin.commissionSettings.update', data.data)
    const index = settings.value?.findIndex((setting) => setting.gameType === gameType) ?? -1
    if (index < 0 || !settings.value) throw new Error('The saved commission setting is missing from the loaded settings.')
    settings.value[index] = response.setting
    fillDraft(response.setting)
    savedMessages[gameType] = 'Commission settings saved. They apply to newly created games only.'
  } catch (error) {
    formErrors[gameType] = errorMessage(error, 'Could not save commission settings.')
  } finally {
    saving[gameType] = false
  }
}

async function resetAdminData() {
  if (resetting.value || resetConfirmation.value !== 'RESET') return
  resetting.value = true
  resetError.value = ''
  resetMessage.value = ''
  try {
    const { data } = await api.post('/admin/settings/reset', { confirmation: resetConfirmation.value })
    const response = expectShape<{ ok: boolean }>('admin.reset', data.data)
    if (!response.ok) throw new Error('The server did not confirm the admin data reset.')
    resetConfirmation.value = ''
    resetMessage.value = 'Admin data reset. Accounts and credentials were preserved.'
    await load()
  } catch (error) {
    resetError.value = errorMessage(error, 'Could not reset admin data.')
  } finally {
    resetting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-wide">
    <header>
      <h1 class="page-title">Settings</h1>
      <p class="page-sub">Configure commission rules independently for each game type.</p>
    </header>

    <div class="card border-accent/20 bg-accent/5 text-sm" role="note">
      Changes apply to games created after the settings are saved. Games already created keep their original commission rules.
    </div>

    <StateBlock :loading="loading && !settings" :error="loadError" :rows="3" @retry="load">
      <div v-if="settings" class="grid gap-4 lg:grid-cols-2">
        <section v-for="setting in settings" :key="setting.gameType" class="card space-y-4" :aria-labelledby="`heading-${setting.gameType}`">
          <div>
            <h2 :id="`heading-${setting.gameType}`" class="page-title">{{ gameLabel(setting.gameType) }}</h2>
            <p class="page-sub">
              <template v-if="setting.gameType === 'ONE_V_ONE'">Commission is charged to the winner.</template>
              <template v-else-if="setting.gameType === 'TWO_V_TWO'">Commission is charged to each winning teammate.</template>
              <template v-else>Commission is charged to second place only. Other placements are unchanged.</template>
            </p>
          </div>

          <form :id="`form-${setting.gameType}`" class="space-y-4" @submit.prevent="save(setting.gameType)">
            <template v-if="setting.gameType !== 'FOUR_PLAYER'">
              <div>
                <label class="label" :for="`threshold-${setting.gameType}`">Stake threshold</label>
                <div class="relative">
                  <span class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true">₹</span>
                  <input
                    :id="`threshold-${setting.gameType}`"
                    v-model="drafts[setting.gameType].tierThreshold"
                    class="input amount pl-8"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    required
                    :aria-describedby="`threshold-help-${setting.gameType}`"
                  />
                </div>
                <p :id="`threshold-help-${setting.gameType}`" class="text-xs text-text-muted mt-1">The first rate applies at or below the threshold; the second rate applies above it.</p>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div>
                  <label class="label" :for="`high-${setting.gameType}`">Rate at or below threshold</label>
                  <div class="relative">
                    <input :id="`high-${setting.gameType}`" v-model="drafts[setting.gameType].highRate" class="input amount pr-8" type="text" inputmode="decimal" autocomplete="off" required />
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true">%</span>
                  </div>
                </div>
                <div>
                  <label class="label" :for="`low-${setting.gameType}`">Rate above threshold</label>
                  <div class="relative">
                    <input :id="`low-${setting.gameType}`" v-model="drafts[setting.gameType].lowRate" class="input amount pr-8" type="text" inputmode="decimal" autocomplete="off" required />
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true">%</span>
                  </div>
                </div>
              </div>
            </template>
            <div v-else>
              <label class="label" :for="`second-${setting.gameType}`">Second-place commission rate</label>
              <div class="relative">
                <input :id="`second-${setting.gameType}`" v-model="drafts[setting.gameType].secondPlaceRate" class="input amount pr-8" type="text" inputmode="decimal" autocomplete="off" required />
                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true">%</span>
              </div>
            </div>

            <p v-if="formErrors[setting.gameType]" class="field-error" role="alert">{{ formErrors[setting.gameType] }}</p>
            <p v-if="savedMessages[setting.gameType]" class="text-sm text-active" role="status">{{ savedMessages[setting.gameType] }}</p>
            <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <p class="text-xs text-text-muted">{{ updatedLabel(setting) }}</p>
              <button type="submit" class="btn-primary" :disabled="saving[setting.gameType]">
                {{ saving[setting.gameType] ? 'Saving…' : 'Save changes' }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </StateBlock>

    <section class="card mt-8 space-y-4 border-danger/40" aria-labelledby="reset-heading">
      <div>
        <h2 id="reset-heading" class="text-lg font-semibold text-danger">Reset admin data</h2>
        <p class="mt-1 text-sm text-text-muted">
          This permanently deletes all games, pings, deposits, transactions, screenshots, and related operational history.
          Every player balance will be set to ₹0, limits restored to defaults, and player activity disabled.
        </p>
        <p class="mt-2 text-sm text-text-muted">
          Player and admin accounts, IDs, usernames, passwords, and phone numbers are preserved. Archived and permanently cleaned-up
          account statuses remain unchanged. Deleted operational and ledger history cannot be recovered.
        </p>
      </div>
      <form class="space-y-3" @submit.prevent="resetAdminData">
        <div>
          <label class="label" for="reset-confirmation">Type RESET to confirm</label>
          <input
            id="reset-confirmation"
            v-model="resetConfirmation"
            class="input"
            type="text"
            autocomplete="off"
            :disabled="resetting"
            aria-describedby="reset-help"
          />
          <p id="reset-help" class="mt-1 text-xs text-text-muted">This action cannot be undone.</p>
        </div>
        <p v-if="resetError" class="field-error" role="alert">{{ resetError }}</p>
        <p v-if="resetMessage" class="text-sm text-active" role="status">{{ resetMessage }}</p>
        <button type="submit" class="btn-danger" :disabled="resetConfirmation !== 'RESET' || resetting">
          {{ resetting ? 'Resetting…' : 'Reset all admin data' }}
        </button>
      </form>
    </section>
  </div>
</template>
