// Spreadsheets: CSV and XLSX, read into a grid and edited simply (cell values; rows and columns
// for CSV). Formulas are never calculated: a formula cell shows the value Excel saved with it
// and is read-only.
//
// Writing changes only what was edited, like the rest of the app:
// - CSV: rows that were not changed are written back exactly as they were (quotes, spacing);
//   the delimiter, line ending and byte-order mark are kept.
// - XLSX: the workbook is a zip of XML files. Only the edited <c> cells of the edited sheets
//   are replaced (keeping their style); every other part of the file stays as it was. A new
//   text is written as an inline string, so the shared string table is not touched. When the
//   workbook has formulas, Excel is asked to recalculate them when it opens the file.
//
// No Electron imports here, so this file is unit tested directly.

import JSZip from 'jszip'
import type { SheetCell, SheetData, SheetTab } from '../shared/types'
import { t } from '../shared/i18n'

/** Rows and columns shown at most per sheet (the rest is not loaded). */
export const MAX_ROWS = 5000
export const MAX_COLS = 200

export class SheetError extends Error {}

// ---------- CSV ----------

export interface CsvFile {
  rows: string[][]
  /** Each row as written in the file (without its line ending). */
  raws: string[]
  delimiter: string
  eol: string
  bom: boolean
  /** The file ends with a line break. */
  trailingEol: boolean
}

/** The delimiter of a CSV: the one of , ; tab | that appears most in its first line (outside quotes). */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && ch in counts) counts[ch]++
  }
  let best = ','
  for (const d of Object.keys(counts)) if (counts[d] > counts[best]) best = d
  return best
}

/** Reads CSV text (RFC 4180: quoted fields may hold the delimiter, quotes and line breaks). */
export function parseCsv(source: string): CsvFile {
  const bom = source.startsWith('﻿')
  const text = bom ? source.slice(1) : source
  const delimiter = detectDelimiter(text)
  const eolMatch = /\r\n|\n|\r/.exec(text)
  const eol = eolMatch ? eolMatch[0] : '\r\n'
  const rows: string[][] = []
  const raws: string[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let rowStart = 0
  let i = 0
  const endRow = (end: number): void => {
    row.push(field)
    rows.push(row)
    raws.push(text.slice(rowStart, end))
    row = []
    field = ''
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\r' || ch === '\n') {
      endRow(i)
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      rowStart = i
      continue
    } else field += ch
    i++
  }
  const trailingEol = rowStart === text.length && text.length > 0
  if (!trailingEol) endRow(text.length)
  return { rows, raws, delimiter, eol, bom, trailingEol }
}

const csvField = (value: string, delimiter: string): string =>
  value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

/** A row of the edited grid: the row of the file it came from (if any) and its cells now. */
export interface CsvRowOut {
  orig?: number
  cells: string[]
}

/** The CSV text for the edited rows: unchanged rows exactly as they were in the file. */
export function writeCsv(file: CsvFile, rows: CsvRowOut[]): string {
  const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
  const lines = rows.map((r) => {
    const orig = r.orig !== undefined ? file.rows[r.orig] : undefined
    if (orig && same(orig, r.cells)) return file.raws[r.orig!]
    return r.cells.map((c) => csvField(String(c), file.delimiter)).join(file.delimiter)
  })
  return (file.bom ? '﻿' : '') + lines.join(file.eol) + (file.trailingEol && lines.length ? file.eol : '')
}

/** The grid shown for a CSV file. */
export function csvSheet(file: CsvFile, name: string): SheetTab {
  const rows = file.rows.slice(0, MAX_ROWS)
  const cols = Math.min(MAX_COLS, Math.max(1, ...rows.map((r) => r.length)))
  return {
    name,
    rows: rows.map((r) => r.slice(0, cols).map((v) => ({ text: v, kind: v === '' ? 'empty' : looksNumeric(v) ? 'number' : 'text' }) as SheetCell)),
    cols,
    truncated: file.rows.length > MAX_ROWS || file.rows.some((r) => r.length > MAX_COLS)
  }
}

const looksNumeric = (v: string): boolean => /^\s*-?(\d+([.,]\d+)?|\d{1,3}([.,]\d{3})+([.,]\d+)?)\s*%?\s*$/.test(v)

// ---------- XLSX: reading ----------

