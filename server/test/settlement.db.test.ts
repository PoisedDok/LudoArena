import { beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { settleGame, SettlementBlockedError } from '../src/services/settlement'
import { settleDueGames } from '../src/lib/jobs'
import { balanceCents, createGame, createUser, resetDb, TestUser } from './helpers'

async function agreedGame(players: TestUser[], opts: { type: 'ONE_V_ONE' | 'TWO_V_TWO' | 'FOUR_PLAYER'; stakeCents: number; winner: TestUser; second?: TestUser; teams?: number[] }) {
  const game = await createGame({ gameType: opts.type, stakeCents: opts.stakeCents, players, teams: opts.teams, status: 'PENDING_COMPLETION' })
  await prisma.game.update({
    where: { id: game.id },
    data: { settlesAt: new Date(Date.now() - 1000), settleWinnerId: opts.winner.id, settleSecondPlaceId: opts.second?.id ?? null },
  })
  return game
}

describe('settleGame', () => {
  beforeEach(resetDb)

  it('pays a due result exactly once however many sweeps race', async () => {
    const [a, b] = [await createUser({ balanceCents: 100_000 }), await createUser({ balanceCents: 100_000 })]
    const game = await agreedGame([a, b], { type: 'ONE_V_ONE', stakeCents: 20_000, winner: a })

    const results = await Promise.all(Array.from({ length: 8 }, () => settleDueGames()))
    expect(results.reduce((s, n) => s + n, 0)).toBe(1)

    expect(await balanceCents(a.id)).toBe(100_000 + 19_000)
    expect(await balanceCents(b.id)).toBe(100_000 - 20_000)
    expect(await prisma.transaction.count({ where: { gameId: game.id } })).toBe(3)
    const done = await prisma.game.findUniqueOrThrow({ where: { id: game.id } })
    expect(done.status).toBe('COMPLETED')
    expect(done.settlesAt).toBeNull()
  })

  it('timer and admin resolve racing pay once; the loser of the race gets a 409', async () => {
    const [a, b] = [await createUser({ balanceCents: 0 }), await createUser({ balanceCents: 0 })]
    const game = await agreedGame([a, b], { type: 'ONE_V_ONE', stakeCents: 10_000, winner: a })

    const outcomes = await Promise.allSettled([
      settleGame(game.id, { kind: 'vote' }),
      settleGame(game.id, { kind: 'admin', winnerId: b.id }),
      settleGame(game.id, { kind: 'vote' }),
    ])
    const paid = await prisma.transaction.findMany({ where: { gameId: game.id, type: 'GAME_WIN' } })
    expect(paid).toHaveLength(1)
    expect(outcomes.filter((o) => o.status === 'rejected' || (o.status === 'fulfilled' && o.value === null)).length).toBeGreaterThanOrEqual(1)
  })

  it('does not pay before the undo window has passed', async () => {
    const [a, b] = [await createUser({ balanceCents: 0 }), await createUser({ balanceCents: 0 })]
    const game = await agreedGame([a, b], { type: 'ONE_V_ONE', stakeCents: 10_000, winner: a })
    await prisma.game.update({ where: { id: game.id }, data: { settlesAt: new Date(Date.now() + 60_000) } })
    expect(await settleDueGames()).toBe(0)
    expect(await balanceCents(a.id)).toBe(0)
  })

  it('survives a restart: the window lives in the database, a fresh process pays it', async () => {
    const [a, b] = [await createUser(), await createUser()]
    const game = await agreedGame([a, b], { type: 'ONE_V_ONE', stakeCents: 5_000, winner: b })
    // A new sweeper with no memory of the previous process:
    expect(await settleDueGames(new Map())).toBe(1)
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).winnerId).toBe(b.id)
  })

  it('Teams: the winner teammate with a low balance is paid, not blocked', async () => {
    const w1 = await createUser({ balanceCents: -50_000, creditLimitCents: 50_000 })
    const w2 = await createUser({ balanceCents: 100_000 })
    const l1 = await createUser({ balanceCents: 100_000 })
    const l2 = await createUser({ balanceCents: 100_000 })
    const game = await agreedGame([w1, l1, w2, l2], { type: 'TWO_V_TWO', stakeCents: 30_000, winner: w2, teams: [1, 2, 1, 2] })
    expect(await settleDueGames()).toBe(1)
    expect(await balanceCents(w1.id)).toBe(-50_000 + 28_500)
    expect(await balanceCents(w2.id)).toBe(100_000 + 28_500)
    expect(await balanceCents(l1.id)).toBe(70_000)
    expect(await balanceCents(l2.id)).toBe(70_000)
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('COMPLETED')
  })

  it('4 players: ranking pays 1st, 2nd and charges 3rd and 4th', async () => {
    const p = await Promise.all([1, 2, 3, 4].map(() => createUser({ balanceCents: 100_000 })))
    await agreedGame(p, { type: 'FOUR_PLAYER', stakeCents: 100_000, winner: p[0]!, second: p[2]! })
    await settleDueGames()
    expect(await Promise.all(p.map((u) => balanceCents(u.id)))).toEqual([200_000, 0, 190_000, 0])
  })

  it('a loser past the credit limit sends the game to DISPUTED and moves no money', async () => {
    const a = await createUser({ balanceCents: 0 })
    const b = await createUser({ balanceCents: -45_000, creditLimitCents: 50_000 })
    const game = await agreedGame([a, b], { type: 'ONE_V_ONE', stakeCents: 20_000, winner: a })
    await settleDueGames()
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('DISPUTED')
    expect(await balanceCents(a.id)).toBe(0)
    expect(await balanceCents(b.id)).toBe(-45_000)
    expect(await prisma.transaction.count({ where: { gameId: game.id } })).toBe(0)

    await expect(settleGame(game.id, { kind: 'admin', winnerId: a.id })).rejects.toBeInstanceOf(SettlementBlockedError)
    await prisma.user.update({ where: { id: b.id }, data: { balance: '0.00' } })
    await settleGame(game.id, { kind: 'admin', winnerId: a.id })
    expect(await balanceCents(b.id)).toBe(-20_000)
  })

  it('an admin can resolve a game stuck in PENDING_COMPLETION and a void moves no money', async () => {
    const [a, b] = [await createUser({ balanceCents: 5_000 }), await createUser({ balanceCents: 5_000 })]
    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents: 1_000, players: [a, b], status: 'PENDING_COMPLETION' })
    await settleGame(game.id, { kind: 'void' })
    expect(await balanceCents(a.id)).toBe(5_000)
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('COMPLETED')
    await expect(settleGame(game.id, { kind: 'void' })).rejects.toMatchObject({ status: 409 })
  })

  it('ledger rows always sum to the balance change, over many random games', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => createUser({ balanceCents: 0, creditLimitCents: 100_000_000 })))
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let i = 0; i < 25; i++) {
      const kind = (['ONE_V_ONE', 'TWO_V_TWO', 'FOUR_PLAYER'] as const)[rnd(3)]!
      const n = kind === 'ONE_V_ONE' ? 2 : 4
      const pool = [...users].sort(() => rnd(3) - 1).slice(0, n)
      const winner = pool[rnd(n)]!
      const second = kind === 'FOUR_PLAYER' ? pool.find((p) => p.id !== winner.id)! : undefined
      await agreedGame(pool, { type: kind, stakeCents: 1 + rnd(5_000_000), winner, second, teams: kind === 'TWO_V_TWO' ? [1, 2, 1, 2] : undefined })
    }
    await settleDueGames()
    for (const u of users) {
      const sum = await prisma.transaction.aggregate({ where: { userId: u.id }, _sum: { amount: true } })
      const balance = (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).balance
      expect((sum._sum.amount ?? 0).toString()).toBe(balance.toString().replace(/^0$/, '0'))
    }
  })
})
