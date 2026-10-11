import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import type { RequestHandler } from 'express'
import { HTTP, UPLOAD } from '../config/limits'
import type { AuthRequest } from './auth'

const tooMany = (message: string) => ({ error: message })

/** Per client address, all of /api. Generous: it only stops a runaway client loop. */
export const apiLimiter = () =>
  rateLimit({
    windowMs: HTTP.apiWindowMs,
    limit: HTTP.apiMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany('Too many requests. Slow down.'),
    skip: (req) => req.path === '/health' || req.path === '/ready',
  })

/** PDF statements: 10 per 10 minutes per user. */
export const statementLimiter = () =>
  rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany('Too many statement exports. Try again in a few minutes.'),
    keyGenerator: (req) => `s:${(req as AuthRequest).user?.userId ?? ipKeyGenerator(req.ip ?? '')}`,
  })

/** Counts only multipart requests (the ones that can carry a file) per user. */
export const uploadLimiter = (): RequestHandler => {
  const limiter = rateLimit({
    windowMs: UPLOAD.perUserWindowMs,
    limit: UPLOAD.perUserMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany('Too many uploads. Try again later.'),
    keyGenerator: (req) => `u:${(req as AuthRequest).user?.userId ?? ipKeyGenerator(req.ip ?? '')}`,
  })
  return (req, res, next) => (req.is('multipart/form-data') ? limiter(req, res, next) : next())
}
