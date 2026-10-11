import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { io as connect, Socket } from 'socket.io-client'
import request from 'supertest'
import { startServer, RunningServer } from '../src/server'
import prisma from '../src/lib/prisma'
import { createUser, resetDb, TestUser } from './helpers'

let running: RunningServer
const sockets: Socket[] = []

beforeEach(async () => {
  await resetDb()
  running = await startServer({ port: 0, jobs: false })
})

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect()
  await running.shutdown()
})

async function cookieFor(user: TestUser): Promise<string> {
  const res = await request(running.built.app).post('/api/auth/login').send({ username: user.username, password: user.password })
  return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!
}

async function open(user: TestUser): Promise<{ socket: Socket; cookie: string; events: Array<[string, unknown]> }> {
  const cookie = await cookieFor(user)
  const socket = connect(`http://127.0.0.1:${running.port}`, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false })
  const events: Array<[string, unknown]> = []
  socket.onAny((name, payload) => events.push([name, payload]))
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('connect_error', reject)
  })
  return { socket, cookie, events }
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

describe('socket authentication', () => {
  it('refuses a connection without a session, with a forged token, or after the account was reset', async () => {
    const user = await createUser()
    const anonymous = connect(`http://127.0.0.1:${running.port}`, { transports: ['websocket'], reconnection: false })
    sockets.push(anonymous)
    await expect(new Promise((_, reject) => anonymous.once('connect_error', reject))).rejects.toThrow(/Unauthorized/)

    const forged = connect(`http://127.0.0.1:${running.port}`, { extraHeaders: { cookie: 'token=abc.def.ghi' }, transports: ['websocket'], reconnection: false })
    sockets.push(forged)
    await expect(new Promise((_, reject) => forged.once('connect_error', reject))).rejects.toThrow(/Unauthorized/)

    const { cookie } = await open(user)
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } })
    const stale = connect(`http://127.0.0.1:${running.port}`, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false })
    sockets.push(stale)
    await expect(new Promise((_, reject) => stale.once('connect_error', reject))).rejects.toThrow(/Unauthorized/)
  })

  it('a password reset disconnects the live sockets of that user', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const victim = await createUser()
    const { socket } = await open(victim)
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve))
    const adminCookie = await cookieFor(admin)
    const res = await request(running.built.app).put(`/api/players/${victim.id}`).set('Cookie', adminCookie).send({ password: 'a-new-long-password' })
    expect(res.status).toBe(200)
    expect(await disconnected).toBe('io server disconnect')
  })

})

describe('sign out', () => {
  it('drops the socket of the browser that signed out and keeps the user\'s other browser connected', async () => {
    const user = await createUser()
    const phone = await open(user)
    const laptop = await open(user)
    const dropped = new Promise<string>((resolve) => phone.socket.once('disconnect', resolve))
    const res = await request(running.built.app).post('/api/auth/logout').set('Cookie', phone.cookie)
    expect(res.status).toBe(200)
    expect(await dropped).toBe('io server disconnect')
    await settle()
    expect(laptop.socket.connected).toBe(true)

    // The signed-out token cannot open a new socket either.
    const again = connect(`http://127.0.0.1:${running.port}`, { extraHeaders: { cookie: phone.cookie }, transports: ['websocket'], reconnection: false })
    sockets.push(again)
    await expect(new Promise((_, reject) => again.once('connect_error', reject))).rejects.toThrow(/Unauthorized/)
  })
})

