/** Display helpers shared by every screen, so one amount or date reads the same everywhere. */

const amount = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

export function formatAmount(value: number | null | undefined, opts: { signed?: boolean } = {}): string {
  const n = value ?? 0
  const text = amount.format(Math.abs(n))
  if (n < 0) return `-${text}`
  return opts.signed && n > 0 ? `+${text}` : text
}

/** "500" or "12.5": a stake or a limit, without forced decimals. */
export function formatPlain(value: number | null | undefined): string {
  return whole.format(value ?? 0)
}

export function amountTone(value: number): 'text-active' | 'text-danger' | 'text-text-muted' {
  return value > 0 ? 'text-active' : value < 0 ? 'text-danger' : 'text-text-muted'
}

const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const dateOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

export const formatDateTime = (iso: string | Date) => dateTime.format(new Date(iso))
export const formatDay = (iso: string | Date) => dateOnly.format(new Date(iso))

export const GAME_TYPE_LABEL: Record<string, string> = { ONE_V_ONE: 'Solo', TWO_V_TWO: 'Teams', FOUR_PLAYER: '4v2' }
export const gameTypeLabel = (type: string) => GAME_TYPE_LABEL[type] ?? type.replace(/_/g, ' ')

export const TX_TYPE_LABEL: Record<string, string> = {
  GAME_WIN: 'Win',
  GAME_LOSS: 'Loss',
  COMMISSION: 'Commission',
  ADMIN_CREDIT: 'Credit',
  ADMIN_DEBIT: 'Debit',
}
export const txTypeLabel = (type: string) => TX_TYPE_LABEL[type] ?? type.replace(/_/g, ' ')

export function txBadgeClass(type: string): string {
  if (type === 'GAME_WIN' || type === 'ADMIN_CREDIT') return 'tag-credit'
  if (type === 'GAME_LOSS' || type === 'ADMIN_DEBIT') return 'tag-debit'
  return 'tag-neutral'
}

export const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  PENDING_COMPLETION: 'Pending',
  DISPUTED: 'Disputed',
  COMPLETED: 'Completed',
}
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status
export const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'badge-active',
  PENDING_COMPLETION: 'badge-pending',
  DISPUTED: 'badge-disputed',
  COMPLETED: 'badge-completed',
}
export const statusBadge = (status: string) => STATUS_BADGE[status] ?? 'badge-pending'

/** Uploaded screenshots are private: they are served by the API behind the session cookie. */
export const fileUrl = (filename: string) => `/api/files/${encodeURIComponent(filename)}`

/** A message may carry "[Room: ABC123]"; the room code is shown separately from the note. */
export function splitMessage(message: string | null | undefined): { note: string; room: string | null } {
  const match = message?.match(/\[Room:\s*([A-Z0-9]+)\]/i)
  return {
    note: (message ?? '').replace(/\s*\[Room:\s*[A-Z0-9]+\]/i, '').trim(),
    room: match ? match[1]!.toUpperCase() : null,
  }
}
