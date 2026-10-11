import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { currentFromParams, monthList, shiftMonth, usePeriodQuery, validateRange } from './period'

describe('month helpers', () => {
  it('shifts across year boundaries', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-10', -10)).toBe('2025-12')
    expect(shiftMonth('all', 1)).toBe('all')
  })

  it('lists the last twelve months, newest first', () => {
    const list = monthList('2026-02')
    expect(list).toHaveLength(12)
    expect(list[0]!.value).toBe('2026-02')
    expect(list[11]!.value).toBe('2025-03')
  })
})

describe('validateRange', () => {
  it('accepts a normal range and a single day', () => {
    expect(validateRange('2026-09-01', '2026-09-30')).toBeNull()
    expect(validateRange('2026-09-01', '2026-09-01')).toBeNull()
  })
  it('refuses missing, inverted and too long ranges', () => {
    expect(validateRange('', '2026-09-01')).toMatch(/both/i)
    expect(validateRange('2026-09-10', '2026-09-01')).toMatch(/before/)
    expect(validateRange('2025-01-01', '2026-12-31')).toMatch(/at most/)
    expect(validateRange('2028-01-01', '2028-12-31')).toBeNull()
  })
})

describe('currentFromParams', () => {
  it('describes the URL parameters for the picker', () => {
    expect(currentFromParams({})).toBeNull()
    expect(currentFromParams({ period: '2026-09' })).toEqual({ key: '2026-09', kind: 'month' })
    expect(currentFromParams({ period: 'all' })).toEqual({ key: 'all', kind: 'all' })
    expect(currentFromParams({ period: '2026' })).toEqual({ key: '2026', kind: 'year' })
    expect(currentFromParams({ from: '2026-09-01', to: '2026-09-15' })).toEqual({ key: '2026-09-01..2026-09-15', kind: 'custom' })
  })
})

describe('usePeriodQuery keeps the period in the URL', () => {
  async function setup(initial = '/games?status=DISPUTED&page=3') {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/games', component: { render: () => null } }] })
    await router.push(initial)
    await router.isReady()
    let api!: ReturnType<typeof usePeriodQuery>
    mount(defineComponent({ setup() { api = usePeriodQuery(); return () => h('div') } }), { global: { plugins: [router] } })
    return { router, api }
  }

  it('writes a period, keeps other parameters and resets paging', async () => {
    const { router, api } = await setup()
    await api.setPeriod('2026-09')
    await nextTick()
    expect(router.currentRoute.value.query).toEqual({ status: 'DISPUTED', period: '2026-09' })
    expect(api.params.value).toEqual({ period: '2026-09' })
    expect(api.isSet.value).toBe(true)
  })

  it('a custom range replaces a period and clear() removes both', async () => {
    const { router, api } = await setup('/games?period=last30')
    await api.setRange('2026-09-01', '2026-09-15')
    expect(router.currentRoute.value.query).toEqual({ from: '2026-09-01', to: '2026-09-15' })
    await api.clear()
    expect(router.currentRoute.value.query).toEqual({})
    expect(api.isSet.value).toBe(false)
  })

  it('reads the period from a reloaded URL', async () => {
    const { api } = await setup('/games?period=2026-07')
    expect(api.params.value).toEqual({ period: '2026-07' })
  })
})
