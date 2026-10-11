import { beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { balanceCents, createGame, createUser, login, resetDb } from './helpers'

const { app } = createApp()

async function players(n: number, opts: Parameters<typeof createUser>[0] = {}) {
  return Promise.all(Array.from({ length: n }, () => createUser({ balanceCents: 100_000, isActive: true, ...opts })))
}

describe('creating pings', () => {
  beforeEach(resetDb)

  it('validates gameType, stake, recipients and message', async () => {
    const [a, b] = await players(2)
    const agent = await login(app, a!)
    const send = (payload: object) => agent.post('/api/pings').send(payload)

    expect((await send({ gameType: 'CHESS', stake: 10, isBroadcast: true })).status).toBe(400)
    for (const stake of [0, -5, 'abc', 1.005, null, 1e30, Number.NaN]) {
      expect((await send({ gameType: 'ONE_V_ONE', stake, isBroadcast: true })).status, String(stake)).toBe(400)
    }
    expect((await send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: [] })).status).toBe(400)
    expect((await send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: ['missing-user'] })).status).toBe(400)
    expect((await send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: [a!.id] })).status).toBe(400)
    expect((await send({ gameType: 'TWO_V_TWO', stake: 10, recipientIds: [b!.id] })).status).toBe(400)
    expect((await send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: [b!.id], message: 'x'.repeat(201) })).status).toBe(400)
    const ok = await send({ gameType: 'ONE_V_ONE', stake: 10.5, recipientIds: [b!.id, b!.id] })
    expect(ok.status).toBe(201)
    expect(ok.body.data.recipients).toHaveLength(1)
    expect(ok.body.data.stake).toBe(10.5)
  })

  it('enforces the spend limit and the credit limit at creation', async () => {
    const [a] = await players(1, { spendLimitCents: 5_000, balanceCents: -48_000, creditLimitCents: 50_000 })
    const agent = await login(app, a!)
    expect((await agent.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 50.01, isBroadcast: true })).status).toBe(400)
    // balance -480, credit 500: a stake of 30 would end at -510
    const res = await agent.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 30, isBroadcast: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/credit/i)
  })

  it('refuses a ping from a player who is in an open game', async () => {
    const [a, b, c] = await players(3)
    await createGame({ gameType: 'ONE_V_ONE', stakeCents: 1_000, players: [a!, b!] })
    const agent = await login(app, a!)
    const res = await agent.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: [c!.id] })
    expect(res.status).toBe(409)
    // PENDING_COMPLETION still counts as open
    await prisma.game.updateMany({ data: { status: 'PENDING_COMPLETION' } })
    expect((await agent.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: [c!.id] })).status).toBe(409)
  })

  it('an idempotent retry returns the same ping and creates one', async () => {
    const [a] = await players(1)
    const agent = await login(app, a!)
    const key = 'retry-key-0001'
    const first = await agent.post('/api/pings').set('Idempotency-Key', key).send({ gameType: 'ONE_V_ONE', stake: 10, isBroadcast: true })
    const second = await agent.post('/api/pings').set('Idempotency-Key', key).send({ gameType: 'ONE_V_ONE', stake: 10, isBroadcast: true })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(await prisma.ping.count()).toBe(1)
  })
})

