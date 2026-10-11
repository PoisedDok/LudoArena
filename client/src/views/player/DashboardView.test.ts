import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import DashboardView from './DashboardView.vue'
import { useAuthStore } from '../../stores/auth'
import { usePingsStore } from '../../stores/pings'

describe('DashboardView broadcast joins', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows accepted players, lets them cancel, and shows joiners to the broadcaster', async () => {
    const auth = useAuthStore()
    auth.user = {
      id: 'joiner',
      username: 'Joiner',
      role: 'PLAYER',
      balance: 100,
      isActive: true,
      creditLimit: 500,
      spendLimit: 1000,
    }

    const pings = usePingsStore()
    const respondToPing = vi.spyOn(pings, 'respondToPing').mockResolvedValue({ status: 'declined', started: false })
    pings.liveBroadcasts = [
      {
        id: 'joined',
        fromUserId: 'host',
        fromUser: { id: 'host', username: 'Host' },
        gameType: 'TWO_V_TWO',
        stake: 10,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        isBroadcast: true,
        recipients: [{ userId: 'joiner', response: 'ACCEPTED' }],
      },
      {
        id: 'available',
        fromUserId: 'other-host',
        fromUser: { id: 'other-host', username: 'Other host' },
        gameType: 'FOUR_PLAYER',
        stake: 10,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        isBroadcast: true,
        recipients: [],
      },
      {
        id: 'hosted',
        fromUserId: 'joiner',
        fromUser: { id: 'joiner', username: 'Joiner' },
        gameType: 'TWO_V_TWO',
        stake: 10,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        isBroadcast: true,
        recipients: [
          { userId: 'player-1', response: 'ACCEPTED', user: { id: 'player-1', username: 'Player One' } },
          { userId: 'player-2', response: 'ACCEPTED', user: { id: 'player-2', username: 'Player Two' } },
        ],
      },
    ]

    const wrapper = mount(DashboardView, {
      global: {
        stubs: {
          RouterLink: true,
          StateBlock: true,
          PingModal: true,
          DepositModal: true,
        },
      },
    })

    const joined = wrapper.findAll('article').find((article) => article.text().includes('Host wants to play'))
    expect(joined?.text()).toContain('You joined · waiting for players')
    expect(joined?.text()).not.toContain('Join game')
    expect(joined?.text()).toContain('Cancel join')
    expect(wrapper.findAll('article').find((article) => article.text().includes('Joiner wants to play'))?.text())
      .toContain('Joined: Player One, Player Two')
    expect(wrapper.findAll('button').filter((button) => button.text() === 'Join game')).toHaveLength(1)

    await joined?.get('button').trigger('click')
    await flushPromises()
    expect(respondToPing).toHaveBeenCalledWith('joined', 'DECLINED')
  })
})
