import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { expectShape, ContractError } from '../lib/contract'
import AdminDashboardView from './admin/AdminDashboardView.vue'
import AdminSettingsView from './admin/AdminSettingsView.vue'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() }))
vi.mock('../lib/api', () => ({ default: apiMock, setUnauthorizedHandler: vi.fn(), idempotencyKey: () => 'k', withKey: () => ({}) }))
vi.mock('../lib/socket', () => ({
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
  bindOnce: vi.fn(),
  onResync: vi.fn(() => () => undefined),
  getSocket: vi.fn(() => null),
}))

const totals = { games: 3, volume: 600, commission: 15, depositsApproved: 2, depositsAmount: 300, playersInPeriod: 4, completedGames: 3, disputedGames: 0 }

function statsFixture() {
  return {
    period: { key: '2026-10', kind: 'month', from: '2026-09-30T18:30:00.000Z', to: '2026-10-31T18:30:00.000Z', granularity: 'day', days: 31, timezone: 'Asia/Kolkata' },
    totals,
    previous: { period: { key: '2026-09' }, totals: { ...totals, games: 2 } },
    chart: [{ date: '2026-10-01', games: 1, volume: 200, commission: 5 }, { date: '2026-10-02', games: 0, volume: 0, commission: 0 }],
    topPlayers: [{ userId: 'u1', username: 'asha', wins: 2, net: 380 }],
    live: { activePlayers: 5, disputedGames: 1, pendingDeposits: 2, totalPlayerBalance: 1234.5 },
    now: { month: '2026-10', date: '2026-10-11' },
  }
}

function settingsFixture() {
  return [
    { gameType: 'FOUR_PLAYER', tierThresholdCents: null, highRateBps: null, lowRateBps: null, fourPlayerSecondBps: 1_000, updatedAt: '2026-10-11T10:00:00.000Z', updatedBy: null },
    { gameType: 'ONE_V_ONE', tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300, fourPlayerSecondBps: null, updatedAt: '2026-10-11T10:00:00.000Z', updatedBy: null },
    { gameType: 'TWO_V_TWO', tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300, fourPlayerSecondBps: null, updatedAt: '2026-10-11T10:00:00.000Z', updatedBy: null },
  ]
}

async function mountSettings() {
  const wrapper = mount(AdminSettingsView, { global: { stubs: { teleport: true } } })
  await flushPromises()
  return wrapper
}

async function mountDashboard() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin', component: AdminDashboardView }, { path: '/admin/games', component: { render: () => null } }, { path: '/admin/deposits', component: { render: () => null } }] })
  await router.push('/admin')
  const wrapper = mount(AdminDashboardView, { global: { plugins: [router], stubs: { teleport: true } } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  Object.values(apiMock).forEach((fn) => fn.mockReset())
})

describe('contract guard', () => {
  it('accepts the documented shape and names every problem of a wrong one', () => {
    expect(() => expectShape('admin.stats', statsFixture())).not.toThrow()
    const { live, ...flat } = statsFixture()
    const wrong = { ...flat, ...live }
    try {
      expectShape('admin.stats', wrong)
      throw new Error('expected a ContractError')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError)
      expect((error as ContractError).problems.join(' ')).toContain('$.live: missing')
    }
  })
})

describe('AdminSettingsView', () => {
  it('shows independent settings for each game type and saves only the selected type', async () => {
    const settings = settingsFixture()
    apiMock.get.mockResolvedValue({ data: { data: { settings } } })
    apiMock.put.mockImplementation((_url: string, payload: Record<string, number>) =>
      Promise.resolve({ data: { data: { setting: { ...settings[1], highRateBps: payload.highRateBps, updatedBy: { id: 'admin', username: 'admin' } } } } }),
    )

    const wrapper = await mountSettings()
    expect(wrapper.text()).toContain('Solo (1v1)')
    expect(wrapper.text()).toContain('Teams (2v2)')
    expect(wrapper.text()).toContain('Four-player (4-player)')
    expect(wrapper.text()).toContain('games created after the settings are saved')

    const solo = wrapper.get('#heading-ONE_V_ONE').element.closest('section')
    if (!solo) throw new Error('Solo settings section was not rendered')
    await wrapper.get('#high-ONE_V_ONE').setValue('6.25')
    await wrapper.get('#form-ONE_V_ONE').trigger('submit')
    await flushPromises()

    expect(apiMock.put).toHaveBeenCalledWith('/admin/settings/commission/ONE_V_ONE', {
      tierThresholdCents: 50_000, highRateBps: 625, lowRateBps: 300,
    })
    expect(wrapper.text()).toContain('Commission settings saved.')
    expect(apiMock.put).toHaveBeenCalledTimes(1)
  })

  it('shows a retryable error instead of displaying defaults when settings fail to load', async () => {
    apiMock.get.mockRejectedValue(new Error('offline'))
    const wrapper = await mountSettings()
    expect(wrapper.get('[role=alert]').text()).toContain('Could not load commission settings.')
    expect(wrapper.text()).not.toContain('Solo (1v1)')
    expect(wrapper.text()).toContain('Try again')
  })
})

describe('AdminDashboardView', () => {
  it('draws the figures, the live cards and the chart table from a correctly shaped answer', async () => {
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(url === '/admin/stats' ? { data: { data: statsFixture() } } : { data: { data: { games: [], total: 0 } } }),
    )
    const wrapper = await mountDashboard()
    expect(wrapper.find('[role=alert]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Pending deposits')
    expect(wrapper.text()).toContain('Disputed now')
    expect(wrapper.text()).toContain('asha')
    expect(wrapper.findAll('table tbody tr').length).toBeGreaterThan(0)
  })

  it('shows the error state, not a blank page, when the answer has the old flat shape', async () => {
    const { live, ...rest } = statsFixture()
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(url === '/admin/stats' ? { data: { data: { ...rest, ...live } } } : { data: { data: { games: [], total: 0 } } }),
    )
    const wrapper = await mountDashboard()
    const alert = wrapper.get('[role=alert]')
    expect(alert.text()).toMatch(/does not understand/)
    expect(alert.text()).toMatch(/Try again/)
  })
})
