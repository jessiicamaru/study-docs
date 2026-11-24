// Scans a workspace folder: finds the documents and reads their titles.
//
// Scanning is kept cheap so even a big library (hundreds of books, GBs) opens quickly:
//  - files whose size and modified time didn't change are taken from a cache, not re-read
//  - EPUB titles come from the book's package file, read straight out of the zip (a few KB)
//  - the searchable text is NOT read here; the search worker does that in the background
//    (see search-worker.ts, which uses extractText below)

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DocEntry, DocKind } from '../shared/types'
import { openZip, type ZipReader } from './zip'
import { decodeText } from '../shared/text'

/** A document as found inside one folder: `path` is relative to that folder. */
export type ScannedDoc = Omit<DocEntry, 'root' | 'rel'>

/** Title and hash of a file, remembered between scans and between app runs. */
export interface CachedInfo {
  title: string
  hash?: string
}

/** Persistent cache of CachedInfo, keyed by absolute path + size + modified time. */
export interface InfoCache {
  get(abs: string, size: number, mtime: number): CachedInfo | undefined
  set(abs: string, size: number, mtime: number, info: CachedInfo): void
}

/** How many files are read at the same time while scanning. */
const READ_CONCURRENCY = 16

/** Files up to this size are hashed (to recognise a renamed file by its content). */
const MAX_HASH_BYTES = 5 * 1024 * 1024
/** Notes (.md, .html) with embedded pictures get big; their text is still read up to this size. */
const MAX_NOTE_BYTES = 50 * 1024 * 1024
const maxRead = (kind: DocKind): number => (kind === 'md' || kind === 'html' ? MAX_NOTE_BYTES : MAX_HASH_BYTES)
/** At most this much text of a book is indexed for search. */
const MAX_BOOK_TEXT = 3 * 1024 * 1024

/**
 * Turns a library-relative path into an absolute one.
 * Returns null for anything that would land outside the library (e.g. "../secret.txt").
 */
export function resolveInLibrary(root: string, rel: string): string | null {
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  // A drive root ("D:\") already ends with the separator: files right in it are inside too.
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  return abs.startsWith(prefix) && abs.length > prefix.length ? abs : null
}

const EXTENSIONS: Record<string, DocKind> = {
  '.md': 'md',
  '.markdown': 'md',
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.mobi': 'mobi',
  '.azw3': 'mobi',
  '.azw': 'mobi',
  '.docx': 'docx',
  '.txt': 'txt',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.bmp': 'image',
  '.avif': 'image'
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

/** Every sub-folder of a workspace folder ("a/b", forward slashes); hidden ones and node_modules left out. */
export async function listFolders(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue
      const sub = rel ? `${rel}/${entry.name}` : entry.name
      out.push(sub)
      await walk(path.join(dir, entry.name), sub)
    }
  }
  await walk(root, '')
  return out.sort((a, b) => a.localeCompare(b, 'vi'))
}

/** The folders with no document anywhere below them (so the tree can still show them). */
export function emptyFolders(folders: string[], docs: { path: string }[]): string[] {
  const used = new Set<string>()
  for (const d of docs) {
    const parts = d.path.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) used.add(parts.slice(0, i).join('/'))
  }
  return folders.filter((f) => !used.has(f))
}

export function kindOf(file: string): DocKind | null {
  return EXTENSIONS[path.extname(file).toLowerCase()] ?? null
}

/**
 * Walks the folder recursively and returns every document.
 * `previous` (the last scan) and `cache` (kept on disk) are used for files whose size and
 * modified time did not change, so they are not read again.
 */
export async function scanLibrary(root: string, previous: ScannedDoc[] = [], cache?: InfoCache): Promise<ScannedDoc[]> {
  const files: { abs: string; kind: DocKind }[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // folder vanished or no permission: just skip it
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await walk(abs)
        continue
      }
      const kind = kindOf(entry.name)
      if (entry.isFile() && kind) files.push({ abs, kind })
    }
  }
  await walk(root)

  const byPath = new Map(previous.map((d) => [d.path, d]))
  const docs: ScannedDoc[] = []
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    const batch = files.slice(i, i + READ_CONCURRENCY)
    const results = await Promise.all(batch.map((f) => readEntry(root, f.abs, f.kind, byPath, cache)))
    for (const doc of results) if (doc) docs.push(doc)
  }
  docs.sort((a, b) => a.path.localeCompare(b.path, 'vi'))
  return docs
}

