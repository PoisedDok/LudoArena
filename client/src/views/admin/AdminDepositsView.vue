<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useDepositsStore } from '../../stores/deposits'
import { errorMessage } from '../../lib/errors'
import { fileUrl, formatAmount, formatDateTime } from '../../lib/format'
import StateBlock from '../../components/StateBlock.vue'
import Lightbox from '../../components/Lightbox.vue'

const deposits = useDepositsStore()

type Filter = '' | 'PENDING' | 'APPROVED' | 'REJECTED'
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
]
const statusFilter = ref<Filter>('')
const reviewingId = ref<string | null>(null)
const reviewNote = ref('')
const reviewBusy = ref(false)
const reviewError = ref('')
const lightbox = ref<string | null>(null)

const load = () => deposits.fetchAdminDeposits(statusFilter.value || undefined)
onMounted(load)

function choose(value: Filter) {
  statusFilter.value = value
  reviewingId.value = null
  void load()
}

function startReview(id: string) {
  reviewingId.value = id
  reviewNote.value = ''
  reviewError.value = ''
}

async function submitReview(action: 'APPROVED' | 'REJECTED') {
  if (!reviewingId.value || reviewBusy.value) return
  reviewBusy.value = true
  reviewError.value = ''
  try {
    await deposits.reviewDeposit(reviewingId.value, action, reviewNote.value.trim() || undefined)
    reviewingId.value = null
  } catch (e) {
    reviewError.value = errorMessage(e, 'Could not update the deposit.')
    // Another review may have won the race: show the current state.
    void load()
  } finally {
    reviewBusy.value = false
  }
}

const statusClass = (s: string) => (s === 'APPROVED' ? 'tag-credit' : s === 'REJECTED' ? 'tag-debit' : 'tag text-amber-400 bg-amber-400/10')
const list = computed(() => deposits.adminDeposits)
</script>

<template>
  <div class="page">
    <div class="space-y-3">
      <div>
        <h1 class="page-title">Deposit requests</h1>
        <p class="page-sub">Check the payment proof, then approve or reject.</p>
      </div>
      <div class="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1" role="tablist" aria-label="Filter by status">
        <button v-for="f in FILTERS" :key="f.value" type="button" role="tab" :aria-selected="statusFilter === f.value"
          class="btn-ghost btn-sm flex-shrink-0" :class="statusFilter === f.value ? 'border-accent text-accent bg-accent/5' : ''" @click="choose(f.value)">
          {{ f.label }}
        </button>
      </div>
    </div>

    <StateBlock :loading="deposits.adminLoading && !list.length" :error="deposits.adminError" :empty="!list.length" empty-text="No deposit requests." @retry="load">
      <ul class="space-y-3">
        <li v-for="d in list" :key="d.id" class="card space-y-3 min-w-0" :class="d.status === 'PENDING' ? 'border-amber-400/30' : ''">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 space-y-1">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-semibold text-sm truncate">{{ d.user?.username }}</span>
                <span :class="statusClass(d.status)" class="flex-shrink-0">{{ d.status.toLowerCase() }}</span>
              </div>
              <p class="text-xs text-text-muted">{{ formatDateTime(d.createdAt) }}</p>
              <p v-if="d.reviewedAt" class="text-xs text-text-muted">Reviewed {{ formatDateTime(d.reviewedAt) }}</p>
            </div>
            <div class="text-right flex-shrink-0">
              <p class="text-xl font-semibold amount text-active">+{{ formatAmount(d.amount) }}</p>
              <p class="text-xs text-text-muted">Balance {{ formatAmount(d.user?.balance ?? 0) }}</p>
            </div>
          </div>

          <button type="button" class="block w-full" @click="lightbox = fileUrl(d.screenshotFilename)">
            <img :src="fileUrl(d.screenshotFilename)" alt="Payment screenshot" loading="lazy" class="w-full max-h-40 object-contain rounded border border-border bg-bg cursor-zoom-in" />
          </button>

          <p v-if="d.adminNote && reviewingId !== d.id" class="text-xs text-text-muted italic">Note: {{ d.adminNote }}</p>

          <div v-if="d.status === 'PENDING'">
            <button v-if="reviewingId !== d.id" type="button" class="btn-ghost w-full" @click="startReview(d.id)">Review</button>
            <div v-else class="space-y-3 pt-3 border-t border-border">
              <div>
                <label class="label" :for="`note-${d.id}`">Note <span class="normal-case font-normal">(optional)</span></label>
                <input :id="`note-${d.id}`" v-model="reviewNote" class="input" type="text" maxlength="200" placeholder="e.g. Payment confirmed" />
              </div>
              <p v-if="reviewError" class="field-error" role="alert">{{ reviewError }}</p>
              <div class="grid grid-cols-2 gap-2">
                <button type="button" class="btn bg-active/10 border border-active/30 text-active hover:bg-active/20" :disabled="reviewBusy" @click="submitReview('APPROVED')">{{ reviewBusy ? '…' : 'Approve' }}</button>
                <button type="button" class="btn-danger" :disabled="reviewBusy" @click="submitReview('REJECTED')">{{ reviewBusy ? '…' : 'Reject' }}</button>
              </div>
              <button type="button" class="btn-ghost btn-sm w-full" @click="reviewingId = null">Cancel</button>
            </div>
          </div>
        </li>
      </ul>
    </StateBlock>
  </div>

  <Lightbox v-if="lightbox" :src="lightbox" @close="lightbox = null" />
</template>
