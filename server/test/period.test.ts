import { describe, expect, it } from 'vitest'
import { bucketKey, localMidnight, previousPeriod, resolvePeriod, spine, zoneOffsetMs } from '../src/lib/period'

const IST = 'Asia/Kolkata'
const iso = (d: Date) => d.toISOString()
// 2026-10-11 12:00 IST
const NOW = new Date('2026-10-11T06:30:00Z')

describe('local midnight', () => {
  it('IST midnight is 18:30 UTC of the previous day', () => {
    expect(iso(localMidnight({ y: 2026, m: 9, d: 1 }, IST))).toBe('2026-08-31T18:30:00.000Z')
    expect(zoneOffsetMs(IST, NOW)).toBe(5.5 * 3_600_000)
  })

  it('handles a zone with DST on the day the clocks change', () => {
    // New York 2026-03-08: clocks jump at 02:00, midnight is still EST (UTC-5).
    expect(iso(localMidnight({ y: 2026, m: 3, d: 8 }, 'America/New_York'))).toBe('2026-03-08T05:00:00.000Z')
    expect(iso(localMidnight({ y: 2026, m: 3, d: 9 }, 'America/New_York'))).toBe('2026-03-09T04:00:00.000Z')
  })
})

describe('resolvePeriod golden table (now = 2026-10-11 12:00 IST)', () => {
  const golden: Array<[string, Record<string, string>, { key: string; from: string; to: string; kind: string; days: number; granularity: string }]> = [
    ['default is the current month', {}, { key: '2026-10', from: '2026-09-30T18:30:00.000Z', to: '2026-10-31T18:30:00.000Z', kind: 'month', days: 31, granularity: 'day' }],
    ['alias this-month equals the default', { period: 'this-month' }, { key: '2026-10', from: '2026-09-30T18:30:00.000Z', to: '2026-10-31T18:30:00.000Z', kind: 'month', days: 31, granularity: 'day' }],
    ['alias last-month', { period: 'last-month' }, { key: '2026-09', from: '2026-08-31T18:30:00.000Z', to: '2026-09-30T18:30:00.000Z', kind: 'month', days: 30, granularity: 'day' }],
    ['alias this-year', { period: 'this-year' }, { key: '2026', from: '2025-12-31T18:30:00.000Z', to: '2026-12-31T18:30:00.000Z', kind: 'year', days: 365, granularity: 'month' }],
    ['a past month', { period: '2026-09' }, { key: '2026-09', from: '2026-08-31T18:30:00.000Z', to: '2026-09-30T18:30:00.000Z', kind: 'month', days: 30, granularity: 'day' }],
    ['february in a leap year', { period: '2028-02' }, { key: '2028-02', from: '2028-01-31T18:30:00.000Z', to: '2028-02-29T18:30:00.000Z', kind: 'month', days: 29, granularity: 'day' }],
    ['february in a common year', { period: '2026-02' }, { key: '2026-02', from: '2026-01-31T18:30:00.000Z', to: '2026-02-28T18:30:00.000Z', kind: 'month', days: 28, granularity: 'day' }],
    ['december rolls into the next year', { period: '2026-12' }, { key: '2026-12', from: '2026-11-30T18:30:00.000Z', to: '2026-12-31T18:30:00.000Z', kind: 'month', days: 31, granularity: 'day' }],
    ['a whole year', { period: '2026' }, { key: '2026', from: '2025-12-31T18:30:00.000Z', to: '2026-12-31T18:30:00.000Z', kind: 'year', days: 365, granularity: 'month' }],
    ['last 7 days includes today', { period: 'last7' }, { key: 'last7', from: '2026-10-04T18:30:00.000Z', to: '2026-10-11T18:30:00.000Z', kind: 'last7', days: 7, granularity: 'day' }],
    ['last 30 days', { period: 'last30' }, { key: 'last30', from: '2026-09-11T18:30:00.000Z', to: '2026-10-11T18:30:00.000Z', kind: 'last30', days: 30, granularity: 'day' }],
    ['last 90 days uses days up to 92', { period: 'last90' }, { key: 'last90', from: '2026-07-13T18:30:00.000Z', to: '2026-10-11T18:30:00.000Z', kind: 'last90', days: 90, granularity: 'day' }],
    ['custom range is inclusive of the last day', { from: '2026-09-28', to: '2026-10-02' }, { key: '2026-09-28..2026-10-02', from: '2026-09-27T18:30:00.000Z', to: '2026-10-02T18:30:00.000Z', kind: 'custom', days: 5, granularity: 'day' }],
    ['custom range across a year end', { from: '2026-12-30', to: '2027-01-02' }, { key: '2026-12-30..2027-01-02', from: '2026-12-29T18:30:00.000Z', to: '2027-01-02T18:30:00.000Z', kind: 'custom', days: 4, granularity: 'day' }],
    ['a single day', { from: '2028-02-29', to: '2028-02-29' }, { key: '2028-02-29..2028-02-29', from: '2028-02-28T18:30:00.000Z', to: '2028-02-29T18:30:00.000Z', kind: 'custom', days: 1, granularity: 'day' }],
  ]

  it.each(golden)('%s', (_name, query, expected) => {
    const p = resolvePeriod(query, NOW, IST)
    expect({ key: p.key, from: iso(p.from), to: iso(p.to), kind: p.kind, days: p.days, granularity: p.granularity }).toEqual(expected)
  })

  it('"now" at 23:59 and 00:00 IST fall in different days and months', () => {
    const lateOnLastDay = new Date('2026-09-30T18:29:59Z') // 23:59:59 IST on 30 Sep
    const firstMoment = new Date('2026-09-30T18:30:00Z') // 00:00:00 IST on 1 Oct
    expect(resolvePeriod({}, lateOnLastDay, IST).key).toBe('2026-09')
    expect(resolvePeriod({}, firstMoment, IST).key).toBe('2026-10')
  })

  it('all time starts at the first month with data and uses a month spine', () => {
    const p = resolvePeriod({ period: 'all' }, NOW, IST, new Date('2026-07-20T10:00:00Z'))
    expect(p.kind).toBe('all')
    expect(p.granularity).toBe('month')
    expect(spine(p, IST)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10'])
    const empty = resolvePeriod({ period: 'all' }, NOW, IST)
    expect(spine(empty, IST)).toEqual(['2026-10'])
  })

  it.each([
    ['unknown period', { period: 'weekly' }],
    ['month 13', { period: '2026-13' }],
    ['month 00', { period: '2026-00' }],
    ['year out of range', { period: '1999' }],
    ['period together with from/to', { period: '2026-09', from: '2026-09-01', to: '2026-09-02' }],
    ['from without to', { from: '2026-09-01' }],
    ['impossible date', { from: '2026-02-30', to: '2026-03-01' }],
    ['not a date', { from: 'yesterday', to: 'today' }],
    ['inverted range', { from: '2026-09-10', to: '2026-09-01' }],
    ['range over 366 days', { from: '2025-01-01', to: '2026-12-31' }],
    ['injection attempt', { period: "2026-09'; DROP TABLE" }],
  ])('rejects %s with a 400', (_name, query) => {
    try {
      resolvePeriod(query, NOW, IST)
      throw new Error('expected a 400')
    } catch (error) {
      expect((error as { status?: number }).status).toBe(400)
    }
  })

  it('accepts exactly 366 days', () => {
    expect(resolvePeriod({ from: '2027-01-01', to: '2027-12-31' }, NOW, IST).days).toBe(365)
    expect(resolvePeriod({ from: '2028-01-01', to: '2028-12-31' }, NOW, IST).days).toBe(366)
  })
})

describe('previous period and spine', () => {
  it('a month compares to the previous month, a year to the previous year, a window to the window before it', () => {
    expect(previousPeriod(resolvePeriod({ period: '2026-01' }, NOW, IST), IST)!.key).toBe('2025-12')
    expect(previousPeriod(resolvePeriod({ period: '2026' }, NOW, IST), IST)!.key).toBe('2025')
    const prev = previousPeriod(resolvePeriod({ period: 'last7' }, NOW, IST), IST)!
    expect(prev.key).toBe('2026-09-28..2026-10-04')
    expect(prev.days).toBe(7)
    expect(previousPeriod(resolvePeriod({ period: 'all' }, NOW, IST), IST)).toBeNull()
  })

  it('the day spine has one entry per local day, including empty ones and the leap day', () => {
    const feb = resolvePeriod({ period: '2028-02' }, NOW, IST)
    const days = spine(feb, IST)
    expect(days).toHaveLength(29)
    expect(days[0]).toBe('2028-02-01')
    expect(days[28]).toBe('2028-02-29')
  })

  it('buckets an instant by local day: 18:30 UTC is already the next IST day', () => {
    const p = resolvePeriod({ period: '2026-09' }, NOW, IST)
    expect(bucketKey(new Date('2026-09-14T18:29:59Z'), p, IST)).toBe('2026-09-14')
    expect(bucketKey(new Date('2026-09-14T18:30:00Z'), p, IST)).toBe('2026-09-15')
    const year = resolvePeriod({ period: '2026' }, NOW, IST)
    expect(bucketKey(new Date('2026-09-30T18:30:00Z'), year, IST)).toBe('2026-10')
  })

  it('the spine of a year is twelve months', () => {
    expect(spine(resolvePeriod({ period: '2026' }, NOW, IST), IST)).toHaveLength(12)
  })
})
