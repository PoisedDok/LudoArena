import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { balanceCents, createUser, login, resetDb } from './helpers'
import { jpegBytes, pngBytes, webpBytes } from './images'

const { app } = createApp()
const uploads = path.join(process.cwd(), 'uploads')

async function submit(agent: request.Agent, amount: string | number, file: Buffer = pngBytes(), type = 'image/png', name = 'proof.png') {
  return agent.post('/api/deposits').field('amount', String(amount)).attach('screenshot', file, { filename: name, contentType: type })
}

describe('deposit requests', () => {
  beforeEach(resetDb)

  it('accepts a real image and stores it under a random name with the sniffed extension', async () => {
    const agent = await login(app, await createUser())
    const res = await submit(agent, '250.50', jpegBytes(), 'image/jpeg', 'x.png')
    expect(res.status).toBe(201)
    expect(res.body.data.amount).toBe(250.5)
    expect(res.body.data.screenshotFilename).toMatch(/^[0-9a-f-]{36}\.jpg$/)
    expect(fs.existsSync(path.join(uploads, res.body.data.screenshotFilename))).toBe(true)
  })

  it('rejects a script or HTML sent as an image, wrong types, and leaves no file behind', async () => {
    const agent = await login(app, await createUser())
    const stored = () => (fs.existsSync(uploads) ? fs.readdirSync(uploads).filter((n) => n !== '.incoming').length : 0)
    const before = stored()
    const html = await submit(agent, 10, Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 'a.png')
    expect(html.status).toBe(415)
    const svg = await submit(agent, 10, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'a.svg')
    expect(svg.status).toBe(415)
    const pdf = await submit(agent, 10, Buffer.from('%PDF-1.4'), 'application/pdf', 'a.pdf')
    expect(pdf.status).toBe(415)
    const badAmount = await submit(agent, 'abc')
    expect(badAmount.status).toBe(400)
    expect(stored()).toBe(before)
    await new Promise((r) => setTimeout(r, 100))
    const incomingDir = path.join(uploads, '.incoming')
    expect(fs.existsSync(incomingDir) ? fs.readdirSync(incomingDir) : []).toEqual([])
    expect(await prisma.depositRequest.count()).toBe(0)
  })

  it('rejects bad amounts: zero, negative, too many decimals, huge, junk suffix', async () => {
    const agent = await login(app, await createUser())
    for (const amount of ['0', '-5', '1.234', '1e3', '12abc', '1000000.01', '']) {
      expect((await submit(agent, amount)).status, amount).toBe(400)
    }
    expect((await agent.post('/api/deposits').field('amount', '10')).status).toBe(400)
  })

  it('rejects an upload over the size limit with 413', async () => {
    const agent = await login(app, await createUser())
    const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024 * 1024)])
    const res = await submit(agent, 10, huge)
    expect(res.status).toBe(413)
  })

  it('the same payment screenshot cannot back two requests', async () => {
    const agent = await login(app, await createUser())
    const shot = pngBytes()
    expect((await submit(agent, 100, shot)).status).toBe(201)
    const again = await submit(agent, 100, shot)
    expect(again.status).toBe(409)
    expect(await prisma.depositRequest.count()).toBe(1)
  })

  it('a double-tap with one idempotency key creates one request', async () => {
    const agent = await login(app, await createUser())
    const shot = pngBytes()
    const send = () =>
      agent.post('/api/deposits').set('Idempotency-Key', 'deposit-key-1').field('amount', '100').attach('screenshot', shot, { filename: 'p.png', contentType: 'image/png' })
    const [a, b] = await Promise.all([send(), send()])
    // The twin is answered from the stored result (201) or told to retry (409); never a second record.
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true)
    expect(await prisma.depositRequest.count()).toBe(1)
    const replay = await send()
    expect(replay.status).toBe(201)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(await prisma.depositRequest.count()).toBe(1)
  })
})

