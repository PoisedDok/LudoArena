import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { GameType } from '../generated/prisma'
import { createPing, respondToPing } from '../src/services/pings'
import { settleGame } from '../src/services/settlement'
import prisma from '../src/lib/prisma'
import { createUser, buildApp, login, resetDb } from './helpers'

const app = buildApp()

beforeEach(resetDb)

describe('admin commission settings', () => {
  it('is only available to authenticated admins', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const player = await createUser()
    const adminAgent = await login(app, admin)
    const playerAgent = await login(app, player)

    expect((await request(app).get('/api/admin/settings/commission')).status).toBe(401)
    expect((await adminAgent.get('/api/admin/settings/commission')).status).toBe(200)
    expect((await playerAgent.get('/api/admin/settings/commission')).status).toBe(403)
    expect((await playerAgent.put('/api/admin/settings/commission/ONE_V_ONE').send({ tierThresholdCents: 1, highRateBps: 0, lowRateBps: 0 })).status).toBe(403)
  })

  it('returns three independent defaults and records attributed changes without changing the others', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const agent = await login(app, admin)
    const initial = (await agent.get('/api/admin/settings/commission')).body.data.settings
    expect(initial.map((setting: { gameType: string }) => setting.gameType).sort()).toEqual(['FOUR_PLAYER', 'ONE_V_ONE', 'TWO_V_TWO'])

    const response = await agent.put('/api/admin/settings/commission/ONE_V_ONE').send({
      tierThresholdCents: 12_345,
      highRateBps: 750,
      lowRateBps: 125,
    })
    expect(response.status).toBe(200)
    expect(response.body.data.setting).toMatchObject({
      gameType: 'ONE_V_ONE',
      tierThresholdCents: 12_345,
      highRateBps: 750,
      lowRateBps: 125,
      fourPlayerSecondBps: null,
      updatedBy: { id: admin.id, username: admin.username },
    })

    const after = (await agent.get('/api/admin/settings/commission')).body.data.settings
    expect(after.find((setting: { gameType: string }) => setting.gameType === 'TWO_V_TWO')).toMatchObject({
      tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300,
    })
    expect(after.find((setting: { gameType: string }) => setting.gameType === 'FOUR_PLAYER')).toMatchObject({ fourPlayerSecondBps: 1_000 })
    const history = await prisma.commissionSettingChange.findMany({ where: { gameType: GameType.ONE_V_ONE } })
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      actorId: admin.id,
      actorUsername: admin.username,
      before: { tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300, fourPlayerSecondBps: null },
      after: { tierThresholdCents: 12_345, highRateBps: 750, lowRateBps: 125, fourPlayerSecondBps: null },
    })
  })

  it.each([
    ['over-precision rate', { tierThresholdCents: 1, highRateBps: 100.5, lowRateBps: 0 }],
    ['out-of-range rate', { tierThresholdCents: 1, highRateBps: 10_001, lowRateBps: 0 }],
    ['negative threshold', { tierThresholdCents: -1, highRateBps: 0, lowRateBps: 0 }],
    ['extra game-type field', { tierThresholdCents: 1, highRateBps: 0, lowRateBps: 0, fourPlayerSecondBps: 1 }],
    ['wrong shape for Four-player', { tierThresholdCents: 1, highRateBps: 0, lowRateBps: 0 }],
  ])('rejects %s', async (_label, payload) => {
    const admin = await createUser({ role: 'ADMIN' })
    const agent = await login(app, admin)
    const gameType = _label === 'wrong shape for Four-player' ? 'FOUR_PLAYER' : 'ONE_V_ONE'
    expect((await agent.put(`/api/admin/settings/commission/${gameType}`).send(payload)).status).toBe(400)
    expect(await prisma.commissionSettingChange.count()).toBe(0)
  })

  it('snapshots the rule when a game starts and settles that snapshot after later edits', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const agent = await login(app, admin)
    const [a, b, c, d] = await Promise.all([
      createUser({ balanceCents: 200_000 }),
      createUser({ balanceCents: 200_000 }),
      createUser({ balanceCents: 200_000 }),
      createUser({ balanceCents: 200_000 }),
    ])

    const startGame = async (senderId: string, recipientId: string) => {
      const ping = await createPing({
        userId: senderId,
        gameType: GameType.ONE_V_ONE,
        stakeCents: 100_000,
        isBroadcast: false,
        recipientIds: [recipientId],
      })
      const outcome = await respondToPing(ping.id, recipientId, 'ACCEPTED', null)
      if (!outcome.game) throw new Error('Expected accepted ping to start the game')
      return prisma.game.findUniqueOrThrow({ where: { id: outcome.game.id } })
    }

    const oldGame = await startGame(a!.id, b!.id)
    expect(oldGame.commissionLowRateBps).toBe(300)

    const update = await agent.put('/api/admin/settings/commission/ONE_V_ONE').send({
      tierThresholdCents: 50_000,
      highRateBps: 500,
      lowRateBps: 700,
    })
    expect(update.status).toBe(200)

    const newGame = await startGame(c!.id, d!.id)
    expect(newGame.commissionLowRateBps).toBe(700)

    await settleGame(oldGame.id, { kind: 'admin', winnerId: a!.id })
    const oldCommission = await prisma.transaction.findFirstOrThrow({ where: { gameId: oldGame.id, type: 'COMMISSION' } })
    expect(oldCommission.amount.toNumber()).toBe(-30)
  })

  it('snapshots one complete settings version when a game start races an admin update', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const agent = await login(app, admin)
    const [sender, recipient] = await Promise.all([
      createUser({ balanceCents: 200_000 }),
      createUser({ balanceCents: 200_000 }),
    ])
    const ping = await createPing({
      userId: sender!.id,
      gameType: GameType.ONE_V_ONE,
      stakeCents: 100_000,
      isBroadcast: false,
      recipientIds: [recipient!.id],
    })

    const [updated, outcome] = await Promise.all([
      agent.put('/api/admin/settings/commission/ONE_V_ONE').send({
        tierThresholdCents: 200_000,
        highRateBps: 200,
        lowRateBps: 700,
      }),
      respondToPing(ping.id, recipient!.id, 'ACCEPTED', null),
    ])
    expect(updated.status).toBe(200)
    if (!outcome.game) throw new Error('Expected accepted ping to start the game')

    const game = await prisma.game.findUniqueOrThrow({ where: { id: outcome.game.id } })
    const version = [
      game.commissionTierThresholdCents,
      game.commissionHighRateBps,
      game.commissionLowRateBps,
    ]
    expect(
      version.every((value, index) => value === [50_000, 500, 300][index])
      || version.every((value, index) => value === [200_000, 200, 700][index]),
    ).toBe(true)
  })
})
