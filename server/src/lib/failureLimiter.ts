/**
 * Counts failures per key inside a fixed window, and refuses a key once it reached the limit.
 * Unlike a request-rate limiter it is consulted before the work and charged only when the work failed,
 * so many people signing in correctly at the same moment (one household, one mobile carrier address)
 * never lock each other out. The map is bounded: expired entries go first, then the oldest.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Seconds until the key may try again, or 0 when it is allowed. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.entries.get(key)
    if (!entry) return 0
    if (entry.resetAt <= now) {
      this.entries.delete(key)
      return 0
    }
    return entry.count >= this.max ? Math.ceil((entry.resetAt - now) / 1000) : 0
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.entries.get(key)
    if (entry && entry.resetAt > now) {
      entry.count++
      return
    }
    if (this.entries.size >= this.maxKeys) this.evict(now)
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs })
  }

  clear(key: string): void {
    this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key)
    }
    // Still full: drop the oldest insertions (Map iterates in insertion order).
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
  }
}
