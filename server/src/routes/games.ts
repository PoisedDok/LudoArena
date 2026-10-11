import { Router } from 'express'
import prisma from '../lib/prisma'
import { requireAuth, requirePlayableAccount, AuthRequest } from '../middleware/auth'
import { imageUpload, removeStoredImage, storeImage } from '../middleware/upload'
import { uploadLimiter } from '../middleware/rateLimit'
import { addScreenshot, castVote, gameInclude, markDone, publishVote, retractVote, setRoomCode } from '../services/games'
import { emitToUsers } from '../lib/socket'
import { GAME } from '../config/limits'
import { badRequest, forbidden, notFound } from '../lib/errors'
import { body, requiredString } from '../lib/validate'

type IdParams = { id: string }

const ROOM_CODE = /^[A-Za-z0-9 _-]+$/
const MAX_LISTED_GAMES = 200

export function gamesRouter(): Router {
  const router = Router()

  // GET /api/games — a player's own games, or all games for the admin (newest first, capped)
  router.get('/', requireAuth, async (req: AuthRequest, res) => {
    const where = req.user!.role === 'ADMIN' ? {} : { players: { some: { userId: req.user!.userId } } }
    const games = await prisma.game.findMany({
      where,
      include: gameInclude,
      orderBy: { createdAt: 'desc' },
      take: MAX_LISTED_GAMES,
    })
    res.json({ data: games })
  })

  // GET /api/games/:id
  router.get('/:id', requireAuth, async (req: AuthRequest<IdParams>, res) => {
    const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: gameInclude })
    if (!game) throw notFound('Game not found')
    const isPlayer = game.players.some((p) => p.userId === req.user!.userId)
    if (req.user!.role !== 'ADMIN' && !isPlayer) throw forbidden()
    res.json({ data: game })
  })

  // PATCH /api/games/:id/roomcode
  router.patch('/:id/roomcode', requireAuth, requirePlayableAccount, async (req: AuthRequest<IdParams>, res) => {
    const code = requiredString(body(req).ludoRoomCode, 'ludoRoomCode', 1, GAME.roomCodeMaxLength)
    if (!ROOM_CODE.test(code)) throw badRequest('ludoRoomCode may contain letters, digits, space, dash and underscore only')
    const game = await setRoomCode(req.params.id, req.user!.userId, code)
    res.json({ data: game })
  })

  // PATCH /api/games/:id/done
  router.patch('/:id/done', requireAuth, requirePlayableAccount, async (req: AuthRequest<IdParams>, res) => {
    await markDone(req.params.id, req.user!.userId)
    res.json({ data: { status: 'pending_completion' } })
  })

  // POST /api/games/:id/screenshots
  router.post('/:id/screenshots', requireAuth, requirePlayableAccount, uploadLimiter(), imageUpload('screenshot'), async (req: AuthRequest<IdParams>, res) => {
    const stored = await storeImage(req.file)
    try {
      const screenshot = await addScreenshot(req.params.id, req.user!.userId, stored.filename)
      res.status(201).json({ data: screenshot })
    } catch (error) {
      await removeStoredImage(stored.filename)
      throw error
    }
  })

  // POST /api/games/:id/confirm — cast the vote; the result settles after the undo window
  router.post('/:id/confirm', requireAuth, requirePlayableAccount, async (req: AuthRequest<IdParams>, res) => {
    const input = body(req)
    const winnerId = requiredString(input.winnerId, 'winnerId', 1, 64)
    const second = typeof input.secondPlaceId === 'string' && input.secondPlaceId ? input.secondPlaceId.slice(0, 64) : null
    const { result, playerIds } = await castVote(req.params.id, req.user!.userId, winnerId, second)
    publishVote(req.params.id, result, playerIds)
    if (result.status === 'settling') {
      res.json({
        data: { status: 'settling', winnerId: result.winnerId, secondPlaceId: result.secondPlaceId, undoWindowMs: result.undoWindowMs, settlesAt: result.settlesAt.getTime() },
      })
      return
    }
    res.json({ data: { status: result.status } })
  })

  // DELETE /api/games/:id/confirm — retract own vote while the game is not paid out
  router.delete('/:id/confirm', requireAuth, requirePlayableAccount, async (req: AuthRequest<IdParams>, res) => {
    const playerIds = await retractVote(req.params.id, req.user!.userId)
    emitToUsers(playerIds, 'game:vote_retracted', { gameId: req.params.id, byUserId: req.user!.userId })
    res.json({ data: { status: 'retracted' } })
  })

  return router
}
