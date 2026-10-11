import type { Response } from 'express'
import prisma, { lockUsers } from './prisma'
import { signToken, verifyToken } from './jwt'
import { getEnv } from '../config/env'
import { AUTH } from '../config/limits'
import { unauthorized } from './errors'

export const COOKIE_NAME = 'token'

export interface SessionUser {
  userId: string
  role: 'ADMIN' | 'PLAYER'
  sid: string
}

/**
 * The one session check: a valid signature is not enough. The session row must still exist and not be
 * expired (sign out deletes it) and the token must carry the user's current tokenVersion (a password
 * reset ends every session of that user). The role comes from the database, never from the token.
 */
export async function authenticateToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  let payload
  try {
    payload = verifyToken(token)
  } catch {
    return null
  }
  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    select: { userId: true, expiresAt: true, user: { select: { id: true, role: true, tokenVersion: true } } },
  })
  if (!session || session.userId !== payload.userId || session.expiresAt.getTime() <= Date.now()) return null
  if (session.user.tokenVersion !== payload.tv) return null
  return { userId: session.user.id, role: session.user.role, sid: payload.sid }
}

export async function issueSession(
  res: Response,
  user: { id: string; role: 'ADMIN' | 'PLAYER'; tokenVersion: number },
  remember: boolean,
): Promise<void> {
  const ttl = remember ? AUTH.rememberTtlSeconds : AUTH.sessionTtlSeconds
  const { session, current } = await prisma.$transaction(async (tx) => {
    await lockUsers(tx, [user.id])
    const current = await tx.user.findUnique({ where: { id: user.id }, select: { role: true, tokenVersion: true } })
    if (!current || current.tokenVersion !== user.tokenVersion) throw unauthorized('Invalid credentials')
    const session = await tx.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + ttl * 1000) },
      select: { id: true },
    })
    return { session, current }
  })
  const token = signToken({ userId: user.id, role: current.role, tv: current.tokenVersion, sid: session.id }, ttl)
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: getEnv().isProduction,
    path: '/',
    // Without "remember me" the cookie is a browser-session cookie; the token still expires after a day.
    ...(remember ? { maxAge: ttl * 1000 } : {}),
  })
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: getEnv().isProduction, path: '/' })
}

/** Signing out: the token is dead from this moment, whoever holds a copy of it. */
export async function revokeSession(sid: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sid } })
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } })
}

/** Reads one cookie from a raw Cookie header (the socket handshake has no cookie-parser). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}
