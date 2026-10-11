import { Router } from 'express'
import prisma from '../lib/prisma'
import { requireAdmin, AuthRequest } from '../middleware/auth'
import { GameStatus } from '../../generated/prisma'
import { body, oneOf, pagination } from '../lib/validate'
import { badRequest, conflict } from '../lib/errors'
import { publishSettlement, settleGame, SettlementBlockedError, InvalidResultError } from '../services/settlement'
import { dashboardData, liveFigures } from '../services/dashboard'
import { nowKeys, Period, PeriodQuery, resolvePeriod } from '../lib/period'
import { LOCALE } from '../config/locale'

type IdParams = { id: string }

const hasPeriod = (q: PeriodQuery) => q.period !== undefined || q.from !== undefined || q.to !== undefined

/** Optional period filter shared by the list endpoints: same parameters as the dashboard. */
function optionalPeriod(query: PeriodQuery, earliest?: Date): Period | undefined {
  return hasPeriod(query) ? resolvePeriod(query, new Date(), LOCALE.timezone, earliest) : undefined
}

export function adminRouter(): Router {
  const router = Router()

  // GET /api/admin/stats?period=YYYY-MM|YYYY|last7|last30|last90|all | from=&to=   [&compare=0]
  router.get('/stats', requireAdmin, async (req: AuthRequest, res) => {
    const { live, earliest } = await liveFigures()
    const period = resolvePeriod(req.query as PeriodQuery, new Date(), LOCALE.timezone, earliest ?? undefined)
    const compare = req.query.compare !== '0'
    const data = await dashboardData(period, compare)
    res.json({ data: { ...data, live, now: nowKeys(new Date(), LOCALE.timezone) } })
  })

  // GET /api/admin/broadcasts
  router.get('/broadcasts', requireAdmin, async (_req, res) => {
    const broadcasts = await prisma.ping.findMany({
      where: { isBroadcast: true, status: 'PENDING', expiresAt: { gt: new Date() } },
      include: {
        fromUser: { select: { id: true, username: true } },
        recipients: { include: { user: { select: { id: true, username: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    res.json({ data: broadcasts })
  })

  // GET /api/admin/transactions?userId=&type=&period=|from=&to=&page=&limit=
  router.get('/transactions', requireAdmin, async (req: AuthRequest, res) => {
    const { limit, skip, page } = pagination(req.query)
    const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined
    const type = typeof req.query.type === 'string' && req.query.type ? oneOf(req.query.type, ['GAME_WIN', 'GAME_LOSS', 'COMMISSION', 'ADMIN_CREDIT', 'ADMIN_DEBIT'] as const, 'type') : undefined
    const period = optionalPeriod(req.query as PeriodQuery, (await liveFigures()).earliest ?? undefined)

    const where = {
      ...(userId ? { userId } : {}),
      ...(type ? { type } : {}),
      ...(period ? { createdAt: { gte: period.from, lt: period.to } } : {}),
    }
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { user: { select: { id: true, username: true } }, game: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ])
    res.json({ data: { transactions, total, page, limit } })
  })

  // GET /api/admin/games?status=&period=|from=&to=&page=&limit=
  router.get('/games', requireAdmin, async (req: AuthRequest, res) => {
    const { limit, skip } = pagination(req.query)
    const rawStatus = req.query.status
    const status = typeof rawStatus === 'string' && rawStatus !== '' ? oneOf(rawStatus, Object.values(GameStatus), 'status') : undefined
    const period = optionalPeriod(req.query as PeriodQuery, (await liveFigures()).earliest ?? undefined)
    const where = {
      ...(status ? { status } : {}),
      ...(period ? { createdAt: { gte: period.from, lt: period.to } } : {}),
    }
    const [games, total] = await Promise.all([
      prisma.game.findMany({
        where,
        include: {
          players: { include: { user: { select: { id: true, username: true } } } },
          screenshots: true,
          ping: { include: { fromUser: { select: { id: true, username: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.game.count({ where }),
    ])
    res.json({ data: { games, total } })
  })

  // PATCH /api/admin/games/:id/resolve — settle or void a game that has not been paid out
  router.patch('/games/:id/resolve', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    const input = body(req)
    const isVoid = input.void === true
    const winnerId = typeof input.winnerId === 'string' ? input.winnerId : undefined
    const secondPlaceId = typeof input.secondPlaceId === 'string' && input.secondPlaceId ? input.secondPlaceId : undefined
    if (!isVoid && !winnerId) throw badRequest('winnerId or void required')

    try {
      const outcome = await settleGame(
        req.params.id,
        isVoid ? { kind: 'void' } : { kind: 'admin', winnerId: winnerId!, secondPlaceId },
      )
      publishSettlement(outcome!)
      res.json({
        data: isVoid
          ? { status: 'voided' }
          : { status: 'resolved', winnerId: outcome!.winnerId, secondPlaceId: outcome!.secondPlaceId },
      })
    } catch (error) {
      if (error instanceof SettlementBlockedError) throw conflict(`${error.message}. Adjust their balance or limit first.`)
      if (error instanceof InvalidResultError) throw badRequest(error.message)
      throw error
    }
  })

  return router
}
