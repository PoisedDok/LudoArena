import { beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { settleDueGames } from '../src/lib/jobs'
import { balanceCents, createGame, createUser, login, resetDb, TestUser } from './helpers'
import { pngBytes } from './images'

const { app } = createApp()

async function pendingGame(type: 'ONE_V_ONE' | 'FOUR_PLAYER' | 'TWO_V_TWO', n: number, stakeCents = 10_000) {
  const users = await Promise.all(Array.from({ length: n }, () => createUser({ balanceCents: 100_000 })))
  const teams = type === 'TWO_V_TWO' ? [1, 2, 1, 2] : undefined
  const game = await createGame({ gameType: type, stakeCents, players: users, teams, status: 'PENDING_COMPLETION' })
  return { users, game }
}

async function withScreenshot(user: TestUser, gameId: string) {
  const agent = await login(app, user)
  const res = await agent.post(`/api/games/${gameId}/screenshots`).attach('screenshot', pngBytes(), { filename: 'win.png', contentType: 'image/png' })
  expect(res.status).toBe(201)
  return agent
}

describe('result voting', () => {
  beforeEach(resetDb)

  it('the last two voters at the same instant start the undo window exactly once', async () => {
    const { users, game } = await pendingGame('ONE_V_ONE', 2)
    const [a, b] = users as [TestUser, TestUser]
    const agentA = await withScreenshot(a, game.id)
    const agentB = await login(app, b)
    const [ra, rb] = await Promise.all([
      agentA.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id }),
      agentB.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id }),
    ])
    expect([ra.status, rb.status]).toEqual([200, 200])
    const statuses = [ra.body.data.status, rb.body.data.status].sort()
    expect(statuses).toEqual(['settling', 'waiting_for_others'])
    const row = await prisma.game.findUniqueOrThrow({ where: { id: game.id } })
    expect(row.settlesAt).not.toBeNull()
    expect(row.settleWinnerId).toBe(a.id)
  })

  it('pays out after the window, once, and the winner sees the right net amount', async () => {
    const { users, game } = await pendingGame('ONE_V_ONE', 2, 20_000)
    const [a, b] = users as [TestUser, TestUser]
    const agentA = await withScreenshot(a, game.id)
    const agentB = await login(app, b)
    await agentA.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id })
    await agentB.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id })
    expect(await balanceCents(a.id)).toBe(100_000)
    await prisma.game.update({ where: { id: game.id }, data: { settlesAt: new Date(Date.now() - 1) } })
    await settleDueGames()
    expect(await balanceCents(a.id)).toBe(119_000)
    expect(await balanceCents(b.id)).toBe(80_000)

    // The ledger the player sees adds up to what was credited.
    const txs = (await agentA.get(`/api/players/${a.id}/transactions`)).body.data as Array<{ amount: number; gameId: string }>
    expect(txs.filter((t) => t.gameId === game.id).reduce((s, t) => s + Math.round(t.amount * 100), 0)).toBe(19_000)
  })

  it('retract cancels the window; re-confirm starts it again; nothing settles meanwhile', async () => {
    const { users, game } = await pendingGame('ONE_V_ONE', 2)
    const [a, b] = users as [TestUser, TestUser]
    const agentA = await withScreenshot(a, game.id)
    const agentB = await login(app, b)
    await agentA.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id })
    await agentB.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id })
    expect((await agentB.delete(`/api/games/${game.id}/confirm`)).status).toBe(200)
    await prisma.game.updateMany({ data: { finishedAt: null } })
    expect(await settleDueGames()).toBe(0)
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).settlesAt).toBeNull()

    // Changing a vote requires undoing it first.
    expect((await agentA.post(`/api/games/${game.id}/confirm`).send({ winnerId: b.id })).status).toBe(409)
    const again = await agentB.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id })
    expect(again.body.data.status).toBe('settling')
  })

  it('disagreement disputes the game; an outsider and a bad winner are refused', async () => {
    const { users, game } = await pendingGame('ONE_V_ONE', 2)
    const [a, b] = users as [TestUser, TestUser]
    const outsider = await createUser()
    const agentA = await withScreenshot(a, game.id)
    const agentB = await withScreenshot(b, game.id)
    expect((await (await login(app, outsider)).post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id })).status).toBe(403)
    expect((await agentA.post(`/api/games/${game.id}/confirm`).send({ winnerId: outsider.id })).status).toBe(400)
    await agentA.post(`/api/games/${game.id}/confirm`).send({ winnerId: a.id })
    const last = await agentB.post(`/api/games/${game.id}/confirm`).send({ winnerId: b.id })
    expect(last.body.data.status).toBe('disputed')
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('DISPUTED')
  })

  it('claiming the win requires an uploaded screenshot', async () => {
    const { users, game } = await pendingGame('ONE_V_ONE', 2)
    const res = await (await login(app, users[0]!)).post(`/api/games/${game.id}/confirm`).send({ winnerId: users[0]!.id })
    expect(res.status).toBe(400)
  })

  it('4 players: second place is required, different from the winner, and must agree', async () => {
    const { users, game } = await pendingGame('FOUR_PLAYER', 4, 100_000)
    const agents = await Promise.all(users.map((u, i) => (i === 0 ? withScreenshot(u, game.id) : login(app, u))))
    const w = users[0]!.id
    expect((await agents[0]!.post(`/api/games/${game.id}/confirm`).send({ winnerId: w })).status).toBe(400)
    expect((await agents[0]!.post(`/api/games/${game.id}/confirm`).send({ winnerId: w, secondPlaceId: w })).status).toBe(400)
    for (const [i, agent] of agents.entries()) {
      const res = await agent.post(`/api/games/${game.id}/confirm`).send({ winnerId: w, secondPlaceId: users[2]!.id })
      expect(res.status, String(i)).toBe(200)
    }
    await prisma.game.update({ where: { id: game.id }, data: { settlesAt: new Date(Date.now() - 1) } })
    await settleDueGames()
    expect(await Promise.all(users.map((u) => balanceCents(u.id)))).toEqual([200_000, 0, 190_000, 0])
  })
})

