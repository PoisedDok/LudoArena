import axios from 'axios'

/**
 * The one HTTP client. Same origin in every environment (`/api`; Vite proxies it in development), the
 * session is an httpOnly cookie, and every request has a timeout so a dead connection ends in an error
 * state instead of a spinner.
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
  timeout: 20_000,
})

type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler | null = null

/** The auth store registers here: a 401 on a data call shows "session ended" without leaving the page. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status: number | undefined = error?.response?.status
    const url: string = error?.config?.url ?? ''
    // /auth/* answers 401 for "not signed in" and "wrong password" by design; the caller handles those.
    if (status === 401 && !url.startsWith('/auth/')) onUnauthorized?.()
    return Promise.reject(error)
  },
)

/** A fresh key per user action: a double tap or a retry of the same action is applied once. */
export function idempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export const withKey = (key: string) => ({ headers: { 'Idempotency-Key': key } })

export default api
