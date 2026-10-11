import { badRequest } from './errors'

/**
 * Period model shared by the dashboard, the admin lists and the statement export. A period is a half-open
 * instant range [from, to) whose edges are local midnights in the configured timezone, so a game played at
 * 00:30 on the 1st lands in the new month everywhere. The only date maths in the server lives here.
 */

export type PeriodKind = 'month' | 'year' | 'last7' | 'last30' | 'last90' | 'all' | 'custom'
export type Granularity = 'day' | 'month'

export interface Period {
  /** Canonical, URL-safe identifier: 2026-09, 2026, last30, all, 2026-09-01..2026-09-15 */
  key: string
  kind: PeriodKind
  from: Date
  to: Date
  granularity: Granularity
  /** Local calendar days covered (inclusive). */
  days: number
}

export const MAX_CUSTOM_DAYS = 366
export const MAX_BUCKETS = 400

interface Ymd {
  y: number
  m: number
  d: number
}

const DAY_MS = 86_400_000

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds (positive east). */
export function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The instant of local midnight at the start of y-m-d in `timeZone`. */
export function localMidnight({ y, m, d }: Ymd, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d)
  const first = guess - zoneOffsetMs(timeZone, new Date(guess))
  // Re-evaluate at the candidate instant so a zone that changes offset near midnight is still exact.
  return new Date(guess - zoneOffsetMs(timeZone, new Date(first)))
}

