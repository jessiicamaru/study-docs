import { describe, expect, it } from 'vitest'
import { movedKeys, staleKeys } from '../src/renderer/src/lib/positions'

describe('staleKeys (issue #8)', () => {
  const docs = [
    { path: 'aaaa/notes/a.md', mtime: 10 },
    { path: 'aaaa/books/b.epub', mtime: 20 }
  ]
  const roots = [
    { key: 'aaaa', available: true },
    { key: 'usb1', available: false }
  ]
  it('keeps positions of documents that exist, and other app keys', () => {
    expect(staleKeys(['pos:aaaa/notes/a.md', 'epubpos:aaaa/books/b.epub', 'epubloc:aaaa/books/b.epub:20', 'selected:workspace', 'outline-open'], docs, roots)).toEqual([])
  })
  it('drops deleted documents and old versions of a book', () => {
    expect(
      staleKeys(['pos:aaaa/notes/gone.md', 'epubloc:aaaa/books/b.epub:19', 'epubpos:aaaa/old.epub'], docs, roots)
    ).toEqual(['pos:aaaa/notes/gone.md', 'epubloc:aaaa/books/b.epub:19', 'epubpos:aaaa/old.epub'])
  })
  it('keeps positions of folders that are not in this workspace (another workspace file may have them)', () => {
    expect(staleKeys(['pos:zzzz/x.md', 'epubpos:zzzz/b.epub'], docs, roots)).toEqual([])
  })
  it('keeps everything of a folder that is only temporarily unavailable', () => {
    expect(staleKeys(['pos:usb1/a.md', 'epubloc:usb1/b.epub:5'], docs, roots)).toEqual([])
  })
})

describe('reading positions follow a rename or move', () => {
  it('moves the keys of a document, or of everything in a folder', () => {
    const keys = ['pos:a1/mang/b1.md', 'epubpos:a1/mang/sach.epub', 'epubloc:a1/mang/sach.epub:1700', 'pos:a1/mang-khac.md', 'pos:a1/x.md', 'other']
    expect(movedKeys(keys, 'a1/mang', 'a1/hk1/mang', true)).toEqual([
      ['pos:a1/mang/b1.md', 'pos:a1/hk1/mang/b1.md'],
      ['epubpos:a1/mang/sach.epub', 'epubpos:a1/hk1/mang/sach.epub'],
      ['epubloc:a1/mang/sach.epub:1700', 'epubloc:a1/hk1/mang/sach.epub:1700']
    ])
    expect(movedKeys(keys, 'a1/x.md', 'a1/y.md', false)).toEqual([['pos:a1/x.md', 'pos:a1/y.md']])
  })
})
