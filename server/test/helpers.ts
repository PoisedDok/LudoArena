import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { Express } from 'express'
import prisma from '../src/lib/prisma'
import { createApp } from '../src/app'
import { centsToDecimal } from '../src/lib/money'
import { GameType, GameStatus, Role } from '../generated/prisma'
import { lockAndReadCommissionSnapshot } from '../src/services/commissionSettings'

export const randomSecret = (): string => randomBytes(12).toString('hex')

export function buildApp(): Express {
  return createApp().app
}

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Session","IdempotencyKey","Screenshot","Transaction","DepositRequest","GamePlayer","Game","PingRecipient","Ping","CommissionSettingChange","CommissionSetting","User" RESTART IDENTITY CASCADE',
  )
  await prisma.commissionSetting.createMany({
    data: [
      { gameType: GameType.ONE_V_ONE, tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300 },
      { gameType: GameType.TWO_V_TWO, tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300 },
      { gameType: GameType.FOUR_PLAYER, fourPlayerSecondBps: 1_000 },
    ],
  })
}

export interface TestUser {
  id: string
  username: string
  password: string
  role: 'ADMIN' | 'PLAYER'
}

let counter = 0

export async function createUser(opts: {
  role?: 'ADMIN' | 'PLAYER'
  balanceCents?: number
  creditLimitCents?: number
  spendLimitCents?: number
  username?: string
  phone?: string
  isActive?: boolean
} = {}): Promise<TestUser> {
  const password = randomSecret()
  const username = opts.username ?? `user${++counter}x${randomBytes(3).toString('hex')}`
  const user = await prisma.user.create({
    data: {
      username,
      phone: opts.phone,
      passwordHash: bcrypt.hashSync(password, 4),
      role: opts.role === 'ADMIN' ? Role.ADMIN : Role.PLAYER,
      balance: centsToDecimal(opts.balanceCents ?? 0),
      creditLimit: centsToDecimal(opts.creditLimitCents ?? 50_000),
      spendLimit: centsToDecimal(opts.spendLimitCents ?? 100_000),
      isActive: opts.isActive ?? false,
    },
  })
  return { id: user.id, username, password, role: opts.role ?? 'PLAYER' }
}

/** A supertest agent that carries the session cookie of a real login. */
export async function login(app: Express, user: TestUser, remember = false) {
  const agent = request.agent(app)
  const res = await agent.post('/api/auth/login').send({ username: user.username, password: user.password, remember })
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`)
  return agent
}

export async function balanceCents(userId: string): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  return Math.round(user.balance.toNumber() * 100)
}

/** Creates an ACTIVE game (ping, players, teams) directly in the database. */
export async function createGame(opts: {
  gameType: 'ONE_V_ONE' | 'TWO_V_TWO' | 'FOUR_PLAYER'
  stakeCents: number
  players: TestUser[]
  teams?: Array<number | null>
  status?: 'ACTIVE' | 'PENDING_COMPLETION' | 'DISPUTED'
}) {
  const [initiator] = opts.players
  const ping = await prisma.ping.create({
    data: {
      fromUserId: initiator!.id,
      gameType: GameType[opts.gameType],
      stake: centsToDecimal(opts.stakeCents),
      isBroadcast: opts.gameType !== 'ONE_V_ONE',
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() + 60_000),
    },
  })
  return prisma.$transaction(async (tx) => {
    const gameType = GameType[opts.gameType]
    const commission = await lockAndReadCommissionSnapshot(tx, gameType)
    return tx.game.create({
      data: {
      pingId: ping.id,
      gameType,
      stake: centsToDecimal(opts.stakeCents),
      status: GameStatus[opts.status ?? 'ACTIVE'],
      ...commission,
      players: {
        create: opts.players.map((p, i) => ({ userId: p.id, team: opts.teams ? (opts.teams[i] ?? null) : null })),
      },
      },
      include: { players: true },
    })
  })
}
