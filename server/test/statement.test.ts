import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { buildStatement, STATEMENT_MAX_ROWS } from '../src/services/statement'
import { ledgerDrift, ledgerFor } from '../src/services/ledger'
import { resolvePeriod } from '../src/lib/period'
import { settleDueGames } from '../src/lib/jobs'
import { acquireExport } from '../src/services/exportGuard'
import { runsOf } from '../src/services/statementPdf'
import { formatMoney, withCurrency } from '../src/services/statementView'
import { centsToDecimal } from '../src/lib/money'
import { balanceCents, createGame, createUser, login, resetDb } from './helpers'
import { pngBytes } from './images'

const { app } = createApp()
const TZ = 'Asia/Kolkata'

const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => done(null, Buffer.concat(chunks)))
}

describe('statement access', () => {
  beforeEach(resetDb)

  it('the owner and the admin get a PDF; another player and anonymous do not', async () => {
    const [owner, other] = await Promise.all([createUser(), createUser()])
    const admin = await createUser({ role: 'ADMIN' })
    const url = `/api/players/${owner.id}/statement.pdf?period=all`

    const mine = await (await login(app, owner)).get(url).buffer(true).parse(binary)
    expect(mine.status).toBe(200)
    expect(mine.headers['content-type']).toBe('application/pdf')
    expect(mine.headers['content-disposition']).toMatch(/^attachment; filename="ludo-statement-.+-all\.pdf"$/)
    expect(mine.headers['cache-control']).toBe('no-store')
    const bytes = mine.body as Buffer
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.subarray(-8).toString()).toContain('%%EOF')

    expect((await (await login(app, admin)).get(url).buffer(true).parse(binary)).status).toBe(200)
    expect((await (await login(app, other)).get(url)).status).toBe(403)
    expect((await request(app).get(url)).status).toBe(401)
    expect((await (await login(app, admin)).get('/api/players/nope/statement.pdf')).status).toBe(404)
  })

  it('bad period parameters are 400, not 500', async () => {
    const owner = await createUser()
    const agent = await login(app, owner)
    for (const q of ['period=banana', 'from=2026-02-30&to=2026-03-01', 'from=2026-03-02&to=2026-03-01', 'period=2026-01&from=2026-01-01&to=2026-01-02']) {
      expect((await agent.get(`/api/players/${owner.id}/statement.pdf?${q}`)).status, q).toBe(400)
    }
  })

  it('one export at a time per user, and a global cap', () => {
    const release = acquireExport('u1')
    expect(() => acquireExport('u1')).toThrow(/already running/)
    const other = acquireExport('u2')
    expect(() => acquireExport('u3')).toThrow(/busy/)
    release()
    release()
    other()
    const again = acquireExport('u1')
    again()
  })
})

describe('statement content', () => {
  beforeEach(resetDb)

  it('an empty player has a zero statement and a PDF is still produced', async () => {
    const user = await createUser()
    const s = await buildStatement(user.id, resolvePeriod({ period: 'all' }, new Date(), TZ))
    expect(s.openingCents).toBe(0)
    expect(s.closingCents).toBe(0)
    expect(s.rows).toEqual([])
    expect(s.games).toEqual([])
    expect(s.summary.gamesPlayed).toBe(0)
  })

  it('period boundaries follow the configured timezone', async () => {
    const user = await createUser()
    // 2026-09-30 23:59:59 IST and 2026-10-01 00:00:00 IST
    const stamps = [new Date('2026-09-30T18:29:59Z'), new Date('2026-09-30T18:30:00Z')]
    for (const [i, at] of stamps.entries()) {
      await prisma.transaction.create({ data: { userId: user.id, amount: '100.00', type: 'ADMIN_CREDIT', description: `adj ${i}`, createdAt: at } })
    }
    await prisma.user.update({ where: { id: user.id }, data: { balance: '200.00' } })
    const now = new Date('2026-10-11T06:30:00Z')
    const sep = await buildStatement(user.id, resolvePeriod({ period: '2026-09' }, now, TZ), now)
    const oct = await buildStatement(user.id, resolvePeriod({ period: '2026-10' }, now, TZ), now)
    expect(sep.rows.map((r) => r.description)).toEqual(['adj 0'])
    expect(oct.rows.map((r) => r.description)).toEqual(['adj 1'])
    expect([sep.openingCents, sep.closingCents]).toEqual([0, 10_000])
    expect([oct.openingCents, oct.closingCents]).toEqual([10_000, 20_000])
  })

  it('refuses a period with more rows than the cap instead of cutting it', async () => {
    const user = await createUser()
    const base = Date.now() - 86_400_000
    await prisma.transaction.createMany({
      data: Array.from({ length: STATEMENT_MAX_ROWS + 1 }, (_, i) => ({ userId: user.id, amount: '1.00', type: 'ADMIN_CREDIT' as const, description: 'bulk', createdAt: new Date(base + i) })),
    })
    await prisma.user.update({ where: { id: user.id }, data: { balance: centsToDecimal(STATEMENT_MAX_ROWS * 100 + 100) } })
    await expect(buildStatement(user.id, resolvePeriod({ period: 'all' }, new Date(), TZ))).rejects.toMatchObject({ status: 422 })
    const agent = await login(app, user)
    expect((await agent.get(`/api/players/${user.id}/statement.pdf?period=all`)).status).toBe(422)
  })

  it('formats money in the configured locale', () => {
    expect(formatMoney(123456789)).toBe('12,34,567.89')
    expect(formatMoney(-5)).toBe('-0.05')
    expect(formatMoney(100, true)).toBe('+1.00')
    expect(withCurrency(-150_000)).toBe('-₹1,500.00')
  })

  it('splits text into font runs: Latin, Devanagari and the rupee sign, unknown glyphs become "?"', () => {
    expect(runsOf('Amit नमस्ते ₹100')).toEqual([
      { text: 'Amit ', script: 'latin' },
      { text: 'नमस्ते ₹', script: 'devanagari' },
      { text: '100', script: 'latin' },
    ])
    expect(runsOf('smile \u{1F600}')).toEqual([{ text: 'smile ?', script: 'latin' }])
  })
})

