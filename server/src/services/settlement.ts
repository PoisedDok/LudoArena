import prisma, { lockGame, lockUsers } from '../lib/prisma'
import { GameStatus, GameType, TransactionType } from '../../generated/prisma'
import { COMMISSION } from '../config/limits'
import { centsToDecimal, decimalToCents, formatCents, shareOfCents, tierCommissionCents, tierRatePercent } from '../lib/money'
import { conflict, notFound } from '../lib/errors'
import { emitToAdmin, emitToUser } from '../lib/socket'
import { invalidateDashboard } from './dashboard'

/**
 * The only place that moves game money. `planSettlement` is pure (what each player gets and which ledger
 * rows are written); `settleGame` applies a plan inside one transaction that first claims the game row,
 * so a result can be paid out exactly once however many timers, retries or admin clicks race.
 */

export interface PlanPlayer {
  userId: string
  team: number | null
}

export interface LedgerEntry {
  userId: string
  amountCents: number
  type: TransactionType
  description: string
}

export interface SettlementPlan {
  entries: LedgerEntry[]
  /** Net balance change per player, in cents. Always equals the sum of that player's ledger entries. */
  deltas: Map<string, number>
}

export class InvalidResultError extends Error {}

/** A loser cannot cover the stake within their credit limit. The game goes to the admin. */
export class SettlementBlockedError extends Error {
  constructor(
    message: string,
    public readonly usernames: string[],
  ) {
    super(message)
  }
}

export function requiredPlayerCount(gameType: GameType): number {
  return gameType === GameType.ONE_V_ONE ? 2 : 4
}

export function planSettlement(input: {
  gameType: GameType
  stakeCents: number
  players: PlanPlayer[]
  winnerId: string
  secondPlaceId?: string | null
}): SettlementPlan {
  const { gameType, stakeCents, players, winnerId } = input
  const ids = players.map((p) => p.userId)
  if (stakeCents <= 0) throw new InvalidResultError('Stake must be positive')
  if (players.length !== requiredPlayerCount(gameType)) {
    throw new InvalidResultError(`A ${gameType} game needs ${requiredPlayerCount(gameType)} players, has ${players.length}`)
  }
  if (new Set(ids).size !== ids.length) throw new InvalidResultError('Duplicate player in game')
  if (!ids.includes(winnerId)) throw new InvalidResultError('Winner is not a player in this game')

  const entries: LedgerEntry[] = []
  const deltas = new Map<string, number>(ids.map((id) => [id, 0]))
  const add = (userId: string, amountCents: number, type: TransactionType, description: string) => {
    entries.push({ userId, amountCents, type, description })
    deltas.set(userId, (deltas.get(userId) ?? 0) + amountCents)
  }
  const stake = formatCents(stakeCents)

  if (gameType === GameType.ONE_V_ONE || gameType === GameType.TWO_V_TWO) {
    const label = gameType === GameType.ONE_V_ONE ? 'Solo' : 'Teams'
    const commission = tierCommissionCents(stakeCents)
    const pct = tierRatePercent(stakeCents)
    let winners: PlanPlayer[]
    let losers: PlanPlayer[]
    if (gameType === GameType.ONE_V_ONE) {
      winners = players.filter((p) => p.userId === winnerId)
      losers = players.filter((p) => p.userId !== winnerId)
    } else {
      const team = players.find((p) => p.userId === winnerId)!.team
      if (team !== 1 && team !== 2) throw new InvalidResultError('Teams game has a player without a team')
      winners = players.filter((p) => p.team === team)
      losers = players.filter((p) => p.team !== team)
      if (winners.length !== 2 || losers.length !== 2) throw new InvalidResultError('Teams game needs two players per team')
    }
    for (const w of winners) {
      add(w.userId, stakeCents, TransactionType.GAME_WIN, `Won ${label} · stake ${stake}`)
      add(w.userId, -commission, TransactionType.COMMISSION, `Commission ${pct}% · ${label} · stake ${stake}`)
    }
    for (const l of losers) add(l.userId, -stakeCents, TransactionType.GAME_LOSS, `Lost ${label} · stake ${stake}`)
  } else {
    const second = input.secondPlaceId
    if (!second) throw new InvalidResultError('secondPlaceId required for a 4-player game')
    if (second === winnerId) throw new InvalidResultError('secondPlaceId must differ from winnerId')
    if (!ids.includes(second)) throw new InvalidResultError('Second place is not a player in this game')
    const commission = shareOfCents(stakeCents, COMMISSION.fourPlayerSecondBps)
    add(winnerId, stakeCents, TransactionType.GAME_WIN, `Won 4v2 · 1st place · stake ${stake} · no commission`)
    add(second, stakeCents, TransactionType.GAME_WIN, `4v2 · 2nd place · stake ${stake}`)
    add(second, -commission, TransactionType.COMMISSION, `Commission 10% · 4v2 2nd place · stake ${stake}`)
    for (const l of players.filter((p) => p.userId !== winnerId && p.userId !== second)) {
      add(l.userId, -stakeCents, TransactionType.GAME_LOSS, `Lost 4v2 · stake ${stake}`)
    }
  }
  return { entries, deltas }
}

export type SettleRequest =
  | { kind: 'vote' }
  | { kind: 'admin'; winnerId: string; secondPlaceId?: string | null }
  | { kind: 'void' }

