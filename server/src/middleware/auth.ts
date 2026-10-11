import type { NextFunction, Request, Response } from 'express'
import type { ParamsDictionary } from 'express-serve-static-core'
import type { ParsedQs } from 'qs'
import { authenticateToken, COOKIE_NAME } from '../lib/session'
import { forbidden, unauthorized } from '../lib/errors'

export interface AuthRequest<
  P extends ParamsDictionary = ParamsDictionary,
  Q extends ParsedQs = ParsedQs,
> extends Request<P, unknown, unknown, Q> {
  user?: { userId: string; role: 'ADMIN' | 'PLAYER' }
}

export async function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await authenticateToken(req.cookies?.[COOKIE_NAME] as string | undefined)
    if (!session) {
      next(unauthorized())
      return
    }
    req.user = session
    next()
  } catch (error) {
    next(error)
  }
}

export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  await requireAuth(req, res, (err?: unknown) => {
    if (err) {
      next(err)
      return
    }
    if (req.user?.role !== 'ADMIN') {
      next(forbidden())
      return
    }
    next()
  })
}
