import prisma, { lockGame } from '../lib/prisma'
import { GameStatus, GameType } from '../../generated/prisma'
import { GAME } from '../config/limits'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors'
import { emitToAdmin, emitToUsers } from '../lib/socket'

export const OPEN_GAME_STATUSES: GameStatus[] = [GameStatus.ACTIVE, GameStatus.PENDING_COMPLETION]

export const gameInclude = {
  players: { include: { user: { select: { id: true, username: true } } } },
  screenshots: true,
  ping: { include: { fromUser: { select: { id: true, username: true } } } },
} as const

export async function setRoomCode(gameId: string, userId: string, code: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { ping: true, players: true } })
  if (!game) throw notFound('Game not found')
  if (game.ping.fromUserId !== userId) throw forbidden('Only the game initiator can set the room code')
  if (game.status !== GameStatus.ACTIVE) throw conflict('The game is no longer active')
  const claimed = await prisma.game.updateMany({ where: { id: gameId, ludoRoomCode: null, status: GameStatus.ACTIVE }, data: { ludoRoomCode: code } })
  if (claimed.count === 0) throw conflict('Room code already set')
  emitToUsers(game.players.map((p) => p.userId), 'game:roomcode', { gameId, ludoRoomCode: code })
  return prisma.game.findUniqueOrThrow({ where: { id: gameId }, include: gameInclude })
}

export async function markDone(gameId: string, userId: string): Promise<void> {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { players: true } })
  if (!game) throw notFound('Game not found')
  if (!game.players.some((p) => p.userId === userId)) throw forbidden()
  const claimed = await prisma.game.updateMany({
    where: { id: gameId, status: GameStatus.ACTIVE },
    data: { status: GameStatus.PENDING_COMPLETION },
  })
  if (claimed.count === 0) throw conflict('Game is not active')
  emitToUsers(game.players.map((p) => p.userId), 'game:done', { gameId })
}

export type VoteResult =
  | { status: 'waiting_for_others' }
  | { status: 'disputed' }
  | { status: 'settling'; winnerId: string; secondPlaceId: string | null; settlesAt: Date; undoWindowMs: number }

/**
 * Records one player's vote. The game row is locked for the whole step, so the last two voters are
 * serialised and exactly one of them sees "everybody is done" and starts the undo window.
 */
export async function castVote(
  gameId: string,
  userId: string,
  winnerId: string,
  secondPlaceId: string | null,
): Promise<{ result: VoteResult; playerIds: string[] }> {
  return prisma.$transaction(async (tx) => {
    await lockGame(tx, gameId)
    const game = await tx.game.findUnique({ where: { id: gameId }, include: { players: true, screenshots: true } })
    if (!game) throw notFound('Game not found')
    const me = game.players.find((p) => p.userId === userId)
    if (!me) throw forbidden()
    if (game.status !== GameStatus.PENDING_COMPLETION) throw conflict('Game is not pending completion')
    if (me.isDone) throw conflict('You already voted. Undo your vote first to change it.')

    const playerIds = game.players.map((p) => p.userId)
    if (!playerIds.includes(winnerId)) throw badRequest('winnerId must be a player in this game')
    if (game.gameType === GameType.FOUR_PLAYER) {
      if (!secondPlaceId) throw badRequest('secondPlaceId required for 4v2 game')
      if (secondPlaceId === winnerId) throw badRequest('secondPlaceId must differ from winnerId')
      if (!playerIds.includes(secondPlaceId)) throw badRequest('secondPlaceId must be a player in this game')
    } else {
      secondPlaceId = null
    }
    if (winnerId === userId && !game.screenshots.some((s) => s.userId === userId)) {
      throw badRequest('Upload a screenshot before confirming your win')
    }

    await tx.gamePlayer.update({
      where: { id: me.id },
      data: { isDone: true, confirmedWinnerId: winnerId, confirmedSecondPlaceId: secondPlaceId },
    })

    const votes = game.players.map((p) => (p.id === me.id ? { winner: winnerId, second: secondPlaceId, done: true } : { winner: p.confirmedWinnerId, second: p.confirmedSecondPlaceId, done: p.isDone }))
    if (!votes.every((v) => v.done)) return { result: { status: 'waiting_for_others' }, playerIds }

    const agreed = votes.every((v) => v.winner === votes[0]!.winner && v.second === votes[0]!.second)
    if (!agreed) {
      await tx.game.update({ where: { id: gameId }, data: { status: GameStatus.DISPUTED, settlesAt: null, settleWinnerId: null, settleSecondPlaceId: null } })
      return { result: { status: 'disputed' }, playerIds }
    }

    const settlesAt = new Date(Date.now() + GAME.undoWindowMs)
    await tx.game.update({
      where: { id: gameId },
      data: { settlesAt, settleWinnerId: votes[0]!.winner, settleSecondPlaceId: votes[0]!.second },
    })
    return {
      result: { status: 'settling', winnerId: votes[0]!.winner!, secondPlaceId: votes[0]!.second, settlesAt, undoWindowMs: GAME.undoWindowMs },
      playerIds,
    }
  })
}

export function publishVote(gameId: string, result: VoteResult, playerIds: string[]): void {
  if (result.status === 'settling') {
    emitToUsers(playerIds, 'game:settling', {
      gameId,
      winnerId: result.winnerId,
      secondPlaceId: result.secondPlaceId,
      settlesAt: result.settlesAt.getTime(),
    })
  } else if (result.status === 'disputed') {
    emitToUsers(playerIds, 'game:disputed', { gameId })
    emitToAdmin('game:disputed', { gameId })
  } else {
    emitToUsers(playerIds, 'game:vote_cast', { gameId })
  }
}

/** Withdraws the caller's vote and cancels a running undo window. Allowed until the game is paid out. */
export async function retractVote(gameId: string, userId: string): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await lockGame(tx, gameId)
    const game = await tx.game.findUnique({ where: { id: gameId }, include: { players: true } })
    if (!game) throw notFound('Game not found')
    const me = game.players.find((p) => p.userId === userId)
    if (!me) throw forbidden()
    if (game.status !== GameStatus.PENDING_COMPLETION) throw conflict('Can only undo while game is pending completion')
    if (!me.isDone) throw conflict('No vote to undo')
    await tx.gamePlayer.update({ where: { id: me.id }, data: { isDone: false, confirmedWinnerId: null, confirmedSecondPlaceId: null } })
    await tx.game.update({ where: { id: gameId }, data: { settlesAt: null, settleWinnerId: null, settleSecondPlaceId: null } })
    return game.players.map((p) => p.userId)
  })
}

/** Counts and checks run in the same lock as the insert so the per-player cap cannot be raced. */
export async function addScreenshot(gameId: string, userId: string, filename: string) {
  return prisma.$transaction(async (tx) => {
    await lockGame(tx, gameId)
    const game = await tx.game.findUnique({ where: { id: gameId }, include: { players: true } })
    if (!game) throw notFound('Game not found')
    if (!game.players.some((p) => p.userId === userId)) throw forbidden()
    if (game.status === GameStatus.COMPLETED) throw conflict('Game is already completed')
    const count = await tx.screenshot.count({ where: { gameId, userId } })
    if (count >= GAME.maxScreenshotsPerPlayerPerGame) throw conflict('Screenshot limit reached for this game')
    return tx.screenshot.create({ data: { gameId, userId, filename } })
  })
}
