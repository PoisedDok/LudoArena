import { Router } from 'express'
import { hashPassword } from '../lib/password'
import prisma, { lockUsers } from '../lib/prisma'
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth'
import { idempotent } from '../middleware/idempotency'
import { imageUpload, removeStoredImage, storeImage } from '../middleware/upload'
import { statementLimiter, uploadLimiter } from '../middleware/rateLimit'
import { disconnectUser, emitToAll, emitToUser } from '../lib/socket'
import { TransactionType, Role } from '../../generated/prisma'
import { AUTH, MONEY } from '../config/limits'
import { amountCents, body, bool, optionalString, requiredString } from '../lib/validate'
import { centsToDecimal } from '../lib/money'
import { invalidateDashboard } from '../services/dashboard'
import { ledgerFor } from '../services/ledger'
import { buildStatement } from '../services/statement'
import { renderStatement } from '../services/statementPdf'
import { shapeStatement } from '../services/statementView'
import { acquireExport } from '../services/exportGuard'
import { PeriodQuery, resolvePeriod } from '../lib/period'
import { LOCALE } from '../config/locale'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors'

const publicUserFields = { id: true, username: true, isActive: true, role: true, createdAt: true } as const
const fullUserFields = {
  id: true, username: true, phone: true, role: true, balance: true, creditLimit: true, spendLimit: true,
  isActive: true, createdAt: true, updatedAt: true,
} as const

type IdParams = { id: string }

const USERNAME = /^[A-Za-z0-9._-]{3,32}$/
const PHONE = /^\+?[0-9]{7,15}$/

function parseUsername(value: unknown): string {
  const username = requiredString(value, 'username', 3, 32)
  if (!USERNAME.test(username)) throw badRequest('username may contain letters, digits, dot, dash and underscore only')
  return username
}

function parsePhone(value: unknown): string | null {
  const text = optionalString(value, 'phone', 20)
  if (!text) return null
  const phone = text.replace(/[\s-]/g, '')
  if (!PHONE.test(phone)) throw badRequest('phone must be 7-15 digits, optionally starting with +')
  return phone
}

function parsePassword(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('password is required')
  if (value.length < AUTH.passwordMinLength) throw badRequest(`password must be at least ${AUTH.passwordMinLength} characters`)
  if (Buffer.byteLength(value, 'utf8') > AUTH.passwordMaxBytes) throw badRequest(`password must be at most ${AUTH.passwordMaxBytes} bytes`)
  return value
}

/** Login accepts a username or a phone number, so one value may never identify two accounts. */
async function assertIdentityFree(username: string | undefined, phone: string | null | undefined, exceptId?: string): Promise<void> {
  const values = [username, phone ?? undefined].filter((v): v is string => !!v)
  if (values.length === 0) return
  const clash = await prisma.user.findFirst({
    where: {
      id: exceptId ? { not: exceptId } : undefined,
      OR: values.flatMap((v) => [{ username: { equals: v, mode: 'insensitive' as const } }, { phone: v }]),
    },
    select: { username: true },
  })
  if (clash) throw conflict('That username or phone number is already in use')
}

