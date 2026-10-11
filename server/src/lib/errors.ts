import type { ErrorRequestHandler, RequestHandler } from 'express'
import { log } from './logger'
import { getEnv } from '../config/env'

/** A failure that is safe to show to the caller. Anything else becomes a fixed 500 sentence. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, code?: string) => new HttpError(400, message, code)
export const unauthorized = (message = 'Unauthorized') => new HttpError(401, message)
export const forbidden = (message = 'Forbidden') => new HttpError(403, message)
export const notFound = (message = 'Not found') => new HttpError(404, message)
export const conflict = (message: string, code?: string) => new HttpError(409, message, code)

interface ErrorLike {
  status?: number
  statusCode?: number
  type?: string
  code?: string
  message?: string
  name?: string
}

const MULTER_LIMITS: Record<string, [number, string]> = {
  LIMIT_FILE_SIZE: [413, 'The file is too large'],
  LIMIT_FILE_COUNT: [400, 'Too many files'],
  LIMIT_FIELD_COUNT: [400, 'Too many fields'],
  LIMIT_PART_COUNT: [400, 'Too many parts'],
  LIMIT_UNEXPECTED_FILE: [400, 'Unexpected file field'],
}

/** Maps library errors (body-parser, multer, Prisma) onto the API's one error shape. */
export function toHttpError(err: unknown): HttpError | null {
  if (err instanceof HttpError) return err
  const e = err as ErrorLike
  if (e?.type === 'entity.too.large') return new HttpError(413, 'Request body too large')
  if (e?.type === 'entity.parse.failed') return new HttpError(400, 'Malformed JSON body')
  if (e?.name === 'MulterError' && e.code && MULTER_LIMITS[e.code]) {
    const [status, message] = MULTER_LIMITS[e.code]!
    return new HttpError(status, message)
  }
  if (e?.code === 'P2002') return new HttpError(409, 'That value is already in use')
  if (e?.code === 'P2025') return new HttpError(404, 'Not found')
  if (e?.code === 'P2003') return new HttpError(409, 'The record is still referenced by other data')
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
    return new HttpError(e.status, e.message || 'Bad request')
  }
  return null
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'Not found', requestId: req.id })
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const mapped = toHttpError(err)
  if (res.headersSent) {
    req.socket.destroy()
    return
  }
  if (mapped) {
    res.status(mapped.status).json({ error: mapped.message, ...(mapped.code ? { code: mapped.code } : {}) })
    return
  }
  log.error('unhandled error', { requestId: req.id, method: req.method, path: req.path, err })
  const message = getEnv().isProduction ? 'Internal server error' : String((err as Error)?.message ?? 'Internal server error')
  res.status(500).json({ error: message, requestId: req.id })
}
