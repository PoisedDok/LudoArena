import bcrypt from 'bcryptjs'
import prisma from '../lib/prisma'
import { AUTH } from '../config/limits'
import { Role } from '../../generated/prisma'

const WEAK = new Set(['admin', 'admin123', 'password', 'password1', '12345678', 'changeme', 'change_me', 'letmein', 'ludo123'])

export interface SeedResult {
  created: boolean
  username: string
}

/**
 * Creates the first admin from ADMIN_USERNAME / ADMIN_PASSWORD, and only when no admin exists. It never
 * changes an existing admin; use `admin-password` for that. Safe to run on every start.
 */
export async function ensureAdmin(username: string | undefined, password: string | undefined): Promise<SeedResult> {
  const existing = await prisma.user.findFirst({ where: { role: Role.ADMIN }, select: { username: true } })
  if (existing) return { created: false, username: existing.username }

  const problems: string[] = []
  if (!username || !/^[A-Za-z0-9._-]{3,32}$/.test(username)) problems.push('ADMIN_USERNAME must be 3-32 characters of letters, digits, dot, dash, underscore')
  if (!password || password.length < AUTH.passwordMinLength) problems.push(`ADMIN_PASSWORD must be at least ${AUTH.passwordMinLength} characters`)
  else if (WEAK.has(password.toLowerCase()) || Buffer.byteLength(password) > AUTH.passwordMaxBytes) problems.push('ADMIN_PASSWORD is a known weak value or longer than 72 bytes')
  if (problems.length > 0) throw new Error(`No admin exists yet and the admin cannot be created:\n - ${problems.join('\n - ')}`)

  const passwordHash = await bcrypt.hash(password!, AUTH.bcryptRounds)
  await prisma.user.create({ data: { username: username!, passwordHash, role: Role.ADMIN } })
  return { created: true, username: username! }
}

async function main(): Promise<void> {
  const result = await ensureAdmin(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD)
  process.stdout.write(result.created ? `Admin created: ${result.username}\n` : `Admin already exists: ${result.username}\n`)
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
