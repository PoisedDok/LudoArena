import jwt from 'jsonwebtoken'
import { getEnv } from '../config/env'

export interface JwtPayload {
  userId: string
  role: 'ADMIN' | 'PLAYER'
  /** User.tokenVersion at issue time; a bump on the user ends all of their sessions. */
  tv: number
  /** Session row id; deleting the row (sign out) revokes this token. */
  sid: string
}

const ISSUER = 'ludo-arena'

export function signToken(payload: JwtPayload, ttlSeconds: number): string {
  return jwt.sign(payload, getEnv().jwtSecret, { algorithm: 'HS256', issuer: ISSUER, expiresIn: ttlSeconds })
}

/** Throws on a bad signature, wrong algorithm, wrong issuer, expiry or an unexpected payload shape. */
export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, getEnv().jwtSecret, { algorithms: ['HS256'], issuer: ISSUER })
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Malformed token')
  const { userId, role, tv, sid } = decoded as Partial<JwtPayload>
  if (typeof userId !== 'string' || (role !== 'ADMIN' && role !== 'PLAYER') || typeof tv !== 'number' || typeof sid !== 'string') {
    throw new Error('Malformed token')
  }
  return { userId, role, tv, sid }
}