/** Reads only the given files of a folder (files opened on their own, see "File lẻ"). */
export async function readFiles(root: string, files: string[], previous: ScannedDoc[], cache?: InfoCache): Promise<ScannedDoc[]> {
  const byPath = new Map(previous.map((d) => [d.path, d]))
  const docs: ScannedDoc[] = []
  for (const abs of files) {
    const kind = kindOf(abs)
    const doc = kind && (await readEntry(root, abs, kind, byPath, cache))
    if (doc) docs.push(doc)
  }
  return docs
}

async function readEntry(
  root: string,
  abs: string,
  kind: DocKind,
  previous: Map<string, ScannedDoc>,
  cache?: InfoCache
): Promise<ScannedDoc | null> {
  try {
    const stat = await fs.stat(abs)
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const known = previous.get(rel)
    if (known && known.mtime === stat.mtimeMs && known.size === stat.size) return known

    const name = path.basename(abs)
    const base = { path: rel, name, kind, size: stat.size, mtime: stat.mtimeMs }
    const cached = cache?.get(abs, stat.size, stat.mtimeMs)
    if (cached) return { ...base, title: cached.title, hash: cached.hash }

    const fallbackTitle = name.replace(/\.[^.]+$/, '')
    let title = ''
    let hash: string | undefined
    if (stat.size <= maxRead(kind)) {
      const buffer = await fs.readFile(abs)
      hash = createHash('sha1').update(buffer).digest('hex')
      if (kind === 'html') title = extractHtml(buffer.toString('utf8')).title
      if (kind === 'md') title = extractMarkdown(buffer.toString('utf8')).title
    }
    if (kind === 'epub') title = await epubTitle(abs).catch(() => '')
    if (kind === 'mobi') title = await mobiTitle(abs).catch(() => '')
    if (kind === 'docx') title = await docxTitle(abs).catch(() => '')
    const info = { title: title || fallbackTitle, hash }
    cache?.set(abs, stat.size, stat.mtimeMs, info)
    return { ...base, ...info }
  } catch {
    return null
  }
}

/** Searchable plain text of a document (used by the search worker). */
export async function extractText(abs: string, kind: DocKind): Promise<string> {
  if (kind === 'epub') return epubText(abs)
  if (kind === 'mobi') return (await import('./mobi-text')).mobiText(abs, MAX_BOOK_TEXT)
  if (kind === 'docx') return docxText(abs)
  if (kind === 'image') return ''
  if (kind === 'txt') {
    const file = await fs.open(abs, 'r')
    try {
      // Big text files (logs...) are searched in their first part only.
      const buf = Buffer.alloc(Math.min((await file.stat()).size, MAX_BOOK_TEXT * 2))
      const { bytesRead } = await file.read(buf, 0, buf.length, 0)
      return decodeText(buf.subarray(0, bytesRead)).slice(0, MAX_BOOK_TEXT)
    } finally {
      await file.close()
    }
  }
  if (kind === 'pdf') return (await import('./pdf-text')).pdfText(abs, MAX_BOOK_TEXT)
  const stat = await fs.stat(abs)
  if (stat.size > maxRead(kind)) return ''
  const source = await fs.readFile(abs, 'utf8')
  return kind === 'html' ? extractHtml(source).text : extractMarkdown(source).text
}

// ---------- Word (.docx) ----------

/** Title from the document properties (File > Info in Word), if it has one. */
export async function docxTitle(abs: string): Promise<string> {
  const zip = await openZip(abs)
  try {
    const core = (await zip.read('docProps/core.xml'))?.toString('utf8') ?? ''
    return collapse(decodeEntities(core.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] ?? ''))
  } finally {
    await zip.close()
  }
}

/** Plain text of a Word document, paragraph by paragraph (straight from its XML, no layout). */
export async function docxText(abs: string): Promise<string> {
  const zip = await openZip(abs)
  try {
    const xml = (await zip.read('word/document.xml'))?.toString('utf8') ?? ''
    const text = xml
      .replace(/<w:tab\/>/g, ' ')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
    return decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_BOOK_TEXT)
  } finally {
    await zip.close()
  }
}

// ---------- MOBI / AZW3 ----------

/**
 * Title of a Kindle book, read straight from its headers (a few KB): the EXTH "updated
 * title" (record type 503) if there is one, else the book's full name.
 */
