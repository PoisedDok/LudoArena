import { Router } from 'express'
import path from 'path'
import prisma from '../lib/prisma'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { CONTENT_TYPES, ImageKind, STORED_NAME, uploadsDir } from '../middleware/upload'
import { notFound } from '../lib/errors'

type NameParams = { filename: string }

/**
 * Payment and result screenshots are private. A file is served only to a signed-in user who is
 * allowed to see the record that references it: the admin sees every referenced file, a player sees
 * their own deposits, their own ledger proofs and the screenshots of games they played in.
 */
export function filesRouter(): Router {
  const router = Router()

  router.get('/:filename', requireAuth, async (req: AuthRequest<NameParams>, res) => {
    const { filename } = req.params
    if (!STORED_NAME.test(filename)) throw notFound()
    const { userId, role } = req.user!
    const mine = { userId }

    const [screenshot, deposit, ledger] = await Promise.all([
      prisma.screenshot.findFirst({
        where: { filename, ...(role === 'ADMIN' ? {} : { game: { players: { some: { userId } } } }) },
        select: { id: true },
      }),
      prisma.depositRequest.findFirst({
        where: { screenshotFilename: filename, ...(role === 'ADMIN' ? {} : mine) },
        select: { id: true },
      }),
      prisma.transaction.findFirst({
        where: { screenshotFilename: filename, ...(role === 'ADMIN' ? {} : mine) },
        select: { id: true },
      }),
    ])
    if (!screenshot && !deposit && !ledger) throw notFound()

    const kind = path.extname(filename).slice(1) as ImageKind
    res.setHeader('Content-Type', CONTENT_TYPES[kind])
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.sendFile(filename, { root: uploadsDir(), dotfiles: 'deny', headers: {} }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Not found' })
    })
  })

  return router
}
