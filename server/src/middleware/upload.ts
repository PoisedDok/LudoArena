import multer from 'multer'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { UPLOAD } from '../config/limits'
import { HttpError, badRequest } from '../lib/errors'

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type ImageKind = 'jpg' | 'png' | 'webp'

export const CONTENT_TYPES: Record<ImageKind, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export function uploadsDir(): string {
  return path.join(process.cwd(), 'uploads')
}

/** Incoming bytes land here first; a file only moves to `uploads/` after its content is verified. */
export function incomingDir(): string {
  return path.join(uploadsDir(), '.incoming')
}

/** The image type from the file's first bytes; the client-declared type is only a hint. */
export function sniffImage(head: Buffer): ImageKind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

const incoming = multer({
  // Streamed to disk: a 10 MB upload never sits in the Node heap.
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fsp.mkdir(incomingDir(), { recursive: true }).then(
        () => cb(null, incomingDir()),
        (error: Error) => cb(error, incomingDir()),
      )
    },
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: { fileSize: UPLOAD.maxBytes, files: 1, fields: 10, parts: 12 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new HttpError(415, 'Only JPEG, PNG or WebP images are accepted'))
      return
    }
    cb(null, true)
  },
})

/**
 * Parses a multipart body with at most one image in `field`. Whatever happens to the request, the
 * temporary file is removed when the response ends unless `storeImage` already moved it.
 */
export function imageUpload(field: string): RequestHandler {
  const parse = incoming.single(field)
  return (req: Request, res: Response, next: NextFunction) => {
    res.once('close', () => {
      const file = req.file
      if (file?.path) void fsp.unlink(file.path).catch(() => undefined)
    })
    parse(req, res, next)
  }
}

export interface StoredImage {
  filename: string
  sha256: string
}

/**
 * Verifies the file's content and moves it under a random name. Call it only after every other
 * validation passed, so a rejected request leaves nothing behind.
 */
export async function storeImage(file: Express.Multer.File | undefined): Promise<StoredImage> {
  if (!file) throw badRequest('Screenshot is required')
  const handle = await fsp.open(file.path, 'r')
  let head: Buffer
  try {
    head = Buffer.alloc(12)
    await handle.read(head, 0, 12, 0)
  } finally {
    await handle.close()
  }
  const kind = sniffImage(head)
  if (!kind) throw new HttpError(415, 'The file is not a valid JPEG, PNG or WebP image')

  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk as Buffer)

  const filename = `${randomUUID()}.${kind}`
  await fsp.mkdir(uploadsDir(), { recursive: true })
  await fsp.rename(file.path, path.join(uploadsDir(), filename))
  await fsp.chmod(path.join(uploadsDir(), filename), 0o640)
  return { filename, sha256: hash.digest('hex') }
}

export async function removeStoredImage(filename: string): Promise<void> {
  await fsp.unlink(path.join(uploadsDir(), filename)).catch(() => undefined)
}

export const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/
