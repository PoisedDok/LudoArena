import { Prisma, PrismaClient } from '../../generated/prisma'
import { PrismaPg } from '@prisma/adapter-pg'
import { getEnv } from '../config/env'

// Money columns are NUMERIC and come back as Decimal. The API and the socket events have always carried
// plain numbers, and every amount is a two-decimal value far below 2^53, so serialise them as numbers.
// This is the only place that decision lives.
;(Prisma.Decimal.prototype as unknown as { toJSON(this: Prisma.Decimal): number }).toJSON = function toJSON(this: Prisma.Decimal): number {
  return this.toNumber()
}

// A small pool on purpose: sized from the load measurements (docs/ARCHITECTURE.md), not from available
// room. Statements and transactions have hard time limits so a stuck query cannot hold row locks or
// pool slots for long.
const adapter = new PrismaPg({
  connectionString: getEnv().databaseUrl,
  max: getEnv().dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 15_000,
})
const prisma = new PrismaClient({ adapter, transactionOptions: { maxWait: 5_000, timeout: 10_000 } })

export type Tx = Prisma.TransactionClient

/**
 * Row locks taken in one statement, in id order, so two transactions that need overlapping sets
 * queue instead of deadlocking.
 */
export async function lockUsers(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const unique = [...new Set(ids)]
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${Prisma.join(unique)}) ORDER BY "id" FOR UPDATE`
}

export async function lockGame(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Game" WHERE "id" = ${id} FOR UPDATE`
}

export async function lockPing(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Ping" WHERE "id" = ${id} FOR UPDATE`
}

export { Prisma }
export default prisma
