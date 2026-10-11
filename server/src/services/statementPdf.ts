import PDFDocument from 'pdfkit'
import path from 'path'
import type { Writable } from 'stream'
import type { Align, Cell, StatementView, TableView } from './statementView'

/**
 * Page template for a statement: layout only, driven by a StatementView (see statementView.ts for the
 * figures). pdfkit is pure JavaScript and streams to the response; text is set in an embedded Noto Sans
 * (Latin) and Noto Sans Devanagari (which also carries the rupee sign), so names and notes in either
 * script render. Pages are buffered (bufferPages) only to number them "n of m".
 */

const PAGE = { width: 595.28, height: 841.89, margin: 40 }
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2
const FOOTER_RESERVE = 34
const ROW_HEIGHT = 16
const HEAD_HEIGHT = 18
const COLOR = { ink: '#111827', muted: '#6b7280', line: '#d1d5db', head: '#f3f4f6', accent: '#b45309', credit: '#047857', debit: '#b91c1c', strong: '#fffbeb' }

const FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts')
const FONTS = {
  latin: { regular: 'NotoSans-latin-400.woff', bold: 'NotoSans-latin-700.woff' },
  devanagari: { regular: 'NotoSans-devanagari-400.woff', bold: 'NotoSans-devanagari-700.woff' },
} as const

type Script = keyof typeof FONTS

/** Devanagari block and the rupee sign live in the Devanagari font; everything else is Latin. */
const scriptOf = (codePoint: number): Script => ((codePoint >= 0x0900 && codePoint <= 0x097f) || codePoint === 0x20b9 ? 'devanagari' : 'latin')

/** Characters neither font can draw become "?" (never a missing-glyph box). */
const drawable = (codePoint: number): boolean =>
  scriptOf(codePoint) === 'devanagari' || (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0x24f) || codePoint === 0x2013 || codePoint === 0x2014 || codePoint === 0x2018 || codePoint === 0x2019 || codePoint === 0x201c || codePoint === 0x201d || codePoint === 0x2026

export function runsOf(value: string): Array<{ text: string; script: Script }> {
  const runs: Array<{ text: string; script: Script }> = []
  for (const ch of value.replace(/[\r\n\t]+/g, ' ')) {
    const cp = ch.codePointAt(0)!
    const safe = drawable(cp) ? ch : '?'
    // Zero-width joiners and Devanagari combining marks stay with their run; spaces follow the current run.
    const script: Script = safe === ' ' && runs.length ? runs[runs.length - 1]!.script : scriptOf(safe.codePointAt(0)!)
    const last = runs[runs.length - 1]
    if (last && last.script === script) last.text += safe
    else runs.push({ text: safe, script })
  }
  return runs
}

export interface RenderOptions {
  /** Tests switch compression off so the content streams can be read back. */
  compress?: boolean
}

