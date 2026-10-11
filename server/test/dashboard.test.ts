import { beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { invalidateDashboard } from '../src/services/dashboard'
import { createGame, createUser, login, resetDb } from './helpers'

const { app } = createApp()

async function seedGames() {
  const [a, b] = await Promise.all([createUser({ balanceCents: 100_000 }), createUser({ balanceCents: 100_000 })])
  const make = async (createdAt: Date, stakeCents: number) => {
    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents, players: [a, b] })
    await prisma.game.update({ where: { id: game.id }, data: { createdAt, status: 'COMPLETED', winnerId: a.id, finishedAt: createdAt } })
    await prisma.transaction.createMany({
      data: [
        { userId: a.id, gameId: game.id, amount: (stakeCents / 100).toFixed(2), type: 'GAME_WIN', description: 'w', createdAt },
        { userId: a.id, gameId: game.id, amount: (-stakeCents * 0.05 / 100).toFixed(2), type: 'COMMISSION', description: 'c', createdAt },
        { userId: b.id, gameId: game.id, amount: (-stakeCents / 100).toFixed(2), type: 'GAME_LOSS', description: 'l', createdAt },
      ],
    })
  }
  // IST: 2026-09-30 23:30 (September), 2026-10-01 00:30 (October), 2026-10-05 12:00 (October)
  await make(new Date('2026-09-30T18:00:00Z'), 10_000)
  await make(new Date('2026-09-30T19:00:00Z'), 20_000)
  await make(new Date('2026-10-05T06:30:00Z'), 30_000)
  return { a, b }
}

describe('admin stats', () => {
  beforeEach(async () => {
    await resetDb()
    invalidateDashboard()
  })

  it('totals, spine and comparison follow the selected month in the configured timezone', async () => {
    await seedGames()
    const admin = await login(app, await createUser({ role: 'ADMIN' }))

    const oct = (await admin.get('/api/admin/stats?period=2026-10')).body.data
    expect(oct.period).toMatchObject({ key: '2026-10', granularity: 'day', days: 31, timezone: 'Asia/Kolkata' })
    expect(oct.totals).toMatchObject({ games: 2, volume: 500, commission: 25 })
    expect(oct.chart).toHaveLength(31)
    expect(oct.chart.find((d: { date: string }) => d.date === '2026-10-01')).toMatchObject({ games: 1, volume: 200 })
    expect(oct.chart.find((d: { date: string }) => d.date === '2026-10-05')).toMatchObject({ games: 1, volume: 300 })
    expect(oct.chart.find((d: { date: string }) => d.date === '2026-10-02')).toMatchObject({ games: 0, volume: 0 })
    expect(oct.previous.period.key).toBe('2026-09')
    expect(oct.previous.totals).toMatchObject({ games: 1, volume: 100 })

    const sep = (await admin.get('/api/admin/stats?period=2026-09&compare=0')).body.data
    expect(sep.totals.games).toBe(1)
    expect(sep.previous).toBeNull()
    expect(sep.chart).toHaveLength(30)

    const all = (await admin.get('/api/admin/stats?period=all')).body.data
    expect(all.totals.games).toBe(3)
    expect(all.period.granularity).toBe('month')
    expect(all.previous).toBeNull()
    expect(oct.topPlayers[0]).toMatchObject({ wins: 2 })
  })

  it('custom range is inclusive and bounded; bad input is a clear 400', async () => {
    await seedGames()
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const custom = (await admin.get('/api/admin/stats?from=2026-10-01&to=2026-10-01')).body.data
    expect(custom.totals.games).toBe(1)
    expect(custom.chart).toHaveLength(1)

    for (const q of ['period=nope', 'from=2026-10-10&to=2026-10-01', 'from=2024-01-01&to=2026-01-01', 'from=2026-10-01', 'period=2026-13', 'period=2026-10&from=2026-10-01&to=2026-10-02']) {
      const res = await admin.get(`/api/admin/stats?${q}`)
      expect(res.status, q).toBe(400)
      expect(res.body.error).toBeTruthy()
    }
  })

  it('the cache is dropped when a settlement or deposit changes the numbers', async () => {
    const { a, b } = await seedGames()
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const before = (await admin.get('/api/admin/stats?period=2026-10')).body.data
    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents: 5_000, players: [a, b], status: 'DISPUTED' })
    expect((await admin.patch(`/api/admin/games/${game.id}/resolve`).send({ winnerId: a.id })).status).toBe(200)
    const after = (await admin.get('/api/admin/stats?period=2026-10')).body.data
    expect(after.totals.games).toBeGreaterThan(before.totals.games)
    expect(after.totals.commission).toBeCloseTo(before.totals.commission + 2.5)
  })

  it('removes archived players from active counts without hiding their preserved balances', async () => {
    const player = await createUser({ balanceCents: 1_234, isActive: true })
    const other = await createUser()
    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents: 1_000, players: [player, other] })
    await prisma.game.update({
      where: { id: game.id },
      data: { status: 'COMPLETED', winnerId: player.id, finishedAt: new Date() },
    })
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const before = (await admin.get('/api/admin/stats?period=all')).body.data.live
    const totalsBefore = (await admin.get('/api/admin/stats?period=all')).body.data.totals
    expect(before).toMatchObject({ activePlayers: 1, totalPlayerBalance: 12.34 })
    expect(totalsBefore.games).toBe(1)

    expect((await admin.delete(`/api/players/${player.id}`)).status).toBe(200)
    const after = (await admin.get('/api/admin/stats?period=all')).body.data.live
    const totalsAfter = (await admin.get('/api/admin/stats?period=all')).body.data.totals
    expect(after).toMatchObject({ activePlayers: 0, totalPlayerBalance: 12.34 })
    expect(totalsAfter).toEqual(totalsBefore)
  })

  it('games and transactions lists accept the same period', async () => {
    await seedGames()
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    expect((await admin.get('/api/admin/games?period=2026-10')).body.data.total).toBe(2)
    expect((await admin.get('/api/admin/games?period=2026-09')).body.data.total).toBe(1)
    expect((await admin.get('/api/admin/games')).body.data.total).toBe(3)
    expect((await admin.get('/api/admin/transactions?from=2026-10-01&to=2026-10-31')).body.data.total).toBe(6)
    expect((await admin.get('/api/admin/transactions?period=2026-10&type=COMMISSION')).body.data.total).toBe(2)
    expect((await admin.get('/api/admin/transactions?period=junk')).status).toBe(400)
    expect((await admin.get('/api/admin/transactions?type=JUNK')).status).toBe(400)
  })
})
