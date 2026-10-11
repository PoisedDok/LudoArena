import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import PeriodPicker from './PeriodPicker.vue'
import StatementButton from './StatementButton.vue'
import PasswordInput from './PasswordInput.vue'
import LoginView from '../views/LoginView.vue'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }))
vi.mock('../lib/api', () => ({
  default: apiMock,
  setUnauthorizedHandler: vi.fn(),
  idempotencyKey: () => 'key-1234567890',
  withKey: (key: string) => ({ headers: { 'Idempotency-Key': key } }),
}))
vi.mock('../lib/socket', () => ({
  connectSocket: vi.fn(() => ({ on: vi.fn() })),
  disconnectSocket: vi.fn(),
  bindOnce: vi.fn(),
  onResync: vi.fn(() => () => undefined),
  getSocket: vi.fn(() => null),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  Object.values(apiMock).forEach((fn) => fn.mockReset())
})

describe('PeriodPicker', () => {
  const mountPicker = (props: Record<string, unknown> = {}) =>
    mount(PeriodPicker, {
      props: { current: { key: '2026-09', kind: 'month' }, currentMonth: '2026-10', params: { period: '2026-09' }, ...props },
      global: { stubs: { teleport: true } },
    })

  it('shows the month and steps with the arrows, never past the current month', async () => {
    const wrapper = mountPicker()
    expect(wrapper.text()).toContain('September 2026')
    await wrapper.get('[aria-label="Previous month"]').trigger('click')
    await wrapper.get('[aria-label="Next month"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['2026-08'], ['2026-10']])

    const atNow = mountPicker({ current: { key: '2026-10', kind: 'month' } })
    expect((atNow.get('[aria-label="Next month"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not offer month arrows for a window like the last 30 days', () => {
    const wrapper = mountPicker({ current: { key: 'last30', kind: 'last30' }, params: { period: 'last30' } })
    expect(wrapper.text()).toContain('Last 30 days')
    expect((wrapper.get('[aria-label="Previous month"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the list, emits a preset and validates a custom range before emitting', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[aria-haspopup="dialog"]').trigger('click')
    const preset = wrapper.findAll('button').find((b) => b.text() === 'Last 7 days')!
    await preset.trigger('click')
    expect(wrapper.emitted('select')!.at(-1)).toEqual(['last7'])

    await wrapper.get('[aria-haspopup="dialog"]').trigger('click')
    await wrapper.get('#period-from').setValue('2026-09-10')
    await wrapper.get('#period-to').setValue('2026-09-01')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('before the start date')
    expect(wrapper.emitted('range')).toBeUndefined()
    await wrapper.get('#period-to').setValue('2026-09-20')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('range')![0]).toEqual(['2026-09-10', '2026-09-20'])
  })
})

describe('StatementButton', () => {
  const mountButton = () => mount(StatementButton, { props: { playerId: 'p1', playerName: 'Aarav' }, global: { stubs: { teleport: true } } })

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:statement')
    URL.revokeObjectURL = vi.fn()
  })

  it('asks the API for the chosen period as a blob and saves it with the server file name', async () => {
    apiMock.get.mockResolvedValue({ data: new Blob(['%PDF-1.4']), headers: { 'content-disposition': 'attachment; filename="ludo-statement-Aarav-all.pdf"' } })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountButton()
    await wrapper.get('button').trigger('click')
    await wrapper.findAll('input[type=radio]')[2]!.setValue(true) // All time
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(apiMock.get).toHaveBeenCalledWith('/players/p1/statement.pdf', expect.objectContaining({ params: { period: 'all' }, responseType: 'blob' }))
    expect(click).toHaveBeenCalledOnce()
    expect(wrapper.find('form').exists()).toBe(false)
    click.mockRestore()
  })

  it('shows the sentence the server sent when the export is refused', async () => {
    const body = new Blob([JSON.stringify({ error: 'An export is already running. Wait for it to finish.' })])
    apiMock.get.mockRejectedValue(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 429, data: body } }))
    const wrapper = mountButton()
    await wrapper.get('button').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('An export is already running')
  })

  it('refuses an inverted custom range without calling the server', async () => {
    const wrapper = mountButton()
    await wrapper.get('button').trigger('click')
    await wrapper.findAll('input[type=radio]')[3]!.setValue(true)
    await wrapper.get('#statement-from').setValue('2026-09-10')
    await wrapper.get('#statement-to').setValue('2026-09-01')
    await wrapper.get('form').trigger('submit')
    expect(apiMock.get).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('before the start date')
  })
})

describe('SessionExpiredModal', () => {
  it('appears on a lapsed session and signs in again in place, keeping the page', async () => {
    const { useAuthStore } = await import('../stores/auth')
    const { default: SessionExpiredModal } = await import('./SessionExpiredModal.vue')
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
    const auth = useAuthStore()
    auth.user = { id: 'u1', username: 'asha', phone: null, role: 'PLAYER', balance: 0, isActive: false, creditLimit: 500, spendLimit: 1000, deletedAt: null }
    const wrapper = mount(SessionExpiredModal, { global: { plugins: [router], stubs: { teleport: true } } })
    expect(wrapper.find('form').exists()).toBe(false)

    auth.sessionExpired = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Your session has ended')
    apiMock.post.mockResolvedValue({ data: { data: { ...auth.user } } })
    await wrapper.get('input[autocomplete="current-password"]').setValue('the-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/login', { username: 'asha', password: 'the-password', remember: true })
    expect(auth.sessionExpired).toBe(false)
  })
})

describe('PasswordInput', () => {
  it('toggles between hidden and visible without changing the value', async () => {
    const wrapper = mount(PasswordInput, { props: { modelValue: 'pw', label: 'Password' } })
    const input = wrapper.get('input')
    expect(input.attributes('type')).toBe('password')
    await wrapper.get('button').trigger('click')
    expect(input.attributes('type')).toBe('text')
    expect(wrapper.get('button').attributes('aria-label')).toBe('Hide password')
    await input.setValue('next')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['next'])
  })
})

describe('LoginView', () => {
  async function mountLogin() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/login', component: { render: () => null } }, { path: '/admin', component: { render: () => null } }] })
    await router.push('/login')
    return { router, wrapper: mount(LoginView, { global: { plugins: [router] } }) }
  }

  it('has labelled fields, no autocapitalisation, a show-password toggle and remember-me off by default', async () => {
    const { wrapper } = await mountLogin()
    const user = wrapper.get('#login-username')
    expect(user.attributes('autocapitalize')).toBe('none')
    expect(wrapper.find('label[for="login-username"]').exists()).toBe(true)
    expect((wrapper.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.find('[aria-label="Show password"]').exists()).toBe(true)
  })

  it('sends the remember flag, keeps nothing in storage and goes to the dashboard', async () => {
    apiMock.post.mockResolvedValue({ data: { data: { id: 'u1', username: 'asha', phone: null, role: 'PLAYER', balance: 0, isActive: false, creditLimit: 500, spendLimit: 1000, deletedAt: null } } })
    const { wrapper, router } = await mountLogin()
    await wrapper.get('#login-username').setValue(' asha ')
    await wrapper.get('input[autocomplete="current-password"]').setValue('a-long-password')
    await wrapper.get('input[type=checkbox]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/login', { username: 'asha', password: 'a-long-password', remember: true })
    expect(router.currentRoute.value.path).toBe('/')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('shows a plain sentence for a wrong password and for a lost connection', async () => {
    const { wrapper } = await mountLogin()
    await wrapper.get('#login-username').setValue('asha')
    await wrapper.get('input[autocomplete="current-password"]').setValue('wrong-password')
    apiMock.post.mockRejectedValueOnce(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 401, data: { error: 'Invalid credentials' } } }))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('Invalid credentials')
    apiMock.post.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { isAxiosError: true, response: undefined }))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toMatch(/No connection/)
  })
})