export function renderStatement(view: StatementView, out: Writable, options: RenderOptions = {}): void {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE.margin,
    bufferPages: true,
    compress: options.compress ?? true,
    info: { Title: `${view.appName} statement`, Author: view.appName, Subject: `Statement for ${view.playerName}` },
  })
  for (const [script, files] of Object.entries(FONTS)) {
    doc.registerFont(`${script}-regular`, path.join(FONT_DIR, files.regular))
    doc.registerFont(`${script}-bold`, path.join(FONT_DIR, files.bold))
  }
  doc.pipe(out)
  const bottom = () => PAGE.height - PAGE.margin - FOOTER_RESERVE

  const widthOf = (runs: ReturnType<typeof runsOf>, size: number, bold: boolean) => {
    let total = 0
    for (const r of runs) total += doc.font(`${r.script}-${bold ? 'bold' : 'regular'}`).fontSize(size).widthOfString(r.text)
    return total
  }

  /** One line, cut with an ellipsis when it does not fit, aligned by its measured width. */
  const text = (value: string, x: number, y: number, width: number, opts: { align?: Align; size?: number; color?: string; bold?: boolean } = {}) => {
    const size = opts.size ?? 9
    const bold = opts.bold ?? false
    let runs = runsOf(value)
    if (widthOf(runs, size, bold) > width) {
      let plain = runs.map((r) => r.text).join('')
      while (plain.length > 1 && widthOf(runsOf(`${plain}...`), size, bold) > width) plain = plain.slice(0, -1)
      runs = runsOf(`${plain}...`)
    }
    const total = widthOf(runs, size, bold)
    let cursor = opts.align === 'right' ? x + width - total : x
    doc.fillColor(opts.color ?? COLOR.ink)
    for (const r of runs) {
      doc.font(`${r.script}-${bold ? 'bold' : 'regular'}`).fontSize(size)
      doc.text(r.text, cursor, y, { lineBreak: false })
      cursor += doc.widthOfString(r.text)
    }
  }

  // Header
  text(view.appName, PAGE.margin, PAGE.margin, 250, { size: 20, bold: true, color: COLOR.accent })
  text(view.title, PAGE.margin, PAGE.margin + 27, 250, { size: 11, color: COLOR.muted })
  text(view.playerName, PAGE.margin + 250, PAGE.margin, CONTENT_WIDTH - 250, { size: 13, bold: true, align: 'right' })
  text(view.playerPhone, PAGE.margin + 250, PAGE.margin + 19, CONTENT_WIDTH - 250, { align: 'right', color: COLOR.muted })
  text(`Period: ${view.periodLabel}`, PAGE.margin + 200, PAGE.margin + 34, CONTENT_WIDTH - 200, { align: 'right' })
  text(`Generated: ${view.generatedLabel}`, PAGE.margin + 150, PAGE.margin + 47, CONTENT_WIDTH - 150, { align: 'right', color: COLOR.muted, size: 8 })
  doc.moveTo(PAGE.margin, PAGE.margin + 66).lineTo(PAGE.width - PAGE.margin, PAGE.margin + 66).lineWidth(0.6).strokeColor(COLOR.line).stroke()

  // Summary tiles: two rows of five
  const cols = 5
  const gap = 8
  const tileW = (CONTENT_WIDTH - gap * (cols - 1)) / cols
  const tileH = 42
  let y = PAGE.margin + 80
  view.tiles.forEach((tile, i) => {
    const x = PAGE.margin + (i % cols) * (tileW + gap)
    const top = y + Math.floor(i / cols) * (tileH + gap)
    doc.roundedRect(x, top, tileW, tileH, 4).lineWidth(0.6).fillAndStroke(tile.strong ? COLOR.strong : '#ffffff', COLOR.line)
    text(tile.label, x + 6, top + 7, tileW - 12, { size: 7, color: COLOR.muted })
    text(tile.value, x + 6, top + 22, tileW - 12, { size: 10.5, bold: true })
  })
  y += Math.ceil(view.tiles.length / cols) * (tileH + gap) + 12

  const drawHeader = (table: TableView, at: number): number => {
    doc.rect(PAGE.margin, at, CONTENT_WIDTH, HEAD_HEIGHT).fill(COLOR.head)
    let x = PAGE.margin
    for (const c of table.columns) {
      text(c.title, x + 4, at + 5, c.width - 8, { size: 8, bold: true, align: c.align })
      x += c.width
    }
    return at + HEAD_HEIGHT
  }

  const paintRow = (table: TableView, cells: Cell[], at: number, bold: boolean) => {
    let x = PAGE.margin
    cells.forEach((cell, i) => {
      const col = table.columns[i]!
      const color = cell.tone === 'credit' && cell.text ? COLOR.credit : cell.tone === 'debit' && cell.text ? COLOR.debit : COLOR.ink
      text(cell.text, x + 4, at + 4, col.width - 8, { align: col.align, bold, color })
      x += col.width
    })
    doc.moveTo(PAGE.margin, at + ROW_HEIGHT).lineTo(PAGE.width - PAGE.margin, at + ROW_HEIGHT).lineWidth(0.4).strokeColor(COLOR.line).stroke()
  }

  const drawTable = (table: TableView) => {
    // A table never starts in the last few lines of a page.
    if (y + HEAD_HEIGHT + 3 * ROW_HEIGHT + 20 > bottom()) {
      doc.addPage()
      y = PAGE.margin
    }
    text(table.title, PAGE.margin, y, CONTENT_WIDTH, { size: 11, bold: true })
    y = drawHeader(table, y + 18)
    if (table.rows.length === 0) {
      text(table.emptyText, PAGE.margin + 4, y + 5, CONTENT_WIDTH - 8, { color: COLOR.muted })
      y += 26
      return
    }
    // Rows are fixed height, so a row is never split; the header repeats at the top of every page.
    const newPage = () => {
      doc.addPage()
      y = drawHeader(table, PAGE.margin)
    }
    for (const row of table.rows) {
      if (y + ROW_HEIGHT > bottom()) newPage()
      paintRow(table, row, y, false)
      y += ROW_HEIGHT
    }
    if (table.totals) {
      if (y + ROW_HEIGHT > bottom()) newPage()
      doc.rect(PAGE.margin, y, CONTENT_WIDTH, ROW_HEIGHT).fill(COLOR.head)
      paintRow(table, table.totals, y, true)
      y += ROW_HEIGHT
    }
    y += 16
  }

  drawTable(view.games)
  drawTable(view.ledger)

  // Footer on every page: who it is for, and "Page n of m".
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    // The footer sits in the bottom margin; without this pdfkit would open a new page for it.
    doc.page.margins.bottom = 0
    text(`${view.appName} statement for ${view.playerName}`, PAGE.margin, PAGE.height - PAGE.margin - 8, 360, { size: 7.5, color: COLOR.muted })
    text(`Page ${i - range.start + 1} of ${range.count}`, PAGE.width - PAGE.margin - 100, PAGE.height - PAGE.margin - 8, 100, { size: 7.5, color: COLOR.muted, align: 'right' })
  }
  doc.end()
}
