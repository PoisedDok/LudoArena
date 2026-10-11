import bcrypt from 'bcryptjs'
import readline from 'readline'
import prisma from '../lib/prisma'
import { AUTH } from '../config/limits'
import { Role } from '../../generated/prisma'

/**
 * Sets a new password for an admin and ends all of that admin's sessions (token version bump).
 * The password is typed at the prompt (not echoed) or piped on standard input; it is never taken from
 * an argument, a file or an image. With several admins name one with ADMIN_USERNAME.
 */

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin })
      rl.once('line', (line) => {
        rl.close()
        resolve(line)
      })
      rl.once('close', () => resolve(''))
      return
    }
    process.stdout.write(prompt)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (char: string) => {
      for (const c of char) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (c === '\u0003') process.exit(130)
        if (c === '\u007f') value = value.slice(0, -1)
        else value += c
      }
    }
    stdin.on('data', onData)
  })
}

export async function setAdminPassword(password: string, username?: string): Promise<string> {
  if (password.length < AUTH.passwordMinLength) throw new Error(`Password must be at least ${AUTH.passwordMinLength} characters`)
  if (Buffer.byteLength(password) > AUTH.passwordMaxBytes) throw new Error(`Password must be at most ${AUTH.passwordMaxBytes} bytes`)
  const admins = await prisma.user.findMany({ where: { role: Role.ADMIN, ...(username ? { username } : {}) }, select: { id: true, username: true } })
  if (admins.length === 0) throw new Error('No matching admin account')
  if (admins.length > 1) throw new Error('Several admins exist: set ADMIN_USERNAME to choose one')
  const admin = admins[0]!
  const passwordHash = await bcrypt.hash(password, AUTH.bcryptRounds)
  await prisma.$transaction([
    prisma.user.update({ where: { id: admin.id }, data: { passwordHash, tokenVersion: { increment: 1 } } }),
    prisma.session.deleteMany({ where: { userId: admin.id } }),
  ])
  return admin.username
}

async function main(): Promise<void> {
  const first = await readPassword('New admin password: ')
  if (process.stdin.isTTY) {
    const second = await readPassword('Repeat password: ')
    if (first !== second) throw new Error('The two entries differ')
  }
  const username = await setAdminPassword(first, process.env.ADMIN_USERNAME)
  process.stdout.write(`Password changed for ${username}; all of their sessions are signed out.\n`)
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
