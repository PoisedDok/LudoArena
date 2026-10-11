/** Every tunable number of the server, in one place. */

export const MONEY = {
  /** Largest single amount (stake, deposit, adjustment, limit): 1,000,000.00 in cents. */
  maxAmountCents: 100_000_000,
}

export const COMMISSION = {
  /** Solo and Teams: stakes above this pay the lower rate. */
  tierThresholdCents: 50_000,
  highRateBps: 500,
  lowRateBps: 300,
  /** 4v2: second place pays this share of the stake, first place pays nothing. */
  fourPlayerSecondBps: 1_000,
}

export const GAME = {
  undoWindowMs: 10_000,
  pingTtlMs: 10 * 60 * 1000,
  staleActiveAfterMs: 6 * 60 * 60 * 1000,
  roomCodeMaxLength: 32,
  messageMaxLength: 200,
  maxScreenshotsPerPlayerPerGame: 5,
}

export const AUTH = {
  rememberTtlSeconds: 30 * 24 * 60 * 60,
  sessionTtlSeconds: 24 * 60 * 60,
  loginWindowMs: 15 * 60 * 1000,
  loginMaxFailuresPerIp: 10,
  loginMaxFailuresPerUser: 20,
  passwordMinLength: 8,
  /** bcrypt ignores everything after 72 bytes. */
  passwordMaxBytes: 72,
  bcryptRounds: 12,
}

export const UPLOAD = {
  maxBytes: 10 * 1024 * 1024,
  perUserWindowMs: 10 * 60 * 1000,
  perUserMax: 30,
}

export const HTTP = {
  jsonBodyLimit: '100kb',
  keepAliveTimeoutMs: 65_000,
  headersTimeoutMs: 66_000,
  requestTimeoutMs: 60_000,
  shutdownGraceMs: 10_000,
  /** Generic API limit per client address. */
  apiWindowMs: 60_000,
  apiMax: 600,
}

export const PAGE = { defaultLimit: 50, maxLimit: 200 }

export const JOBS = {
  settleSweepMs: 1_000,
  pingExpiryMs: 60_000,
  staleGameMs: 60 * 60 * 1000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  idempotencySweepMs: 60 * 60 * 1000,
}
