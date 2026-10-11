import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { io as connect, Socket } from 'socket.io-client'
import request from 'supertest'
import { startServer, RunningServer } from '../src/server'
import prisma from '../src/lib/prisma'
import { settleDueGames } from '../src/lib/jobs'
import { checkShape, Contract, Shape } from '../../contracts/shape'
import contractJson from '../../contracts/api-shapes.json'
import { createUser, resetDb, TestUser } from './helpers'
import { pngBytes } from './images'

const contract = contractJson as unknown as Contract

/** Asserts a value against the shared contract and fails with every mismatching path. */
function conforms(shapeName: string, value: unknown, kind: 'endpoints' | 'socket' = 'endpoints'): void {
  const shape = contract[kind][shapeName] as Shape | undefined
  if (!shape) throw new Error(`No shape named ${shapeName}`)
  expect(checkShape(value, shape, contract.types), `${kind}/${shapeName}`).toEqual([])
}

let running: RunningServer
let admin: TestUser
let p1: TestUser
let p2: TestUser
const sockets: Socket[] = []
const events = new Map<string, Array<{ who: string; payload: unknown }>>()

async function cookie(user: TestUser): Promise<string> {
  const res = await request(running.built.app).post('/api/auth/login').send({ username: user.username, password: user.password })
  return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!
}

async function listen(who: string, user: TestUser, c: string): Promise<void> {
  const socket = connect(`http://127.0.0.1:${running.port}`, { extraHeaders: { cookie: c }, transports: ['websocket'], reconnection: false })
  socket.onAny((name: string, payload: unknown) => {
    const list = events.get(name) ?? []
    list.push({ who, payload })
    events.set(name, list)
  })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('connect_error', reject)
  })
}

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  await resetDb()
  running = await startServer({ port: 0, jobs: false })
  admin = await createUser({ role: 'ADMIN' })
  p1 = await createUser({ balanceCents: 100_000 })
  p2 = await createUser({ balanceCents: 100_000 })
}, 60_000)

afterAll(async () => {
  for (const s of sockets) s.disconnect()
  await running.shutdown()
})