const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()] ?? m
  })
const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

/** The value of an attribute in a start tag (any namespace prefix), unescaped. */
const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag)
  return m ? unescapeXml(m[2] ?? m[3]) : undefined
}

/** All text of <t> elements inside a piece of XML (a shared string or an inline string), not phonetic runs. */
function textOf(xml: string): string {
  const noPhonetic = xml.replace(/<(\w+:)?rPh\b[\s\S]*?<\/(\w+:)?rPh>/g, '')
  let out = ''
  for (const m of noPhonetic.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += unescapeXml(m[1])
  return out
}

/** "B12" -> { row: 11, col: 1 } (zero-based). */
export function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref.toUpperCase())
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]) - 1, col: col - 1 }
}
/** Zero-based column -> "A", "B", ... "AA". */
export function colName(col: number): string {
  let s = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
/** Whether a number format shows a date or time (its code has d/m/y/h/s outside quotes and brackets). */
function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
  return /[dmyhs]/i.test(bare) && !/^[#0.,\s%]*$/.test(bare)
}

interface Workbook {
  zip: JSZip
  sheets: { name: string; path: string }[]
  shared: string[]
  /** For each cell style (s="n"): whether it shows a date. */
  dateStyles: boolean[]
  /** The workbook uses the 1904 date system (old Mac files). */
  date1904: boolean
}

const resolvePart = (base: string, target: string): string => {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const p of target.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '.') parts.push(p)
  }
  return parts.join('/')
}