export async function mobiTitle(abs: string): Promise<string> {
  const file = await fs.open(abs, 'r')
  try {
    const head = Buffer.alloc(86)
    await file.read(head, 0, 86, 0)
    if (head.toString('latin1', 60, 68) !== 'BOOKMOBI') return ''
    const rec0 = Buffer.alloc(64 * 1024)
    const { bytesRead } = await file.read(rec0, 0, rec0.length, head.readUInt32BE(78))
    const r = rec0.subarray(0, bytesRead)
    if (r.length < 132 || r.toString('latin1', 16, 20) !== 'MOBI') return ''
    const decoder = new TextDecoder(r.readUInt32BE(28) === 65001 ? 'utf-8' : 'windows-1252')
    const headerLength = r.readUInt32BE(20)
    if (r.readUInt32BE(128) & 0x40) {
      let at = 16 + headerLength
      if (r.toString('latin1', at, at + 4) === 'EXTH') {
        const count = r.readUInt32BE(at + 8)
        at += 12
        for (let i = 0; i < count && at + 8 <= r.length; i++) {
          const type = r.readUInt32BE(at)
          const length = r.readUInt32BE(at + 4)
          if (length < 8) break
          if (type === 503) return collapse(decodeEntities(decoder.decode(r.subarray(at + 8, at + length))))
          at += length
        }
      }
    }
    const offset = r.readUInt32BE(84)
    const length = r.readUInt32BE(88)
    return offset + length <= r.length ? collapse(decodeEntities(decoder.decode(r.subarray(offset, offset + length)))) : ''
  } finally {
    await file.close()
  }
}

// ---------- EPUB ----------

/** Package file (.opf) of a book: title, and the chapter files in reading order. */
async function epubPackage(zip: ZipReader): Promise<{ title: string; chapters: string[] }> {
  const container = (await zip.read('META-INF/container.xml'))?.toString('utf8')
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1]
  const opf = opfPath ? (await zip.read(opfPath))?.toString('utf8') : undefined
  if (!opfPath || !opf) return { title: '', chapters: [] }

  const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
  const title = collapse(stripTags(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? ''))
  const base = path.posix.dirname(opfPath)
  const hrefs = new Map<string, string>()
  // <item\b so that <itemref> (the reading order, below) doesn't match too.
  for (const [tag] of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(tag, 'id')
    const href = attr(tag, 'href')
    if (id && href) hrefs.set(id, href)
  }
  const chapters: string[] = []
  for (const [tag] of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const href = hrefs.get(attr(tag, 'idref') ?? '')
    if (href) chapters.push(path.posix.normalize(path.posix.join(base, decodeURIComponent(href))))
  }
  return { title, chapters }
}

export async function epubTitle(file: string): Promise<string> {
  const zip = await openZip(file)
  try {
    return (await epubPackage(zip)).title
  } finally {
    await zip.close()
  }
}

/** Text of the chapters in reading order, reading only the chapter files (not images). */
export async function epubText(file: string): Promise<string> {
  const zip = await openZip(file)
  try {
    let text = ''
    for (const chapter of (await epubPackage(zip)).chapters) {
      const html = await zip.read(chapter)
      if (!html) continue
      text += ' ' + extractHtml(html.toString('utf8')).text
      if (text.length > MAX_BOOK_TEXT) break
    }
    return collapse(text).slice(0, MAX_BOOK_TEXT)
  } finally {
    await zip.close()
  }
}

// ---------- text extraction ----------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…'
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : match
    }
    return ENTITIES[code.toLowerCase()] ?? match
  })
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
}

export function extractHtml(source: string): { title: string; text: string } {
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const h1Match = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const title = collapse(stripTags(titleMatch?.[1] ?? h1Match?.[1] ?? ''))

  const body = source
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  return { title, text: collapse(stripTags(body)) }
}

export function extractMarkdown(source: string): { title: string; text: string } {
  let body = source
  let title = ''

  // Optional YAML front matter: only `title:` is read here.
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (fm) {
    const t = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (t) title = t[1]
    body = body.slice(fm[0].length)
  }
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m)
    if (h1) title = h1[1].trim()
  }

  const text = body
    .replace(/```[\w-]*\n?/g, ' ') // keep code contents, drop fences
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/[#>*_`~|-]+/g, ' ')
  return { title, text: collapse(stripTags(text)) }
}
