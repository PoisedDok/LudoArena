import prisma, { Prisma } from '../lib/prisma'
import { decimalToCents } from '../lib/money'
import type { TransactionType } from '../../generated/prisma'
import type { Period } from '../lib/period'

/** Prefix of the ledger description written when a deposit is approved; the statement classifies on it. */
export const DEPOSIT_DESCRIPTION_PREFIX = 'Deposit approved'

export interface LedgerRow {
  id: string
  at: Date
  type: TransactionType
  description: string
  gameId: string | null
  screenshotFilename: string | null
  amountCents: number
  /** The player's balance right after this row. */
  balanceAfterCents: number
}

export interface Ledger {
  openingCents: number
  closingCents: number
  rows: LedgerRow[]
  /** True when rows were cut off at `limit`; opening/closing stay exact either way. */
  truncated: boolean
}

const sumCents = (value: { toString(): string } | null | undefined): number => (value ? decimalToCents(value) : 0)

/**
 * The one place that turns the stored ledger into running balances. It works backwards from the stored
 * balance, so the closing balance of a window that reaches "now" is exactly the stored balance, and
 * opening + movements = closing holds by construction for any window. Used by the on-screen history
 * and by the PDF statement.
 *
 *   closing(window) = balance now - sum of rows at or after window end
 *   opening(window) = closing - sum of rows inside the window
 *
 * `period` bounds the window; without it the window is "everything up to now" and `limit` keeps the
 * newest rows. Rows are ordered by time, credits before debits inside one instant, then id.
 */
export async function ledgerFor(userId: string, opts: { period?: Period; limit?: number } = {}): Promise<Ledger> {
  const { period, limit } = opts
  const [user, afterWindow] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } }),
    period
      ? prisma.transaction.aggregate({ where: { userId, createdAt: { gte: period.to } }, _sum: { amount: true } })
      : Promise.resolve({ _sum: { amount: null } }),
  ])
  const closingCents = decimalToCents(user.balance) - sumCents(afterWindow._sum.amount)

  const where: Prisma.TransactionWhereInput = period ? { userId, createdAt: { gte: period.from, lt: period.to } } : { userId }
  const order: Prisma.TransactionOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { amount: 'asc' }, { id: 'desc' }]
  const fetched = await prisma.transaction.findMany({ where, orderBy: order, take: limit ? limit + 1 : undefined })
  const truncated = limit !== undefined && fetched.length > limit
  const newestFirst = truncated ? fetched.slice(0, limit) : fetched

  const rows: LedgerRow[] = []
  let running = closingCents
  for (const t of newestFirst) {
    const amountCents = decimalToCents(t.amount)
    rows.push({
      id: t.id,
      at: t.createdAt,
      type: t.type,
      description: t.description ?? '',
      gameId: t.gameId,
      screenshotFilename: t.screenshotFilename,
      amountCents,
      balanceAfterCents: running,
    })
    running -= amountCents
  }
  rows.reverse()

  let openingCents = running
  if (truncated) {
    // Rows older than the cut still lie inside the window: opening is closing minus ALL movements.
    const windowSum = await prisma.transaction.aggregate({ where, _sum: { amount: true } })
    openingCents = closingCents - sumCents(windowSum._sum.amount)
  }
  return { openingCents, closingCents, rows, truncated }
}

/** Diagnostic: stored balance minus the sum of the whole ledger (0 for every account created by this app). */
export async function ledgerDrift(userId: string): Promise<number> {
  const [user, sum] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } }),
    prisma.transaction.aggregate({ where: { userId }, _sum: { amount: true } }),
  ])
  return decimalToCents(user.balance) - sumCents(sum._sum.amount)
}
