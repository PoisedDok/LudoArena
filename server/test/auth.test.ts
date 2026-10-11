import { beforeEach, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import prisma from '../src/lib/prisma'
import { createApp, PUBLIC_ROUTES } from '../src/app'
import { signToken } from '../src/lib/jwt'
import { createUser, login, randomSecret, resetDb } from './helpers'

const cookieHeader = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []

describe('login', () => {
  beforeEach(resetDb)

  it('accepts a username, a phone number and a differently capitalised username', async () => {
    const { app } = createApp()
    const user = await createUser({ username: 'Rahul_7', phone: '9876543210' })
    for (const id of [user.username, '9876543210', 'rahul_7']) {
      const res = await request(app).post('/api/auth/login').send({ username: id, password: user.password })
      expect(res.status, id).toBe(200)
      expect(res.body.data.id).toBe(user.id)
      expect(res.body.data).not.toHaveProperty('token')
      expect(res.body.data).not.toHaveProperty('passwordHash')
    }
  })

  it('answers every failure the same way', async () => {
    const { app } = createApp()
    const user = await createUser()
    const wrongPassword = await request(app).post('/api/auth/login').send({ username: user.username, password: 'nope-nope' })
    const unknownUser = await request(app).post('/api/auth/login').send({ username: 'nobody-here', password: 'nope-nope' })
    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(unknownUser.body).toEqual(wrongPassword.body)
  })

  it.each([
    ['missing fields', {}],
    ['numbers', { username: 5, password: 6 }],
    ['objects (NoSQL style)', { username: { $ne: '' }, password: { $ne: '' } }],
    ['empty password', { username: 'x', password: '' }],
  ])('rejects malformed input: %s', async (_label, payload) => {
    const { app } = createApp()
    const res = await request(app).post('/api/auth/login').send(payload)
    expect([400, 401]).toContain(res.status)
  })

  it('"remember me" gives a persistent cookie, otherwise a browser-session cookie', async () => {
    const { app } = createApp()
    const user = await createUser()
    const remembered = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password, remember: true })
    const session = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password })
    const rem = cookieHeader(remembered)[0]!
    const ses = cookieHeader(session)[0]!
    expect(rem).toMatch(/Max-Age=2592000/)
    expect(ses).not.toMatch(/Max-Age|Expires/)
    for (const c of [rem, ses]) {
      expect(c).toMatch(/HttpOnly/)
      expect(c).toMatch(/SameSite=Lax/)
    }
  })

  it('the token lifetime follows the choice (30 days vs 1 day)', async () => {
    const { app } = createApp()
    const user = await createUser()
    const ttl = async (remember: boolean) => {
      const res = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password, remember })
      const token = /token=([^;]+)/.exec(cookieHeader(res)[0]!)![1]!
      const claims = jwt.decode(token) as { iat: number; exp: number }
      return claims.exp - claims.iat
    }
    expect(await ttl(true)).toBe(30 * 24 * 3600)
    expect(await ttl(false)).toBe(24 * 3600)
  })

  it('share links rotate, expire, grant a remembered session once, and cannot be replayed', async () => {
    const { app } = createApp()
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const player = await createUser()
    const createLink = async () => {
      const res = await admin.post(`/api/players/${player.id}/share-link`)
      expect(res.status).toBe(200)
      return res.body.data as { token: string; expiresAt: string }
    }

    const oldLink = await createLink()
    const activeLink = await createLink()
    const recipient = request.agent(app)
    expect((await recipient.post('/api/auth/share-login').send({ token: oldLink.token })).status).toBe(401)

    const signedIn = await recipient.post('/api/auth/share-login').send({ token: activeLink.token })
    expect(signedIn.status).toBe(200)
    expect(signedIn.body.data.id).toBe(player.id)
    expect(cookieHeader(signedIn)[0]).toMatch(/Max-Age=2592000/)
    expect((await recipient.get('/api/auth/me')).body.data.id).toBe(player.id)
    expect((await recipient.post('/api/auth/share-login').send({ token: activeLink.token })).status).toBe(401)
    expect((await prisma.shareLoginLink.findUniqueOrThrow({ where: { userId: player.id } })).consumedAt).toBeInstanceOf(Date)

    const expired = await createLink()
    await prisma.shareLoginLink.update({
      where: { userId: player.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    })
    expect((await request(app).post('/api/auth/share-login').send({ token: expired.token })).status).toBe(401)
    expect(Date.parse(activeLink.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('redeeming one share link concurrently creates exactly one session', async () => {
    const { app } = createApp()
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const player = await createUser()
    const link = await admin.post(`/api/players/${player.id}/share-link`)
    const attempts = await Promise.all([
      request(app).post('/api/auth/share-login').send({ token: link.body.data.token }),
      request(app).post('/api/auth/share-login').send({ token: link.body.data.token }),
    ])
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 401])
    expect(await prisma.session.count({ where: { userId: player.id } })).toBe(1)
  })

  it('only failed attempts count towards the limit, and the limit is per IP', async () => {
    const { app } = createApp()
    const user = await createUser()
    for (let i = 0; i < 12; i++) {
      const ok = await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ username: user.username, password: user.password })
      expect(ok.status).toBe(200)
    }
    let last = 0
    for (let i = 0; i < 11; i++) {
      last = (await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ username: 'ghost', password: 'wrong-pass' })).status
    }
    expect(last).toBe(429)
    // Same account, another address: not blocked (the per-IP bucket is separate).
    const other = await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.77').send({ username: user.username, password: user.password })
    expect(other.status).toBe(200)
  })

  it('many correct logins at the same moment from one address are never refused', async () => {
    const { app } = createApp()
    const users = await Promise.all(Array.from({ length: 25 }, () => createUser()))
    const results = await Promise.all(
      users.map((u) => request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.50').send({ username: u.username, password: u.password })),
    )
    expect(results.map((r) => r.status)).toEqual(users.map(() => 200))
  })

  it('a block lifts after the window and a successful login clears the account counter', async () => {
    const { FailureLimiter } = await import('../src/lib/failureLimiter')
    const limiter = new FailureLimiter(1000, 3, 4)
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) limiter.recordFailure('a', t0 + i)
    expect(limiter.retryAfterSeconds('a', t0 + 10)).toBeGreaterThan(0)
    expect(limiter.retryAfterSeconds('a', t0 + 1500)).toBe(0)
    limiter.recordFailure('b', t0)
    limiter.clear('b')
    expect(limiter.retryAfterSeconds('b', t0)).toBe(0)
    // Bounded: far more keys than the cap never grow the map past it.
    for (let i = 0; i < 100; i++) limiter.recordFailure(`k${i}`, t0)
    expect(limiter.size).toBeLessThanOrEqual(4)
  })

  it('the rate limit is keyed on the address Cloudflare appended, not on a forged one', async () => {
    const { app } = createApp()
    // One trusted hop: the rightmost entry is the client. The attacker varies the forged left part only.
    let last = 0
    for (let i = 0; i < 11; i++) {
      last = (await request(app).post('/api/auth/login').set('X-Forwarded-For', `10.0.0.${i}, 198.51.100.5`).send({ username: `ghost${i}`, password: 'wrong-pass' })).status
    }
    expect(last).toBe(429)
  })
})

