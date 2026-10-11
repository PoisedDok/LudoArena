import { describe, expect, it } from 'vitest'
import { centsToDecimal, decimalToCents, formatCents, parseCents, shareOfCents, tierCommissionCents } from '../src/lib/money'

describe('parseCents', () => {
  it.each([
    [0, 0],
    [1, 100],
    [12.5, 1250],
    [0.01, 1],
    ['12', 1200],
    ['12.34', 1234],
    [' 7.5 ', 750],
    ['-3.25', -325],
    [1_000_000, 100_000_000],
  ])('accepts %j as %i cents', (input, cents) => {
    expect(parseCents(input)).toBe(cents)
  })

  it.each([
    ['empty', ''],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['three decimals', '1.001'],
    ['float noise', 0.1 + 0.2],
    ['exponent', '1e3'],
    ['exponent number', 1e21],
    ['trailing junk', '12abc'],
    ['over the maximum', 1_000_000.01],
    ['object', {}],
    ['null', null],
    ['array', [5]],
  ])('rejects %s', (_label, input) => {
    expect(parseCents(input)).toBeNull()
  })
})

describe('cents conversion', () => {
  it('round-trips through the database string form', () => {
    for (const cents of [0, 1, 99, 100, 101, 123_456_789, -1, -150]) {
      expect(decimalToCents(centsToDecimal(cents))).toBe(cents)
    }
    expect(centsToDecimal(-5)).toBe('-0.05')
    expect(formatCents(20000)).toBe('200')
    expect(formatCents(1667)).toBe('16.67')
  })

  it('refuses a fractional cent count', () => {
    expect(() => centsToDecimal(1.5)).toThrow()
  })
})

describe('commission', () => {
  const defaultRules = { tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300 }

  it('uses 5% up to and including 500 and 3% above', () => {
    expect(tierCommissionCents(20_000, defaultRules)).toBe(1_000)
    expect(tierCommissionCents(50_000, defaultRules)).toBe(2_500)
    expect(tierCommissionCents(50_001, defaultRules)).toBe(1_500)
    expect(tierCommissionCents(100_000, defaultRules)).toBe(3_000)
  })

  it('rounds half up to the cent without float arithmetic', () => {
    // 333.33 * 5% = 16.6665 -> 16.67 ; 0.10 * 5% = 0.005 -> 0.01
    expect(tierCommissionCents(33_333, defaultRules)).toBe(1_667)
    expect(tierCommissionCents(10, defaultRules)).toBe(1)
    expect(tierCommissionCents(9, defaultRules)).toBe(0)
    expect(shareOfCents(100_000, 1_000)).toBe(10_000)
  })
})
