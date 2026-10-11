import prisma, { Prisma } from '../lib/prisma'
import { LOCALE } from '../config/locale'
import { Period, previousPeriod, spine } from '../lib/period'
import { decimalToCents } from '../lib/money'
import { GameStatus } from '../../generated/prisma'

/**
 * Admin dashboard numbers for one period. Every figure is one grouped SQL statement over an indexed
 * range; Node only merges the bounded day/month spine. Results are cached briefly per period and
 * dropped by `invalidateDashboard()` whenever money or games change.
 */

export interface Totals {
  games: number
  volume: number
  commission: number
  depositsApproved: number
  depositsAmount: number
  playersInPeriod: number
  completedGames: number
  disputedGames: number
}

export interface DashboardData {
  period: { key: string; kind: string; from: string; to: string; granularity: string; days: number; timezone: string }
  totals: Totals
  previous: { period: { key: string; from: string; to: string }; totals: Totals } | null
  chart: Array<{ date: string; games: number; volume: number; commission: number }>
  topPlayers: Array<{ userId: string; username: string; wins: number; net: number }>
}

const CACHE_TTL_MS = 30_000
const CACHE_MAX = 40
const cache = new Map<string, { at: number; value: DashboardData }>()

export function invalidateDashboard(): void {
  cache.clear()
}

const iso = (d: Date) => d.toISOString()
/** A UTC instant as the naive UTC timestamp the columns hold. */
const ts = (d: Date) => Prisma.sql`(${iso(d)}::timestamptz AT TIME ZONE 'UTC')`
const cents = (value: string | null | undefined) => (value ? decimalToCents(value) : 0) / 100

async function totalsFor(from: Date, to: Date): Promise<Totals> {
  const [games, commission, deposits, players] = await Promise.all([
    prisma.$queryRaw<Array<{ games: number; volume: string; completed: number; disputed: number }>>`
      SELECT COUNT(*)::int AS games,
             COALESCE(SUM("stake"), 0)::text AS volume,
             (COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "winnerId" IS NOT NULL))::int AS completed,
             (COUNT(*) FILTER (WHERE "status" = 'DISPUTED'))::int AS disputed
      FROM "Game" WHERE "createdAt" >= ${ts(from)} AND "createdAt" < ${ts(to)}`,
    prisma.$queryRaw<Array<{ total: string }>>`
      SELECT COALESCE(-SUM("amount"), 0)::text AS total FROM "Transaction"
      WHERE "type" = 'COMMISSION' AND "createdAt" >= ${ts(from)} AND "createdAt" < ${ts(to)}`,
    prisma.$queryRaw<Array<{ n: number; total: string }>>`
      SELECT COUNT(*)::int AS n, COALESCE(SUM("amount"), 0)::text AS total FROM "DepositRequest"
      WHERE "status" = 'APPROVED' AND "reviewedAt" >= ${ts(from)} AND "reviewedAt" < ${ts(to)}`,
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(DISTINCT gp."userId")::int AS n FROM "GamePlayer" gp
      JOIN "Game" g ON g."id" = gp."gameId"
      WHERE g."createdAt" >= ${ts(from)} AND g."createdAt" < ${ts(to)}`,
  ])
  const g = games[0]!
  return {
    games: g.games,
    volume: cents(g.volume),
    commission: cents(commission[0]!.total),
    depositsApproved: deposits[0]!.n,
    depositsAmount: cents(deposits[0]!.total),
    playersInPeriod: players[0]!.n,
    completedGames: g.completed,
    disputedGames: g.disputed,
  }
}

export async function dashboardData(period: Period, compare: boolean): Promise<DashboardData> {
  const cacheKey = `${period.key}|${compare ? 1 : 0}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const tz = LOCALE.timezone
  const label = period.granularity === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'
  const prev = compare ? previousPeriod(period, tz) : null
  const local = (column: string) => Prisma.raw(`to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE '${tz.replace(/'/g, "''")}', '${label}')`)

  const [totals, previousTotals, gameBuckets, commissionBuckets, top] = await Promise.all([
    totalsFor(period.from, period.to),
    prev ? totalsFor(prev.from, prev.to) : Promise.resolve(null),
    prisma.$queryRaw<Array<{ bucket: string; games: number; volume: string }>>`
      SELECT ${local('"createdAt"')} AS bucket, COUNT(*)::int AS games, COALESCE(SUM("stake"), 0)::text AS volume
      FROM "Game" WHERE "createdAt" >= ${ts(period.from)} AND "createdAt" < ${ts(period.to)} GROUP BY 1`,
    prisma.$queryRaw<Array<{ bucket: string; total: string }>>`
      SELECT ${local('"createdAt"')} AS bucket, COALESCE(-SUM("amount"), 0)::text AS total
      FROM "Transaction" WHERE "type" = 'COMMISSION' AND "createdAt" >= ${ts(period.from)} AND "createdAt" < ${ts(period.to)} GROUP BY 1`,
    prisma.$queryRaw<Array<{ userId: string; username: string; wins: number; net: string }>>`
      SELECT t."userId", u."username",
             (COUNT(*) FILTER (WHERE t."type" = 'GAME_WIN'))::int AS wins,
             COALESCE(SUM(t."amount"), 0)::text AS net
      FROM "Transaction" t JOIN "User" u ON u."id" = t."userId"
      WHERE t."gameId" IS NOT NULL AND t."createdAt" >= ${ts(period.from)} AND t."createdAt" < ${ts(period.to)}
      GROUP BY t."userId", u."username" ORDER BY SUM(t."amount") DESC LIMIT 5`,
  ])

  const byBucket = new Map(spine(period, tz).map((date) => [date, { date, games: 0, volume: 0, commission: 0 }]))
  for (const row of gameBuckets) {
    const bucket = byBucket.get(row.bucket)
    if (bucket) {
      bucket.games = row.games
      bucket.volume = cents(row.volume)
    }
  }
  for (const row of commissionBuckets) {
    const bucket = byBucket.get(row.bucket)
    if (bucket) bucket.commission = cents(row.total)
  }

  const value: DashboardData = {
    period: { key: period.key, kind: period.kind, from: iso(period.from), to: iso(period.to), granularity: period.granularity, days: period.days, timezone: tz },
    totals,
    previous: prev && previousTotals ? { period: { key: prev.key, from: iso(prev.from), to: iso(prev.to) }, totals: previousTotals } : null,
    chart: [...byBucket.values()],
    topPlayers: top.map((r) => ({ userId: r.userId, username: r.username, wins: r.wins, net: cents(r.net) })),
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(cacheKey, { at: Date.now(), value })
  return value
}

/** Figures that are about now, not about the period; cheap counts, never cached. */
export async function liveFigures() {
  const [activePlayers, disputedGames, pendingDeposits, balances, earliest] = await Promise.all([
    prisma.user.count({ where: { isActive: true, role: 'PLAYER' } }),
    prisma.game.count({ where: { status: GameStatus.DISPUTED } }),
    prisma.depositRequest.count({ where: { status: 'PENDING' } }),
    prisma.user.aggregate({ where: { role: 'PLAYER' }, _sum: { balance: true } }),
    prisma.game.aggregate({ _min: { createdAt: true } }),
  ])
  return {
    live: {
      activePlayers,
      disputedGames,
      pendingDeposits,
      totalPlayerBalance: balances._sum.balance ? decimalToCents(balances._sum.balance) / 100 : 0,
    },
    earliest: earliest._min.createdAt,
  }
}
