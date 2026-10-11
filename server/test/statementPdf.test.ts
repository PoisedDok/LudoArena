import { describe, expect, it } from 'vitest'
import { Writable } from 'stream'
import type { Statement } from '../src/services/statement'
import { renderStatement } from '../src/services/statementPdf'
import { shapeStatement } from '../src/services/statementView'
import { resolvePeriod } from '../src/lib/period'
import { readPdf } from './pdfText'

function statementWith(rowCount: number, overrides: Partial<Statement> = {}): Statement {
  const period = resolvePeriod({ period: '2026-09' }, new Date('2026-10-11T06:30:00Z'), 'Asia/Kolkata')
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const amountCents = i % 3 === 0 ? -(1000 + i) : 2500 + i
    return {
      id: `t${i}`,
      at: new Date(Date.UTC(2026, 8, 1 + (i % 28), 5, i % 60)),
      type: (amountCents < 0 ? 'GAME_LOSS' : 'GAME_WIN') as 'GAME_LOSS' | 'GAME_WIN',
      description: i === 1 ? 'नमस्ते ₹ bonus' : `Row ${i} · stake 100`,
      gameId: null,
      screenshotFilename: null,
      amountCents,
      balanceAfterCents: 100_000 + i * 10,
    }
  })
  return {
    player: { id: 'p1', username: 'Aarav_Kumar', phone: '+919876543210' },
    period,
    generatedAt: new Date('2026-10-11T06:30:00Z'),
    openingCents: 100_000,
    closingCents: 123_456,
    summary: { depositsCents: 50_000, adjustmentsInCents: 0, withdrawalsCents: 0, gamesPlayed: 3, wins: 2, losses: 1, stakesWonCents: 40_000, stakesLostCents: 20_000, commissionCents: 2_000 },
    games: [
      { id: 'g1', at: new Date('2026-09-05T10:00:00Z'), gameType: 'ONE_V_ONE', stakeCents: 20_000, opponents: ['Vikram'], status: 'COMPLETED', result: 'Won', netCents: 19_000 },
      { id: 'g2', at: new Date('2026-09-06T10:00:00Z'), gameType: 'FOUR_PLAYER', stakeCents: 10_000, opponents: ['A_very_long_username_without_any_break_at_all_1234567890', 'B', 'C'], status: 'COMPLETED', result: 'Lost', netCents: -10_000 },
    ],
    rows,
    ...overrides,
  }
}

function render(statement: Statement) {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk)
      cb()
    },
  })
  const done = new Promise<void>((resolve) => sink.on('finish', resolve))
  renderStatement(shapeStatement(statement), sink, { compress: false })
  return done.then(() => Buffer.concat(chunks))
}

describe('statement document', () => {
  it('the view carries the figures: tiles, totals and the file name', () => {
    const view = shapeStatement(statementWith(5))
    expect(view.tiles.find((t) => t.label === 'Opening balance')!.value).toBe('₹1,000.00')
    expect(view.tiles.find((t) => t.label === 'Closing balance')!.value).toBe('₹1,234.56')
    expect(view.fileName).toBe('ludo-statement-Aarav_Kumar-2026-09.pdf')
    expect(view.ledger.rows).toHaveLength(6)
    expect(view.ledger.totals!.map((c) => c.text)).toEqual(['Total', '', 'Closing balance 1,234.56', expect.any(String), expect.any(String), '1,234.56'])
    expect(view.games.totals!.at(-1)!.text).toBe('+90.00')
  })

  it('renders a valid, readable PDF with the rupee sign, Devanagari text and a long unbroken name', async () => {
    const bytes = await render(statementWith(6))
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.subarray(-8).toString()).toContain('%%EOF')
    const info = readPdf(bytes)
    expect(info.pages).toBe(1)
    const all = info.text.flat().join('\n')
    // The rupee sign is drawn in its own font run, so amounts are read with the runs of a line joined.
    const joined = info.text.flat().join('')
    expect(all).toContain('Account statement')
    expect(all).toContain('Aarav_Kumar')
    expect(all).toContain('Opening balance')
    expect(joined).toContain('₹1,000.00')
    expect(joined).toContain('₹1,234.56')
    // Devanagari conjuncts are drawn as shaped ligature glyphs, so check the letters that are single glyphs.
    expect(all).toContain('नम')
    expect(all).toContain('Page 1 of 1')
    // The long opponent list is cut with an ellipsis instead of running into the next column.
    expect(all).toMatch(/A_very_long_username.*\.\.\./)
    expect(all).not.toContain('A_very_long_username_without_any_break_at_all_1234567890')
  })

  it('an empty statement says so and still has a header and footer', async () => {
    const empty = statementWith(0, { games: [], summary: { depositsCents: 0, adjustmentsInCents: 0, withdrawalsCents: 0, gamesPlayed: 0, wins: 0, losses: 0, stakesWonCents: 0, stakesLostCents: 0, commissionCents: 0 }, openingCents: 0, closingCents: 0 })
    const info = readPdf(await render(empty))
    const all = info.text.flat().join('\n')
    expect(all).toContain('No games in this period.')
    expect(all).toContain('Closing balance')
    expect(info.pages).toBe(1)
  })

  it('paginates: header repeated and footer numbered on every page, totals at the end, no rows lost', async () => {
    const rows = 150
    const info = readPdf(await render(statementWith(rows)))
    expect(info.pages).toBeGreaterThan(2)
    info.text.forEach((lines, i) => {
      expect(lines.join('\n'), `page ${i + 1}`).toContain(`Page ${i + 1} of ${info.pages}`)
    })
    // Every page after the first starts with the ledger header ("Date" and "Balance" columns).
    for (const lines of info.text.slice(1)) {
      expect(lines.slice(0, 8)).toContain('Date')
      expect(lines.slice(0, 8)).toContain('Balance')
    }
    const all = info.text.flat()
    const drawn = all.filter((line) => /^Row \d+ /.test(line)).length
    expect(drawn).toBe(rows - 1)
    const last = info.text.at(-1)!.join('\n')
    expect(last).toContain('Closing balance 1,234.56')
  })

  it('a large history (3000 rows) renders within a modest heap', async () => {
    if (global.gc) global.gc()
    const before = process.memoryUsage().heapUsed
    const started = Date.now()
    const bytes = await render(statementWith(3000))
    const info = readPdf(bytes)
    const grownMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024
    // Printed for the capacity notes in docs/ARCHITECTURE.md.
    console.log(`3000-row statement: ${info.pages} pages, ${(bytes.length / 1024).toFixed(0)} KiB uncompressed, ${Date.now() - started} ms incl. parsing, heap +${grownMb.toFixed(0)} MiB`)
    expect(info.pages).toBeGreaterThan(50)
    expect(grownMb).toBeLessThan(200)
  })
})