export function playersRouter(): Router {
  const router = Router()

  // GET /api/players
  router.get('/', requireAuth, async (req: AuthRequest, res) => {
    const isAdmin = req.user!.role === 'ADMIN'
    const users = await prisma.user.findMany({
      select: isAdmin ? fullUserFields : publicUserFields,
      orderBy: { username: 'asc' },
    })
    res.json({ data: users })
  })

  // GET /api/players/:id
  router.get('/:id', requireAuth, async (req: AuthRequest<IdParams>, res) => {
    const isAdmin = req.user!.role === 'ADMIN'
    const isSelf = req.user!.userId === req.params.id
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: isAdmin || isSelf ? fullUserFields : publicUserFields,
    })
    if (!user) throw notFound('Player not found')
    res.json({ data: user })
  })

  // POST /api/players
  router.post('/', requireAdmin, idempotent, async (req: AuthRequest, res) => {
    const input = body(req)
    const username = parseUsername(input.username)
    const phone = parsePhone(input.phone)
    const password = parsePassword(input.password)
    const balance = input.balance === undefined ? 0 : amountCents(input.balance, 'balance', { min: -MONEY.maxAmountCents, max: MONEY.maxAmountCents })
    const creditLimit = input.creditLimit === undefined ? 50_000 : amountCents(input.creditLimit, 'creditLimit', { min: 0, max: MONEY.maxAmountCents })
    const spendLimit = input.spendLimit === undefined ? 100_000 : amountCents(input.spendLimit, 'spendLimit', { min: 1, max: MONEY.maxAmountCents })
    await assertIdentityFree(username, phone)

    const passwordHash = await hashPassword(password)
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username, phone, passwordHash,
          balance: centsToDecimal(balance),
          creditLimit: centsToDecimal(creditLimit),
          spendLimit: centsToDecimal(spendLimit),
        },
        select: fullUserFields,
      })
      if (balance !== 0) {
        await tx.transaction.create({
          data: {
            userId: created.id,
            amount: centsToDecimal(balance),
            type: balance > 0 ? TransactionType.ADMIN_CREDIT : TransactionType.ADMIN_DEBIT,
            description: 'Opening balance',
          },
        })
      }
      return created
    })
    res.status(201).json({ data: user })
  })

  // PUT /api/players/:id
  router.put('/:id', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    const input = body(req)
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!target) throw notFound('Player not found')

    const data: Record<string, unknown> = {}
    let username: string | undefined
    let phone: string | null | undefined
    if (input.username !== undefined) {
      username = parseUsername(input.username)
      data.username = username
    }
    if (input.phone !== undefined) {
      phone = parsePhone(input.phone)
      data.phone = phone
    }
    if (input.creditLimit !== undefined) {
      data.creditLimit = centsToDecimal(amountCents(input.creditLimit, 'creditLimit', { min: 0, max: MONEY.maxAmountCents }))
    }
    if (input.spendLimit !== undefined) {
      data.spendLimit = centsToDecimal(amountCents(input.spendLimit, 'spendLimit', { min: 1, max: MONEY.maxAmountCents }))
    }
    const passwordChanged = typeof input.password === 'string' && input.password !== ''
    if (passwordChanged) {
      data.passwordHash = await hashPassword(parsePassword(input.password))
      data.tokenVersion = { increment: 1 }
    }
    await assertIdentityFree(username, phone, req.params.id)

    const user = await prisma.user.update({ where: { id: req.params.id }, data, select: fullUserFields })
    // A reset ends every session of that user (the version bump refuses old tokens, the rows go too),
    // sockets included.
    if (passwordChanged) {
      await prisma.session.deleteMany({ where: { userId: req.params.id } })
      disconnectUser(req.params.id)
    }
    res.json({ data: user })
  })

  // PATCH /api/players/:id/active
  router.patch('/:id/active', requireAuth, async (req: AuthRequest<IdParams>, res) => {
    if (req.user!.userId !== req.params.id && req.user!.role !== 'ADMIN') throw forbidden()
    const isActive = bool(body(req).isActive, 'isActive')
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive },
      select: { id: true, isActive: true, username: true },
    })
    emitToAll('player:status', { userId: user.id, isActive: user.isActive, username: user.username })
    res.json({ data: user })
  })

  // PATCH /api/players/:id/balance — manual credit or debit with an audit row and optional proof
  router.patch('/:id/balance', requireAdmin, idempotent, uploadLimiter(), imageUpload('screenshot'), async (req: AuthRequest<IdParams>, res) => {
    const input = body(req)
    const cents = amountCents(input.amount, 'amount', { min: -MONEY.maxAmountCents, max: MONEY.maxAmountCents })
    if (cents === 0) throw badRequest('amount must not be zero')
    const description = optionalString(input.description, 'description', 200) ?? 'Admin adjustment'
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!target) throw notFound('Player not found')

    const stored = req.file ? await storeImage(req.file) : null
    try {
      const user = await prisma.$transaction(async (tx) => {
        await lockUsers(tx, [req.params.id])
        const updated = await tx.user.update({
          where: { id: req.params.id },
          data: { balance: { increment: centsToDecimal(cents) } },
          select: fullUserFields,
        })
        await tx.transaction.create({
          data: {
            userId: req.params.id,
            amount: centsToDecimal(cents),
            type: cents > 0 ? TransactionType.ADMIN_CREDIT : TransactionType.ADMIN_DEBIT,
            description,
            screenshotFilename: stored?.filename ?? null,
          },
        })
        return updated
      })
      invalidateDashboard()
      emitToUser(req.params.id, 'balance:updated', { balance: user.balance })
      res.json({ data: user })
    } catch (error) {
      if (stored) await removeStoredImage(stored.filename)
      throw error
    }
  })

  // DELETE /api/players/:id — only a player without any history; the ledger is never rewritten
  router.delete('/:id', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!user) throw notFound('Player not found')
    if (user.role === Role.ADMIN) throw badRequest('Cannot delete admin account')
    if (req.params.id === req.user!.userId) throw badRequest('Cannot delete yourself')

    await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [req.params.id])
      const [games, ledger, pingsSent] = await Promise.all([
        tx.gamePlayer.count({ where: { userId: req.params.id } }),
        tx.transaction.count({ where: { userId: req.params.id } }),
        tx.ping.count({ where: { fromUserId: req.params.id, game: { isNot: null } } }),
      ])
      if (games > 0 || ledger > 0 || pingsSent > 0) {
        throw conflict('This player has game or ledger history and cannot be deleted. Change their password to lock them out.')
      }
      await tx.idempotencyKey.deleteMany({ where: { userId: req.params.id } })
      await tx.depositRequest.deleteMany({ where: { userId: req.params.id } })
      await tx.pingRecipient.deleteMany({ where: { OR: [{ userId: req.params.id }, { ping: { fromUserId: req.params.id } }] } })
      await tx.ping.deleteMany({ where: { fromUserId: req.params.id } })
      await tx.user.delete({ where: { id: req.params.id } })
    })
    disconnectUser(req.params.id)
    res.json({ data: { ok: true } })
  })

  // GET /api/players/:id/transactions — newest first, each row with the running balance after it
  router.get('/:id/transactions', requireAuth, async (req: AuthRequest<IdParams>, res) => {
    if (req.user!.userId !== req.params.id && req.user!.role !== 'ADMIN') throw forbidden()
    const exists = await prisma.user.count({ where: { id: req.params.id } })
    if (!exists) throw notFound('Player not found')
    const ledger = await ledgerFor(req.params.id, { limit: 200 })
    const transactions = [...ledger.rows].reverse().map((r) => ({
      id: r.id,
      userId: req.params.id,
      amount: r.amountCents / 100,
      type: r.type,
      gameId: r.gameId,
      description: r.description,
      screenshotFilename: r.screenshotFilename,
      createdAt: r.at,
      balanceAfter: r.balanceAfterCents / 100,
    }))
    res.json({ data: transactions, meta: { truncated: ledger.truncated, closingBalance: ledger.closingCents / 100 } })
  })

  // GET /api/players/:id/statement.pdf?period=YYYY-MM|YYYY|last30|all | from=&to=
  router.get('/:id/statement.pdf', requireAuth, statementLimiter(), async (req: AuthRequest<IdParams>, res) => {
    if (req.user!.userId !== req.params.id && req.user!.role !== 'ADMIN') throw forbidden()
    const player = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, username: true } })
    if (!player) throw notFound('Player not found')

    const first = await prisma.transaction.aggregate({ where: { userId: player.id }, _min: { createdAt: true } })
    const period = resolvePeriod(req.query as PeriodQuery, new Date(), LOCALE.timezone, first._min.createdAt ?? undefined)
    const release = acquireExport(req.user!.userId)
    try {
      const view = shapeStatement(await buildStatement(player.id, period))
      // A client that already went away costs nothing more; otherwise the guard is held until the
      // response is fully written (or the connection drops), with pipe backpressure in between.
      if (res.destroyed) return
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${view.fileName}"`)
      res.setHeader('Cache-Control', 'no-store')
      await new Promise<void>((resolve, reject) => {
        res.once('finish', resolve)
        res.once('close', resolve)
        res.once('error', reject)
        renderStatement(view, res)
      })
    } finally {
      release()
    }
  })

  return router
}
