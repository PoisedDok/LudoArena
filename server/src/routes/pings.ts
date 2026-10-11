import { Router } from 'express'
import prisma from '../lib/prisma'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { idempotent } from '../middleware/idempotency'
import { GameType, PingStatus } from '../../generated/prisma'
import { cancelPing, createPing, publishResponse, respondToPing } from '../services/pings'
import { GAME, MONEY } from '../config/limits'
import { amountCents, body, oneOf, optionalString } from '../lib/validate'
import { badRequest, conflict } from '../lib/errors'

type IdParams = { id: string }

const MAX_RECIPIENTS = 10

export function pingsRouter(): Router {
  const router = Router()

  // GET /api/pings — own pings (sent/received) plus all open broadcasts
  router.get('/', requireAuth, async (req: AuthRequest, res) => {
    const userId = req.user!.userId
    const pings = await prisma.ping.findMany({
      where: {
        OR: [
          { fromUserId: userId },
          { recipients: { some: { userId } } },
          { isBroadcast: true, status: PingStatus.PENDING, fromUserId: { not: userId }, expiresAt: { gt: new Date() } },
        ],
      },
      include: {
        fromUser: { select: { id: true, username: true } },
        recipients: { include: { user: { select: { id: true, username: true } } } },
        game: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    res.json({ data: pings })
  })

  // POST /api/pings — direct (Solo only) or broadcast
  router.post('/', requireAuth, idempotent, async (req: AuthRequest, res) => {
    const input = body(req)
    const gameType = oneOf(input.gameType, Object.values(GameType), 'gameType')
    const stakeCents = amountCents(input.stake, 'stake', { min: 1, max: MONEY.maxAmountCents })
    const message = optionalString(input.message, 'message', GAME.messageMaxLength)
    const isBroadcast = input.isBroadcast === true
    let recipientIds: string[] = []
    if (!isBroadcast) {
      const raw = input.recipientIds
      if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) throw badRequest('recipientIds required for direct ping')
      recipientIds = [...new Set(raw as string[])]
      if (recipientIds.length > MAX_RECIPIENTS) throw badRequest(`At most ${MAX_RECIPIENTS} recipients`)
    }
    const ping = await createPing({ userId: req.user!.userId, gameType, stakeCents, message, isBroadcast, recipientIds })
    res.status(201).json({ data: ping })
  })

  // DELETE /api/pings/:id — the sender cancels a pending ping
  router.delete('/:id', requireAuth, async (req: AuthRequest<IdParams>, res) => {
    await cancelPing(req.params.id, req.user!.userId)
    res.json({ data: { ok: true } })
  })

  // PATCH /api/pings/:id/respond
  router.patch('/:id/respond', requireAuth, async (req: AuthRequest<IdParams>, res) => {
    const input = body(req)
    const response = oneOf(input.response, ['ACCEPTED', 'DECLINED'] as const, 'response')
    const team = typeof input.team === 'number' && Number.isInteger(input.team) ? input.team : null
    const outcome = await respondToPing(req.params.id, req.user!.userId, response, team)
    publishResponse(req.params.id, req.user!.userId, outcome)
    if (outcome.error) throw conflict(outcome.error)
    res.json({
      data: { status: outcome.status, acceptedCount: outcome.acceptedCount, required: outcome.required, started: outcome.started ?? false },
    })
  })

  return router
}
