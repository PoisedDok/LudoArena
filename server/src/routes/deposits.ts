import { Router } from 'express'
import prisma, { lockUsers } from '../lib/prisma'
import { requireAuth, requireAdmin, requirePlayableAccount, AuthRequest } from '../middleware/auth'
import { idempotent } from '../middleware/idempotency'
import { imageUpload, removeStoredImage, storeImage } from '../middleware/upload'
import { uploadLimiter } from '../middleware/rateLimit'
import { emitToAdmin, emitToUser } from '../lib/socket'
import { invalidateDashboard } from '../services/dashboard'
import { DEPOSIT_DESCRIPTION_PREFIX } from '../services/ledger'
import { DepositStatus, TransactionType } from '../../generated/prisma'
import { MONEY } from '../config/limits'
import { amountCents, body, oneOf, optionalString } from '../lib/validate'
import { centsToDecimal, decimalToCents } from '../lib/money'
import { conflict, forbidden, notFound } from '../lib/errors'

type IdParams = { id: string }

const userBrief = { select: { id: true, username: true, balance: true } } as const

export function depositsRouter(): Router {
  const router = Router()

  // POST /api/deposits — a player submits a payment proof
  router.post('/', requireAuth, requirePlayableAccount, idempotent, uploadLimiter(), imageUpload('screenshot'), async (req: AuthRequest, res) => {
    const userId = req.user!.userId
    const cents = amountCents(body(req).amount, 'amount', { min: 1, max: MONEY.maxAmountCents })
    const stored = await storeImage(req.file)
    try {
      const deposit = await prisma.$transaction(async (tx) => {
        await lockUsers(tx, [userId])
        const user = await tx.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })
        if (!user) throw notFound('Player not found')
        if (user.deletedAt) throw forbidden('This account is deleted and cannot submit deposits')
        return tx.depositRequest.create({
          data: { userId, amount: centsToDecimal(cents), screenshotFilename: stored.filename, screenshotHash: stored.sha256 },
          include: { user: { select: { id: true, username: true } } },
        })
      })
      emitToAdmin('deposit:new', { deposit })
      res.status(201).json({ data: deposit })
    } catch (error) {
      await removeStoredImage(stored.filename)
      if ((error as { code?: string }).code === 'P2002') throw conflict('This payment screenshot was already submitted')
      throw error
    }
  })

  // GET /api/deposits — a player's own history
  router.get('/', requireAuth, async (req: AuthRequest, res) => {
    const deposits = await prisma.depositRequest.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    res.json({ data: deposits })
  })

  // GET /api/deposits/admin
  router.get('/admin', requireAdmin, async (req: AuthRequest, res) => {
    const raw = req.query.status
    const status = typeof raw === 'string' && raw !== '' ? oneOf(raw, Object.values(DepositStatus), 'status') : undefined
    const deposits = await prisma.depositRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: userBrief },
    })
    res.json({ data: deposits })
  })

  // PATCH /api/deposits/admin/:id — approve or reject, exactly once
  router.patch('/admin/:id', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    const { id } = req.params
    const input = body(req)
    const action = oneOf(input.action, ['APPROVED', 'REJECTED'] as const, 'action')
    const adminNote = optionalString(input.adminNote, 'adminNote', 200) ?? null

    const result = await prisma.$transaction(async (tx) => {
      // The status condition is the claim: of two concurrent reviews only one updates a row.
      const claimed = await tx.depositRequest.updateMany({
        where: { id, status: DepositStatus.PENDING },
        data: { status: action, adminNote, reviewedAt: new Date() },
      })
      if (claimed.count === 0) {
        const exists = await tx.depositRequest.findUnique({ where: { id }, select: { id: true } })
        throw exists ? conflict('Deposit has already been reviewed') : notFound('Deposit request not found')
      }
      const deposit = await tx.depositRequest.findUniqueOrThrow({ where: { id } })
      let newBalance: number | null = null
      if (action === 'APPROVED') {
        await lockUsers(tx, [deposit.userId])
        const user = await tx.user.update({
          where: { id: deposit.userId },
          data: { balance: { increment: centsToDecimal(decimalToCents(deposit.amount)) } },
          select: { balance: true },
        })
        await tx.transaction.create({
          data: {
            userId: deposit.userId,
            amount: deposit.amount,
            type: TransactionType.ADMIN_CREDIT,
            description: `${DEPOSIT_DESCRIPTION_PREFIX} (#${id.slice(-6)})`,
            screenshotFilename: deposit.screenshotFilename,
          },
        })
        newBalance = user.balance.toNumber()
      }
      const updated = await tx.depositRequest.findUniqueOrThrow({ where: { id }, include: { user: userBrief } })
      return { updated, deposit, newBalance }
    })

    invalidateDashboard()
    const amount = result.deposit.amount.toNumber()
    if (action === 'APPROVED') {
      emitToUser(result.deposit.userId, 'deposit:approved', { depositId: id, amount, newBalance: result.newBalance, adminNote })
      emitToUser(result.deposit.userId, 'balance:updated', { balance: result.newBalance })
    } else {
      emitToUser(result.deposit.userId, 'deposit:rejected', { depositId: id, amount, adminNote })
    }
    res.json({ data: result.updated })
  })

  return router
}
