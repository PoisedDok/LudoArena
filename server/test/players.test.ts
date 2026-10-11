import { beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { balanceCents, createGame, createUser, login, randomSecret, resetDb } from './helpers'

const { app } = createApp()

describe('player management', () => {
  beforeEach(resetDb)

  it('only an admin can create, edit, adjust or delete', async () => {
    const player = await login(app, await createUser())
    const target = await createUser()
    expect((await player.post('/api/players').send({ username: 'abc', password: randomSecret() })).status).toBe(403)
    expect((await player.put(`/api/players/${target.id}`).send({ creditLimit: 5 })).status).toBe(403)
    expect((await player.patch(`/api/players/${target.id}/balance`).send({ amount: 5 })).status).toBe(403)
    expect((await player.delete(`/api/players/${target.id}`)).status).toBe(403)
  })

  it('players cannot read each other (IDOR): full record for self/admin only', async () => {
    const [a, b] = await Promise.all([createUser({ balanceCents: 5_000 }), createUser({ balanceCents: 7_000 })])
    const admin = await createUser({ role: 'ADMIN' })
    const agent = await login(app, a)
    const other = (await agent.get(`/api/players/${b.id}`)).body.data
    expect(other).not.toHaveProperty('balance')
    expect(other).not.toHaveProperty('phone')
    expect(other).not.toHaveProperty('passwordHash')
    expect((await agent.get(`/api/players/${a.id}`)).body.data.balance).toBe(50)
    expect((await agent.get(`/api/players/${b.id}/transactions`)).status).toBe(403)
    const list = (await agent.get('/api/players')).body.data as Array<Record<string, unknown>>
    expect(list.every((p) => !('balance' in p) && !('passwordHash' in p))).toBe(true)
    expect((await (await login(app, admin)).get(`/api/players/${b.id}`)).body.data.balance).toBe(70)
    expect((await agent.patch(`/api/players/${b.id}/active`).send({ isActive: true })).status).toBe(403)
  })

  it('creates a player with validation, an opening-balance ledger row, and unique identities', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const password = randomSecret()
    const created = await admin.post('/api/players').send({ username: 'Asha_01', phone: '+91 98765-43210', password, balance: 150.25, creditLimit: 300, spendLimit: 80 })
    expect(created.status).toBe(201)
    expect(created.body.data).not.toHaveProperty('passwordHash')
    expect(created.body.data).toMatchObject({ username: 'Asha_01', phone: '+919876543210', balance: 150.25, creditLimit: 300, spendLimit: 80 })
    const rows = await prisma.transaction.findMany({ where: { userId: created.body.data.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amount.toString()).toBe('150.25')

    const bad: Array<[string, object]> = [
      ['short username', { username: 'ab', password }],
      ['bad chars', { username: 'a b!', password }],
      ['short password', { username: 'validname', password: 'short' }],
      ['long password', { username: 'validname', password: 'x'.repeat(73) }],
      ['bad phone', { username: 'validname', password, phone: '12' }],
      ['NaN balance', { username: 'validname', password, balance: 'NaN' }],
      ['huge balance', { username: 'validname', password, balance: 1e12 }],
      ['negative limit', { username: 'validname', password, creditLimit: -1 }],
    ]
    for (const [label, payload] of bad) expect((await admin.post('/api/players').send(payload)).status, label).toBe(400)

    // Same username (any case) or a username equal to somebody's phone is a conflict, never a 500.
    expect((await admin.post('/api/players').send({ username: 'asha_01', password })).status).toBe(409)
    expect((await admin.post('/api/players').send({ username: '+919876543210', password })).status).toBe(400)
    expect((await admin.post('/api/players').send({ username: 'other_person', phone: '+919876543210', password })).status).toBe(409)
  })

  it('issues a fresh 5-minute login link only for an active player account', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const player = await createUser()
    const otherPlayer = await createUser()
    const playerAgent = await login(app, player)
    expect((await playerAgent.post(`/api/players/${player.id}/share-link`)).status).toBe(403)

    const first = await admin.post(`/api/players/${player.id}/share-link`)
    expect(first.status).toBe(200)
    expect(first.body.data.token).toMatch(/^[a-f0-9]{64}$/)
    const firstExpiry = Date.parse(first.body.data.expiresAt)
    expect(firstExpiry - Date.now()).toBeGreaterThan(4 * 60 * 1000)
    expect(firstExpiry - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000)
    const stored = await prisma.shareLoginLink.findUniqueOrThrow({ where: { userId: player.id } })
    expect(stored.tokenHash).not.toBe(first.body.data.token)
    expect(stored.consumedAt).toBeNull()

    const rotated = await admin.post(`/api/players/${player.id}/share-link`)
    expect(rotated.status).toBe(200)
    expect(rotated.body.data.token).not.toBe(first.body.data.token)
    expect((await prisma.shareLoginLink.findUniqueOrThrow({ where: { userId: player.id } })).tokenHash).not.toBe(stored.tokenHash)

    expect((await admin.delete(`/api/players/${player.id}`)).status).toBe(200)
    expect(await prisma.shareLoginLink.findUnique({ where: { userId: player.id } })).toBeNull()
    expect((await admin.post(`/api/players/${player.id}/share-link`)).status).toBe(409)
    expect((await admin.post(`/api/players/${otherPlayer.id}/share-link`)).status).toBe(200)
  })

  it('edits limits and identity; unknown ids are 404 and clashes 409', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const [a, b] = await Promise.all([createUser(), createUser()])
    expect((await admin.put(`/api/players/${a.id}`).send({ creditLimit: 123.45, spendLimit: 10 })).body.data).toMatchObject({ creditLimit: 123.45, spendLimit: 10 })
    expect((await admin.put('/api/players/nope').send({ creditLimit: 1 })).status).toBe(404)
    expect((await admin.put(`/api/players/${a.id}`).send({ username: b.username.toUpperCase() })).status).toBe(409)
    expect((await admin.put(`/api/players/${a.id}`).send({ creditLimit: 'many' })).status).toBe(400)
  })

  it('balance adjustments: exact amounts, a ledger row, bounds, and a retry with the same key applies once', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const player = await createUser({ balanceCents: 0 })
    const adjust = (amount: unknown, key?: string) => {
      const req = admin.patch(`/api/players/${player.id}/balance`)
      if (key) req.set('Idempotency-Key', key)
      return req.send({ amount, description: 'cash' })
    }
    expect((await adjust(0.1)).status).toBe(200)
    expect((await adjust(0.2)).status).toBe(200)
    expect(await balanceCents(player.id)).toBe(30)
    expect((await adjust(-5.5)).status).toBe(200)
    expect(await balanceCents(player.id)).toBe(-520)

    for (const bad of [0, 'abc', null, 1e9, -1e9, 0.001, 'Infinity']) expect((await adjust(bad)).status, String(bad)).toBe(400)
    expect((await admin.patch('/api/players/nope/balance').send({ amount: 5 })).status).toBe(404)

    const [x, y] = await Promise.all([adjust(100, 'adjust-key-0001'), adjust(100, 'adjust-key-0001')])
    // One request applies the change; the concurrent twin is either answered from the stored result or told to retry.
    expect([x.status, y.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1)
    expect([x.status, y.status].every((s) => s === 200 || s === 409)).toBe(true)
    const third = await adjust(100, 'adjust-key-0001')
    expect(third.status).toBe(200)
    expect(third.headers['idempotent-replay']).toBe('true')
    expect(await balanceCents(player.id)).toBe(-520 + 10_000)
    const rows = await prisma.transaction.findMany({ where: { userId: player.id } })
    expect(rows.reduce((s, r) => s + Math.round(r.amount.toNumber() * 100), 0)).toBe(-520 + 10_000)
  })

  it('archives players with history, blocks active games, and supports restore and permanent cleanup', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const [a, b] = await Promise.all([createUser({ isActive: true }), createUser({ isActive: true })])
    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents: 100, players: [a, b] })
    expect((await admin.patch(`/api/players/${a.id}/balance`).send({ amount: 10, description: 'test credit' })).status).toBe(200)
    expect((await admin.patch(`/api/players/${a.id}/balance`).send({ amount: -10, description: 'test debit' })).status).toBe(200)
    expect(await balanceCents(a.id)).toBe(0)
    expect((await admin.patch(`/api/players/${b.id}/balance`).send({ amount: 7.5, description: 'other player credit' })).status).toBe(200)
    const otherPlayerTransactionCount = await prisma.transaction.count({ where: { userId: b.id } })
    const archivedWhilePlaying = await admin.delete(`/api/players/${a.id}`)
    expect(archivedWhilePlaying.status).toBe(409)
    expect(archivedWhilePlaying.body.error).toMatch(/active or awaiting completion/)
    await prisma.game.update({ where: { id: game.id }, data: { status: 'PENDING_COMPLETION' } })
    expect((await admin.delete(`/api/players/${a.id}`)).status).toBe(409)
    await prisma.game.update({ where: { id: game.id }, data: { status: 'COMPLETED' } })

    const playerAgent = await login(app, a)
    const ping = await playerAgent.post('/api/pings').send({ gameType: 'TWO_V_TWO', stake: 10, isBroadcast: true })
    expect(ping.status).toBe(201)
    expect((await admin.delete(`/api/players/${a.id}`)).status).toBe(200)
    expect((await prisma.ping.findUniqueOrThrow({ where: { id: ping.body.data.id } })).status).toBe('DECLINED')
    expect((await playerAgent.get('/api/auth/me')).body.data.deletedAt).toBeTruthy()
    expect((await playerAgent.get('/api/games')).body.data.map((g: { id: string }) => g.id)).toContain(game.id)
    expect((await playerAgent.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 10, isBroadcast: true })).status).toBe(403)
    expect((await playerAgent.post('/api/deposits')).status).toBe(403)
    expect((await playerAgent.patch(`/api/games/${game.id}/roomcode`).send({ ludoRoomCode: 'AB12' })).status).toBe(403)
    expect((await admin.patch(`/api/players/${a.id}/active`).send({ isActive: true })).status).toBe(409)
    expect((await admin.put(`/api/players/${a.id}`).send({ creditLimit: 100 })).status).toBe(409)
    expect((await admin.patch(`/api/players/${a.id}/balance`).send({ amount: 5 })).status).toBe(409)
    const otherAgent = await login(app, b)
    expect((await otherAgent.get('/api/players')).body.data.map((u: { id: string }) => u.id)).not.toContain(a.id)
    expect((await otherAgent.get(`/api/players/${a.id}`)).status).toBe(404)
    expect((await playerAgent.get('/api/pings')).body.data).toEqual([])
    expect((await login(app, a).then((agent) => agent.get('/api/auth/me'))).body.data.deletedAt).toBeTruthy()
    expect((await playerAgent.get(`/api/players/${a.id}/transactions`)).status).toBe(200)

    const deleted = (await admin.get('/api/players/deleted')).body.data
    expect(deleted.map((u: { id: string }) => u.id)).toContain(a.id)
    expect((await admin.post(`/api/players/${a.id}/restore`)).status).toBe(200)
    expect((await admin.get('/api/players/deleted')).body.data.map((u: { id: string }) => u.id)).not.toContain(a.id)
    expect((await admin.get('/api/players')).body.data.find((u: { id: string }) => u.id === a.id)).toMatchObject({ isActive: false })
    expect((await admin.delete(`/api/players/${a.id}`)).status).toBe(200)
    const replacement = { ...a, password: randomSecret() }
    expect((await admin.post('/api/players').send(replacement)).status).toBe(409)
    expect((await admin.delete(`/api/players/${a.id}/permanent-cleanup`)).status).toBe(200)
    expect((await admin.get('/api/players/deleted')).body.data.map((u: { id: string }) => u.id)).not.toContain(a.id)
    expect(await prisma.gamePlayer.count({ where: { userId: a.id } })).toBe(1)
    expect(await prisma.gamePlayer.count({ where: { userId: b.id } })).toBe(1)
    expect(await prisma.transaction.count({ where: { userId: a.id } })).toBeGreaterThan(0)
    expect(await prisma.transaction.count({ where: { userId: b.id } })).toBe(otherPlayerTransactionCount)
    expect(await balanceCents(b.id)).toBe(750)
    const purged = await prisma.user.findUniqueOrThrow({ where: { id: a.id } })
    expect(purged.deletedAt).toBeInstanceOf(Date)
    expect(purged.permanentlyPurgedAt).toBeInstanceOf(Date)
    expect(purged.phone).toBeNull()
    expect(purged.username).toBe(a.username)
    expect(await prisma.session.count({ where: { userId: a.id } })).toBe(0)
    await expect(login(app, a)).rejects.toThrow(/login failed/)
    const replacementResponse = await admin.post('/api/players').send(replacement)
    expect(replacementResponse.status).toBe(201)
    expect(replacementResponse.body.data.username).toBe(a.username)
    const replacementAgent = await login(app, replacement)
    expect((await replacementAgent.get('/api/auth/me')).body.data.id).toBe(replacementResponse.body.data.id)
    await expect(login(app, a)).rejects.toThrow(/login failed/)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).username).toBe(a.username)
    expect((await admin.post(`/api/players/${a.id}/restore`)).status).toBe(409)
  })

  it('the admin account cannot be deleted', async () => {
    const adminUser = await createUser({ role: 'ADMIN' })
    const admin = await login(app, adminUser)
    expect((await admin.delete(`/api/players/${adminUser.id}`)).status).toBe(400)
  })

  it('active toggle: own status only and a real boolean', async () => {
    const player = await createUser()
    const agent = await login(app, player)
    expect((await agent.patch(`/api/players/${player.id}/active`).send({ isActive: 'yes' })).status).toBe(400)
    expect((await agent.patch(`/api/players/${player.id}/active`).send({ isActive: true })).body.data.isActive).toBe(true)
  })
})