export function localYmd(at: Date, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')
export const ymdKey = ({ y, m, d }: Ymd) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`

function addDays(ymd: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d) + days * DAY_MS)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

function addMonths(y: number, m: number, months: number): { y: number; m: number } {
  const index = y * 12 + (m - 1) + months
  return { y: Math.floor(index / 12), m: (index % 12) + 1 }
}

const daysBetween = (a: Ymd, b: Ymd) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS)

function parseYmd(text: string, field: string): Ymd {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) throw badRequest(`${field} must be a date like 2026-09-15`)
  const ymd = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
  const real = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d))
  if (real.getUTCFullYear() !== ymd.y || real.getUTCMonth() + 1 !== ymd.m || real.getUTCDate() !== ymd.d) {
    throw badRequest(`${field} is not a real calendar date`)
  }
  return ymd
}

function build(kind: PeriodKind, key: string, start: Ymd, endExclusive: Ymd, timeZone: string): Period {
  const days = daysBetween(start, endExclusive)
  return {
    key,
    kind,
    from: localMidnight(start, timeZone),
    to: localMidnight(endExclusive, timeZone),
    granularity: days > 92 ? 'month' : 'day',
    days,
  }
}

export interface PeriodQuery {
  period?: unknown
  from?: unknown
  to?: unknown
}

/**
 * Resolves query parameters to a Period.
 *   period=YYYY-MM | YYYY | last7 | last30 | last90 | all     (default: the current month)
 *   from=YYYY-MM-DD&to=YYYY-MM-DD                             (custom, inclusive, at most 366 days)
 * `earliest` is the first local day with data, used only for `all`.
 */
export function resolvePeriod(query: PeriodQuery, now: Date, timeZone: string, earliest?: Date): Period {
  const today = localYmd(now, timeZone)
  const tomorrow = addDays(today, 1)
  const text = (v: unknown, field: string): string | undefined => {
    if (v === undefined || v === '') return undefined
    if (typeof v !== 'string') throw badRequest(`${field} must be text`)
    return v
  }
  const period = text(query.period, 'period')
  const from = text(query.from, 'from')
  const to = text(query.to, 'to')

  if ((from || to) && period) throw badRequest('Use either period or from/to, not both')
  if (from || to) {
    if (!from || !to) throw badRequest('Both from and to are required for a custom range')
    const start = parseYmd(from, 'from')
    const end = parseYmd(to, 'to')
    const span = daysBetween(start, end)
    if (span < 0) throw badRequest('"to" must not be before "from"')
    if (span + 1 > MAX_CUSTOM_DAYS) throw badRequest(`A custom range may cover at most ${MAX_CUSTOM_DAYS} days`)
    return build('custom', `${ymdKey(start)}..${ymdKey(end)}`, start, addDays(end, 1), timeZone)
  }

  // Aliases let a client name "this month" or "last month" without knowing the server's timezone.
  if (!period || period === 'this-month' || period === 'last-month') {
    const base = period === 'last-month' ? addMonths(today.y, today.m, -1) : { y: today.y, m: today.m }
    const next = addMonths(base.y, base.m, 1)
    return build('month', `${pad(base.y, 4)}-${pad(base.m)}`, { y: base.y, m: base.m, d: 1 }, { y: next.y, m: next.m, d: 1 }, timeZone)
  }
  if (period === 'this-year') {
    return build('year', String(today.y), { y: today.y, m: 1, d: 1 }, { y: today.y + 1, m: 1, d: 1 }, timeZone)
  }
  let match = /^(\d{4})-(\d{2})$/.exec(period)
  if (match) {
    const y = Number(match[1])
    const m = Number(match[2])
    if (m < 1 || m > 12 || y < 2000 || y > 2100) throw badRequest('period must be a real month such as 2026-09')
    const next = addMonths(y, m, 1)
    return build('month', period, { y, m, d: 1 }, { y: next.y, m: next.m, d: 1 }, timeZone)
  }
  match = /^(\d{4})$/.exec(period)
  if (match) {
    const y = Number(match[1])
    if (y < 2000 || y > 2100) throw badRequest('period must be a real year such as 2026')
    return build('year', period, { y, m: 1, d: 1 }, { y: y + 1, m: 1, d: 1 }, timeZone)
  }
  match = /^last(7|30|90)$/.exec(period)
  if (match) {
    const n = Number(match[1])
    return build(`last${n}` as PeriodKind, period, addDays(today, -(n - 1)), tomorrow, timeZone)
  }
  if (period === 'all') {
    const first = earliest ? localYmd(earliest, timeZone) : today
    const start = { y: first.y, m: first.m, d: 1 }
    // Bounded: at most MAX_BUCKETS months are ever drawn.
    const monthsBack = Math.min(MAX_BUCKETS, (today.y - start.y) * 12 + (today.m - start.m) + 1)
    const clamped = addMonths(today.y, today.m, -(monthsBack - 1))
    const p = build('all', 'all', { y: clamped.y, m: clamped.m, d: 1 }, tomorrow, timeZone)
    return { ...p, granularity: 'month' }
  }
  throw badRequest('period must be YYYY-MM, YYYY, this-month, last-month, this-year, last7, last30, last90 or all')
}

/** The current local month and day keys, for clients that build month lists. */
export function nowKeys(now: Date, timeZone: string): { month: string; date: string } {
  const ymd = localYmd(now, timeZone)
  return { month: `${pad(ymd.y, 4)}-${pad(ymd.m)}`, date: ymdKey(ymd) }
}

/** The period of equal length immediately before `p` (months compare to the previous month). */
export function previousPeriod(p: Period, timeZone: string): Period | null {
  if (p.kind === 'all') return null
  const start = localYmd(p.from, timeZone)
  if (p.kind === 'month') {
    const prev = addMonths(start.y, start.m, -1)
    const key = `${pad(prev.y, 4)}-${pad(prev.m)}`
    return build('month', key, { y: prev.y, m: prev.m, d: 1 }, { y: start.y, m: start.m, d: 1 }, timeZone)
  }
  if (p.kind === 'year') {
    return build('year', String(start.y - 1), { y: start.y - 1, m: 1, d: 1 }, { y: start.y, m: 1, d: 1 }, timeZone)
  }
  const prevStart = addDays(start, -p.days)
  return build(p.kind, `${ymdKey(prevStart)}..${ymdKey(addDays(start, -1))}`, prevStart, start, timeZone)
}

/** Every bucket label of the period, so empty days and months are zeros, not gaps. */
export function spine(p: Period, timeZone: string): string[] {
  const start = localYmd(p.from, timeZone)
  const keys: string[] = []
  if (p.granularity === 'month') {
    const end = localYmd(new Date(p.to.getTime() - 1), timeZone)
    let { y, m } = start
    while (y < end.y || (y === end.y && m <= end.m)) {
      keys.push(`${pad(y, 4)}-${pad(m)}`)
      ;({ y, m } = addMonths(y, m, 1))
    }
    return keys
  }
  for (let i = 0; i < p.days; i++) keys.push(ymdKey(addDays(start, i)))
  return keys
}

/** The bucket label of an instant for the period's granularity (same rule as the SQL grouping). */
export function bucketKey(at: Date, p: Period, timeZone: string): string {
  const ymd = localYmd(at, timeZone)
  return p.granularity === 'month' ? `${pad(ymd.y, 4)}-${pad(ymd.m)}` : ymdKey(ymd)
}
