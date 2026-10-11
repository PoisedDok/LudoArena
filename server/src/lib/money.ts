import { MONEY } from '../config/limits'

/**
 * Money is handled as integer cents everywhere in application code. The database column is
 * NUMERIC(12,2); values cross the boundary as two-decimal strings, so nothing is ever rounded twice.
 */

interface DecimalLike {
  toString(): string
}

/** Parses a user supplied amount ("12", "12.5", 12.34). Returns cents, or null for anything else. */
export function parseCents(value: unknown): number | null {
  let text: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    text = String(value)
    if (/e/i.test(text)) return null
  } else if (typeof value === 'string') {
    text = value.trim()
  } else {
    return null
  }
  const match = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return null
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0') || 0)
  const signed = match[1] === '-' ? -cents : cents
  return Math.abs(signed) > MONEY.maxAmountCents ? null : signed
}

/** Cents from a database Decimal (or numeric string). */
export function decimalToCents(value: DecimalLike | number | string): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.toString()
  const parsed = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!parsed) throw new Error(`Not a decimal amount: ${text}`)
  const fraction = (parsed[3] ?? '').padEnd(2, '0').slice(0, 2)
  const cents = Number(parsed[2]) * 100 + Number(fraction)
  return parsed[1] === '-' ? -cents : cents
}

/** Two-decimal string for the database ("190.00"). */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`Cents must be an integer, got ${cents}`)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Display number for messages ("200", "16.67"). */
export function formatCents(cents: number): string {
  const text = centsToDecimal(cents)
  return text.endsWith('.00') ? text.slice(0, -3) : text
}

/** Half-up share of a stake in basis points; integer arithmetic only. */
export function shareOfCents(cents: number, bps: number): number {
  return Math.floor((cents * bps + 5_000) / 10_000)
}

export interface TierCommissionRates {
  tierThresholdCents: number
  highRateBps: number
  lowRateBps: number
}

export function tierCommissionCents(stakeCents: number, rules: TierCommissionRates): number {
  const bps = stakeCents > rules.tierThresholdCents ? rules.lowRateBps : rules.highRateBps
  return shareOfCents(stakeCents, bps)
}

export function tierRatePercent(stakeCents: number, rules: TierCommissionRates): number {
  const bps = stakeCents > rules.tierThresholdCents ? rules.lowRateBps : rules.highRateBps
  return bps / 100
}