async function openWorkbook(buf: Uint8Array): Promise<Workbook> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    throw new SheetError(t('File XLSX bị hỏng hoặc không phải file Excel (.xlsx).'))
  }
  const read = async (p: string): Promise<string | null> => (zip.file(p) ? zip.file(p)!.async('string') : null)
  const wbXml = await read('xl/workbook.xml')
  const relsXml = await read('xl/_rels/workbook.xml.rels')
  if (!wbXml || !relsXml) throw new SheetError(t('File XLSX bị hỏng hoặc không phải file Excel (.xlsx).'))
  const rels = new Map<string, string>()
  for (const m of relsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    if (id && target) rels.set(id, resolvePart('xl/workbook.xml', target))
  }
  const sheets: Workbook['sheets'] = []
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const rid = attr(m[0], 'r:id') ?? /\s\w+:id\s*=\s*"([^"]*)"/.exec(m[0])?.[1]
    const p = rid ? rels.get(rid) : undefined
    if (p && zip.file(p)) sheets.push({ name: attr(m[0], 'name') ?? p, path: p })
  }
  const shared: string[] = []
  const sstXml = await read('xl/sharedStrings.xml')
  if (sstXml) for (const m of sstXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '')
  const dateStyles: boolean[] = []
  const stylesXml = await read('xl/styles.xml')
  if (stylesXml) {
    const custom = new Map<number, string>()
    for (const m of stylesXml.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '')
    const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(stylesXml)?.[1] ?? ''
    for (const m of xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)) {
      const id = Number(attr(m[0], 'numFmtId') ?? 0)
      dateStyles.push(BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!)))
    }
  }
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*"(1|true)"/.test(wbXml)
  return { zip, sheets, shared, dateStyles, date1904 }
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** An Excel date serial as dd/mm/yyyy (and hh:mm when it has a time). */
export function formatSerialDate(serial: number, date1904 = false): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000)
  const d = new Date(ms)
  const date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
  const secs = Math.round((serial % 1) * 86400)
  if (secs === 0) return date
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}`
}
/** dd/mm/yyyy [hh:mm[:ss]] or yyyy-mm-dd[ hh:mm[:ss]] -> Excel date serial; null if not a date. */
export function parseDateText(text: string, date1904 = false): number | null {
  const s = text.trim()
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  let y: number, mo: number, d: number
  if (m) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else {
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
    if (!m) return null
    ;[y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const ms = Date.UTC(y, mo - 1, d, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0))
  const check = new Date(ms)
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return ms / 86400000 + 25569 - (date1904 ? 1462 : 0)
}

/** A number as Excel would show it in General format (no float noise like 0.30000000000000004). */
const showNumber = (v: string): string => {
  const n = Number(v)
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v
}

const CELL_RE = /<((?:\w+:)?)c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/g
const ROW_RE = /<((?:\w+:)?)row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1row>)/g

function readCell(wb: Workbook, attrs: string, inner: string): SheetCell {
  const type = attr(` ${attrs}`, 't') ?? 'n'
  const style = Number(attr(` ${attrs}`, 's') ?? 0)
  const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1]
  const formula = /<(?:\w+:)?f\b/.test(inner)
  let text = ''
  let kind: SheetCell['kind'] = 'empty'
  if (type === 's' && v !== undefined) [text, kind] = [wb.shared[Number(v)] ?? '', 'text']
  else if (type === 'inlineStr') [text, kind] = [textOf(inner), 'text']
  else if (type === 'str') [text, kind] = [unescapeXml(v ?? ''), 'text']
  else if (type === 'b') [text, kind] = [v === '1' ? 'TRUE' : 'FALSE', 'bool']
  else if (type === 'e') [text, kind] = [unescapeXml(v ?? ''), 'error']
  else if (type === 'd') [text, kind] = [unescapeXml(v ?? ''), 'date']
  else if (v !== undefined && v !== '') {
    if (wb.dateStyles[style]) [text, kind] = [formatSerialDate(Number(v), wb.date1904), 'date']
    else [text, kind] = [showNumber(unescapeXml(v)), 'number']
  }
  if (formula) kind = 'formula'
  return { text, kind }
}

/** Reads every sheet of an XLSX workbook into grids (values only; formulas as their saved results). */
export async function readXlsx(buf: Uint8Array): Promise<SheetTab[]> {
  const wb = await openWorkbook(buf)
  const tabs: SheetTab[] = []
  for (const sheet of wb.sheets) {
    const xml = (await wb.zip.file(sheet.path)!.async('string')) ?? ''
    const data = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(xml)?.[1] ?? ''
    const rows: SheetCell[][] = []
    let cols = 0
    let truncated = false
    // Rows and cells without an r="" position can't be edited safely (rare; old generators).
    let readOnly = false
    let rowIndex = -1
    for (const rm of data.matchAll(ROW_RE)) {
      const r = attr(` ${rm[2]}`, 'r')
      rowIndex = r ? Number(r) - 1 : rowIndex + 1
      if (!r) readOnly = true
      if (rowIndex >= MAX_ROWS) {
        truncated = true
        break
      }
      let colIndex = -1
      for (const cm of (rm[3] ?? '').matchAll(CELL_RE)) {
        const ref = attr(` ${cm[2]}`, 'r')
        const pos = ref ? parseRef(ref) : null
        colIndex = pos ? pos.col : colIndex + 1
        if (!pos) readOnly = true
        if (colIndex >= MAX_COLS) {
          truncated = true
          continue
        }
        const cell = readCell(wb, cm[2], cm[3] ?? '')
        if (cell.kind === 'empty') continue
        while (rows.length <= rowIndex) rows.push([])
        const row = rows[rowIndex]
        while (row.length < colIndex) row.push({ text: '', kind: 'empty' })
        row[colIndex] = cell
        cols = Math.max(cols, colIndex + 1)
      }
    }
    tabs.push({
      name: sheet.name,
      rows,
      cols: Math.max(cols, 1),
      truncated,
      readOnly: readOnly ? t('Sheet này được tạo theo cách app không sửa an toàn được (ô không có vị trí); chỉ xem được.') : undefined
    })
  }
  return tabs
}

/** Searchable text of a workbook: every cell's text, sheet by sheet. */
export async function xlsxText(buf: Uint8Array, max: number): Promise<string> {
  const tabs = await readXlsx(buf)
  let out = ''
  for (const tab of tabs) {
    out += `${tab.name}\n`
    for (const row of tab.rows) {
      out += row.map((c) => c.text).filter(Boolean).join(' ') + '\n'
      if (out.length > max) return out.slice(0, max)
    }
  }
  return out
}

// ---------- XLSX: writing ----------

/** A new value for a cell (zero-based position). */
export interface XlsxEdit {
  sheet: number
  row: number
  col: number
  text: string
}

/** The XML of a cell with its new value, keeping its style. */
function cellXml(prefix: string, ref: string, style: string | undefined, oldType: string | undefined, text: string, wb: Workbook): string {
  const s = style !== undefined ? ` s="${style}"` : ''
  const open = `<${prefix}c r="${ref}"${s}`
  if (text === '') return `${open}/>`
  const isDateStyle = style !== undefined && wb.dateStyles[Number(style)]
  if (isDateStyle) {
    const serial = parseDateText(text, wb.date1904)
    if (serial !== null) return `${open}><${prefix}v>${Number(serial.toPrecision(15))}</${prefix}v></${prefix}c>`
  }
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text.trim()) && Number.isFinite(Number(text))) {
    return `${open}><${prefix}v>${Number(text.trim())}</${prefix}v></${prefix}c>`
  }
  if (oldType === 'b' && /^(true|false)$/i.test(text.trim())) {
    return `${open} t="b"><${prefix}v>${/^true$/i.test(text.trim()) ? 1 : 0}</${prefix}v></${prefix}c>`
  }
  return `${open} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${escapeXml(text)}</${prefix}t></${prefix}is></${prefix}c>`
}

/** The workbook with the edited cells changed; everything else in the file as it was. */
export async function applyXlsxEdits(buf: Uint8Array, edits: XlsxEdit[]): Promise<Uint8Array> {
  const wb = await openWorkbook(buf)
  const bySheet = new Map<number, XlsxEdit[]>()
  for (const e of edits) {
    if (!wb.sheets[e.sheet]) throw new SheetError(t('Không tìm thấy sheet đã sửa. File có thể vừa bị thay đổi.'))
    if (!Number.isInteger(e.row) || !Number.isInteger(e.col) || e.row < 0 || e.col < 0 || e.row >= 1048576 || e.col >= 16384) {
      throw new SheetError(t('Vị trí ô không hợp lệ.'))
    }
    bySheet.set(e.sheet, [...(bySheet.get(e.sheet) ?? []), e])
  }
  let hasFormulas = false
  for (const [index, list] of bySheet) {
    const sheet = wb.sheets[index]
    let xml = await wb.zip.file(sheet.path)!.async('string')
    const sd = /<((?:\w+:)?)sheetData\b([^>]*?)(\/>|>([\s\S]*?)<\/\1sheetData>)/.exec(xml)
    if (!sd) throw new SheetError(t('File XLSX bị hỏng hoặc không phải file Excel (.xlsx).'))
    const prefix = sd[1]
    // The rows, by position: their start tag attributes and cells (as XML, by column).
    const rows = new Map<number, { attrs: string; cells: Map<number, string> }>()
    for (const rm of (sd[4] ?? '').matchAll(ROW_RE)) {
      const r = attr(` ${rm[2]}`, 'r')
      if (!r) throw new SheetError(t('Sheet này được tạo theo cách app không sửa an toàn được (ô không có vị trí); chỉ xem được.'))
      const cells = new Map<number, string>()
      for (const cm of (rm[3] ?? '').matchAll(CELL_RE)) {
        const ref = attr(` ${cm[2]}`, 'r')
        const pos = ref ? parseRef(ref) : null
        if (!pos) throw new SheetError(t('Sheet này được tạo theo cách app không sửa an toàn được (ô không có vị trí); chỉ xem được.'))
        cells.set(pos.col, cm[0])
      }
      rows.set(Number(r) - 1, { attrs: rm[2], cells })
    }
    const touched = new Set<number>()
    for (const e of list) {
      let row = rows.get(e.row)
      if (!row) rows.set(e.row, (row = { attrs: ` r="${e.row + 1}"`, cells: new Map() }))
      const old = row.cells.get(e.col)
      const oldAttrs = old ? (/^<(?:\w+:)?c\b([^>]*?)\/?>/.exec(old)?.[1] ?? '') : ''
      if (old && /<(?:\w+:)?f\b/.test(old)) throw new SheetError(t('Ô {0} có công thức nên không sửa ở đây được; hãy sửa trong Excel.', { 0: colName(e.col) + (e.row + 1) }))
      // A new cell takes the style of its row, if the row has one.
      const style = old ? attr(` ${oldAttrs}`, 's') : attr(` ${row.attrs}`, 'customFormat') === '1' ? attr(` ${row.attrs}`, 's') : undefined
      row.cells.set(e.col, cellXml(prefix, colName(e.col) + (e.row + 1), style, old ? attr(` ${oldAttrs}`, 't') : undefined, e.text, wb))
      touched.add(e.row)
    }
    // Rebuild sheetData: untouched rows exactly as they were, touched rows with cells in order.
    const original = new Map<number, string>()
    for (const rm of (sd[4] ?? '').matchAll(ROW_RE)) original.set(Number(attr(` ${rm[2]}`, 'r')) - 1, rm[0])
    const order = [...rows.keys()].sort((a, b) => a - b)
    const body = order
      .map((r) => {
        if (!touched.has(r)) return original.get(r)!
        const row = rows.get(r)!
        // "spans" is a hint of the columns used; it may be wrong now, and is optional.
        const attrs = row.attrs.replace(/\sspans\s*=\s*"[^"]*"/, '')
        const cells = [...row.cells.keys()].sort((a, b) => a - b).map((c) => row.cells.get(c)!)
        return cells.length ? `<${prefix}row${attrs}>${cells.join('')}</${prefix}row>` : `<${prefix}row${attrs}/>`
      })
      .join('')
    xml = xml.slice(0, sd.index) + `<${prefix}sheetData${sd[2]}>${body}</${prefix}sheetData>` + xml.slice(sd.index + sd[0].length)
    // The used range grows with new cells.
    xml = xml.replace(/<((?:\w+:)?)dimension\b([^>]*?)\bref\s*=\s*"([^"]*)"/, (m, p: string, before: string, ref: string) => {
      const [a, b = a] = ref.split(':')
      const from = parseRef(a)
      const to = parseRef(b)
      if (!from || !to) return m
      for (const e of list) {
        from.row = Math.min(from.row, e.row)
        from.col = Math.min(from.col, e.col)
        to.row = Math.max(to.row, e.row)
        to.col = Math.max(to.col, e.col)
      }
      return `<${p}dimension${before}ref="${colName(from.col)}${from.row + 1}:${colName(to.col)}${to.row + 1}"`
    })
    wb.zip.file(sheet.path, xml)
  }
  for (const s of wb.sheets) if (/<(?:\w+:)?f\b/.test(await wb.zip.file(s.path)!.async('string'))) hasFormulas = true
  if (hasFormulas && bySheet.size) {
    // Formulas that use the edited cells show old results until recalculated: ask Excel to.
    let wbXml = await wb.zip.file('xl/workbook.xml')!.async('string')
    if (/<(?:\w+:)?calcPr\b/.test(wbXml)) {
      wbXml = wbXml.replace(/<((?:\w+:)?)calcPr\b([^>]*?)(\/?)>/, (_m, p: string, a: string, slash: string) => `<${p}calcPr${a.replace(/\sfullCalcOnLoad\s*=\s*"[^"]*"/, '')} fullCalcOnLoad="1"${slash}>`)
    } else {
      const p = /<((?:\w+:)?)workbook\b/.exec(wbXml)?.[1] ?? ''
      // calcPr comes right after these, in this order of preference (the schema's order).
      const after = ['definedNames', 'externalReferences', 'functionGroups', 'sheets'].map((n) => new RegExp(`</${p}${n}>`)).find((re) => re.test(wbXml))
      if (after) wbXml = wbXml.replace(after, (m) => `${m}<${p}calcPr fullCalcOnLoad="1"/>`)
    }
    wb.zip.file('xl/workbook.xml', wbXml)
  }
  return wb.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

/** Loads a CSV or XLSX file for the grid. */
export async function loadSheet(buf: Uint8Array, ext: string, name: string, decode: (b: Uint8Array) => { text: string; editable: boolean }): Promise<SheetData> {
  if (ext === '.xlsx') return { format: 'xlsx', sheets: await readXlsx(buf), mtime: 0 }
  const { text, editable } = decode(buf)
  const file = parseCsv(text)
  const tab = csvSheet(file, name)
  if (!editable) tab.readOnly = t('File này không phải mã hoá UTF-8, nên không sửa được trong app (sẽ làm hỏng chữ). Hãy chuyển file sang UTF-8 bằng một trình soạn thảo khác, hoặc chỉ xem.')
  else if (tab.truncated) tab.readOnly = t('File quá lớn nên chỉ hiện {0} hàng đầu và chỉ xem được.', { 0: MAX_ROWS })
  return { format: 'csv', sheets: [tab], mtime: 0, delimiter: file.delimiter }
}
