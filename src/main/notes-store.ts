// Highlights and notes of the documents in one workspace folder: data\<folder key>\notes.json
// in the app's data folder.
// Documents themselves are never changed. File safety (write queue, corrupt-file backup,
// following renames) lives in DocStore.

import type { Annotation, Bookmark, DocEntry, HighlightColor } from '../shared/types'
import { DocStore, type DocKeyed } from './doc-store'
import { t } from '../shared/i18n'

export const NOTES_FILE = 'notes.json'

interface DocNotes extends DocKeyed {
  items: Annotation[]
  /** A note about the whole document, not tied to a highlight (issue #21). */
  docNote?: { text: string; updated: number }
  /** Places kept in a book. */
  bookmarks?: Bookmark[]
}

/** An entry still holds something (or can be left out of the file). */
const hasContent = (e: DocNotes): boolean => !!(e.items?.length || e.docNote || e.bookmarks?.length)

const MAX_DOC_NOTE = 50000

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink']
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** A bookmark from the UI, with known fields of sane sizes. */
export function sanitizeBookmark(input: Partial<Bookmark>, now = Date.now()): Bookmark {
  if (typeof input.id !== 'string' || !/^[\w-]{6,64}$/.test(input.id)) throw new Error(t('Dấu trang không hợp lệ.'))
  if (typeof input.cfi !== 'string' || !input.cfi.startsWith('epubcfi(')) throw new Error(t('Dấu trang không hợp lệ.'))
  const percent = Number(input.percent)
  return {
    id: input.id,
    cfi: input.cfi.slice(0, 2000),
    quote: text(input.quote, 200),
    chapter: text(input.chapter, 200),
    percent: input.percent === null || !Number.isFinite(percent) ? null : Math.min(100, Math.max(0, Math.round(percent))),
    created: typeof input.created === 'number' ? input.created : now
  }
}

/** Keeps only known fields with sane sizes; anything coming from the UI goes through here. */
export function sanitizeAnnotation(input: Partial<Annotation>, now = Date.now()): Annotation {
  if (typeof input.id !== 'string' || !/^[\w-]{6,64}$/.test(input.id)) throw new Error(t('Ghi chú không hợp lệ (id)'))
  const quote = text(input.quote, 5000)
  if (!quote.trim()) throw new Error(t('Ghi chú không hợp lệ (đoạn trích trống)'))
  return {
    id: input.id,
    color: COLORS.includes(input.color as HighlightColor) ? (input.color as HighlightColor) : 'yellow',
    note: text(input.note, 20000),
    quote,
    prefix: text(input.prefix, 64),
    suffix: text(input.suffix, 64),
    ...(typeof input.cfi === 'string' ? { cfi: input.cfi.slice(0, 2000) } : {}),
    ...(Number.isInteger(input.page) && input.page! > 0 && input.page! < 1e6 ? { page: input.page } : {}),
    created: typeof input.created === 'number' ? input.created : now,
    updated: now
  }
}

/** Bookmarks in reading order (by how far into the book; then by when they were made). */
function byPlace(list: Bookmark[]): Bookmark[] {
  return list.slice().sort((x, y) => (x.percent ?? 101) - (y.percent ?? 101) || x.created - y.created)
}

export class NotesStore extends DocStore<DocNotes> {
  private constructor(root: string) {
    super(root, NOTES_FILE, t('highlight và ghi chú'))
  }

  static async open(root: string): Promise<NotesStore> {
    const store = new NotesStore(root)
    await store.load()
    return store
  }

  /** Highlights from both versions (the newer copy of each); the newer document note. */
  protected mergeEntry(a: DocNotes, b: DocNotes): DocNotes {
    const items = new Map<string, Annotation>()
    for (const x of [...(a.items ?? []), ...(b.items ?? [])]) {
      const prev = items.get(x.id)
      if (!prev || (x.updated ?? 0) > (prev.updated ?? 0)) items.set(x.id, x)
    }
    const notes = [a.docNote, b.docNote].filter((n): n is NonNullable<DocNotes['docNote']> => !!n?.text)
    const docNote = notes.sort((x, y) => y.updated - x.updated)[0]
    const marks = new Map<string, Bookmark>()
    for (const x of [...(a.bookmarks ?? []), ...(b.bookmarks ?? [])]) marks.set(x.id, x)
    return {
      ...b,
      ...a,
      items: [...items.values()].sort((x, y) => x.created - y.created),
      ...(docNote ? { docNote } : {}),
      ...(marks.size ? { bookmarks: byPlace([...marks.values()]) } : {})
    }
  }

