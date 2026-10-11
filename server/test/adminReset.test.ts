import { randomBytes, randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { GameType } from '../generated/prisma'
import { buildApp, createGame, createUser, login, resetDb } from './helpers'
import prisma from '../src/lib/prisma'
import { uploadsDir } from '../src/middleware/upload'

const app = buildApp()

beforeEach(resetDb)

describe('admin data reset', () => {
  it('requires an admin and an exact confirmation phrase', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const player = await createUser()
    const adminAgent = await login(app, admin)
    const playerAgent = await login(app, player)

    expect((await request(app).post('/api/admin/settings/reset')).status).toBe(401)
    expect((await playerAgent.post('/api/admin/settings/reset').send({ confirmation: 'RESET' })).status).toBe(403)
    expect((await adminAgent.post('/api/admin/settings/reset').send({ confirmation: 'reset' })).status).toBe(400)
    expect((await adminAgent.post('/api/admin/settings/reset').send({ confirmation: 'RESET', extra: true })).status).toBe(400)
    expect(await prisma.user.count()).toBe(2)
  })

  it('clears operational records and images while preserving accounts, credentials, and archive status', async () => {
    const admin = await createUser({ role: 'ADMIN', balanceCents: 25_000, isActive: true })
    const player = await createUser({
      balanceCents: 8_000, creditLimitCents: 12_345, spendLimitCents: 23_456,
      username: `keep${randomUUID().slice(0, 8)}`, phone: '+919876543210', isActive: true,
    })
    const archived = await createUser({ balanceCents: 9_000, isActive: true })
    const purged = await createUser({ balanceCents: 7_000, isActive: true })
    const archivedAt = new Date('2025-01-02T03:04:05.000Z')
    const purgedAt = new Date('2025-02-03T04:05:06.000Z')
    await prisma.user.update({ where: { id: archived.id }, data: { deletedAt: archivedAt } })
    await prisma.user.update({
      where: { id: purged.id },
      data: { deletedAt: archivedAt, permanentlyPurgedAt: purgedAt, phone: null },
    })

    const originalUsers = await prisma.user.findMany({
      where: { id: { in: [admin.id, player.id, archived.id, purged.id] } },
      orderBy: { id: 'asc' },
    })
    const adminAgent = await login(app, admin)
    await login(app, player)

    const game = await createGame({ gameType: 'ONE_V_ONE', stakeCents: 1_000, players: [player, archived] })
    const uploadName = `${randomUUID()}.png`
    const unrelatedName = `keep-${randomUUID()}.txt`
    const incomingName = `keep-${randomUUID()}`
    const uploadPath = path.join(uploadsDir(), uploadName)
    const unrelatedPath = path.join(uploadsDir(), unrelatedName)
    const incomingPath = path.join(uploadsDir(), '.incoming', incomingName)
    await fs.mkdir(path.dirname(incomingPath), { recursive: true })
    await Promise.all([
      fs.writeFile(uploadPath, 'test screenshot'),
      fs.writeFile(unrelatedPath, 'unrelated upload content'),
      fs.writeFile(incomingPath, 'in-flight upload content'),
    ])

    await prisma.screenshot.create({ data: { gameId: game.id, userId: player.id, filename: uploadName } })
    await prisma.depositRequest.create({
      data: { userId: player.id, amount: '50.00', screenshotFilename: uploadName },
    })
    await prisma.transaction.create({
      data: { userId: player.id, amount: '25.00', type: 'ADMIN_CREDIT', gameId: game.id, screenshotFilename: uploadName },
    })
    await prisma.pingRecipient.create({
      data: { pingId: game.pingId, userId: archived.id, response: 'ACCEPTED' },
    })
    await prisma.idempotencyKey.create({
      data: { userId: player.id, key: randomUUID(), method: 'POST', path: '/api/deposits', status: 201, response: {} },
    })
    await prisma.shareLoginLink.create({
      data: {
        userId: player.id,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const settingsUpdate = await adminAgent.put('/api/admin/settings/commission/ONE_V_ONE').send({
      tierThresholdCents: 10_000, highRateBps: 900, lowRateBps: 800,
    })
    expect(settingsUpdate.status).toBe(200)

    const response = await adminAgent.post('/api/admin/settings/reset').send({ confirmation: 'RESET' })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ ok: true })

    const usersAfter = await prisma.user.findMany({
      where: { id: { in: [admin.id, player.id, archived.id, purged.id] } },
      orderBy: { id: 'asc' },
    })
    expect(usersAfter).toHaveLength(4)
    for (let index = 0; index < originalUsers.length; index++) {
      const before = originalUsers[index]!
      const after = usersAfter[index]!
      expect(after).toMatchObject({
        id: before.id,
        username: before.username,
        phone: before.phone,
        passwordHash: before.passwordHash,
        tokenVersion: before.tokenVersion,
        deletedAt: before.deletedAt,
        permanentlyPurgedAt: before.permanentlyPurgedAt,
      })
    }
    const adminAfter = usersAfter.find((user) => user.id === admin.id)!
    expect(adminAfter.balance.toNumber()).toBe(250)
    expect(adminAfter.isActive).toBe(true)
    for (const user of usersAfter.filter((entry) => entry.role === 'PLAYER')) {
      expect(user).toMatchObject({ balance: 0, creditLimit: 500, spendLimit: 1000, isActive: false })
    }
    expect(usersAfter.find((user) => user.id === archived.id)?.deletedAt).toEqual(archivedAt)
    expect(usersAfter.find((user) => user.id === purged.id)?.permanentlyPurgedAt).toEqual(purgedAt)

    expect(await prisma.game.count()).toBe(0)
    expect(await prisma.gamePlayer.count()).toBe(0)
    expect(await prisma.ping.count()).toBe(0)
    expect(await prisma.pingRecipient.count()).toBe(0)
    expect(await prisma.transaction.count()).toBe(0)
    expect(await prisma.depositRequest.count()).toBe(0)
    expect(await prisma.screenshot.count()).toBe(0)
    expect(await prisma.idempotencyKey.count()).toBe(0)
    expect(await prisma.shareLoginLink.count()).toBe(0)
    expect(await prisma.session.count()).toBe(2)
    expect(await prisma.commissionSettingChange.count()).toBe(0)

    const defaults = await prisma.commissionSetting.findMany()
    expect(defaults).toHaveLength(3)
    expect(defaults.find((setting) => setting.gameType === GameType.ONE_V_ONE)).toMatchObject({
      tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300, updatedById: null,
    })
    expect(defaults.find((setting) => setting.gameType === GameType.TWO_V_TWO)).toMatchObject({
      tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300, updatedById: null,
    })
    expect(defaults.find((setting) => setting.gameType === GameType.FOUR_PLAYER)).toMatchObject({
      fourPlayerSecondBps: 1_000, updatedById: null,
    })

    await expect(fs.access(uploadPath)).rejects.toThrow()
    await expect(fs.access(unrelatedPath)).resolves.toBeUndefined()
    await expect(fs.access(incomingPath)).resolves.toBeUndefined()
    expect((await adminAgent.get('/api/auth/me')).status).toBe(200)

    await Promise.all([fs.unlink(unrelatedPath), fs.unlink(incomingPath)])
  })
})