describe('deposit review', () => {
  beforeEach(resetDb)

  it('concurrent approvals credit the balance exactly once', async () => {
    const player = await createUser({ balanceCents: 1_000 })
    const deposit = (await submit(await login(app, player), '500')).body.data
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const results = await Promise.all(
      Array.from({ length: 6 }, () => admin.patch(`/api/deposits/admin/${deposit.id}`).send({ action: 'APPROVED' })),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(5)
    expect(await balanceCents(player.id)).toBe(51_000)
    expect(await prisma.transaction.count({ where: { userId: player.id } })).toBe(1)
  })

  it('approve and reject racing end in one outcome; a rejected deposit never credits', async () => {
    const player = await createUser()
    const deposit = (await submit(await login(app, player), '100')).body.data
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    const [a, r] = await Promise.all([
      admin.patch(`/api/deposits/admin/${deposit.id}`).send({ action: 'APPROVED' }),
      admin.patch(`/api/deposits/admin/${deposit.id}`).send({ action: 'REJECTED' }),
    ])
    expect([a.status, r.status].sort()).toEqual([200, 409])
    const row = await prisma.depositRequest.findUniqueOrThrow({ where: { id: deposit.id } })
    expect(await balanceCents(player.id)).toBe(row.status === 'APPROVED' ? 10_000 : 0)
  })

  it('validates the review input and unknown ids', async () => {
    const admin = await login(app, await createUser({ role: 'ADMIN' }))
    expect((await admin.patch('/api/deposits/admin/nope').send({ action: 'APPROVED' })).status).toBe(404)
    expect((await admin.patch('/api/deposits/admin/nope').send({ action: 'DELETE' })).status).toBe(400)
    expect((await admin.get('/api/deposits/admin?status=WHATEVER')).status).toBe(400)
  })
})

describe('serving screenshots', () => {
  beforeEach(resetDb)

  it('serves a deposit proof to its owner and the admin only, with safe headers', async () => {
    const owner = await createUser()
    const other = await createUser()
    const admin = await createUser({ role: 'ADMIN' })
    const file = (await submit(await login(app, owner), '100', webpBytes(), 'image/webp', 'p.webp')).body.data.screenshotFilename as string

    const ok = await (await login(app, owner)).get(`/api/files/${file}`)
    expect(ok.status).toBe(200)
    expect(ok.headers['content-type']).toBe('image/webp')
    expect(ok.headers['x-content-type-options']).toBe('nosniff')
    expect(ok.headers['cache-control']).toMatch(/private/)
    expect((await (await login(app, admin)).get(`/api/files/${file}`)).status).toBe(200)
    expect((await (await login(app, other)).get(`/api/files/${file}`)).status).toBe(404)
    expect((await request(app).get(`/api/files/${file}`)).status).toBe(401)
  })

  it('rejects traversal and non-generated names, and the old public path is gone', async () => {
    const agent = await login(app, await createUser({ role: 'ADMIN' }))
    for (const name of ['..%2F..%2Fetc%2Fpasswd', '../package.json', 'index.html', '.env', 'a.png']) {
      const res = await agent.get(`/api/files/${name}`)
      expect(res.status, name).toBe(404)
    }
    expect((await request(app).get('/uploads/anything.png')).status).toBe(404)
  })

  it('a game screenshot is visible to the players of that game, not to other players', async () => {
    const [a, b, c] = await Promise.all([createUser(), createUser(), createUser()])
    const game = await prisma.game.create({
      data: {
        ping: { create: { fromUserId: a.id, gameType: 'ONE_V_ONE', stake: '10.00', expiresAt: new Date() } },
        gameType: 'ONE_V_ONE',
        stake: '10.00',
        commissionTierThresholdCents: 50_000,
        commissionHighRateBps: 500,
        commissionLowRateBps: 300,
        commissionFourPlayerSecondBps: null,
        players: { create: [{ userId: a.id }, { userId: b.id }] },
      },
    })
    const upload = await (await login(app, a)).post(`/api/games/${game.id}/screenshots`).attach('screenshot', pngBytes(), { filename: 'g.png', contentType: 'image/png' })
    const file = upload.body.data.filename as string
    expect((await (await login(app, b)).get(`/api/files/${file}`)).status).toBe(200)
    expect((await (await login(app, c)).get(`/api/files/${file}`)).status).toBe(404)
  })
})
