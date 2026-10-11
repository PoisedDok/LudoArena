import 'dotenv/config'
import net from 'net'

/**
 * Environment validation. The server refuses to start with a missing or unsafe setting and names every
 * problem at once (never a secret's value). `parseEnv` is pure so it can be tested; `env` is the parsed
 * process environment, the only place `process.env` is read.
 */

export const MIN_SECRET_LENGTH = 32
const PLACEHOLDER = /change|secret_key|placeholder|example|password|admin123|ludo_secret/i
const ENVIRONMENTS = ['development', 'test', 'production'] as const
type NodeEnv = (typeof ENVIRONMENTS)[number]

export interface Env {
  nodeEnv: NodeEnv
  isProduction: boolean
  databaseUrl: string
  jwtSecret: string
  port: number
  clientUrl: string
  clientOrigin: string
  trustProxy: number | string | false
  dbPoolMax: number
}

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment:\n - ${problems.join('\n - ')}`)
    this.name = 'EnvError'
  }
}

/** Hop count, `false`, or an explicit address list. `true` would let a client choose its own address. */
export function parseTrustProxy(value: string | undefined): number | string | false {
  const text = (value ?? '').trim()
  if (text === '') return 1
  if (/^\d+$/.test(text)) return Number(text)
  const lower = text.toLowerCase()
  if (lower === 'false') return false
  if (lower === 'true') {
    throw new Error('TRUST_PROXY=true trusts every hop and makes X-Forwarded-For spoofable: use a hop count or an address list')
  }
  const keywords = ['loopback', 'linklocal', 'uniquelocal']
  const tokens = text.split(',').map((t) => t.trim())
  const ok = tokens.every((t) => {
    if (keywords.includes(t)) return true
    const [address, prefix, ...rest] = t.split('/')
    if (rest.length > 0 || !address || !net.isIP(address)) return false
    if (prefix === undefined) return true
    return /^\d+$/.test(prefix) && Number(prefix) <= (net.isIPv4(address) ? 32 : 128)
  })
  if (!ok) throw new Error(`TRUST_PROXY="${text}" is not a hop count, false, or a list of addresses/subnets`)
  return tokens.join(', ')
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const problems: string[] = []

  const nodeEnv = source.NODE_ENV as NodeEnv
  if (!ENVIRONMENTS.includes(nodeEnv)) problems.push(`NODE_ENV must be one of ${ENVIRONMENTS.join(', ')}`)
  const isProduction = nodeEnv === 'production'

  const databaseUrl = source.DATABASE_URL ?? ''
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must be a postgresql:// URL')

  const jwtSecret = source.JWT_SECRET ?? ''
  if (jwtSecret.length < MIN_SECRET_LENGTH) problems.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32)`)
  else if (PLACEHOLDER.test(jwtSecret)) problems.push('JWT_SECRET is still a placeholder value')

  const portText = source.PORT ?? '4002'
  const port = Number(portText)
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) problems.push('PORT must be a number between 1 and 65535')

  let clientUrl = source.CLIENT_URL ?? ''
  let clientOrigin = ''
  if (!clientUrl && !isProduction) clientUrl = 'http://localhost:5867'
  try {
    const parsed = new URL(clientUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('scheme')
    clientOrigin = parsed.origin
    if (isProduction && parsed.protocol !== 'https:') {
      problems.push('CLIENT_URL must be https in production (the session cookie is Secure)')
    }
  } catch {
    problems.push('CLIENT_URL must be an absolute http(s) URL such as https://ludo.example.com')
  }

  let trustProxy: Env['trustProxy'] = 1
  try {
    trustProxy = parseTrustProxy(source.TRUST_PROXY)
  } catch (error) {
    problems.push((error as Error).message)
  }

  const poolText = source.DB_POOL_MAX ?? '8'
  const dbPoolMax = Number(poolText)
  if (!/^\d{1,2}$/.test(poolText) || dbPoolMax < 2 || dbPoolMax > 30) problems.push('DB_POOL_MAX must be a whole number from 2 to 30')

  if (problems.length > 0) throw new EnvError(problems)
  return { nodeEnv, isProduction, databaseUrl, jwtSecret, port, clientUrl, clientOrigin, trustProxy, dbPoolMax }
}

let cached: Env | undefined

/** Parsed once, on first use, so a bad environment fails at boot and tests can set the variables first. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env)
  return cached
}

export function resetEnvCache(): void {
  cached = undefined
}
