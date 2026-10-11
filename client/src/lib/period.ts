import { computed } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'

/**
 * The period of a list or dashboard lives in the URL (?period=2026-09 or ?from=…&to=…), so any view can
 * be linked and reloaded. The server interprets it in its own timezone; this module only builds and
 * validates the parameters.
 */

export const MAX_CUSTOM_DAYS = 366

export interface PresetOption {
  value: string
  label: string
}

export const PRESETS: PresetOption[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'this-year', label: 'This year' },
  { value: 'all', label: 'All time' },
]

const MONTH = /^(\d{4})-(\d{2})$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

export const isMonthKey = (value: string) => MONTH.test(value)

export function shiftMonth(key: string, delta: number): string {
  const m = MONTH.exec(key)
  if (!m) return key
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

export function monthLabel(key: string): string {
  const m = MONTH.exec(key)
  if (!m) return key
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** The last `count` months ending at `currentKey`, newest first. */
export function monthList(currentKey: string, count = 12): Array<{ value: string; label: string }> {
  return Array.from({ length: count }, (_, i) => {
    const value = shiftMonth(currentKey, -i)
    return { value, label: monthLabel(value) }
  })
}

/** Browser-local month, only used until the server has said what its current month is. */
export function browserMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function validateRange(from: string, to: string): string | null {
  const a = DAY.exec(from)
  const b = DAY.exec(to)
  if (!a || !b) return 'Choose both dates.'
  const start = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]))
  const end = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]))
  if (end < start) return 'The end date is before the start date.'
  if ((end - start) / 86_400_000 + 1 > MAX_CUSTOM_DAYS) return `A range may cover at most ${MAX_CUSTOM_DAYS} days.`
  return null
}

export function describePeriod(period: { key: string; kind: string }): string {
  if (period.kind === 'month') return monthLabel(period.key)
  if (period.kind === 'year') return period.key
  if (period.kind === 'all') return 'All time'
  if (period.kind === 'custom') return period.key.replace('..', ' to ')
  return PRESETS.find((p) => p.value === period.key)?.label ?? period.key
}

export interface PeriodParams {
  period?: string
  from?: string
  to?: string
}

/** Describes the period in the URL for the picker, for lists that do not get it back from the server. */
export function currentFromParams(p: PeriodParams): { key: string; kind: string } | null {
  if (p.from && p.to) return { key: `${p.from}..${p.to}`, kind: 'custom' }
  if (!p.period) return null
  if (isMonthKey(p.period)) return { key: p.period, kind: 'month' }
  if (p.period === 'all') return { key: 'all', kind: 'all' }
  if (/^\d{4}$/.test(p.period)) return { key: p.period, kind: 'year' }
  return { key: p.period, kind: 'preset' }
}

/** Reads and writes the period parameters of the current route, keeping every other query parameter. */
export function usePeriodQuery() {
  const route = useRoute()
  const router = useRouter()

  const params = computed<PeriodParams>(() => {
    const q = route.query
    const out: PeriodParams = {}
    if (typeof q.period === 'string' && q.period) out.period = q.period
    if (typeof q.from === 'string' && typeof q.to === 'string' && q.from && q.to) {
      out.from = q.from
      out.to = q.to
    }
    return out
  })

  const isSet = computed(() => params.value.period !== undefined || params.value.from !== undefined)

  async function write(next: PeriodParams) {
    const query: LocationQueryRaw = { ...route.query }
    delete query.period
    delete query.from
    delete query.to
    delete query.page
    Object.assign(query, next)
    await router.replace({ query })
  }

  return {
    params,
    isSet,
    setPeriod: (value: string) => write({ period: value }),
    setRange: (from: string, to: string) => write({ from, to }),
    clear: () => write({}),
  }
}