describe('sessions', () => {
  beforeEach(resetDb)

  it('rejects a missing, malformed, forged, wrong-algorithm and expired token', async () => {
    const { app } = createApp()
    const user = await createUser()
    const live = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) } })
    const claims = { userId: user.id, role: 'PLAYER' as const, tv: 0, sid: live.id }
    const forged = jwt.sign(claims, randomSecret(), { algorithm: 'HS256', issuer: 'ludo-arena' })
    const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, iss: 'ludo-arena' })).toString('base64url')}.`
    const expired = jwt.sign(claims, process.env.JWT_SECRET!, { algorithm: 'HS256', issuer: 'ludo-arena', expiresIn: -10 })
    const wrongIssuer = jwt.sign(claims, process.env.JWT_SECRET!, { algorithm: 'HS256', issuer: 'someone-else' })
    const promoted = jwt.sign({ ...claims, role: 'ADMIN' }, randomSecret(), { algorithm: 'HS256', issuer: 'ludo-arena' })
    for (const token of ['', 'garbage', forged, noneAlg, expired, wrongIssuer, promoted]) {
      const res = await request(app).get('/api/auth/me').set('Cookie', `token=${token}`)
      expect(res.status).toBe(401)
    }
    const good = await request(app).get('/api/auth/me').set('Cookie', `token=${signToken(claims, 60)}`)
    expect(good.status).toBe(200)
  })

  it('a correctly signed token cannot raise the role: the role comes from the database', async () => {
    const { app } = createApp()
    const player = await createUser()
    const session = await prisma.session.create({ data: { userId: player.id, expiresAt: new Date(Date.now() + 60_000) } })
    const token = signToken({ userId: player.id, role: 'ADMIN', tv: 0, sid: session.id }, 60)
    const res = await request(app).get('/api/admin/stats').set('Cookie', `token=${token}`)
    expect(res.status).toBe(403)
  })

  it('a password reset ends old sessions; archiving preserves login and the current session', async () => {
    const { app } = createApp()
    const admin = await createUser({ role: 'ADMIN' })
    const player = await createUser()
    const adminAgent = await login(app, admin)
    const playerAgent = await login(app, player)
    expect((await playerAgent.get('/api/auth/me')).status).toBe(200)

    const newPassword = randomSecret()
    expect((await adminAgent.put(`/api/players/${player.id}`).send({ password: newPassword })).status).toBe(200)
    expect((await playerAgent.get('/api/auth/me')).status).toBe(401)
    const again = await request(app).post('/api/auth/login').send({ username: player.username, password: newPassword })
    expect(again.status).toBe(200)

    const doomed = await createUser()
    const doomedAgent = await login(app, doomed)
    expect((await adminAgent.delete(`/api/players/${doomed.id}`)).status).toBe(200)
    expect((await doomedAgent.get('/api/auth/me')).body.data.deletedAt).toBeTruthy()
    expect(await prisma.session.count({ where: { userId: doomed.id } })).toBe(1)
  })

  /** The raw token of a fresh login, so a test can replay it exactly as a thief would (no cookie jar). */
  async function rawToken(app: ReturnType<typeof createApp>['app'], user: { username: string; password: string }): Promise<string> {
    const res = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password })
    return /token=([^;]+)/.exec(cookieHeader(res)[0]!)![1]!
  }
  const replay = (app: ReturnType<typeof createApp>['app'], token: string) => request(app).get('/api/auth/me').set('Cookie', `token=${token}`)

  it('a copied token stops working at sign out, and only that browser is signed out', async () => {
    const { app } = createApp()
    const user = await createUser()
    const phone = await rawToken(app, user)
    const laptop = await rawToken(app, user)
    expect((await replay(app, phone)).status).toBe(200)

    expect((await request(app).post('/api/auth/logout').set('Cookie', `token=${phone}`)).status).toBe(200)
    expect((await replay(app, phone)).status).toBe(401)
    expect((await replay(app, laptop)).status).toBe(200)
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1)
  })

  it('a copied token stops working after password reset and permanent cleanup, not soft archive', async () => {
    const { app } = createApp()
    const admin = await createUser({ role: 'ADMIN' })
    const adminAgent = await login(app, admin)
    const player = await createUser()
    const token = await rawToken(app, player)
    const shareLink = await adminAgent.post(`/api/players/${player.id}/share-link`)
    expect((await replay(app, token)).status).toBe(200)
    expect((await adminAgent.put(`/api/players/${player.id}`).send({ password: randomSecret() })).status).toBe(200)
    expect((await replay(app, token)).status).toBe(401)
    expect((await request(app).post('/api/auth/share-login').send({ token: shareLink.body.data.token })).status).toBe(401)

    const doomed = await createUser()
    const doomedToken = await rawToken(app, doomed)
    const doomedShareLink = await adminAgent.post(`/api/players/${doomed.id}/share-link`)
    expect((await adminAgent.delete(`/api/players/${doomed.id}`)).status).toBe(200)
    expect((await replay(app, doomedToken)).status).toBe(200)
    expect((await request(app).post('/api/auth/share-login').send({ token: doomedShareLink.body.data.token })).status).toBe(401)
    expect((await adminAgent.delete(`/api/players/${doomed.id}/permanent-cleanup`)).status).toBe(200)
    expect((await replay(app, doomedToken)).status).toBe(401)
    expect(await prisma.session.count({ where: { userId: doomed.id } })).toBe(0)
  })

  it('an expired session row is refused even with a valid signature', async () => {
    const { app } = createApp()
    const user = await createUser()
    const token = await rawToken(app, user)
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await replay(app, token)).status).toBe(401)
  })

  it('logout clears the cookie, even with an invalid session, and marks the player inactive', async () => {
    const { app } = createApp()
    const player = await createUser({ isActive: true })
    const agent = await login(app, player)
    const res = await agent.post('/api/auth/logout')
    expect(res.status).toBe(200)
    expect(cookieHeader(res)[0]).toMatch(/token=;/)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).isActive).toBe(false)
    expect((await request(app).post('/api/auth/logout').set('Cookie', 'token=junk')).status).toBe(200)
  })
})

describe('every API route requires a session (and admin routes an admin)', () => {
  beforeEach(resetDb)

  it('answers 401 without a session on all but the public routes, 403 for a player on admin routes', async () => {
    const { app, routers } = createApp()
    const player = await createUser()
    const playerAgent = await login(app, player)
    const seen: string[] = []

    for (const { prefix, router } of routers) {
      for (const layer of (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack) {
        if (!layer.route) continue
        const url = `${prefix}${layer.route.path === '/' ? '' : layer.route.path.replace(/:\w+/g, 'someid')}`
        for (const method of Object.keys(layer.route.methods)) {
          const key = `${method.toUpperCase()} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`
          seen.push(key)
          if (PUBLIC_ROUTES.has(key)) continue
          const anonymous = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(url).send({})
          expect(anonymous.status, `anonymous ${key}`).toBe(401)
          if (prefix === '/api/admin' || key.includes('PATCH /api/deposits/admin') || key.includes('GET /api/deposits/admin')) {
            const asPlayer = await (playerAgent as unknown as Record<string, (u: string) => request.Test>)[method]!(url).send({})
            expect(asPlayer.status, `player ${key}`).toBe(403)
          }
        }
      }
    }
    expect(seen.length).toBeGreaterThan(25)
    for (const open of PUBLIC_ROUTES) expect(seen).toContain(open)
  })
})
