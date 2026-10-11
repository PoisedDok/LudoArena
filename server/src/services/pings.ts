import prisma, { lockPing, lockUsers, Tx } from '../lib/prisma'
import { GameStatus, GameType, PingResponse, PingStatus } from '../../generated/prisma'
import { GAME } from '../config/limits'
import { centsToDecimal, decimalToCents, formatCents } from '../lib/money'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors'
import { emitToAdmin, emitToAll, emitToUser, emitToUsers } from '../lib/socket'
import { OPEN_GAME_STATUSES, gameInclude } from './games'
import { requiredPlayerCount } from './settlement'
import { invalidateDashboard } from './dashboard'
import { lockAndReadCommissionSnapshot } from './commissionSettings'

export interface CreatePingInput {
  userId: string
  gameType: GameType
  stakeCents: number
  message?: string
  isBroadcast: boolean
  recipientIds: string[]
}

const userSummary = { select: { id: true, username: true } } as const

async function inOpenGame(tx: Tx, userId: string): Promise<boolean> {
  const row = await tx.gamePlayer.findFirst({ where: { userId, game: { status: { in: OPEN_GAME_STATUSES } } }, select: { id: true } })
  return row !== null
}

interface MoneyUser {
  balance: { toString(): string }
  creditLimit: { toString(): string }
}

/** Would paying `stakeCents` keep the balance within the credit limit? */
export function coversStake(user: MoneyUser, stakeCents: number): boolean {
  return decimalToCents(user.balance) - stakeCents >= -decimalToCents(user.creditLimit)
}

export async function createPing(input: CreatePingInput) {
  const { userId, gameType, stakeCents, message, isBroadcast, recipientIds } = input

  const { ping, sender, becameActive } = await prisma.$transaction(async (tx) => {
    await lockUsers(tx, [userId])
    const sender = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    const spendLimit = decimalToCents(sender.spendLimit)
    if (stakeCents > spendLimit) throw badRequest(`Stake exceeds your spend limit (${formatCents(spendLimit)})`)
    if (!coversStake(sender, stakeCents)) throw badRequest('Your balance and credit limit do not cover this stake')
    if (await inOpenGame(tx, userId)) throw conflict('You are already in an active game')

    if (!isBroadcast) {
      if (gameType !== GameType.ONE_V_ONE) throw badRequest('Direct pings must be Solo (1v1). Use a broadcast for Teams or 4v2.')
      if (recipientIds.length === 0) throw badRequest('recipientIds required for direct ping')
      if (recipientIds.includes(userId)) throw badRequest('Cannot ping yourself')
      const found = await tx.user.count({ where: { id: { in: recipientIds }, role: 'PLAYER' } })
      if (found !== recipientIds.length) throw badRequest('One or more recipients do not exist')
    }

    // Sending a request implies being available.
    const becameActive = !sender.isActive
    if (becameActive) await tx.user.update({ where: { id: userId }, data: { isActive: true } })

    const ping = await tx.ping.create({
      data: {
        fromUserId: userId,
        gameType,
        stake: centsToDecimal(stakeCents),
        message: message ?? null,
        isBroadcast,
        expiresAt: new Date(Date.now() + GAME.pingTtlMs),
        recipients: isBroadcast ? undefined : { create: recipientIds.map((rid) => ({ userId: rid })) },
      },
      include: { fromUser: userSummary, recipients: { include: { user: userSummary } } },
    })
    return { ping, sender, becameActive }
  })

  if (becameActive) emitToAll('player:status', { userId, isActive: true, username: sender.username })
  const from = { id: sender.id, username: sender.username }
  if (isBroadcast) {
    const others = await prisma.user.findMany({ where: { isActive: true, role: 'PLAYER', id: { not: userId } }, select: { id: true } })
    emitToUsers(others.map((u) => u.id), 'ping:broadcast_new', { ping, from })
    emitToAdmin('ping:broadcast_new', { ping, from })
  } else {
    emitToUsers(recipientIds, 'ping:received', { ping, from, isBroadcast: false })
  }
  return ping
}

export async function cancelPing(pingId: string, userId: string): Promise<void> {
  const ping = await prisma.ping.findUnique({ where: { id: pingId } })
  if (!ping) throw notFound('Ping not found')
  if (ping.fromUserId !== userId) throw forbidden('Not your ping')
  const claimed = await prisma.ping.updateMany({ where: { id: pingId, status: PingStatus.PENDING }, data: { status: PingStatus.DECLINED } })
  if (claimed.count === 0) throw conflict('Ping is no longer pending')
  emitToAll('ping:broadcast_resolved', { pingId, reason: 'cancelled' })
}

