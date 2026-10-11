import { describe, expect, it } from 'vitest'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { errorMessage, isUnauthorized } from './errors'
import { formatAmount, splitMessage } from './format'
import { normalizeGame } from '../stores/games'

function failure(status: number | null, data?: unknown, code?: string): AxiosError {
  const config = { headers: {} } as InternalAxiosRequestConfig
  if (status === null) return new AxiosError('Network Error', code ?? 'ERR_NETWORK', config)
  return new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, { status, statusText: '', headers: {}, config, data })
}

describe('errorMessage', () => {
  it('shows the server sentence for a client error', () => {
    expect(errorMessage(failure(409, { error: 'Deposit has already been reviewed' }))).toBe('Deposit has already been reviewed')
  })
  it('explains a network failure, a timeout and a server error in plain words', () => {
    expect(errorMessage(failure(null))).toMatch(/No connection/)
    expect(errorMessage(failure(null, undefined, 'ECONNABORTED'))).toMatch(/too long/)
    expect(errorMessage(failure(503, { error: 'database unavailable' }))).toMatch(/server had a problem/)
  })
  it('keeps the rate-limit message and falls back for anything else', () => {
    expect(errorMessage(failure(429, { error: 'Too many login attempts. Try again in 15 minutes.' }))).toMatch(/15 minutes/)
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('fallback')
  })
  it('recognises a 401', () => {
    expect(isUnauthorized(failure(401))).toBe(true)
    expect(isUnauthorized(failure(403))).toBe(false)
  })
})

describe('format and normalisation', () => {
  it('formats amounts in the Indian grouping with a sign when asked', () => {
    expect(formatAmount(1234567.5)).toBe('12,34,567.50')
    expect(formatAmount(-5, { signed: true })).toBe('-5.00')
    expect(formatAmount(5, { signed: true })).toBe('+5.00')
  })
  it('splits the room code out of a message', () => {
    expect(splitMessage('Classic board · [Room: ab3k7p]')).toEqual({ note: 'Classic board ·', room: 'AB3K7P' })
    expect(splitMessage(null)).toEqual({ note: '', room: null })
  })
  it('turns the API settlesAt (ISO string) into milliseconds', () => {
    expect(normalizeGame({ settlesAt: '2026-10-11T06:30:00.000Z' }).settlesAt).toBe(Date.parse('2026-10-11T06:30:00.000Z'))
    expect(normalizeGame({ settlesAt: null }).settlesAt).toBeNull()
    expect(normalizeGame({ settlesAt: 1234 }).settlesAt).toBe(1234)
  })
})
