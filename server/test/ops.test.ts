import { beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import { Client } from 'pg'
import bcrypt from 'bcryptjs'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { ensureAdmin } from '../src/scripts/seed'
import { setAdminPassword } from '../src/scripts/admin-password'
import { startServer } from '../src/server'
import { settleDueGames } from '../src/lib/jobs'
import { createUser, login, randomSecret, resetDb, TestUser } from './helpers'
import { pngBytes } from './images'

describe('admin seed', () => {
  beforeEach(resetDb)

  it('creates the first admin once and never touches an existing one', async () => {
    const password = randomSecret()
    const first = await ensureAdmin('owner_1', password)
    expect(first).toEqual({ created: true, username: 'owner_1' })
    const row = await prisma.user.findUniqueOrThrow({ where: { username: 'owner_1' } })
    expect(row.role).toBe('ADMIN')
    expect(await bcrypt.compare(password, row.passwordHash)).toBe(true)

    const second = await ensureAdmin('someone_else', randomSecret())
    expect(second).toEqual({ created: false, username: 'owner_1' })
    const after = await prisma.user.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.passwordHash).toBe(row.passwordHash)
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1)
  })

  it.each([
    ['no username', undefined, 'longenoughpass'],
    ['no password', 'owner_1', undefined],
    ['short password', 'owner_1', 'short'],
    ['a known weak password', 'owner_1', 'admin123'],
    ['a bad username', 'a b', 'longenoughpass'],
  ])('refuses to create an admin with %s', async (_label, username, password) => {
    await expect(ensureAdmin(username, password)).rejects.toThrow(/cannot be created/)
    expect(await prisma.user.count()).toBe(0)
  })
})

describe('admin password change', () => {
  beforeEach(resetDb)

  it('sets a new password and signs every existing session out', async () => {
    const { app } = createApp()
    const admin = await createUser({ role: 'ADMIN' })
    const session = await login(app, admin)
    expect((await session.get('/api/auth/me')).status).toBe(200)

    const next = randomSecret()
    expect(await setAdminPassword(next, admin.username)).toBe(admin.username)

    expect((await session.get('/api/auth/me')).status).toBe(401)
    expect((await request(app).post('/api/auth/login').send({ username: admin.username, password: admin.password })).status).toBe(401)
    expect((await request(app).post('/api/auth/login').send({ username: admin.username, password: next })).status).toBe(200)
  })

  it('refuses a short password, an unknown admin and an ambiguous choice', async () => {
    await createUser({ role: 'ADMIN' })
    await expect(setAdminPassword('short')).rejects.toThrow(/at least/)
    await expect(setAdminPassword(randomSecret(), 'nobody')).rejects.toThrow(/No matching/)
    await createUser({ role: 'ADMIN' })
    await expect(setAdminPassword(randomSecret())).rejects.toThrow(/Several admins/)
  })
})

describe('start-up', () => {
  beforeEach(resetDb)

  it('marks everybody inactive: nobody is connected after a restart', async () => {
    const [a, b] = await Promise.all([createUser({ isActive: true }), createUser({ isActive: true })])
    const running = await startServer({ port: 0, jobs: false })
    try {
      const rows = await prisma.user.findMany({ where: { id: { in: [a.id, b.id] } } })
      expect(rows.every((r) => !r.isActive)).toBe(true)
    } finally {
      await running.shutdown()
    }
  })

  it('shutdown flips readiness and closes the listener', async () => {
    const running = await startServer({ port: 0, jobs: false })
    const url = `http://127.0.0.1:${running.port}/api/ready`
    expect((await fetch(url)).status).toBe(200)
    const closing = running.shutdown()
    expect(running.built.state.shuttingDown).toBe(true)
    await closing
    await expect(fetch(url)).rejects.toThrow()
  })
})

