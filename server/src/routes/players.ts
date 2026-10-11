import { Router } from 'express'
import { randomBytes } from 'crypto'
import { hashPassword } from '../lib/password'
import { hashShareLoginToken } from '../lib/session'
import prisma, { lockUsers } from '../lib/prisma'
import { requireAuth, requireAdmin, requirePlayableAccount, AuthRequest } from '../middleware/auth'
import { idempotent } from '../middleware/idempotency'
import { imageUpload, removeStoredImage, storeImage } from '../middleware/upload'
import { statementLimiter, uploadLimiter } from '../middleware/rateLimit'
import { disconnectUser, emitToAll, emitToUser, emitToUsers } from '../lib/socket'
import { TransactionType, Role } from '../../generated/prisma'
import { requiredPlayerCount } from '../services/settlement'
import { AUTH, MONEY } from '../config/limits'
import { amountCents, body, bool, optionalString, requiredString } from '../lib/validate'
import { centsToDecimal } from '../lib/money'
import { invalidateDashboard } from '../services/dashboard'
import { ledgerFor } from '../services/ledger'
import { buildStatement } from '../services/statement'
import { renderStatement } from '../services/statementPdf'
import { shapeStatement } from '../services/statementView'
import { acquireExport } from '../services/exportGuard'
import { OPEN_GAME_STATUSES } from '../services/games'
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
      permanentlyPurgedAt: null,
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
      where: { deletedAt: null },
      select: isAdmin ? fullUserFields : publicUserFields,
      orderBy: { username: 'asc' },
    })
    res.json({ data: users })
  })

  // GET /api/players/deleted — admin-only archive, excluding accounts whose private profile was purged
  router.get('/deleted', requireAdmin, async (_req, res) => {
    const users = await prisma.user.findMany({
      where: { deletedAt: { not: null }, permanentlyPurgedAt: null, role: Role.PLAYER },
      select: { ...fullUserFields, deletedAt: true },
      orderBy: { deletedAt: 'desc' },
    })
    res.json({ data: users })
  })

  // POST /api/players/:id/restore — return an archived player to the regular player list.
  router.post('/:id/restore', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    const restored = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [req.params.id])
      const user = await tx.user.findUnique({ where: { id: req.params.id } })
      if (!user || user.role !== Role.PLAYER || !user.deletedAt) throw notFound('Deleted player not found')
      if (user.permanentlyPurgedAt) throw conflict('A permanently cleaned-up player cannot be restored')
      return tx.user.update({
        where: { id: req.params.id },
        data: { deletedAt: null, isActive: false },
        select: { id: true, username: true },
      })
    })
    emitToAll('player:status', { userId: restored.id, username: restored.username, isActive: false, deleted: false, restored: true })
    invalidateDashboard()
    res.json({ data: { ok: true } })
  })

  // GET /api/players/:id
  router.get('/:id', requireAuth, async (req: AuthRequest<IdParams>, res) => {
    const isAdmin = req.user!.role === 'ADMIN'
    const isSelf = req.user!.userId === req.params.id
    const user = await prisma.user.findUnique({
      where: { id: req.params.id, deletedAt: isAdmin || isSelf ? undefined : null },
      select: isAdmin || isSelf ? fullUserFields : publicUserFields,
    })
    if (!user) throw notFound('Player not found')
    res.json({ data: user })
  })

  // POST /api/players/:id/share-link — issue a fresh, single-use 5-minute login link.
  router.post('/:id/share-link', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    const token = randomBytes(32).toString('hex')
    const tokenHash = hashShareLoginToken(token)
    const expiresAt = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [req.params.id])
      const user = await tx.user.findUnique({
        where: { id: req.params.id },
        select: { role: true, deletedAt: true, permanentlyPurgedAt: true },
      })
      if (!user || user.role !== Role.PLAYER) throw notFound('Player not found')
      if (user.deletedAt || user.permanentlyPurgedAt) throw conflict('Restore this player before creating a share link')
      const now = new Date()
      const expiresAt = new Date(now.getTime() + AUTH.shareLoginLinkTtlSeconds * 1000)
      await tx.shareLoginLink.upsert({
        where: { userId: req.params.id },
        create: { userId: req.params.id, tokenHash, expiresAt },
        update: { tokenHash, expiresAt, consumedAt: null, createdAt: now },
      })
      return expiresAt
    })
    res.json({ data: { token, expiresAt: expiresAt.toISOString() } })
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
    try {
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
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw conflict('That username or phone number is already in use')
      throw error
    }
  })

  // PUT /api/players/:id
  router.put('/:id', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    const input = body(req)
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true } })
    if (!target) throw notFound('Player not found')
    if (target.deletedAt) throw conflict('Restore this player before editing their account')

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

    const user = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [req.params.id])
      const current = await tx.user.findUnique({ where: { id: req.params.id }, select: { deletedAt: true } })
      if (!current) throw notFound('Player not found')
      if (current.deletedAt) throw conflict('Restore this player before editing their account')
      const updated = await tx.user.update({ where: { id: req.params.id }, data, select: fullUserFields })
      if (passwordChanged) await tx.shareLoginLink.deleteMany({ where: { userId: req.params.id } })
      return updated
    })
    // A reset ends every session of that user (the version bump refuses old tokens, the rows go too),
    // sockets included.
    if (passwordChanged) {
      await prisma.session.deleteMany({ where: { userId: req.params.id } })
      disconnectUser(req.params.id)
    }
    res.json({ data: user })
  })

  // PATCH /api/players/:id/active
  router.patch('/:id/active', requireAuth, requirePlayableAccount, async (req: AuthRequest<IdParams>, res) => {
    if (req.user!.userId !== req.params.id && req.user!.role !== 'ADMIN') throw forbidden()
    const isActive = bool(body(req).isActive, 'isActive')
    const user = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [req.params.id])
      const target = await tx.user.findUnique({ where: { id: req.params.id } })
      if (!target) throw notFound('Player not found')
      if (target.deletedAt) throw conflict('Restore this player before changing their status')
      return tx.user.update({
        where: { id: req.params.id },
        data: { isActive },
        select: { id: true, isActive: true, username: true },
      })
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
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true } })
    if (!target) throw notFound('Player not found')
    if (target.deletedAt) throw conflict('Restore this player before adjusting their balance')

    const stored = req.file ? await storeImage(req.file) : null
    try {
      const user = await prisma.$transaction(async (tx) => {
        await lockUsers(tx, [req.params.id])
        const current = await tx.user.findUnique({ where: { id: req.params.id }, select: { deletedAt: true } })
        if (!current) throw notFound('Player not found')
        if (current.deletedAt) throw conflict('Restore this player before adjusting their balance')
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

  // DELETE /api/players/:id — move the account to the deleted-player archive without touching history
  router.delete('/:id', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    if (req.params.id === req.user!.userId) throw badRequest('Cannot delete yourself')
    const archived = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [req.params.id])
      const user = await tx.user.findUnique({ where: { id: req.params.id } })
      if (!user) throw notFound('Player not found')
      if (user.role === Role.ADMIN) throw badRequest('Cannot delete admin account')
      if (user.deletedAt) throw conflict('Player is already in the deleted players list')
      const openGames = await tx.gamePlayer.findMany({
        where: { userId: req.params.id, game: { status: { in: OPEN_GAME_STATUSES } } },
        select: { gameId: true },
      })
      if (openGames.length > 0) {
        throw conflict(`Cannot delete this player while ${openGames.length} game${openGames.length === 1 ? ' is' : 's are'} active or awaiting completion. Finish or resolve ${openGames.length === 1 ? 'it' : 'them'} first.`)
      }

      const openPings = await tx.ping.findMany({
        where: {
          status: 'PENDING',
          OR: [
            { fromUserId: req.params.id },
            { recipients: { some: { userId: req.params.id, response: { in: ['PENDING', 'ACCEPTED'] } } } },
          ],
        },
        select: {
          id: true,
          fromUserId: true,
          isBroadcast: true,
          gameType: true,
          recipients: {
            select: { userId: true, response: true, user: { select: { username: true } } },
          },
        },
      })

      const archivedUser = await tx.user.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date(), isActive: false },
        select: { username: true, deletedAt: true },
      })
      await tx.shareLoginLink.deleteMany({ where: { userId: req.params.id } })
      return { openPings, username: archivedUser.username, deletedAt: archivedUser.deletedAt! }
    })

    emitToAll('player:status', {
      userId: req.params.id,
      isActive: false,
      username: archived.username,
      deleted: true,
      deletedAt: archived.deletedAt.toISOString(),
    })
    for (const ping of archived.openPings) {
      if (ping.fromUserId === req.params.id) {
        const cancelled = await prisma.ping.updateMany({
          where: { id: ping.id, status: 'PENDING' },
          data: { status: 'DECLINED' },
        })
        if (cancelled.count === 0) continue
        if (ping.isBroadcast) emitToAll('ping:broadcast_resolved', { pingId: ping.id, reason: 'cancelled' })
        else emitToUsers(
          (await prisma.pingRecipient.findMany({ where: { pingId: ping.id }, select: { userId: true } })).map((r) => r.userId),
          'ping:declined',
          { pingId: ping.id, byUserId: req.params.id },
        )
      } else if (ping.isBroadcast && ping.recipients.some((recipient) => recipient.userId === req.params.id && recipient.response === 'ACCEPTED')) {
        const declined = await prisma.pingRecipient.updateMany({
          where: { pingId: ping.id, userId: req.params.id, response: 'ACCEPTED', ping: { status: 'PENDING' } },
          data: { response: 'DECLINED' },
        })
        if (declined.count === 0) continue
        const acceptedPlayers = ping.recipients
          .filter((recipient) => recipient.userId !== req.params.id && recipient.response === 'ACCEPTED')
          .map((recipient) => ({ userId: recipient.userId, username: recipient.user.username }))
        const acceptedCount = acceptedPlayers.length
        const required = requiredPlayerCount(ping.gameType) - 1
        emitToAll('ping:broadcast_update', { pingId: ping.id, acceptedCount, required })
        emitToUser(ping.fromUserId, 'ping:partially_accepted', { pingId: ping.id, acceptedCount, required, acceptedPlayers })
      } else if (!ping.isBroadcast && ping.recipients.some((recipient) => recipient.userId === req.params.id && recipient.response === 'PENDING')) {
        const declined = await prisma.pingRecipient.updateMany({
          where: { pingId: ping.id, userId: req.params.id, response: 'PENDING', ping: { status: 'PENDING' } },
          data: { response: 'DECLINED' },
        })
        if (declined.count === 0) continue
        emitToUser(ping.fromUserId, 'ping:declined', { pingId: ping.id, byUserId: req.params.id })
      }
    }
    invalidateDashboard()
    res.json({ data: { ok: true } })
  })

  // DELETE /api/players/:id/permanent-cleanup — erase login/contact data while retaining shared history
  router.delete('/:id/permanent-cleanup', requireAdmin, async (req: AuthRequest<IdParams>, res) => {
    if (req.params.id === req.user!.userId) throw badRequest('Cannot delete yourself')
    const passwordHash = await hashPassword(randomBytes(32).toString('hex'))
    await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [req.params.id])
      const user = await tx.user.findUnique({ where: { id: req.params.id } })
      if (!user || !user.deletedAt || user.role !== Role.PLAYER) throw notFound('Deleted player not found')
      if (user.permanentlyPurgedAt) throw conflict('Player profile has already been permanently cleaned up')

      await tx.session.deleteMany({ where: { userId: req.params.id } })
      await tx.idempotencyKey.deleteMany({ where: { userId: req.params.id } })
      await tx.shareLoginLink.deleteMany({ where: { userId: req.params.id } })
      await tx.user.update({
        where: { id: req.params.id },
        data: {
          phone: null,
          passwordHash,
          permanentlyPurgedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
      })
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