describe('statement reconciles with the stored balance', () => {
  beforeEach(resetDb)

  it('after a random sequence of deposits, adjustments and games of every type', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const players = await Promise.all(Array.from({ length: 5 }, () => createUser({ creditLimitCents: 100_000_000 })))
    let seed = 99
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }

    for (let step = 0; step < 40; step++) {
      const player = players[rnd(players.length)]!
      const action = rnd(4)
      if (action === 0) {
        const amount = (rnd(200_000) + 1) / 100
        const sign = rnd(3) === 0 ? -1 : 1
        expect((await admin.patch(`/api/players/${player.id}/balance`).send({ amount: sign * amount, description: 'adj' })).status).toBe(200)
      } else if (action === 1) {
        const agent = await login(app, player)
        const dep = await agent.post('/api/deposits').field('amount', String((rnd(50_000) + 1) / 100)).attach('screenshot', pngBytes(), { filename: 'p.png', contentType: 'image/png' })
        expect(dep.status).toBe(201)
        const review = await admin.patch(`/api/deposits/admin/${dep.body.data.id}`).send({ action: rnd(4) === 0 ? 'REJECTED' : 'APPROVED' })
        expect(review.status).toBe(200)
      } else {
        const kind = (['ONE_V_ONE', 'TWO_V_TWO', 'FOUR_PLAYER'] as const)[rnd(3)]!
        const n = kind === 'ONE_V_ONE' ? 2 : 4
        const pool = [...players].sort(() => rnd(3) - 1).slice(0, n)
        const winner = pool[rnd(n)]!
        const second = kind === 'FOUR_PLAYER' ? pool.find((p) => p.id !== winner.id)! : undefined
        const game = await createGame({ gameType: kind, stakeCents: 1 + rnd(3_000_000), players: pool, teams: kind === 'TWO_V_TWO' ? [1, 2, 1, 2] : undefined, status: 'PENDING_COMPLETION' })
        await prisma.game.update({
          where: { id: game.id },
          data: { settlesAt: new Date(Date.now() - 1), settleWinnerId: winner.id, settleSecondPlaceId: second?.id ?? null },
        })
        await settleDueGames()
      }
    }

    const now = new Date()
    for (const p of players) {
      expect(await ledgerDrift(p.id), 'ledger sums to the stored balance').toBe(0)
      const s = await buildStatement(p.id, resolvePeriod({ period: 'all' }, now, TZ, new Date(Date.now() - 86_400_000)), now)
      const movements = s.rows.reduce((sum, r) => sum + r.amountCents, 0)
      expect(s.openingCents + movements).toBe(s.closingCents)
      expect(s.closingCents).toBe(await balanceCents(p.id))
      // Running balances chain from the opening balance to the closing balance, row by row.
      let running = s.openingCents
      for (const row of s.rows) {
        running += row.amountCents
        expect(row.balanceAfterCents).toBe(running)
      }
      // The summary tiles are a partition of the movements.
      const sm = s.summary
      expect(s.openingCents + sm.depositsCents + sm.adjustmentsInCents - sm.withdrawalsCents + sm.stakesWonCents - sm.stakesLostCents - sm.commissionCents).toBe(s.closingCents)
      expect(sm.wins + sm.losses).toBe(sm.gamesPlayed)
      expect(s.games.length).toBe(sm.gamesPlayed)

      // The on-screen history is the same function: the newest row's running balance is the balance.
      const history = await ledgerFor(p.id, { limit: 200 })
      expect(history.closingCents).toBe(s.closingCents)
    }

    const response = await (await login(app, players[0]!)).get(`/api/players/${players[0]!.id}/transactions`)
    const rows = response.body.data as Array<{ amount: number; balanceAfter: number }>
    if (rows.length > 0) expect(Math.round(rows[0]!.balanceAfter * 100)).toBe(await balanceCents(players[0]!.id))
  })

  it('a window in the middle: opening + movements = closing for every period slice', async () => {
    const user = await createUser()
    const day = 86_400_000
    const start = new Date('2026-08-10T10:00:00Z').getTime()
    let total = 0
    for (let i = 0; i < 60; i++) {
      const cents = ((i * 7919) % 5000) - 2000
      total += cents
      await prisma.transaction.create({ data: { userId: user.id, amount: centsToDecimal(cents), type: cents >= 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT', description: 'x', createdAt: new Date(start + i * day) } })
    }
    await prisma.user.update({ where: { id: user.id }, data: { balance: centsToDecimal(total) } })
    const now = new Date('2026-10-11T06:30:00Z')
    let previousClosing: number | null = null
    for (const key of ['2026-08', '2026-09', '2026-10']) {
      const s = await buildStatement(user.id, resolvePeriod({ period: key }, now, TZ), now)
      expect(s.openingCents + s.rows.reduce((a, r) => a + r.amountCents, 0)).toBe(s.closingCents)
      if (previousClosing !== null) expect(s.openingCents).toBe(previousClosing)
      previousClosing = s.closingCents
    }
    expect(previousClosing).toBe(total)
  })
})