export type RespondStatus = 'ignored' | 'declined' | 'accepted'

export interface RespondOutcome {
  status: RespondStatus
  acceptedCount?: number
  required?: number
  started?: boolean
  /** Set when the answer must be an error even though the transaction committed (the request was cancelled). */
  error?: string
  senderId?: string
  /** The sender is told a direct request was declined. */
  declined?: boolean
  cancelled?: boolean
  isBroadcast?: boolean
  acceptedPlayers?: Array<{ userId: string; username: string }>
  /** A player who had accepted was removed because they no longer qualify. */
  droppedId?: string
  game?: { id: string; players: unknown[] }
  participantIds?: string[]
}

/**
 * Accept or decline a ping. The ping row and every user involved are locked for the whole step, so
 * capacity, team slots, the "one open game per player" rule and the credit checks are decided against
 * the state that is actually committed.
 */
export async function respondToPing(
  pingId: string,
  userId: string,
  response: 'ACCEPTED' | 'DECLINED',
  requestedTeam: number | null,
): Promise<RespondOutcome> {
  return prisma.$transaction(async (tx): Promise<RespondOutcome> => {
    await lockPing(tx, pingId)
    const ping = await tx.ping.findUnique({ where: { id: pingId }, include: { recipients: true } })
    if (!ping) throw notFound('Ping not found')
    if (ping.status !== PingStatus.PENDING) throw conflict('Ping is no longer active')
    if (new Date() > ping.expiresAt) throw conflict('Ping has expired')
    if (ping.fromUserId === userId) throw badRequest('Cannot respond to your own ping')

    const mine = ping.recipients.find((r) => r.userId === userId)
    if (!mine && !ping.isBroadcast) throw forbidden('You were not invited to this ping')

    if (response === 'DECLINED') {
      // Ignoring a broadcast changes nothing: it stays open for everybody else.
      if (!mine) return { status: 'ignored' }
      await tx.pingRecipient.update({ where: { id: mine.id }, data: { response: PingResponse.DECLINED } })
      if (ping.isBroadcast) {
        const accepted = await tx.pingRecipient.findMany({
          where: { pingId, response: PingResponse.ACCEPTED },
          include: { user: { select: { id: true, username: true } } },
        })
        return {
          status: 'declined',
          senderId: ping.fromUserId,
          isBroadcast: true,
          acceptedCount: accepted.length,
          required: requiredPlayerCount(ping.gameType) - 1,
          acceptedPlayers: accepted.map((recipient) => ({ userId: recipient.userId, username: recipient.user.username })),
        }
      }
      const everyoneDeclined = !ping.isBroadcast && ping.recipients.every((r) => r.id === mine.id || r.response === PingResponse.DECLINED)
      if (everyoneDeclined) {
        await tx.ping.update({ where: { id: pingId }, data: { status: PingStatus.DECLINED } })
        return { status: 'declined', declined: true, senderId: ping.fromUserId }
      }
      return { status: 'declined' }
    }

    const others = ping.recipients.filter((r) => r.response === PingResponse.ACCEPTED && r.userId !== userId)
    await lockUsers(tx, [ping.fromUserId, userId, ...others.map((r) => r.userId)])

    const stakeCents = decimalToCents(ping.stake)
    const needed = requiredPlayerCount(ping.gameType) - 1
    if (others.length >= needed) throw conflict('Game is already full')

    const me = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (await inOpenGame(tx, userId)) throw conflict('You are already in an active game')
    if (!coversStake(me, stakeCents)) throw badRequest('Your balance and credit limit do not cover this stake')

    let team: number | null = null
    if (ping.gameType === GameType.TWO_V_TWO) {
      // The sender is on team 1. Each team holds two players: one more on team 1, two on team 2.
      const free = { 1: 1 - others.filter((r) => r.team === 1).length, 2: 2 - others.filter((r) => r.team === 2).length }
      if (requestedTeam !== null) {
        if (requestedTeam !== 1 && requestedTeam !== 2) throw badRequest('team must be 1 or 2')
        if (free[requestedTeam] <= 0) throw conflict(`Team ${requestedTeam} is full`)
        team = requestedTeam
      } else {
        team = free[1] > 0 ? 1 : 2
      }
    }

    if (mine) await tx.pingRecipient.update({ where: { id: mine.id }, data: { response: PingResponse.ACCEPTED, team } })
    else await tx.pingRecipient.create({ data: { pingId, userId, response: PingResponse.ACCEPTED, team } })

    const acceptedCount = others.length + 1
    if (acceptedCount < needed) {
      const acceptedPlayers = ping.isBroadcast
        ? await tx.pingRecipient.findMany({
          where: { pingId, response: PingResponse.ACCEPTED },
          include: { user: { select: { id: true, username: true } } },
        })
        : []
      return {
        status: 'accepted',
        acceptedCount,
        required: needed,
        started: false,
        senderId: ping.fromUserId,
        isBroadcast: ping.isBroadcast,
        acceptedPlayers: acceptedPlayers.map((recipient) => ({ userId: recipient.userId, username: recipient.user.username })),
      }
    }

    // Enough players: re-verify everyone against the committed state before the game exists.
    const players = [...others.map((r) => ({ userId: r.userId, team: r.team })), { userId, team }]
    const users = await tx.user.findMany({ where: { id: { in: [ping.fromUserId, ...players.map((p) => p.userId)] } } })
    const byId = new Map(users.map((u) => [u.id, u]))
    if (!coversStake(byId.get(ping.fromUserId)!, stakeCents) || (await inOpenGame(tx, ping.fromUserId))) {
      await tx.ping.update({ where: { id: pingId }, data: { status: PingStatus.DECLINED } })
      return { status: 'declined', cancelled: true, error: 'The sender can no longer start this game. The request was cancelled.' }
    }
    for (const p of players) {
      if (p.userId === userId) continue
      if (!coversStake(byId.get(p.userId)!, stakeCents) || (await inOpenGame(tx, p.userId))) {
        await tx.pingRecipient.updateMany({ where: { pingId, userId: p.userId }, data: { response: PingResponse.DECLINED } })
        return { status: 'accepted', acceptedCount: acceptedCount - 1, required: needed, started: false, senderId: ping.fromUserId, isBroadcast: ping.isBroadcast, droppedId: p.userId }
      }
    }

    await tx.ping.update({ where: { id: pingId }, data: { status: PingStatus.ACCEPTED } })
    const commissionSnapshot = await lockAndReadCommissionSnapshot(tx, ping.gameType)
    const game = await tx.game.create({
      data: {
        pingId,
        gameType: ping.gameType,
        stake: centsToDecimal(stakeCents),
        status: GameStatus.ACTIVE,
        ...commissionSnapshot,
        players: {
          create: [
            { userId: ping.fromUserId, team: ping.gameType === GameType.TWO_V_TWO ? 1 : null },
            ...players.map((p) => ({ userId: p.userId, team: p.team })),
          ],
        },
      },
      // The same shape as GET /api/games/:id, so the client can show the game straight from the event.
      include: gameInclude,
    })
    return {
      status: 'accepted',
      acceptedCount,
      required: needed,
      started: true,
      isBroadcast: ping.isBroadcast,
      game,
      participantIds: [ping.fromUserId, ...players.map((p) => p.userId)],
    }
  })
}

export function publishResponse(pingId: string, userId: string, o: RespondOutcome): void {
  if (o.declined && o.senderId) emitToUser(o.senderId, 'ping:declined', { pingId, byUserId: userId })
  if (o.cancelled) emitToAll('ping:broadcast_resolved', { pingId, reason: 'cancelled' })
  if (o.droppedId) emitToUser(o.droppedId, 'ping:declined', { pingId, byUserId: o.droppedId })
  if (o.isBroadcast && !o.started && o.acceptedCount !== undefined) {
    emitToAll('ping:broadcast_update', { pingId, acceptedCount: o.acceptedCount, required: o.required })
    if (o.senderId) emitToUser(o.senderId, 'ping:partially_accepted', {
      pingId,
      acceptedCount: o.acceptedCount,
      required: o.required,
      acceptedPlayers: o.acceptedPlayers ?? [],
    })
  }
  if (o.game && o.participantIds) {
    invalidateDashboard()
    emitToUsers(o.participantIds, 'ping:accepted', { pingId, game: o.game })
    emitToAll('ping:broadcast_resolved', { pingId, reason: 'started', gameId: o.game.id })
  }
}