export interface SettleOutcome {
  gameId: string
  playerIds: string[]
  winnerId: string | null
  secondPlaceId: string | null
  voided: boolean
  /** Each player's balance after settlement, in currency units. */
  balances: Record<string, number>
}

const SETTLEABLE_BY_ADMIN: GameStatus[] = [GameStatus.ACTIVE, GameStatus.PENDING_COMPLETION, GameStatus.DISPUTED]

/**
 * Settles a game. `vote` pays the agreed result once its undo window has passed and returns null when
 * there is nothing (any more) to do; `admin` and `void` act on a game that is not completed yet and
 * throw a 409 when it already is.
 */
export async function settleGame(gameId: string, request: SettleRequest): Promise<SettleOutcome | null> {
  return prisma.$transaction(async (tx) => {
    await lockGame(tx, gameId)
    const game = await tx.game.findUnique({ where: { id: gameId }, include: { players: true } })
    if (!game) throw notFound('Game not found')
    const playerIds = game.players.map((p) => p.userId)

    let winnerId: string | null
    let secondPlaceId: string | null
    if (request.kind === 'vote') {
      if (game.status !== GameStatus.PENDING_COMPLETION || !game.settlesAt || game.settlesAt > new Date() || !game.settleWinnerId) {
        return null
      }
      winnerId = game.settleWinnerId
      secondPlaceId = game.settleSecondPlaceId
    } else {
      if (!SETTLEABLE_BY_ADMIN.includes(game.status)) throw conflict('Game is already settled')
      winnerId = request.kind === 'admin' ? request.winnerId : null
      secondPlaceId = request.kind === 'admin' ? (request.secondPlaceId ?? null) : null
    }

    const cleared = { settlesAt: null, settleWinnerId: null, settleSecondPlaceId: null }

    if (winnerId === null) {
      await tx.game.update({ where: { id: gameId }, data: { status: GameStatus.COMPLETED, finishedAt: new Date(), ...cleared } })
      return { gameId, playerIds, winnerId: null, secondPlaceId: null, voided: true, balances: {} }
    }

    const plan = planSettlement({
      gameType: game.gameType,
      stakeCents: decimalToCents(game.stake),
      players: game.players.map((p) => ({ userId: p.userId, team: p.team })),
      winnerId,
      secondPlaceId,
    })

    await lockUsers(tx, playerIds)
    const users = await tx.user.findMany({ where: { id: { in: playerIds } } })
    const blocked: string[] = []
    for (const user of users) {
      const delta = plan.deltas.get(user.id) ?? 0
      if (delta < 0 && decimalToCents(user.balance) + delta < -decimalToCents(user.creditLimit)) blocked.push(user.username)
    }
    if (blocked.length > 0) {
      throw new SettlementBlockedError(`${blocked.join(', ')} would exceed the credit limit`, blocked)
    }

    for (const [userId, delta] of plan.deltas) {
      if (delta !== 0) await tx.user.update({ where: { id: userId }, data: { balance: { increment: centsToDecimal(delta) } } })
    }
    await tx.transaction.createMany({
      data: plan.entries.map((e) => ({
        userId: e.userId,
        gameId,
        amount: centsToDecimal(e.amountCents),
        type: e.type,
        description: e.description,
      })),
    })
    await tx.game.update({
      where: { id: gameId },
      data: { status: GameStatus.COMPLETED, winnerId, secondPlaceId, finishedAt: new Date(), ...cleared },
    })

    const after = await tx.user.findMany({ where: { id: { in: playerIds } }, select: { id: true, balance: true } })
    const balances: Record<string, number> = {}
    for (const u of after) balances[u.id] = u.balance.toNumber()
    return { gameId, playerIds, winnerId, secondPlaceId, voided: false, balances }
  })
}

/** Sends the settlement to the players (their own balance only) and to the admin room. */
export function publishSettlement(outcome: SettleOutcome): void {
  invalidateDashboard()
  for (const userId of outcome.playerIds) {
    emitToUser(userId, 'game:completed', {
      gameId: outcome.gameId,
      winnerId: outcome.winnerId,
      secondPlaceId: outcome.secondPlaceId,
      voided: outcome.voided,
      balance: outcome.balances[userId],
    })
    if (!outcome.voided) emitToUser(userId, 'balance:updated', { balance: outcome.balances[userId] })
  }
  emitToAdmin('game:completed', {
    gameId: outcome.gameId,
    winnerId: outcome.winnerId,
    secondPlaceId: outcome.secondPlaceId,
    voided: outcome.voided,
  })
}

/** Moves a game to DISPUTED (admin resolves), clearing any agreed result, and tells everyone involved. */
export async function disputeGame(gameId: string, reason: string): Promise<boolean> {
  const result = await prisma.game.updateMany({
    where: { id: gameId, status: { in: [GameStatus.ACTIVE, GameStatus.PENDING_COMPLETION] } },
    data: { status: GameStatus.DISPUTED, settlesAt: null, settleWinnerId: null, settleSecondPlaceId: null },
  })
  if (result.count === 0) return false
  invalidateDashboard()
  const players = await prisma.gamePlayer.findMany({ where: { gameId }, select: { userId: true } })
  for (const p of players) emitToUser(p.userId, 'game:disputed', { gameId, reason })
  emitToAdmin('game:disputed', { gameId, reason })
  return true
}
