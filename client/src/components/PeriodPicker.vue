<script setup lang="ts">
import { computed, ref } from 'vue'
import Modal from './Modal.vue'
import { PRESETS, browserMonthKey, isMonthKey, monthList, monthLabel, shiftMonth, validateRange, type PeriodParams } from '../lib/period'

/**
 * Period control: previous/next month arrows, a label that opens the full list (presets, the last twelve
 * months, a custom range). It only emits; the page decides where the value lives (the URL).
 */
const props = defineProps<{
  /** The period as the server resolved it (key + kind), or null before the first answer. */
  current: { key: string; kind: string } | null
  /** The server's current month, YYYY-MM, once known. */
  currentMonth?: string
  params: PeriodParams
}>()

const emit = defineEmits<{ select: [period: string]; range: [from: string, to: string] }>()

const open = ref(false)
const from = ref('')
const to = ref('')
const rangeError = ref('')

const nowMonth = computed(() => props.currentMonth ?? browserMonthKey())
const monthKey = computed(() => (props.current && props.current.kind === 'month' ? props.current.key : null))

const label = computed(() => {
  if (!props.current) return 'Choose period'
  const { key, kind } = props.current
  if (kind === 'month') return monthLabel(key)
  if (kind === 'year') return key
  if (kind === 'all') return 'All time'
  if (kind === 'custom') return key.replace('..', ' to ')
  return PRESETS.find((p) => p.value === key)?.label ?? key
})

const canNext = computed(() => monthKey.value !== null && monthKey.value < nowMonth.value)

function step(delta: number) {
  const base = monthKey.value ?? nowMonth.value
  const next = shiftMonth(base, delta)
  if (isMonthKey(next) && next <= nowMonth.value) emit('select', next)
}

function choose(value: string) {
  open.value = false
  emit('select', value)
}

function applyRange() {
  const problem = validateRange(from.value, to.value)
  rangeError.value = problem ?? ''
  if (problem) return
  open.value = false
  emit('range', from.value, to.value)
}

function isActive(value: string): boolean {
  if (!props.current) return false
  return props.params.period === value || props.current.key === value
}
</script>

<template>
  <div class="flex items-stretch gap-1 min-w-0 max-w-full">
    <button type="button" class="icon-btn border border-border" :disabled="monthKey === null" aria-label="Previous month" @click="step(-1)">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
    </button>
    <button type="button" class="btn-ghost flex-1 min-w-0 px-3 py-2 text-sm" aria-haspopup="dialog" @click="open = true">
      <span class="truncate">{{ label }}</span>
      <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
    </button>
    <button type="button" class="icon-btn border border-border" :disabled="!canNext" aria-label="Next month" @click="step(1)">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
    </button>
  </div>

  <Modal v-if="open" title="Period" size="sm" @close="open = false">
    <div class="space-y-5">
      <div>
        <div class="label">Quick ranges</div>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="p in PRESETS" :key="p.value" type="button"
            class="btn-ghost text-sm" :class="isActive(p.value) ? 'border-accent text-accent' : ''"
            @click="choose(p.value)">{{ p.label }}</button>
        </div>
      </div>

      <div>
        <div class="label">Month</div>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="m in monthList(nowMonth)" :key="m.value" type="button"
            class="btn-ghost text-sm" :class="props.current?.key === m.value ? 'border-accent text-accent' : ''"
            @click="choose(m.value)">{{ m.label }}</button>
        </div>
      </div>

      <form class="space-y-3" @submit.prevent="applyRange">
        <div class="label">Custom range</div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="sr-only" for="period-from">From</label>
            <input id="period-from" v-model="from" type="date" class="input" required />
          </div>
          <div>
            <label class="sr-only" for="period-to">To</label>
            <input id="period-to" v-model="to" type="date" class="input" required />
          </div>
        </div>
        <p v-if="rangeError" class="field-error" role="alert">{{ rangeError }}</p>
        <button type="submit" class="btn-primary w-full">Apply range</button>
      </form>
    </div>
  </Modal>
</template>