describe('room isolation', () => {
  it('sends accepted broadcast player names only to the broadcaster', async () => {
    const [sender, joiner, observer] = await Promise.all([1, 2, 3].map(() => createUser({ balanceCents: 100_000, isActive: true })))
    const senderSocket = await open(sender!)
    const joinerSocket = await open(joiner!)
    const observerSocket = await open(observer!)

    const created = await request(running.built.app)
      .post('/api/pings')
      .set('Cookie', senderSocket.cookie)
      .send({ gameType: 'TWO_V_TWO', stake: 100, isBroadcast: true })
    expect(created.status).toBe(201)

    const joined = await request(running.built.app)
      .patch(`/api/pings/${created.body.data.id}/respond`)
      .set('Cookie', joinerSocket.cookie)
      .send({ response: 'ACCEPTED' })
    expect(joined.status).toBe(200)
    await settle()

    const senderEvent = senderSocket.events.find(([name]) => name === 'ping:partially_accepted')
    expect(senderEvent?.[1]).toMatchObject({
      pingId: created.body.data.id,
      acceptedCount: 1,
      required: 3,
      acceptedPlayers: [{ userId: joiner!.id, username: joiner!.username }],
    })
    expect(joinerSocket.events.some(([name]) => name === 'ping:partially_accepted')).toBe(false)
    expect(observerSocket.events.some(([name]) => name === 'ping:partially_accepted')).toBe(false)
  })

  it('a player receives only their own events: balance, pings, deposits stay private', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const [alice, bob, carol] = await Promise.all([1, 2, 3].map(() => createUser({ balanceCents: 100_000, isActive: true })))
    const a = await open(alice!)
    const b = await open(bob!)
    const c = await open(carol!)
    const adm = await open(admin)

    const adminCookie = await cookieFor(admin)
    const server = running.built.app
    await request(server).patch(`/api/players/${alice!.id}/balance`).set('Cookie', adminCookie).send({ amount: 10 })
    const direct = await request(server).post('/api/pings').set('Cookie', a.cookie).send({ gameType: 'ONE_V_ONE', stake: 10, recipientIds: [bob!.id] })
    expect(direct.status).toBe(201)
    await settle()

    const names = (e: typeof a.events) => e.map(([n]) => n)
    expect(names(a.events)).toContain('balance:updated')
    expect(names(b.events)).toContain('ping:received')
    expect(names(b.events)).not.toContain('balance:updated')
    expect(names(c.events)).not.toContain('ping:received')
    expect(names(c.events)).not.toContain('balance:updated')
    expect(names(adm.events)).not.toContain('ping:received')

    // Deposit notifications go to the admin room only.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('proof-' + Math.random())])
    await request(server).post('/api/deposits').set('Cookie', c.cookie).field('amount', '10').attach('screenshot', png, { filename: 'p.png', contentType: 'image/png' })
    await settle()
    expect(names(adm.events)).toContain('deposit:new')
    expect(names(a.events)).not.toContain('deposit:new')
    expect(names(b.events)).not.toContain('deposit:new')
  })

  it('a client cannot join another room or make the server emit', async () => {
    const [alice, bob] = await Promise.all([1, 2].map(() => createUser({ isActive: true })))
    const a = await open(alice!)
    const b = await open(bob!)
    a.socket.emit('join', `user:${bob!.id}`)
    a.socket.emit('admin', {})
    a.socket.emit('ping:received', { fake: true })
    await settle()
    // Settlement is addressed to rooms by user id: Bob is not in any game with Alice.
    expect(b.events.map(([n]) => n)).not.toContain('ping:received')
  })

  it('game events reach the players of that game only, and payloads carry only the receiver balance', async () => {
    const [p1, p2, outsider] = await Promise.all([1, 2, 3].map(() => createUser({ balanceCents: 100_000, isActive: true })))
    const s1 = await open(p1!)
    const s2 = await open(p2!)
    const so = await open(outsider!)
    const game = await prisma.game.create({
      data: {
        ping: { create: { fromUserId: p1!.id, gameType: 'ONE_V_ONE', stake: '100.00', expiresAt: new Date() } },
        gameType: 'ONE_V_ONE',
        stake: '100.00',
        commissionTierThresholdCents: 50_000,
        commissionHighRateBps: 500,
        commissionLowRateBps: 300,
        commissionFourPlayerSecondBps: null,
        status: 'PENDING_COMPLETION',
        settlesAt: new Date(Date.now() - 1),
        settleWinnerId: p1!.id,
        players: { create: [{ userId: p1!.id }, { userId: p2!.id }] },
      },
    })
    const { settleDueGames } = await import('../src/lib/jobs')
    expect(await settleDueGames()).toBe(1)
    await settle()
    const done1 = s1.events.find(([n]) => n === 'game:completed')![1] as Record<string, unknown>
    const done2 = s2.events.find(([n]) => n === 'game:completed')![1] as Record<string, unknown>
    expect(done1.gameId).toBe(game.id)
    expect(done1.balance).toBe(1095)
    expect(done2.balance).toBe(900)
    expect(done1).not.toHaveProperty('balances')
    expect(so.events.map(([n]) => n)).not.toContain('game:completed')
    expect(so.events.map(([n]) => n)).not.toContain('balance:updated')
  })
})
