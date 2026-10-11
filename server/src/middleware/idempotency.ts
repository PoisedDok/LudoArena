import type { NextFunction, Response } from 'express'
import prisma, { Prisma } from '../lib/prisma'
import type { AuthRequest } from './auth'
import { badRequest, conflict, HttpError } from '../lib/errors'

const KEY = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Optional `Idempotency-Key` header on a create. The first request with a key runs; a retry with the
 * same key (a double tap, a flaky network) gets the stored answer instead of a second record, and a
 * retry that arrives while the first is still running gets 409. Only successful answers are stored,
 * so a request that failed validation can be corrected and sent again with the same key.
 * Must come after requireAuth: keys are scoped per user.
 */
export async function idempotent(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const key = req.get('idempotency-key')
    if (key === undefined) {
      next()
      return
    }
    if (!KEY.test(key)) throw badRequest('Idempotency-Key must be 8-64 characters of A-Z a-z 0-9 _ -')
    const userId = req.user!.userId
    const path = req.baseUrl + req.path

    try {
      await prisma.idempotencyKey.create({ data: { userId, key, method: req.method, path } })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      const existing = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } })
      if (!existing) throw conflict('Request already in progress')
      if (existing.method !== req.method || existing.path !== path) {
        throw new HttpError(422, 'Idempotency-Key was already used for a different request')
      }
      if (existing.status === null) throw conflict('Request already in progress')
      res.setHeader('Idempotent-Replay', 'true')
      res.status(existing.status).json(existing.response)
      return
    }

    const json = res.json.bind(res)
    res.json = (body: unknown) => {
      const status = res.statusCode
      const settle =
        status >= 200 && status < 300
          ? prisma.idempotencyKey.update({
              where: { userId_key: { userId, key } },
              data: { status, response: body as Prisma.InputJsonValue },
            })
          : prisma.idempotencyKey.delete({ where: { userId_key: { userId, key } } })
      // The answer is sent after the record is settled, so a retry never sees a half-finished key.
      settle.then(
        () => json(body),
        () => json(body),
      )
      return res
    }
    next()
  } catch (error) {
    next(error)
  }
}
