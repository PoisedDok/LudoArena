import { HttpError } from '../lib/errors'

/**
 * Backpressure for PDF exports: one at a time per user, and at most MAX_GLOBAL at once on the whole
 * server, so a few people exporting never take the memory of the box. Rejected requests fail fast
 * with 429 instead of queueing.
 */
const MAX_GLOBAL = 2
const running = new Set<string>()

export function acquireExport(userId: string): () => void {
  if (running.has(userId)) throw new HttpError(429, 'An export is already running. Wait for it to finish.')
  if (running.size >= MAX_GLOBAL) throw new HttpError(429, 'The server is busy exporting. Try again in a moment.')
  running.add(userId)
  let released = false
  return () => {
    if (released) return
    released = true
    running.delete(userId)
  }
}

export function activeExports(): number {
  return running.size
}
