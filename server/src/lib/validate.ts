import { badRequest } from './errors'
import { PAGE } from '../config/limits'
import { parseCents } from './money'

/** Input parsing for route handlers. Every helper throws a 400 HttpError that names the field. */

export function body(req: { body?: unknown }): Record<string, unknown> {
  const value = req.body
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function requiredString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw badRequest(`${field} is required`)
  const text = value.trim()
  if (text.length < min) throw badRequest(`${field} must be at least ${min} characters`)
  if (text.length > max) throw badRequest(`${field} must be at most ${max} characters`)
  return text
}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw badRequest(`${field} must be text`)
  const text = value.trim()
  if (text.length > max) throw badRequest(`${field} must be at most ${max} characters`)
  return text || undefined
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`${field} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

/** A money amount in cents within [min, max]; rejects NaN, extra decimals and exponent forms. */
export function amountCents(value: unknown, field: string, opts: { min: number; max: number }): number {
  const cents = parseCents(value)
  if (cents === null) throw badRequest(`${field} must be a number with at most 2 decimals`)
  if (cents < opts.min || cents > opts.max) throw badRequest(`${field} is out of range`)
  return cents
}

export function pagination(query: Record<string, unknown>, defaultLimit = PAGE.defaultLimit): { page: number; limit: number; skip: number } {
  const num = (v: unknown, fallback: number): number => {
    if (v === undefined || v === '') return fallback
    if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) throw badRequest('page and limit must be positive whole numbers')
    return Number(v)
  }
  const page = Math.max(1, num(query.page, 1))
  const limit = Math.min(PAGE.maxLimit, Math.max(1, num(query.limit, defaultLimit)))
  return { page, limit, skip: (page - 1) * limit }
}

export function dateParam(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw badRequest(`${field} must be a date`)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw badRequest(`${field} must be a valid date`)
  return date
}

export function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false`)
  return value
}
