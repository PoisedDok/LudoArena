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
import { listCommissionSettings, updateCommissionSetting } from '../services/commissionSettings'
import type { CommissionSettingInput } from '../services/commissionSettings'

type IdParams = { id: string }

const hasPeriod = (q: PeriodQuery) => q.period !== undefined || q.from !== undefined || q.to !== undefined

/** Optional period filter shared by the list endpoints: same parameters as the dashboard. */
function optionalPeriod(query: PeriodQuery, earliest?: Date): Period | undefined {
  return hasPeriod(query) ? resolvePeriod(query, new Date(), LOCALE.timezone, earliest) : undefined
}

export function adminRouter(): Router {
  const router = Router()

  // GET /api/admin/settings/commission
  router.get('/settings/commission', requireAdmin, async (_req, res) => {
    res.json({ data: { settings: await listCommissionSettings(prisma) } })
  })

  // PUT /api/admin/settings/commission/:gameType
  router.put('/settings/commission/:gameType', requireAdmin, async (req: AuthRequest, res) => {
    const gameType = oneOf(req.params.gameType, ['ONE_V_ONE', 'TWO_V_TWO', 'FOUR_PLAYER'] as const, 'gameType')
    const input = body(req)
    const allowed = gameType === 'FOUR_PLAYER'
      ? ['fourPlayerSecondBps']
      : ['tierThresholdCents', 'highRateBps', 'lowRateBps']
    if (Object.keys(input).length !== allowed.length || Object.keys(input).some((key) => !allowed.includes(key))) {
      throw badRequest(`Settings for ${gameType} must contain exactly: ${allowed.join(', ')}`)
    }
    const integerField = (field: string, min: number, max: number): number => {
      const value = input[field]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw badRequest(`${field} must be a whole number from ${min} to ${max}`)
      }
      return value
    }
    const setting: CommissionSettingInput = gameType === 'FOUR_PLAYER'
      ? {
          tierThresholdCents: null,
          highRateBps: null,
          lowRateBps: null,
          fourPlayerSecondBps: integerField('fourPlayerSecondBps', 0, 10_000),
        }
      : {
          tierThresholdCents: integerField('tierThresholdCents', 0, 100_000_000),
          highRateBps: integerField('highRateBps', 0, 10_000),
          lowRateBps: integerField('lowRateBps', 0, 10_000),
          fourPlayerSecondBps: null,
        }
    const saved = await updateCommissionSetting(gameType, setting, req.user!.userId)
    res.json({ data: { setting: saved } })
  })

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
      where: { isBroadcast: true, status: 'PENDING', expiresAt: { gt: new Date() }, fromUser: { deletedAt: null } },
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