describe('migrate script', () => {
  const serverDir = path.resolve(__dirname, '..')

  async function withDatabase<T>(fn: (url: string, client: Client) => Promise<T>): Promise<T> {
    const adminUrl = process.env.DATABASE_ADMIN_URL!
    const name = `ludo_migrate_${randomSecret().slice(0, 10)}`
    const admin = new Client({ connectionString: adminUrl })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    const client = new Client({ connectionString: url.toString() })
    await client.connect()
    try {
      return await fn(url.toString(), client)
    } finally {
      await client.end()
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    }
  }

  const migrate = (databaseUrl: string) =>
    spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), '-T', 'src/scripts/migrate.ts'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 120_000,
    })

  it('baselines a database created by the old `db push` image, keeps its data and applies the rest', async () => {
    await withDatabase(async (url, client) => {
      const baseline = fs.readFileSync(path.join(serverDir, 'prisma/migrations/0001_init/migration.sql'), 'utf8')
      await client.query(baseline)
      await client.query(`INSERT INTO "User" ("id","username","passwordHash","balance","updatedAt") VALUES ('legacy1','legacy_player','x',12.5,now())`)
      await client.query(`
        INSERT INTO "Ping" ("id","fromUserId","gameType","stake","expiresAt")
        VALUES ('legacy_ping_solo','legacy1','ONE_V_ONE',200,now()), ('legacy_ping_four','legacy1','FOUR_PLAYER',200,now())
      `)
      await client.query(`
        INSERT INTO "Game" ("id","internalRef","pingId","gameType","stake")
        VALUES ('legacy_game_solo','legacy_ref_solo','legacy_ping_solo','ONE_V_ONE',200),
               ('legacy_game_four','legacy_ref_four','legacy_ping_four','FOUR_PLAYER',200)
      `)

      const run = migrate(url)
      expect(run.status, run.stdout + run.stderr).toBe(0)
      expect(run.stdout).toContain('baselining 0001_init')

      const applied = await client.query(`SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`)
      expect(applied.rows.map((r) => r.migration_name)).toEqual([
        '0001_init',
        '0002_exact_money_and_settlement_state',
        '0003_sessions',
        '0004_commission_settings',
      ])
      const user = await client.query(`SELECT "balance"::text AS balance, "tokenVersion" FROM "User" WHERE "id" = 'legacy1'`)
      expect(user.rows[0]).toEqual({ balance: '12.50', tokenVersion: 0 })
      const snapshots = await client.query(`
        SELECT "id", "commissionTierThresholdCents", "commissionHighRateBps", "commissionLowRateBps", "commissionFourPlayerSecondBps"
        FROM "Game" ORDER BY "id"
      `)
      expect(snapshots.rows).toEqual([
        { id: 'legacy_game_four', commissionTierThresholdCents: null, commissionHighRateBps: null, commissionLowRateBps: null, commissionFourPlayerSecondBps: 1000 },
        { id: 'legacy_game_solo', commissionTierThresholdCents: 50000, commissionHighRateBps: 500, commissionLowRateBps: 300, commissionFourPlayerSecondBps: null },
      ])

      const again = migrate(url)
      expect(again.status, again.stdout + again.stderr).toBe(0)
      expect(again.stdout).not.toContain('baselining')
    })
  }, 180_000)

  it('builds an empty database from scratch, and fails (non-zero) when the database is unreachable', async () => {
    await withDatabase(async (url, client) => {
      const run = migrate(url)
      expect(run.status, run.stdout + run.stderr).toBe(0)
      const tables = await client.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('User','Game','IdempotencyKey')`)
      expect(tables.rows[0].n).toBe(3)
    })
    const broken = migrate('postgresql://nobody:nothing@127.0.0.1:1/none')
    expect(broken.status).not.toBe(0)
  }, 180_000)
})

describe('money conservation under concurrency', () => {
  beforeEach(resetDb)

  async function playGame(app: ReturnType<typeof createApp>['app'], players: TestUser[], type: 'ONE_V_ONE' | 'FOUR_PLAYER', stake: number, winner: number, second: number, retract: boolean) {
    const agents = await Promise.all(players.map((p) => login(app, p)))
    const [senderAgent, ...joiners] = agents
    const ping = (await senderAgent!.post('/api/pings').send({ gameType: type, stake, isBroadcast: true })).body.data
    await Promise.all(joiners.map((a) => a.patch(`/api/pings/${ping.id}/respond`).send({ response: 'ACCEPTED' })))
    const game = (await senderAgent!.get('/api/games')).body.data[0] as { id: string }
    await senderAgent!.patch(`/api/games/${game.id}/done`)
    await agents[winner]!.post(`/api/games/${game.id}/screenshots`).attach('screenshot', pngBytes(), { filename: 'w.png', contentType: 'image/png' })
    const body = { winnerId: players[winner]!.id, ...(type === 'FOUR_PLAYER' ? { secondPlaceId: players[second]!.id } : {}) }
    await Promise.all(agents.map((a) => a.post(`/api/games/${game.id}/confirm`).send(body)))
    if (retract) {
      await Promise.all([agents[0]!.delete(`/api/games/${game.id}/confirm`), agents[1]!.delete(`/api/games/${game.id}/confirm`)])
      await Promise.all([agents[0]!, agents[1]!].map((a) => a.post(`/api/games/${game.id}/confirm`).send(body)))
    }
    return game.id
  }

  it('concurrent games, retracts, deposits and adjustments leave balances equal to the ledger, and wins equal losses', async () => {
    const { app } = createApp()
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const lanes = await Promise.all(Array.from({ length: 3 }, () => Promise.all(Array.from({ length: 2 }, () => createUser({ isActive: true })))))
    const quad = await Promise.all(Array.from({ length: 4 }, () => createUser({ isActive: true })))
    const everyone = [...lanes.flat(), ...quad]
    for (const u of everyone) await admin.patch(`/api/players/${u.id}/balance`).send({ amount: 5000 })

    const noise = Promise.all(
      everyone.flatMap((u) => [
        admin.patch(`/api/players/${u.id}/balance`).send({ amount: 12.34 }),
        login(app, u).then((a) => a.post('/api/deposits').field('amount', '77.7').attach('screenshot', pngBytes(), { filename: 'd.png', contentType: 'image/png' })),
      ]),
    )
    const games = await Promise.all([
      ...lanes.map((pair, i) => playGame(app, pair, 'ONE_V_ONE', 100 + i * 450, i % 2, 0, i === 0)),
      playGame(app, quad, 'FOUR_PLAYER', 250, 2, 1, true),
    ])
    await noise

    await prisma.game.updateMany({ where: { id: { in: games } }, data: { settlesAt: new Date(Date.now() - 1) } })
    const sweeps = await Promise.all([settleDueGames(), settleDueGames(), settleDueGames()])
    expect(sweeps.reduce((a, b) => a + b, 0)).toBe(games.length)
    expect(await prisma.game.count({ where: { id: { in: games }, status: 'COMPLETED' } })).toBe(games.length)

    const sum = async (type: string) => (await prisma.transaction.aggregate({ where: { type: type as never }, _sum: { amount: true } }))._sum.amount?.toNumber() ?? 0
    expect(Math.round(((await sum('GAME_WIN')) + (await sum('GAME_LOSS'))) * 100)).toBe(0)
    expect(await sum('COMMISSION')).toBeLessThan(0)

    const balances = await prisma.user.aggregate({ _sum: { balance: true } })
    const ledger = await prisma.transaction.aggregate({ _sum: { amount: true } })
    expect(balances._sum.balance!.toString()).toBe(ledger._sum.amount!.toString())
    for (const u of everyone) {
      const rows = await prisma.transaction.aggregate({ where: { userId: u.id }, _sum: { amount: true } })
      const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
      expect(rows._sum.amount!.toString(), u.username).toBe(user.balance.toString())
    }
    // Each game paid exactly one winner set: one row per player per game result.
    expect(await prisma.transaction.count({ where: { type: 'GAME_WIN', gameId: { in: games } } })).toBe(3 + 2)
  })
})
