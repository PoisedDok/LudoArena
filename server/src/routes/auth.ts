import { Router } from 'express'
import { hashPassword, verifyPassword } from '../lib/password'
import prisma from '../lib/prisma'
import { authenticateToken, clearSession, COOKIE_NAME, issueSession, revokeSession } from '../lib/session'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { FailureLimiter } from '../lib/failureLimiter'
import { AUTH } from '../config/limits'
import { badRequest, HttpError, unauthorized } from '../lib/errors'
import { body } from '../lib/validate'
import { disconnectSession, emitToAll } from '../lib/socket'

// A real bcrypt hash of a random value, compared against when the account does not exist, so an unknown
// username costs the same time as a wrong password.
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password'))

const sessionView = (user: {
  id: string
  username: string
  phone: string | null
  role: string
  balance: { toNumber(): number }
  isActive?: boolean
  creditLimit?: { toNumber(): number }
  spendLimit?: { toNumber(): number }
}) => ({
  id: user.id,
  username: user.username,
  phone: user.phone,
  role: user.role,
  balance: user.balance.toNumber(),
  isActive: user.isActive,
  creditLimit: user.creditLimit?.toNumber(),
  spendLimit: user.spendLimit?.toNumber(),
})

export function authRouter(): Router {
  const router = Router()
  // Failed attempts only, per address and per account name: a correct password is never slowed down.
  const byIp = new FailureLimiter(AUTH.loginWindowMs, AUTH.loginMaxFailuresPerIp)
  const byName = new FailureLimiter(AUTH.loginWindowMs, AUTH.loginMaxFailuresPerUser)

  router.post('/login', async (req, res) => {
    const input = body(req)
    const { username, password } = input
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      throw badRequest('Username and password required')
    }
    const login = username.trim()
    const ipKey = req.ip ?? 'unknown'
    const nameKey = login.toLowerCase().slice(0, 64)
    const wait = Math.max(byIp.retryAfterSeconds(ipKey), byName.retryAfterSeconds(nameKey))
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait))
      throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.')
    }
    const reject: () => never = () => {
      byIp.recordFailure(ipKey)
      byName.recordFailure(nameKey)
      throw unauthorized('Invalid credentials')
    }
    if (username.length > 64 || password.length > 256) reject()

    // Exact username first, then phone, then username ignoring case (phone keyboards capitalise).
    const user =
      (await prisma.user.findUnique({ where: { username: login } })) ??
      (await prisma.user.findUnique({ where: { phone: login } })) ??
      (await prisma.user.findFirst({ where: { username: { equals: login, mode: 'insensitive' } } }))

    const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()))
    if (!user || !valid) reject()
    byName.clear(nameKey)

    await issueSession(res, user, input.remember === true)
    res.json({ data: sessionView(user) })
  })

  // Public on purpose: signing out must always clear the cookie, even when the session already expired.
  router.post('/logout', async (req, res) => {
    const session = await authenticateToken(req.cookies?.[COOKIE_NAME] as string | undefined)
    if (session) {
      // The token dies now, for anybody holding a copy, and this browser's socket is dropped.
      await revokeSession(session.sid)
      disconnectSession(session.sid)
      // Players stop appearing as available when they sign out.
      const user = await prisma.user.update({ where: { id: session.userId }, data: { isActive: false } })
      emitToAll('player:status', { userId: session.userId, isActive: false, username: user.username })
    }
    clearSession(res)
    res.json({ data: { ok: true } })
  })

  router.get('/me', requireAuth, async (req: AuthRequest, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.userId } })
    res.json({ data: sessionView(user) })
  })

  return router
}
