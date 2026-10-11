/**
 * A small text extractor for uncompressed pdfkit output (renderStatement with compress: false).
 * It maps the glyph ids drawn in each content stream back to characters through the fonts' ToUnicode
 * CMaps, so tests can assert on the figures a reader would see.
 */

export interface PdfInfo {
  pages: number
  /** Text lines per page, in drawing order. */
  text: string[][]
}

function objects(pdf: string): Map<number, string> {
  const map = new Map<number, string>()
  const re = /(\d+) 0 obj([\s\S]*?)endobj/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pdf))) map.set(Number(m[1]), m[2]!)
  return map
}

function parseCmap(body: string): Map<number, string> {
  const map = new Map<number, string>()
  const utf16 = (hex: string) => {
    let out = ''
    for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    return out
  }
  for (const block of body.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1]!, 16), utf16(m[2]!))
  }
  for (const block of body.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // pdfkit writes ranges as "<lo> <hi> [<u1> <u2> ...]"; the plain "<lo> <hi> <start>" form is also valid.
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:\[([^\]]*)\]|<([0-9a-fA-F]+)>)/g)) {
      const lo = parseInt(m[1]!, 16)
      const hi = parseInt(m[2]!, 16)
      if (m[3] !== undefined) {
        const list = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16(x[1]!))
        list.forEach((u, i) => map.set(lo + i, u))
      } else {
        const start = parseInt(m[4]!, 16)
        for (let g = lo; g <= hi; g++) map.set(g, String.fromCharCode(start + g - lo))
      }
    }
  }
  return map
}

export function readPdf(bytes: Buffer): PdfInfo {
  const pdf = bytes.toString('latin1')
  const objs = objects(pdf)

  // Font object number -> glyph map
  const fontMaps = new Map<number, Map<number, string>>()
  for (const [id, body] of objs) {
    const to = /\/ToUnicode (\d+) 0 R/.exec(body)
    if (to && /\/Type \/Font/.test(body)) fontMaps.set(id, parseCmap(objs.get(Number(to[1]))!))
  }

  const pages: Array<{ fonts: Map<string, number>; contents: number[] }> = []
  for (const [, body] of objs) {
    if (!/\/Type \/Page\b(?!s)/.test(body)) continue
    const resources = /\/Resources (\d+) 0 R/.exec(body)
    const resBody = resources ? objs.get(Number(resources[1]))! : body
    const fontDictRef = /\/Font (\d+) 0 R/.exec(resBody)
    const fontDict = fontDictRef ? objs.get(Number(fontDictRef[1]))! : (/\/Font <<([\s\S]*?)>>/.exec(resBody)?.[1] ?? '')
    const fonts = new Map<string, number>()
    for (const f of fontDict.matchAll(/\/(F\d+) (\d+) 0 R/g)) fonts.set(f[1]!, Number(f[2]))
    const contents = [...(/\/Contents (\d+) 0 R/.exec(body) ? [Number(/\/Contents (\d+) 0 R/.exec(body)![1])] : [])]
    pages.push({ fonts, contents })
  }

  const text: string[][] = pages.map((page) => {
    const lines: string[] = []
    for (const id of page.contents) {
      const stream = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(objs.get(id) ?? '')?.[1] ?? ''
      let font: Map<number, string> | undefined
      for (const op of stream.matchAll(/\/(F\d+) [\d.]+ Tf|\[((?:<[0-9a-fA-F]*>|\s|-?[\d.]+)+)\] TJ|<([0-9a-fA-F]+)> Tj/g)) {
        if (op[1]) {
          font = fontMaps.get(page.fonts.get(op[1])!)
          continue
        }
        const hexes = op[2] ? [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1]!) : [op[3]!]
        let line = ''
        for (const hex of hexes) {
          for (let i = 0; i < hex.length; i += 4) line += font?.get(parseInt(hex.slice(i, i + 4), 16)) ?? '�'
        }
        lines.push(line)
      }
    }
    return lines
  })
  return { pages: pages.length, text }
}