describe('game access and state', () => {
  beforeEach(resetDb)

  it('a game is visible to its players and the admin only', async () => {
    const { users, game } = await pendingGame('ONE_V_ONE', 2)
    const admin = await createUser({ role: 'ADMIN' })
    const outsider = await createUser()
    expect((await (await login(app, users[0]!)).get(`/api/games/${game.id}`)).status).toBe(200)
    expect((await (await login(app, admin)).get(`/api/games/${game.id}`)).status).toBe(200)
    expect((await (await login(app, outsider)).get(`/api/games/${game.id}`)).status).toBe(403)
    expect((await (await login(app, outsider)).get('/api/games')).body.data).toEqual([])
    expect((await (await login(app, users[0]!)).get('/api/games/does-not-exist')).status).toBe(404)
  })

  it('the room code is set once, by the initiator, in a sane format', async () => {
    const users = await Promise.all([1, 2].map(() => createUser()))
    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents: 1_000, players: users })
    const [a, b] = users as [TestUser, TestUser]
    const agentA = await login(app, a)
    expect((await (await login(app, b)).patch(`/api/games/${game.id}/roomcode`).send({ ludoRoomCode: 'AB12' })).status).toBe(403)
    expect((await agentA.patch(`/api/games/${game.id}/roomcode`).send({ ludoRoomCode: '<script>' })).status).toBe(400)
    expect((await agentA.patch(`/api/games/${game.id}/roomcode`).send({ ludoRoomCode: 'x'.repeat(40) })).status).toBe(400)
    const [one, two] = await Promise.all([
      agentA.patch(`/api/games/${game.id}/roomcode`).send({ ludoRoomCode: 'AB12CD34' }),
      agentA.patch(`/api/games/${game.id}/roomcode`).send({ ludoRoomCode: 'ZZ99ZZ99' }),
    ])
    expect([one.status, two.status].sort()).toEqual([200, 409])
  })

  it('mark done is claimed once; screenshots are capped per player and refused for strangers', async () => {
    const users = await Promise.all([1, 2].map(() => createUser()))
    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents: 1_000, players: users })
    const agent = await login(app, users[0]!)
    const [d1, d2] = await Promise.all([agent.patch(`/api/games/${game.id}/done`), agent.patch(`/api/games/${game.id}/done`)])
    expect([d1.status, d2.status].sort()).toEqual([200, 409])

    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      statuses.push((await agent.post(`/api/games/${game.id}/screenshots`).attach('screenshot', pngBytes(), { filename: 's.png', contentType: 'image/png' })).status)
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(5)
    expect(statuses.filter((s) => s === 409)).toHaveLength(2)
    const stranger = await login(app, await createUser())
    expect((await stranger.post(`/api/games/${game.id}/screenshots`).attach('screenshot', pngBytes(), { filename: 's.png', contentType: 'image/png' })).status).toBe(403)
  })
})

describe('admin resolution', () => {
  beforeEach(resetDb)

  it('resolves a disputed game, and a second resolve is a 409 that moves no money', async () => {
    const { users, game } = await pendingGame('ONE_V_ONE', 2, 10_000)
    await prisma.game.update({ where: { id: game.id }, data: { status: 'DISPUTED' } })
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const body = { winnerId: users[1]!.id }
    const [r1, r2] = await Promise.all([admin.patch(`/api/admin/games/${game.id}/resolve`).send(body), admin.patch(`/api/admin/games/${game.id}/resolve`).send(body)])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    expect(await balanceCents(users[1]!.id)).toBe(100_000 + 9_500)
    expect(await balanceCents(users[0]!.id)).toBe(90_000)
  })

  it('validates the resolution input', async () => {
    const { users, game } = await pendingGame('FOUR_PLAYER', 4)
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const path = `/api/admin/games/${game.id}/resolve`
    expect((await admin.patch(path).send({})).status).toBe(400)
    expect((await admin.patch(path).send({ winnerId: 'stranger' })).status).toBe(400)
    expect((await admin.patch(path).send({ winnerId: users[0]!.id })).status).toBe(400)
    expect((await admin.patch('/api/admin/games/nope/resolve').send({ winnerId: users[0]!.id })).status).toBe(404)
  })

  it('paginates and validates list queries', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    for (const q of ['page=abc', 'limit=-1', 'page=0x10', 'limit=1e9', 'status=NOPE']) {
      expect((await admin.get(`/api/admin/games?${q}`)).status, q).toBe(400)
    }
    expect((await admin.get('/api/admin/transactions?from=notadate')).status).toBe(400)
    expect((await admin.get('/api/admin/transactions?from=2026-02-01&to=2026-01-01')).status).toBe(400)
    const big = await admin.get('/api/admin/transactions?limit=100000')
    expect(big.body.data.limit).toBe(200)
  })
})
