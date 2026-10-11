import { randomUUID } from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { log } from '../lib/logger'
import { getEnv } from '../config/env'
import { forbidden } from '../lib/errors'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string
    }
  }
}

const WELL_FORMED = /^[A-Za-z0-9._-]{8,64}$/

/** Gives every request an id (kept from the proxy when well formed); it is on 500 bodies and log lines. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('x-request-id')
  req.id = inbound && WELL_FORMED.test(inbound) ? inbound : randomUUID()
  res.setHeader('X-Request-Id', req.id)
  next()
}

/** One JSON line per finished request; slow requests are flagged. Never logs bodies, cookies or query strings. */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n)
    // originalUrl, not path: inside a mounted router `path` is relative to the mount point.
    const path = req.originalUrl.split('?')[0]!
    if (path === '/api/health' || path === '/api/ready') return
    const fields = { requestId: req.id, method: req.method, path, status: res.statusCode, ms, ip: req.ip }
    if (res.statusCode >= 500) log.error('request', fields)
    else if (ms > 500) log.warn('slow request', fields)
    else log.info('request', fields)
  })
  next()
}

/**
 * The session cookie is Secure: a page opened over plain http logs in but never keeps the cookie.
 * Cloudflare reports the visitor's scheme in X-Forwarded-Proto; direct calls (health checks) carry no
 * header and are never redirected. The target is the configured origin, not the Host header.
 */
export function httpsRedirect(req: Request, res: Response, next: NextFunction): void {
  if (getEnv().isProduction && req.headers['x-forwarded-proto'] === 'http') {
    res.redirect(308, `${getEnv().clientOrigin}${req.originalUrl}`)
    return
  }
  next()
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Defence in depth next to SameSite=Lax: a state-changing request from another origin is refused. */
export function sameOriginWrites(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin')
  if (!SAFE_METHODS.has(req.method) && origin && origin !== getEnv().clientOrigin) {
    next(forbidden('Cross-origin request refused'))
    return
  }
  next()
}