describe('joining a broadcast', () => {
  beforeEach(resetDb)

  it('lets an accepted player cancel their join and exposes joiners only to the broadcaster', async () => {
    const [sender, joiner, observer] = await players(3)
    const senderAgent = await login(app, sender!)
    const joinerAgent = await login(app, joiner!)
    const observerAgent = await login(app, observer!)
    const ping = (await senderAgent.post('/api/pings').send({ gameType: 'TWO_V_TWO', stake: 100, isBroadcast: true })).body.data

    const accepted = await joinerAgent.patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })
    expect(accepted.status).toBe(200)
    expect(accepted.body.data.started).toBe(false)

    const senderPing = (await senderAgent.get('/api/pings')).body.data.find((p: { id: string }) => p.id === ping.id)
    expect(senderPing.recipients).toEqual([
      expect.objectContaining({
        userId: joiner!.id,
        response: 'ACCEPTED',
        user: expect.objectContaining({ username: joiner!.username }),
      }),
    ])
    const observerPing = (await observerAgent.get('/api/pings')).body.data.find((p: { id: string }) => p.id === ping.id)
    expect(observerPing.recipients).toEqual([])

    const cancelled = await joinerAgent.patch(`/api/pings/${ping.id}/respond`).send({ response: 'DECLINED' })
    expect(cancelled.status).toBe(200)
    expect(await prisma.pingRecipient.findFirstOrThrow({ where: { pingId: ping.id, userId: joiner!.id } }))
      .toMatchObject({ response: 'DECLINED' })

    const rejoined = await joinerAgent.patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })
    expect(rejoined.status).toBe(200)
    expect(rejoined.body.data.started).toBe(false)
  })

  it('a burst of simultaneous joins on a Solo broadcast starts exactly one game with two players', async () => {
    const [sender, ...joiners] = await players(9)
    const senderAgent = await login(app, sender!)
    const ping = (await senderAgent.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 100, isBroadcast: true })).body.data

    const agents = await Promise.all(joiners.map((j) => login(app, j)))
    const results = await Promise.all(agents.map((a) => a.patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })))

    expect(results.filter((r) => r.status === 200 && r.body.data.started)).toHaveLength(1)
    expect(results.filter((r) => r.status === 200 && !r.body.data.started)).toHaveLength(0)
    expect(results.filter((r) => r.status === 409)).toHaveLength(joiners.length - 1)
    expect(results.some((r) => r.status >= 500)).toBe(false)
    const games = await prisma.game.findMany({ include: { players: true } })
    expect(games).toHaveLength(1)
    expect(games[0]!.players).toHaveLength(2)
    expect(await prisma.pingRecipient.count({ where: { pingId: ping.id, response: 'ACCEPTED' } })).toBe(1)
  })

  it('a Teams broadcast fills two and two, whatever team the joiners ask for', async () => {
    const [sender, ...joiners] = await players(6)
    const senderAgent = await login(app, sender!)
    const ping = (await senderAgent.post('/api/pings').send({ gameType: 'TWO_V_TWO', stake: 100, isBroadcast: true })).body.data
    const agents = await Promise.all(joiners.map((j) => login(app, j)))
    // Everybody asks for team 1; only one slot exists there.
    const results = await Promise.all(agents.map((a) => a.patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED', team: 1 })))
    expect(results.some((r) => r.status >= 500)).toBe(false)
    const accepted = results.filter((r) => r.status === 200)
    expect(accepted.length).toBe(1)

    // Without a requested team, the server assigns the free slots.
    const fresh = (await senderAgent.get('/api/pings')).body.data
    expect(fresh.length).toBeGreaterThan(0)
    for (const a of agents.slice(1)) {
      await a.patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })
    }
    const game = await prisma.game.findFirstOrThrow({ include: { players: true } })
    expect(game.players).toHaveLength(4)
    expect(game.players.filter((p) => p.team === 1)).toHaveLength(2)
    expect(game.players.filter((p) => p.team === 2)).toHaveLength(2)
  })

  it('one player cannot end up in two open games by accepting two broadcasts at once', async () => {
    const [s1, s2, joiner] = await players(3)
    const a1 = await login(app, s1!)
    const a2 = await login(app, s2!)
    const p1 = (await a1.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, isBroadcast: true })).body.data
    const p2 = (await a2.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, isBroadcast: true })).body.data
    const j = await login(app, joiner!)
    const [r1, r2] = await Promise.all([
      j.patch(`/api/pings/${p1.id}/respond`).send({ response: 'ACCEPTED' }),
      j.patch(`/api/pings/${p2.id}/respond`).send({ response: 'ACCEPTED' }),
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    expect(await prisma.gamePlayer.count({ where: { userId: joiner!.id } })).toBe(1)
  })

  it('refuses a joiner who cannot cover the stake and does not record them', async () => {
    const [sender] = await players(1)
    const poor = await createUser({ balanceCents: -49_000, creditLimitCents: 50_000, isActive: true })
    const senderAgent = await login(app, sender!)
    const ping = (await senderAgent.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 100, isBroadcast: true })).body.data
    const res = await (await login(app, poor)).patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })
    expect(res.status).toBe(400)
    expect(await prisma.pingRecipient.count()).toBe(0)
    expect((await prisma.ping.findUniqueOrThrow({ where: { id: ping.id } })).status).toBe('PENDING')
  })

  it('a direct ping can only be answered by its recipient, and the sender cannot answer their own', async () => {
    const [a, b, c] = await players(3)
    const ping = (await (await login(app, a!)).post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: [b!.id] })).body.data
    expect((await (await login(app, c!)).patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })).status).toBe(403)
    expect((await (await login(app, a!)).patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })).status).toBe(400)
    expect((await (await login(app, b!)).patch(`/api/pings/${ping.id}/respond`).send({ response: 'MAYBE' })).status).toBe(400)
    const ok = await (await login(app, b!)).patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.started).toBe(true)
  })

  it('expired and cancelled pings cannot be joined; only the sender cancels', async () => {
    const [a, b] = await players(2)
    const agentA = await login(app, a!)
    const agentB = await login(app, b!)
    const ping = (await agentA.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, isBroadcast: true })).body.data
    expect((await agentB.delete(`/api/pings/${ping.id}`)).status).toBe(403)
    await prisma.ping.update({ where: { id: ping.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await agentB.patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })).status).toBe(409)

    const second = (await agentA.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, isBroadcast: true })).body.data
    expect((await agentA.delete(`/api/pings/${second.id}`)).status).toBe(200)
    expect((await agentA.delete(`/api/pings/${second.id}`)).status).toBe(409)
    expect((await agentB.patch(`/api/pings/${second.id}/respond`).send({ response: 'ACCEPTED' })).status).toBe(409)
    expect(await balanceCents(a!.id)).toBe(100_000)
  })
})
