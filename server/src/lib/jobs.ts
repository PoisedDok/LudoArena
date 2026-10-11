import fsp from 'fs/promises'
import path from 'path'
import prisma from './prisma'
import { incomingDir } from '../middleware/upload'
import { GameStatus, PingStatus } from '../../generated/prisma'
import { GAME, JOBS } from '../config/limits'
import { emitToAdmin, emitToAll, emitToUsers } from './socket'
import { disputeGame, publishSettlement, settleGame, SettlementBlockedError } from '../services/settlement'
import { log } from './logger'

/** Pays out every agreed result whose undo window has passed. Safe to run at any time, from any number of callers. */
export async function settleDueGames(retryAfter = new Map<string, number>()): Promise<number> {
  const due = await prisma.game.findMany({
    where: { status: GameStatus.PENDING_COMPLETION, settlesAt: { lte: new Date() } },
    select: { id: true },
    take: 50,
  })
  let settled = 0
  for (const { id } of due) {
    if ((retryAfter.get(id) ?? 0) > Date.now()) continue
    try {
      const outcome = await settleGame(id, { kind: 'vote' })
      if (outcome) {
        publishSettlement(outcome)
        settled++
      }
    } catch (error) {
      if (error instanceof SettlementBlockedError) {
        log.warn('settlement blocked, game sent to admin', { gameId: id, usernames: error.usernames })
        await disputeGame(id, error.message)
      } else {
        log.error('settlement failed, will retry', { gameId: id, err: error })
        retryAfter.set(id, Date.now() + 30_000)
      }
    }
  }
  return settled
}

export async function expirePings(): Promise<number> {
  const expired = await prisma.ping.updateMany({
    where: { status: PingStatus.PENDING, expiresAt: { lt: new Date() } },
    data: { status: PingStatus.EXPIRED },
  })
  if (expired.count > 0) emitToAll('ping:expired', { count: expired.count })
  return expired.count
}

/** Games that have been ACTIVE for hours are moved to PENDING_COMPLETION so the players are asked for a result. */
export async function flagStaleGames(): Promise<number> {
  const threshold = new Date(Date.now() - GAME.staleActiveAfterMs)
  const stale = await prisma.game.findMany({
    where: { status: GameStatus.ACTIVE, createdAt: { lt: threshold } },
    include: { players: { select: { userId: true } } },
  })
  let flagged = 0
  for (const game of stale) {
    const claimed = await prisma.game.updateMany({
      where: { id: game.id, status: GameStatus.ACTIVE },
      data: { status: GameStatus.PENDING_COMPLETION },
    })
    if (claimed.count === 0) continue
    flagged++
    emitToUsers(game.players.map((p) => p.userId), 'game:stale', { gameId: game.id })
    emitToAdmin('game:stale', { gameId: game.id })
  }
  return flagged
}

export async function sweepIdempotencyKeys(): Promise<void> {
  const old = new Date(Date.now() - JOBS.idempotencyTtlMs)
  await prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: old } } })
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  // A request that died mid-flight leaves an unanswered key; free it so the client can retry.
  const stuck = new Date(Date.now() - 2 * 60 * 1000)
  await prisma.idempotencyKey.deleteMany({ where: { status: null, createdAt: { lt: stuck } } })
}

/** Removes upload temp files left behind by a crash (a request never keeps one longer than a minute). */
export async function sweepIncoming(): Promise<number> {
  const dir = incomingDir()
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - 60 * 60 * 1000
  let removed = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const stat = await fsp.stat(file)
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fsp.unlink(file)
        removed++
      }
    } catch {
      // The file vanished between listing and removal: nothing left to do.
    }
  }
  return removed
}

export interface Jobs {
  stop(): void
}

/** Starts the background loops. A failing run is logged and retried on the next tick, never thrown. */
export function startJobs(): Jobs {
  const retryAfter = new Map<string, number>()
  let sweeping = false
  const guarded = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn()
    } catch (error) {
      log.error('job failed', { job: name, err: error })
    }
  }

  const timers = [
    setInterval(async () => {
      if (sweeping) return
      sweeping = true
      try {
        await guarded('settle', () => settleDueGames(retryAfter))()
      } finally {
        sweeping = false
      }
    }, JOBS.settleSweepMs),
    setInterval(guarded('pings', expirePings), JOBS.pingExpiryMs),
    setInterval(guarded('stale-games', flagStaleGames), JOBS.staleGameMs),
    setInterval(guarded('idempotency', sweepIdempotencyKeys), JOBS.idempotencySweepMs),
    setInterval(guarded('incoming', sweepIncoming), JOBS.idempotencySweepMs),
  ]
  for (const t of timers) t.unref()
  return { stop: () => timers.forEach(clearInterval) }
}
