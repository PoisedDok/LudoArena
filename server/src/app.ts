import express, { Express, Router } from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import prisma from './lib/prisma'
import { getEnv } from './config/env'
import { HTTP } from './config/limits'
import { errorHandler, notFoundHandler } from './lib/errors'
import { httpsRedirect, requestId, requestLog, sameOriginWrites } from './middleware/request'
import { apiLimiter } from './middleware/rateLimit'
import { authRouter } from './routes/auth'
import { playersRouter } from './routes/players'
import { pingsRouter } from './routes/pings'
import { gamesRouter } from './routes/games'
import { adminRouter } from './routes/admin'
import { depositsRouter } from './routes/deposits'
import { filesRouter } from './routes/files'

export interface AppOptions {
  /** Directory holding the built client; served with SPA fallback when set. */
  staticDir?: string
}

export interface MountedRouter {
  prefix: string
  router: Router
}

export interface BuiltApp {
  app: Express
  routers: MountedRouter[]
  /** Flipped by shutdown so /api/ready tells the proxy to stop sending traffic. */
  state: { shuttingDown: boolean }
}

/** Public routes, by "METHOD path". Everything else must answer 401 without a session (tested). */
export const PUBLIC_ROUTES = new Set(['POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/share-login'])

export function createApp(options: AppOptions = {}): BuiltApp {
  const env = getEnv()
  const app = express()
  const state = { shuttingDown: false }

  app.disable('x-powered-by')
  app.set('trust proxy', env.trustProxy)

  app.use(requestId)
  app.use(httpsRedirect)

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Vue writes inline style attributes (safe-area padding, transitions).
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", env.clientOrigin.replace(/^http/, 'ws')],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'same-origin' },
    }),
  )
  // Health endpoints answer before anything that could refuse them (limits, origin checks).
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true })
  })
  app.get('/api/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (state.shuttingDown) {
      res.status(503).json({ ok: false, reason: 'shutting down' })
      return
    }
    try {
      await prisma.$queryRaw`SELECT 1`
      res.json({ ok: true })
    } catch {
      res.status(503).json({ ok: false, reason: 'database unavailable' })
    }
  })

  app.use(cors({ origin: env.clientOrigin, credentials: true }))
  app.use(requestLog)
  app.use(express.json({ limit: HTTP.jsonBodyLimit }))
  app.use(cookieParser())
  app.use('/api', apiLimiter())
  app.use('/api', sameOriginWrites)
  app.use('/api', (_req, res, next) => {
    // Financial data is never kept by a browser cache or an intermediary.
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  const routers: MountedRouter[] = [
    { prefix: '/api/auth', router: authRouter() },
    { prefix: '/api/players', router: playersRouter() },
    { prefix: '/api/pings', router: pingsRouter() },
    { prefix: '/api/games', router: gamesRouter() },
    { prefix: '/api/admin', router: adminRouter() },
    { prefix: '/api/deposits', router: depositsRouter() },
    { prefix: '/api/files', router: filesRouter() },
  ]
  for (const { prefix, router } of routers) app.use(prefix, router)

  // Unknown API paths are JSON 404s; they must never fall through to the SPA shell.
  app.use('/api', notFoundHandler)

  if (options.staticDir) {
    const dir = options.staticDir
    app.use(
      express.static(dir, {
        index: false,
        setHeaders(res, filePath) {
          if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          else res.setHeader('Cache-Control', 'no-cache')
        },
      }),
    )
    // SPA routes have no file extension; a missing asset is a real 404, never index.html.
    app.get(/^\/(?!api\/)[^.]*$/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.sendFile(path.join(dir, 'index.html'))
    })
  }
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, routers, state }
}
