import { LOCALE } from '../config/locale'
import type { Statement } from './statement'

/**
 * Pure shaping of a Statement into the strings a document shows (formatted money, dates in the configured
 * timezone, labels, totals). The PDF template only lays this out, so the figures are testable without
 * parsing PDF bytes.
 */

export type Align = 'left' | 'right'
export type Tone = 'credit' | 'debit' | undefined

export interface Cell {
  text: string
  tone?: Tone
}

export interface TableView {
  title: string
  columns: Array<{ title: string; width: number; align: Align }>
  rows: Cell[][]
  totals: Cell[] | null
  emptyText: string
}

export interface StatementView {
  appName: string
  title: string
  playerName: string
  playerPhone: string
  periodLabel: string
  generatedLabel: string
  fileName: string
  tiles: Array<{ label: string; value: string; strong: boolean }>
  games: TableView
  ledger: TableView
}

const money = new Intl.NumberFormat(LOCALE.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: LOCALE.timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const dayOnly = new Intl.DateTimeFormat('en-GB', { timeZone: LOCALE.timezone, day: '2-digit', month: 'short', year: 'numeric' })

/** "1,23,456.78", "-0.05", "+1.00" (signed). */
export function formatMoney(cents: number, signed = false): string {
  const text = money.format(Math.abs(cents) / 100)
  if (cents < 0) return `-${text}`
  return signed && cents > 0 ? `+${text}` : text
}

export function withCurrency(cents: number, signed = false): string {
  const text = formatMoney(cents, signed)
  return text.startsWith('-') || text.startsWith('+') ? `${text[0]}${LOCALE.currencySymbol}${text.slice(1)}` : `${LOCALE.currencySymbol}${text}`
}

const TYPE_LABEL: Record<string, string> = {
  GAME_WIN: 'Game win',
  GAME_LOSS: 'Game loss',
  COMMISSION: 'Commission',
  ADMIN_CREDIT: 'Credit',
  ADMIN_DEBIT: 'Debit',
}
const GAME_LABEL: Record<string, string> = { ONE_V_ONE: 'Solo', TWO_V_TWO: 'Teams', FOUR_PLAYER: '4v2' }

export function periodLabel(statement: Statement): string {
  const { period } = statement
  if (period.kind === 'all') return 'All time'
  return `${dayOnly.format(period.from)} to ${dayOnly.format(new Date(period.to.getTime() - 1))}`
}

const sanitizeForFile = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)

export function shapeStatement(statement: Statement): StatementView {
  const s = statement.summary
  const tone = (cents: number): Tone => (cents < 0 ? 'debit' : cents > 0 ? 'credit' : undefined)
  const netTotal = statement.games.reduce((sum, g) => sum + g.netCents, 0)
  const debit = statement.rows.reduce((sum, r) => sum + (r.amountCents < 0 ? -r.amountCents : 0), 0)
  const credit = statement.rows.reduce((sum, r) => sum + (r.amountCents > 0 ? r.amountCents : 0), 0)
  const c = (text: string, t?: Tone): Cell => ({ text, tone: t })

  return {
    appName: LOCALE.appName,
    title: 'Account statement',
    playerName: statement.player.username,
    playerPhone: statement.player.phone ?? 'No phone number',
    periodLabel: periodLabel(statement),
    generatedLabel: `${stamp.format(statement.generatedAt)} (${LOCALE.timezone})`,
    fileName: `ludo-statement-${sanitizeForFile(statement.player.username)}-${sanitizeForFile(statement.period.key.replace('..', '_to_'))}.pdf`,
    tiles: [
      { label: 'Opening balance', value: withCurrency(statement.openingCents), strong: true },
      { label: 'Deposits', value: withCurrency(s.depositsCents), strong: false },
      { label: 'Adjustments (credit)', value: withCurrency(s.adjustmentsInCents), strong: false },
      { label: 'Withdrawals / debits', value: withCurrency(s.withdrawalsCents), strong: false },
      { label: 'Games played', value: String(s.gamesPlayed), strong: false },
      { label: 'Wins / losses', value: `${s.wins} / ${s.losses}`, strong: false },
      { label: 'Stakes won', value: withCurrency(s.stakesWonCents), strong: false },
      { label: 'Stakes lost', value: withCurrency(s.stakesLostCents), strong: false },
      { label: 'Commission paid', value: withCurrency(s.commissionCents), strong: false },
      { label: 'Closing balance', value: withCurrency(statement.closingCents), strong: true },
    ],
    games: {
      title: `Games (${statement.games.length})`,
      columns: [
        { title: 'Date', width: 82, align: 'left' },
        { title: 'Type', width: 44, align: 'left' },
        { title: 'Stake', width: 58, align: 'right' },
        { title: 'Opponents', width: 166, align: 'left' },
        { title: 'Result', width: 48, align: 'left' },
        { title: 'Status', width: 52, align: 'left' },
        { title: 'Net', width: 65, align: 'right' },
      ],
      rows: statement.games.map((g) => [
        c(stamp.format(g.at)),
        c(GAME_LABEL[g.gameType] ?? g.gameType),
        c(formatMoney(g.stakeCents)),
        c(g.opponents.join(', ')),
        c(g.result),
        c(g.status === 'COMPLETED' ? 'Settled' : g.status.toLowerCase().replace(/_/g, ' ')),
        c(formatMoney(g.netCents, true), tone(g.netCents)),
      ]),
      totals: statement.games.length ? [c('Total'), c(''), c(''), c(''), c(''), c(''), c(formatMoney(netTotal, true), tone(netTotal))] : null,
      emptyText: 'No games in this period.',
    },
    ledger: {
      title: `Ledger (${statement.rows.length} entries)`,
      columns: [
        { title: 'Date', width: 82, align: 'left' },
        { title: 'Type', width: 62, align: 'left' },
        { title: 'Reference', width: 171, align: 'left' },
        { title: 'Debit', width: 66, align: 'right' },
        { title: 'Credit', width: 66, align: 'right' },
        { title: 'Balance', width: 68, align: 'right' },
      ],
      rows: [
        [c(''), c('Opening'), c('Opening balance'), c(''), c(''), c(formatMoney(statement.openingCents))],
        ...statement.rows.map((r) => [
          c(stamp.format(r.at)),
          c(TYPE_LABEL[r.type] ?? r.type),
          c(r.description),
          c(r.amountCents < 0 ? formatMoney(-r.amountCents) : '', 'debit'),
          c(r.amountCents > 0 ? formatMoney(r.amountCents) : '', 'credit'),
          c(formatMoney(r.balanceAfterCents)),
        ]),
      ],
      totals: [c('Total'), c(''), c(`Closing balance ${formatMoney(statement.closingCents)}`), c(formatMoney(debit)), c(formatMoney(credit)), c(formatMoney(statement.closingCents))],
      emptyText: 'No entries in this period.',
    },
  }
}
