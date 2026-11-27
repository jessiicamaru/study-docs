import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTES_FILE, NotesStore, sanitizeAnnotation, sanitizeBookmark } from '../src/main/notes-store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studydocs-notes-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const note = (id: string, quote: string, extra: object = {}) => sanitizeAnnotation({ id, quote, prefix: '', suffix: '', ...extra })

describe('sanitizeAnnotation', () => {
  it('keeps known fields and fixes bad values', () => {
    const a = sanitizeAnnotation({ id: 'abc123', quote: 'x', color: 'purple' as never, note: 5 as never, created: 7 })
    expect(a).toMatchObject({ id: 'abc123', quote: 'x', color: 'yellow', note: '', created: 7 })
  })
  it('refuses missing ids and empty quotes', () => {
    expect(() => sanitizeAnnotation({ id: '../x', quote: 'x' })).toThrow()
    expect(() => sanitizeAnnotation({ id: 'abc123', quote: '  ' })).toThrow()
  })
})

describe('NotesStore', () => {
  it('adds, updates and removes annotations, never touching documents', async () => {
    const store = await NotesStore.open(dir)
    await store.save('a.md', note('n1abc1', 'một'))
    await store.save('a.md', note('n2abc2', 'hai'))
    await store.save('a.md', note('n1abc1', 'một', { note: 'đã sửa', color: 'green' }))
    expect(store.byDoc()['a.md'].map((a) => [a.id, a.note, a.color])).toEqual([
      ['n1abc1', 'đã sửa', 'green'],
      ['n2abc2', '', 'yellow']
    ])
    await store.remove('a.md', 'n1abc1')
    await store.remove('a.md', 'n2abc2')
    expect(store.byDoc()).toEqual({})
    const saved = JSON.parse(await readFile(path.join(dir, NOTES_FILE), 'utf8'))
    expect(saved.docs).toEqual({})
  })

  it('keeps every note when several are saved at once', async () => {
    const store = await NotesStore.open(dir)
    await Promise.all(['n1abc1', 'n2abc2', 'n3abc3'].map((id) => store.save('a.md', note(id, id))))
    expect(store.byDoc()['a.md']).toHaveLength(3)
  })

  it('follows a renamed document', async () => {
    const store = await NotesStore.open(dir)
    await store.save('old.md', note('n1abc1', 'x'), { hash: 'h1', name: 'old.md' })
    await store.reconcile([{ path: 'new.md', hash: 'h1', name: 'new.md' }])
    expect(Object.keys(store.byDoc())).toEqual(['new.md'])
  })

  it('backs up a corrupt notes file', async () => {
    await writeFile(path.join(dir, NOTES_FILE), '{ broken')
    const store = await NotesStore.open(dir)
    expect(store.warning).toMatch(/highlight và ghi chú/)
    expect((await readdir(dir)).some((f) => f.startsWith('notes.corrupt-'))).toBe(true)
  })
})

describe('bookmarks', () => {
  const mark = (id: string, cfi: string, percent: number | null, created = 1) => sanitizeBookmark({ id, cfi, quote: 'Đoạn', chapter: 'Chương 1', percent, created })

  it('are checked: an id, and a place in the book', () => {
    expect(() => sanitizeBookmark({ id: '../x', cfi: 'epubcfi(/6/2)' })).toThrow()
    expect(() => sanitizeBookmark({ id: 'abc123', cfi: 'page 3' })).toThrow()
    expect(sanitizeBookmark({ id: 'abc123', cfi: 'epubcfi(/6/2)', percent: 140 }).percent).toBe(100)
  })

  it('are kept in reading order, one per place, and go with the book', async () => {
    const store = await NotesStore.open(dir)
    await store.addBookmark('b.epub', mark('m1aaaa', 'epubcfi(/6/4!/4/2)', 60))
    await store.addBookmark('b.epub', mark('m2aaaa', 'epubcfi(/6/2!/4/2)', 10))
    const again = await store.addBookmark('b.epub', mark('m3aaaa', 'epubcfi(/6/2!/4/2)', 10, 5)) // same place
    expect(again.map((b) => b.id)).toEqual(['m3aaaa', 'm1aaaa'])
    const reopened = await NotesStore.open(dir)
    expect(reopened.bookmarks('b.epub').map((b) => b.percent)).toEqual([10, 60])
  })

  it('removing the last one leaves no empty entry; highlights stay', async () => {
    const store = await NotesStore.open(dir)
    await store.addBookmark('b.epub', mark('m1aaaa', 'epubcfi(/6/4!/4/2)', 60))
    await store.save('b.epub', note('n1abc1', 'một'))
    await store.removeBookmark('b.epub', 'm1aaaa')
    expect(store.byDoc()['b.epub'].length).toBe(1)
    await store.addBookmark('c.epub', mark('m2aaaa', 'epubcfi(/6/4!/4/2)', 5))
    await store.removeBookmark('c.epub', 'm2aaaa')
    expect(JSON.parse(await readFile(path.join(dir, NOTES_FILE), 'utf8')).docs['c.epub']).toBeUndefined()
  })
})
