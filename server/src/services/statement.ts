import prisma from '../lib/prisma'
import { Period } from '../lib/period'
import { ledgerFor, LedgerRow, DEPOSIT_DESCRIPTION_PREFIX } from './ledger'
import { HttpError, notFound } from '../lib/errors'

/** Most ledger rows one statement may contain; a wider period is refused rather than truncated silently. */
export const STATEMENT_MAX_ROWS = 3000

export interface StatementGame {
  id: string
  at: Date
  gameType: string
  stakeCents: number
  opponents: string[]
  status: string
  result: 'Won' | 'Lost' | 'Voided'
  netCents: number
}

export interface Statement {
  player: { id: string; username: string; phone: string | null }
  period: Period
  generatedAt: Date
  openingCents: number
  closingCents: number
  summary: {
    depositsCents: number
    adjustmentsInCents: number
    withdrawalsCents: number
    gamesPlayed: number
    wins: number
    losses: number
    stakesWonCents: number
    stakesLostCents: number
    commissionCents: number
  }
  games: StatementGame[]
  rows: LedgerRow[]
}

/**
 * Everything a statement shows, computed from the single ledger function. The summary is a plain sum over
 * the same rows, so opening + deposits + adjustments - withdrawals + stakes won - stakes lost - commission
 * equals closing.
 */
export async function buildStatement(userId: string, period: Period, now = new Date()): Promise<Statement> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, phone: true } })
  if (!user) throw notFound('Player not found')

  const ledger = await ledgerFor(userId, { period, limit: STATEMENT_MAX_ROWS })
  if (ledger.truncated) {
    throw new HttpError(422, `This period has more than ${STATEMENT_MAX_ROWS} ledger entries. Choose a shorter period.`)
  }

  const summary = {
    depositsCents: 0,
    adjustmentsInCents: 0,
    withdrawalsCents: 0,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    stakesWonCents: 0,
    stakesLostCents: 0,
    commissionCents: 0,
  }
  const netByGame = new Map<string, number>()
  const wonGames = new Set<string>()
  for (const row of ledger.rows) {
    switch (row.type) {
      case 'ADMIN_CREDIT':
        if (row.description.startsWith(DEPOSIT_DESCRIPTION_PREFIX)) summary.depositsCents += row.amountCents
        else summary.adjustmentsInCents += row.amountCents
        break
      case 'ADMIN_DEBIT':
        summary.withdrawalsCents += -row.amountCents
        break
      case 'GAME_WIN':
        summary.stakesWonCents += row.amountCents
        if (row.gameId) wonGames.add(row.gameId)
        break
      case 'GAME_LOSS':
        summary.stakesLostCents += -row.amountCents
        break
      case 'COMMISSION':
        summary.commissionCents += -row.amountCents
        break
    }
    if (row.gameId) netByGame.set(row.gameId, (netByGame.get(row.gameId) ?? 0) + row.amountCents)
  }
  summary.gamesPlayed = netByGame.size
  summary.wins = wonGames.size
  summary.losses = summary.gamesPlayed - summary.wins

  const gameIds = [...netByGame.keys()]
  const games = gameIds.length
    ? await prisma.game.findMany({
        where: { id: { in: gameIds } },
        include: { players: { include: { user: { select: { id: true, username: true } } } } },
        orderBy: { createdAt: 'asc' },
      })
    : []

  return {
    player: user,
    period,
    generatedAt: now,
    openingCents: ledger.openingCents,
    closingCents: ledger.closingCents,
    summary,
    rows: ledger.rows,
    games: games.map((g) => {
      const net = netByGame.get(g.id) ?? 0
      return {
        id: g.id,
        at: g.finishedAt ?? g.createdAt,
        gameType: g.gameType,
        stakeCents: Math.round(g.stake.toNumber() * 100),
        opponents: g.players.filter((p) => p.userId !== userId).map((p) => p.user.username),
        status: g.status,
        result: wonGames.has(g.id) ? 'Won' : net < 0 ? 'Lost' : 'Voided',
        netCents: net,
      } satisfies StatementGame
    }),
  }
}