  /** Document path -> its note about the whole document (documents without one are left out). */
  docNotes(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [p, entry] of Object.entries(this.docs)) if (entry.docNote?.text) out[p] = entry.docNote.text
    return out
  }

  /** Sets (or clears, with an empty text) the note about the whole document. */
  setDocNote(docPath: string, text: string, doc?: Pick<DocEntry, 'hash' | 'name'>): Promise<string> {
    return this.enqueue(async () => {
      const clean = String(text ?? '').slice(0, MAX_DOC_NOTE)
      const entry = this.docs[docPath] ?? { items: [] }
      const next = { ...this.docs }
      const updated: DocNotes = { ...entry, hash: doc?.hash ?? entry.hash, name: doc?.name ?? entry.name }
      if (clean.trim()) updated.docNote = { text: clean, updated: Date.now() }
      else delete updated.docNote
      if (hasContent(updated)) next[docPath] = updated
      else delete next[docPath]
      await this.write(next)
      return clean.trim() ? clean : ''
    })
  }

  /** Document path -> its annotations (documents without any are left out). */
  byDoc(): Record<string, Annotation[]> {
    const out: Record<string, Annotation[]> = {}
    for (const [p, entry] of Object.entries(this.docs)) if (entry.items?.length) out[p] = entry.items
    return out
  }

  /** Adds or replaces one annotation (matched by id). Resolves with the document's annotations. */
  save(docPath: string, annotation: Annotation, doc?: Pick<DocEntry, 'hash' | 'name'>): Promise<Annotation[]> {
    return this.enqueue(async () => {
      const entry = this.docs[docPath] ?? { items: [] }
      entry.items ??= []
      const items = entry.items.some((a) => a.id === annotation.id)
        ? entry.items.map((a) => (a.id === annotation.id ? annotation : a))
        : [...entry.items, annotation]
      await this.write({ ...this.docs, [docPath]: { ...entry, hash: doc?.hash ?? entry.hash, name: doc?.name ?? entry.name, items } })
      return items
    })
  }

  /** Bookmarks of a book, in reading order. */
  bookmarks(docPath: string): Bookmark[] {
    return this.docs[docPath]?.bookmarks ?? []
  }

  /** Adds a bookmark (one per place). Resolves with the book's bookmarks. */
  addBookmark(docPath: string, bookmark: Bookmark, doc?: Pick<DocEntry, 'hash' | 'name'>): Promise<Bookmark[]> {
    return this.enqueue(async () => {
      const entry = this.docs[docPath] ?? { items: [] }
      const others = (entry.bookmarks ?? []).filter((b) => b.id !== bookmark.id && b.cfi !== bookmark.cfi)
      const bookmarks = byPlace([...others, bookmark])
      await this.write({ ...this.docs, [docPath]: { ...entry, items: entry.items ?? [], hash: doc?.hash ?? entry.hash, name: doc?.name ?? entry.name, bookmarks } })
      return bookmarks
    })
  }

  /** Removes a bookmark. Resolves with the book's remaining bookmarks. */
  removeBookmark(docPath: string, id: string): Promise<Bookmark[]> {
    return this.enqueue(async () => {
      const entry = this.docs[docPath]
      if (!entry) return []
      const bookmarks = (entry.bookmarks ?? []).filter((b) => b.id !== id)
      const updated: DocNotes = { ...entry, bookmarks }
      if (!bookmarks.length) delete updated.bookmarks
      const next = { ...this.docs }
      if (hasContent(updated)) next[docPath] = updated
      else delete next[docPath]
      await this.write(next)
      return bookmarks
    })
  }

  /** Deletes one annotation. Resolves with the document's remaining annotations. */
  remove(docPath: string, id: string): Promise<Annotation[]> {
    return this.enqueue(async () => {
      const entry = this.docs[docPath]
      if (!entry) return []
      const items = entry.items.filter((a) => a.id !== id)
      const next = { ...this.docs }
      if (hasContent({ ...entry, items })) next[docPath] = { ...entry, items }
      else delete next[docPath]
      await this.write(next)
      return items
    })
  }
}