describe('API and socket payloads match contracts/api-shapes.json', () => {
  it('a full game flow, deposit review and the admin dashboard', async () => {
    const app = running.built.app
    const [c1, c2, ca] = await Promise.all([cookie(p1), cookie(p2), cookie(admin)])
    await Promise.all([listen('p1', p1, c1), listen('p2', p2, c2), listen('admin', admin, ca)])
    const as = (c: string) => ({
      get: (url: string) => request(app).get(url).set('Cookie', c),
      post: (url: string) => request(app).post(url).set('Cookie', c),
      patch: (url: string) => request(app).patch(url).set('Cookie', c),
    })
    const P1 = as(c1)
    const P2 = as(c2)
    const A = as(ca)

    // session
    const login = await request(app).post('/api/auth/login').send({ username: p1.username, password: p1.password })
    conforms('auth.login', login.body.data)
    conforms('auth.me', (await P1.get('/api/auth/me')).body.data)

    // players
    await P1.patch(`/api/players/${p1.id}/active`).send({ isActive: true })
    await P2.patch(`/api/players/${p2.id}/active`).send({ isActive: true })
    const publicList = (await P1.get('/api/players')).body.data
    expect(publicList.length).toBeGreaterThan(1)
    conforms('players.list.public', publicList)
    const adminList = (await A.get('/api/players')).body.data
    expect(adminList.length).toBeGreaterThan(1)
    conforms('players.list.admin', adminList)
    conforms('players.detail.full', (await P1.get(`/api/players/${p1.id}`)).body.data)

    // direct ping -> accept -> game
    const ping = await P1.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 200, recipientIds: [p2.id] })
    conforms('pings.create', ping.body.data)
    const pingList = (await P1.get('/api/pings')).body.data
    expect(pingList.length).toBeGreaterThan(0)
    conforms('pings.list', pingList)
    const accept = await P2.patch(`/api/pings/${ping.body.data.id}/respond`).send({ response: 'ACCEPTED' })
    conforms('pings.respond', accept.body.data)

    const gameList = (await P1.get('/api/games')).body.data
    expect(gameList.length).toBe(1)
    conforms('games.list', gameList)
    const gameId = gameList[0].id as string
    conforms('games.detail', (await P1.get(`/api/games/${gameId}`)).body.data)

    await P1.patch(`/api/games/${gameId}/roomcode`).send({ ludoRoomCode: 'AB12CD34' })
    await P1.patch(`/api/games/${gameId}/done`).send({})
    await request(app).post(`/api/games/${gameId}/screenshots`).set('Cookie', c1).attach('screenshot', pngBytes(), { filename: 'w.png', contentType: 'image/png' })
    const withShot = (await P1.get(`/api/games/${gameId}`)).body.data
    expect(withShot.screenshots.length).toBe(1)
    conforms('games.detail', withShot)

    const waiting = await P1.post(`/api/games/${gameId}/confirm`).send({ winnerId: p1.id })
    conforms('games.confirm', waiting.body.data)
    const settling = await P2.post(`/api/games/${gameId}/confirm`).send({ winnerId: p1.id })
    expect(settling.body.data.status).toBe('settling')
    conforms('games.confirm', settling.body.data)
    const mid = (await P1.get(`/api/games/${gameId}`)).body.data
    expect(typeof mid.settlesAt).toBe('string')
    conforms('games.detail', mid)

    await prisma.game.update({ where: { id: gameId }, data: { settlesAt: new Date(Date.now() - 1) } })
    expect(await settleDueGames()).toBe(1)
    await wait()

    const history = await P1.get(`/api/players/${p1.id}/transactions`)
    expect(history.body.data.length).toBe(2)
    conforms('players.transactions', history.body.data)
    expect(typeof history.body.meta.closingBalance).toBe('number')

    // deposit and review
    const deposit = await request(app).post('/api/deposits').set('Cookie', c1).field('amount', '75.5').attach('screenshot', pngBytes(), { filename: 'p.png', contentType: 'image/png' })
    expect(deposit.status).toBe(201)
    conforms('deposits.create', deposit.body.data)
    conforms('deposits.mine', (await P1.get('/api/deposits')).body.data)
    const pending = (await A.get('/api/deposits/admin?status=PENDING')).body.data
    expect(pending.length).toBe(1)
    conforms('deposits.admin', pending)
    const review = await A.patch(`/api/deposits/admin/${deposit.body.data.id}`).send({ action: 'APPROVED' })
    conforms('deposits.review', review.body.data)

    // admin screens
    const stats = (await A.get('/api/admin/stats')).body.data
    conforms('admin.stats', stats)
    expect(stats.totals.games).toBe(1)
    expect(stats.live.activePlayers).toBe(2)
    expect(stats.chart.length).toBeGreaterThan(27)
    const adminGames = (await A.get('/api/admin/games')).body.data
    expect(adminGames.games.length).toBe(1)
    conforms('admin.games', adminGames)
    const adminTx = (await A.get('/api/admin/transactions')).body.data
    expect(adminTx.transactions.length).toBeGreaterThan(0)
    conforms('admin.transactions', adminTx)

    // a broadcast for the live list and its socket events
    const blocked = await P2.post('/api/pings').send({ gameType: 'ONE_V_ONE', stake: 50, isBroadcast: true })
    expect(blocked.status).toBe(201)
    const broadcasts = (await A.get('/api/admin/broadcasts')).body.data
    expect(broadcasts.length).toBe(1)
    conforms('admin.broadcasts', broadcasts)
    await wait(500)

    // socket payloads the client handles
    const seen = (name: string) => (events.get(name) ?? []).map((e) => e.payload)
    for (const name of ['ping:received', 'ping:broadcast_new', 'ping:accepted', 'ping:broadcast_resolved', 'game:roomcode', 'game:done', 'game:settling', 'game:completed', 'balance:updated', 'player:status', 'deposit:new', 'deposit:approved']) {
      const payloads = seen(name)
      expect(payloads.length, `socket event ${name} was emitted`).toBeGreaterThan(0)
      for (const payload of payloads) conforms(name, payload, 'socket')
    }
  }, 60_000)
})
