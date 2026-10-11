import { afterAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { closePasswordWorker, hashPassword, verifyPassword } from '../src/lib/password'
import { randomSecret } from './helpers'

afterAll(closePasswordWorker)

describe('password worker', () => {
  it('hashes and verifies off the main thread, wrong passwords are false', async () => {
    const password = randomSecret()
    const hash = await hashPassword(password)
    expect(hash).toMatch(/^\$2[aby]\$12\$/)
    expect(await verifyPassword(password, hash)).toBe(true)
    expect(await verifyPassword('not-the-password', hash)).toBe(false)
    // Interoperates with hashes made elsewhere (the existing admin's hash was made by bcryptjs directly).
    expect(await verifyPassword('legacy-pass', bcrypt.hashSync('legacy-pass', 4))).toBe(true)
  })

  it('keeps the event loop responsive while cost-12 hashes are computed', async () => {
    let worst = 0
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 10)
    await Promise.all([hashPassword(randomSecret()), hashPassword(randomSecret()), hashPassword(randomSecret())])
    clearInterval(timer)
    // On the main thread one cost-12 hash blocks for hundreds of milliseconds.
    expect(worst).toBeLessThan(150)
  }, 30_000)

  it('refuses work with a 503 instead of queueing without bound', async () => {
    const hash = bcrypt.hashSync('x', 10)
    const results = await Promise.allSettled(Array.from({ length: 120 }, () => verifyPassword('x', hash)))
    const refused = results.filter((r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 503)
    expect(refused.length).toBeGreaterThan(0)
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0)
  }, 60_000)
})
