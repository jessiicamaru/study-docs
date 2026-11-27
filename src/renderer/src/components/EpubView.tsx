// EPUB books, shown with epub.js.
//
// The book is read as bytes through window.api (no network), unzipped in memory by epub.js,
// and each chapter is shown in an iframe. Book scripts never run (the app's CSP blocks them).
// Books are read page by page, like a real book: buttons, ←/→, PageUp/PageDown or the
// mouse wheel turn the page; a wide window shows two pages side by side. The reading
// position is remembered as an EPUB CFI (an exact position in the book), highlights too.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import ePub, { EpubCFI } from 'epubjs'
import type { Annotation, Bookmark, DocEntry } from '../../../shared/types'
import { loadLocal, saveLocal } from '../lib/docs'
import { generateLocations } from '../lib/epub-locations'
import { HIGHLIGHT_COLORS } from './Annotations'
import { newAnnotationId, type FindResult, type ReaderCallbacks, type ReaderHandle } from './reader'
import { t } from '../../../shared/i18n'

type Book = ReturnType<typeof ePub>
type Rendition = ReturnType<Book['renderTo']>
/** The part of epub.js's spine item (Section) used for searching the book. */
interface SpineItem {
  load(request: unknown): Promise<unknown>
  unload(): void
  find(query: string): { cfi: string; excerpt: string }[]
}

interface TocEntry {
  href: string
  label: string
  level: number
}

interface Props extends ReaderCallbacks {
  doc: DocEntry
  onError: (err: unknown) => void
  /** Places kept in this book; the bar's button (or Ctrl+D) adds or removes the one on the pages shown. */
  bookmarks?: Bookmark[]
  onBookmarksChange?: (list: Bookmark[]) => void
}

/** a <= b in the book (two epub.js positions). */
const cfiBefore = (a: string, b: string): boolean => {
  try {
    return new EpubCFI().compare(a, b) <= 0
  } catch {
    return false
  }
}

const positionKey = (path: string): string => `epubpos:${path}`
const locationsKey = (doc: DocEntry): string => `epubloc:${doc.path}:${doc.mtime}`

/** Joins a path relative to `base` (a file path inside the book), handling "../". */
function resolveIn(base: string, href: string): string {
  const parts = base.split('/').slice(0, -1)
  for (const p of href.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '.' && p !== '') parts.push(p)
  }
  return parts.join('/')
}

/**
 * epub.js turns a range that starts or ends on an element (double-clicking a bold word,
 * triple-clicking a paragraph) into a one-character highlight. Move both ends into text nodes.
 */
function toTextRange(range: Range): Range {
  const doc = range.startContainer.ownerDocument!
  const r = range.cloneRange()
  const texts = (root: Node): TreeWalker => doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  if (r.startContainer.nodeType !== Node.TEXT_NODE) {
    const node = r.startContainer.childNodes[r.startOffset] ?? r.startContainer
    const w = texts(doc.body)
    w.currentNode = node
    const first = node.nodeType === Node.TEXT_NODE ? node : w.nextNode()
    if (first) r.setStart(first, 0)
  }
  if (r.endContainer.nodeType !== Node.TEXT_NODE) {
    // The node just before the end boundary: its last text node is where the selection ends.
    const before = r.endContainer.childNodes[r.endOffset - 1]
    let last: Node | null = null
    if (before?.nodeType === Node.TEXT_NODE) last = before
    else if (before) {
      const w = texts(before)
      for (let n = w.nextNode(); n; n = w.nextNode()) last = n
    }
    if (!last) {
      // Nothing before the boundary inside that element: use the text just before the element.
      const w = texts(doc.body)
      w.currentNode = r.endContainer
      last = w.previousNode()
    }
    if (last) r.setEnd(last, (last as Text).data.length)
  }
  return r
}
const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Settings > Đọc sách: "none" = always one page; "auto" = two pages when the book area is wide. */
const spreadSetting = (): 'none' | 'auto' => (document.documentElement.dataset.epubSpread === 'single' ? 'none' : 'auto')

/**
 * Lights up the paragraph at `cfi` for a moment: after the pages are laid out again (a bigger
 * window shows more text per page, and pages have fixed edges), the page starts before the
 * place you were reading, and this shows where it is.
 */
function showPlace(r: Rendition | null, cfi: string): void {
  let node: Node | null = null
  try {
    node = (r as unknown as { getRange: (c: string) => Range | null } | null)?.getRange(cfi)?.startContainer ?? null
  } catch {
    return
  }
  let el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
  while (el && !/^(P|LI|H[1-6]|BLOCKQUOTE|PRE|DD|DT|FIGCAPTION|TD|TH)$/.test(el.tagName) && el.parentElement && el.tagName !== 'BODY') el = el.parentElement
  if (!el || el.tagName === 'BODY') return
  const box = el as HTMLElement
  const before = { bg: box.style.backgroundColor, transition: box.style.transition }
  box.style.transition = 'background-color .9s ease'
  box.style.backgroundColor = 'rgba(250, 204, 21, .45)'
  setTimeout(() => (box.style.backgroundColor = before.bg), 900)
  setTimeout(() => (box.style.transition = before.transition), 1900)
}

/**
 * With two pages side by side, epub.js pairs the pages from the start of the chapter, so the
 * place you were reading can land on the right page after a re-layout (a bigger window) or
 * when the book opens: the left page then shows text you had already read, as if you had
 * gone back. Move on by one page so that place is on the left again; turning pages after
 * that still goes two at a time.
 */
function placeOnLeftPage(r: Rendition | null, cfi: string): void {
  type View = { offset: () => { left: number }; locationOf: (target: string) => { left: number } | undefined }
  type Manager = {
    isPaginated: boolean
    layout: { divisor: number; pageWidth: number; delta: number }
    container: HTMLElement
    visible: () => View[]
    scrollTo: (x: number, y: number, silent: boolean) => void
  }
  const m = (r as unknown as { manager?: Manager } | null)?.manager
  if (!r || !m?.isPaginated || !m.layout || m.layout.divisor < 2) return
  for (const view of m.visible()) {
    let at: { left: number } | undefined
    try {
      at = view.locationOf(cfi)
    } catch {
      continue // the place is in another chapter's view
    }
    if (!at || !Number.isFinite(at.left)) continue
    const x = view.offset().left + at.left
    const left = m.container.scrollLeft
    const page = m.layout.pageWidth
    // On the right page, and there is a page after it to pair with.
    if (x >= left + page - 2 && left + page + m.layout.delta <= m.container.scrollWidth + 2) {
      m.scrollTo(left + page, 0, true)
      ;(r as unknown as { reportLocation?: () => void }).reportLocation?.()
    }
    return
  }
}
const MIN_SPREAD_WIDTH = 1100

/** The part of epub.js's Contents (one shown chapter) used to place outline entries. */
interface ShownChapter {
  sectionIndex: number
  document: Document
  cfiFromNode(node: Node): string
}

/** Colours and reading font follow the app (Settings > Đọc Markdown, light/dark). */
function applyTheme(rendition: Rendition): void {
  rendition.themes.override('color', css('--ink'))
  rendition.themes.override('background', css('--paper'))
  rendition.themes.override('font-family', css('--read-font') || 'inherit')
  rendition.themes.fontSize(css('--read-size') || '16px')
}

const EpubView = forwardRef<ReaderHandle, Props>(function EpubView(props, ref) {
  const { doc } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const rendition = useRef<Rendition | null>(null)
  const toc = useRef<TocEntry[]>([])
  const annotations = useRef<Annotation[]>([])
  const drawn = useRef<string[]>([])
  const bookRef = useRef<Book | null>(null)
  const [progress, setProgress] = useState<{ chapter: string; percent: number | null }>({ chapter: '', percent: null })
  // The pages shown (from the start of the first to the end of the last) and your place in them.
  const [shown, setShown] = useState<{ start: string; end: string } | null>(null)
  const placeRef = useRef<string | null>(null)
  // A bookmark on the pages shown (the ribbon, and the button that removes it).
  const bookmarkHere = shown ? (props.bookmarks ?? []).find((b) => cfiBefore(shown.start, b.cfi) && cfiBefore(b.cfi, shown.end)) : undefined
  /** Adds a bookmark at your place, or removes the one on the pages shown. */
  const toggleBookmark = async (): Promise<void> => {
    try {
      if (bookmarkHere) {
        cb.current.onBookmarksChange?.(await window.api.removeBookmark(doc.path, bookmarkHere.id))
        return
      }
      const cfi = placeRef.current ?? shown?.start
      if (!cfi) return
      // The first words there, to recognise it in the list.
      let quote = ''
      try {
        const range = (rendition.current as unknown as { getRange: (c: string) => Range | null } | null)?.getRange(cfi)
        const node = range?.startContainer
        const block = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
        quote = (block?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, div')?.textContent ?? block?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
      } catch {
        // no text at hand: the chapter and % still say where it is
      }
      const mark: Bookmark = { id: newAnnotationId(), cfi, quote, chapter: progress.chapter, percent: progress.percent, created: Date.now() }
      cb.current.onBookmarksChange?.(await window.api.addBookmark(doc.path, mark))
    } catch (err) {
      cb.current.onError(err)
    }
  }
  const toggleRef = useRef(toggleBookmark)
  toggleRef.current = toggleBookmark
  const cb = useRef(props)
  cb.current = props

  // Ctrl+F results: positions (CFI) of every match in the book; the current one is marked.
  const found = useRef<string[]>([])
  const foundIndex = useRef(0)
  const foundMark = useRef<string | null>(null)
  const clearFoundMark = (): void => {
    if (foundMark.current) rendition.current?.annotations.remove(foundMark.current, 'highlight')
    foundMark.current = null
  }
  const gotoFound = async (): Promise<FindResult> => {
    clearFoundMark()
    const cfi = found.current[foundIndex.current]
    if (cfi && rendition.current) {
      await rendition.current.display(cfi)
      rendition.current.annotations.highlight(cfi, {}, () => {}, 'sd-epub-find', { fill: '#f97316', 'fill-opacity': '0.5' })
      foundMark.current = cfi
    }
    return { index: foundIndex.current, total: found.current.length }
  }

  const next = (): void => void rendition.current?.next()
  const prev = (): void => void rendition.current?.prev()

  /**
   * Outline links are written relative to the book's navigation file, which is often in
   * its own folder (e.g. Nav/toc.xhtml -> "../Text/ch5.xhtml"); epub.js expects them
   * relative to the package. Find the chapter it means.
   */
  const chapterHref = (href: string): string => {
    const book = bookRef.current
    if (!book) return href
    const [file, hash] = href.split('#')
    const navFile = (book.packaging as unknown as { navPath?: string; ncxPath?: string }).navPath ||
      (book.packaging as unknown as { ncxPath?: string }).ncxPath || ''
    const spine = book.spine as unknown as { get(target: string): { href: string } | null; spineItems: { href: string }[] }
    const candidates = [file, resolveIn(navFile, file)]
    let item = candidates.map((c) => spine.get(c)).find(Boolean) ?? null
    if (!item) {
      const name = file.split('/').pop()!
      item = spine.spineItems.find((it) => it.href === resolveIn(navFile, file) || it.href.split('/').pop() === name) ?? null
    }
    return item ? item.href + (hash ? `#${hash}` : '') : href
  }

  /** Replaces the highlights drawn in the book. */
  const draw = (): void => {
    const r = rendition.current
    if (!r) return
    for (const cfi of drawn.current) r.annotations.remove(cfi, 'highlight')
    drawn.current = []
    const missing: string[] = []
    for (const a of annotations.current) {
      if (!a.cfi) {
        missing.push(a.id)
        continue
      }
      try {
        const fill = HIGHLIGHT_COLORS.find((c) => c.id === a.color)?.css ?? '#facc15'
        r.annotations.highlight(
          a.cfi,
          { id: a.id },
          (e: MouseEvent) => cb.current.onAnnotationClick(a.id, (e.target as Element).getBoundingClientRect()),
          'sd-epub-hl',
          { fill, 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply' }
        )
        drawn.current.push(a.cfi)
      } catch {
        missing.push(a.id)
      }
    }
    cb.current.onAnchored(missing)
  }

  useEffect(() => {
    let book: Book | null = null
    let disposeBook: (() => void) | undefined
    let stopWatching: (() => void) | undefined
    let cancelled = false
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => {
      if (rendition.current) applyTheme(rendition.current)
    }

    // Mouse wheel turns the page (at most one page per 350 ms, so one flick = one page).
    let lastWheel = 0
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) < 4 || Date.now() - lastWheel < 350) return
      lastWheel = Date.now()
      if (e.deltaY > 0) next()
      else prev()
    }
    hostRef.current!.addEventListener('wheel', onWheel, { passive: true })
    // Keys when the focus is in the app rather than in the book.
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return
      // Ctrl+D: bookmark this place (or remove the bookmark here).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        void toggleRef.current()
        return
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') next()
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev()
    }
    window.addEventListener('keydown', onKey)
    // Re-layout the pages when the window or the side panel changes size.
    //
    // Laying the pages out again (new window size, one or two pages) makes epub.js lose the
    // page you were on. So: remember the place you were reading (lastCfi, from 'relocated'),
    // ignore the positions epub.js reports while it re-lays out, and go back there after.
    let lastCfi: string | null = null
    let restoring: string | null = null
    let exactAfterRestore: string | null = null
    // For a moment after a re-layout, epub.js may lay the pages out once more (going to two
    // pages side by side happens a little later) and show the pair from its start: each new
    // position it reports then puts your place back on the left page.
    let keepOnLeft: { cfi: string; until: number } | null = null
    let restoreTimer: ReturnType<typeof setTimeout> | undefined
    const relayout = (change: () => void): void => {
      restoring ??= lastCfi
      change()
      clearTimeout(restoreTimer)
      restoreTimer = setTimeout(async () => {
        const at = restoring
        try {
          if (at && !cancelled) {
            await rendition.current?.display(at)
            keepOnLeft = { cfi: at, until: Date.now() + 1500 }
            placeOnLeftPage(rendition.current, at)
            showPlace(rendition.current, at)
          }
        } finally {
          // Keep the exact place, not the start of the page(s) now shown: with two pages that
          // is the left page, and each re-layout would move you back a little. epub.js reports
          // the new position just after display() finishes, so remember it for that report.
          if (restoring === at) restoring = null
          if (at) {
            lastCfi = at
            exactAfterRestore = at
            setTimeout(() => (exactAfterRestore = null), 400)
          }
        }
      }, 200)
    }
    // epub.js re-lays out by itself when the window is resized (shortly after this event);
    // catch it first so the place you were reading is kept.
    const onWindowResize = (): void => {
      if ((rendition.current as unknown as { manager?: unknown } | null)?.manager) relayout(() => {})
    }
    window.addEventListener('resize', onWindowResize, true)
    const resize = new ResizeObserver(() => {
      const host = hostRef.current
      // The view manager only exists once the book has opened; earlier size changes are picked up by display().
      const r = rendition.current as unknown as { manager?: unknown; resize: (w: number, h: number) => void } | null
      if (host && r?.manager) relayout(() => r.resize(host.clientWidth, host.clientHeight))
    })
    resize.observe(hostRef.current!)

    void (async () => {
      const bytes = await window.api.readBinary(doc.path)
      if (cancelled) return
      let data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      // Kindle books are turned into an EPUB first (issue #20).
      if (doc.kind === 'mobi') {
        const { mobiToEpub } = await import('../lib/mobi-to-epub')
        const converted = await mobiToEpub(bytes)
        disposeBook = converted.dispose
        if (cancelled) return converted.dispose()
        data = converted.epub
      }
      book = ePub(data)
      bookRef.current = book
      const r = book.renderTo(hostRef.current!, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: spreadSetting(),
        minSpreadWidth: MIN_SPREAD_WIDTH, // two pages side by side when there is room (if allowed)
        allowScriptedContent: false
      })
      rendition.current = r
      applyTheme(r)
      darkQuery.addEventListener('change', onScheme)

      // Chapters list -> outline panel.
      const nav = await book.loaded.navigation
      const flatten = (items: { href: string; label: string; subitems?: unknown[] }[], level: number): TocEntry[] =>
        items.flatMap((it) => [
          { href: it.href, label: it.label.trim(), level },
          ...flatten((it.subitems ?? []) as { href: string; label: string }[], level + 1)
        ])
      toc.current = flatten(nav.toc, 1).map((t) => ({ ...t, href: chapterHref(t.href) }))
      cb.current.onOutline(toc.current.map((t) => ({ level: Math.min(t.level, 3), text: t.label })))
      // Position of each outline entry in the reading order (-1 if it points nowhere).
      const spine = book.spine as unknown as { get(target: string): { index: number } | null }
      const tocSpine = toc.current.map((t) => spine.get(t.href.split('#')[0])?.index ?? -1)
      const cfiCompare = new EpubCFI()

      // Where you are: remember the position, highlight the current chapter in the outline.
      r.on('relocated', (location: { start: { cfi: string; href: string; index: number }; end: { cfi: string } }) => {
        if (restoring) return // a passing position while the pages are laid out again
        if (keepOnLeft && Date.now() < keepOnLeft.until) placeOnLeftPage(r, keepOnLeft.cfi)
        // Right after a re-layout the page shown starts before your place (pages have fixed
        // edges): your place, not the page's start, is kept, saved and counted, or each resize
        // would move you back a little.
        lastCfi = exactAfterRestore ?? location.start.cfi
        exactAfterRestore = null
        const place = lastCfi
        saveLocal(positionKey(doc.path), place)
        placeRef.current = place
        setShown({ start: location.start.cfi, end: location.end.cfi })
        const active = activeEntry(location)
        cb.current.onReading(0, active)
        const ready = (book?.locations as unknown as { length(): number } | undefined)?.length() ?? 0
        setProgress({
          chapter: active >= 0 ? toc.current[active].label : '',
          percent: ready ? Math.round((book!.locations.percentageFromCfi(place) ?? 0) * 100) : null
        })
      })
      /**
       * The outline entry being read: the last one that starts on or before the pages shown.
       * Entries in earlier files count; in the file being read, an entry pointing at a place
       * inside it (#section) counts once that place is on or before the last page shown.
       * Files that are not in the outline keep the entry before them highlighted.
       */
      function activeEntry(location: { start: { index: number }; end: { cfi: string } }): number {
        const here = location.start.index
        const shown = (r.getContents() as unknown as ShownChapter[]).find((c) => c.sectionIndex === here)
        let active = -1
        toc.current.forEach((t, i) => {
          const at = tocSpine[i]
          if (at < 0 || at > here) return
          const hash = t.href.split('#')[1]
          if (at === here && hash && shown) {
            const el = shown.document.getElementById(decodeURIComponent(hash))
            try {
              if (el && cfiCompare.compare(shown.cfiFromNode(el), location.end.cfi) > 0) return // further on
            } catch {
              // can't place it: treat it as the start of its file
            }
          }
          if (active < 0 || at >= tocSpine[active]) active = i
        })
        return active
      }

      // Settings > Đọc sách changed: one page or two, right away.
      const spreadWatch = new MutationObserver(() => relayout(() => r.spread(spreadSetting(), MIN_SPREAD_WIDTH)))
      spreadWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-epub-spread'] })
      stopWatching = () => spreadWatch.disconnect()

      // Turning pages with the keyboard / mouse wheel while the book has the focus.
      r.on('keyup', (e: KeyboardEvent) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return
        if (e.key === 'ArrowRight' || e.key === 'PageDown') next()
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev()
      })
      // Selecting text -> highlight toolbar.
      r.on('selected', (_cfi: string, contents: { window: Window; document: Document; cfiFromRange(range: Range): string }) => {
        const selected = contents.window.getSelection()
        if (!selected?.rangeCount) return
        const range = toTextRange(selected.getRangeAt(0))
        const cfiRange = contents.cfiFromRange(range)
        const quote = range.toString()
        if (!quote.trim()) return
        const frame = contents.document.defaultView?.frameElement?.getBoundingClientRect()
        const rr = range.getBoundingClientRect()
        const dx = frame?.left ?? 0
        const dy = frame?.top ?? 0
        cb.current.onSelection({
          quote,
          prefix: '',
          suffix: '',
          cfi: cfiRange,
          rect: { left: rr.left + dx, right: rr.right + dx, top: rr.top + dy, bottom: rr.bottom + dy }
        })
      })
      // Inside each chapter: clicking clears the toolbar; app shortcuts still work.
      r.hooks.content.register((contents: { document: Document }) => {
        contents.document.addEventListener('mousedown', () => cb.current.onSelection(null))
        contents.document.addEventListener('scroll', () => cb.current.onSelection(null), true)
        contents.document.addEventListener('wheel', onWheel, { passive: true })
        // Ctrl+F inside the book opens the app's find bar.
        contents.document.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            window.dispatchEvent(new Event('studydocs:find'))
          }
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'd') {
            e.preventDefault()
            void toggleRef.current()
          }
        })
      })
      r.on('rendered', () => draw())

      const savedPlace = loadLocal<string | null>(positionKey(doc.path), null)
      await r.display(savedPlace ?? undefined)
      if (cancelled) return
      if (savedPlace) {
        keepOnLeft = { cfi: savedPlace, until: Date.now() + 1500 }
        placeOnLeftPage(r, savedPlace)
      }
      draw()
      cb.current.onReady()

      // "% read" needs the book split into locations: cached per book version, else computed
      // in the background (a few seconds for a big book) without blocking reading.
      const saved = loadLocal<string | null>(locationsKey(doc), null)
      if (saved) book.locations.load(saved)
      else {
        // Computed in small slices so turning pages stays smooth meanwhile (issue #13).
        const locations = await generateLocations(book as unknown as Parameters<typeof generateLocations>[0], 1600, () => cancelled)
        if (!locations || cancelled) return
        book.locations.load(locations as unknown as string)
        saveLocal(locationsKey(doc), book.locations.save())
      }
      const loc = r.currentLocation() as unknown as { start?: { cfi: string } }
      if (loc?.start) setProgress((p) => ({ ...p, percent: Math.round((book!.locations.percentageFromCfi(loc.start!.cfi) ?? 0) * 100) }))
    })().catch((err) => cb.current.onError(err))

    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKey)
      resize.disconnect()
      clearTimeout(restoreTimer)
      window.removeEventListener('resize', onWindowResize, true)
      darkQuery.removeEventListener('change', onScheme)
      rendition.current?.destroy()
      rendition.current = null
      drawn.current = []
      bookRef.current = null
      book?.destroy()
      disposeBook?.()
      stopWatching?.()
    }
  }, [doc.path, doc.mtime])

  useImperativeHandle(ref, () => ({
    gotoHeading: (index) => {
      const href = toc.current[index]?.href
      if (href) rendition.current?.display(href).catch((err: unknown) => cb.current.onError(err))
    },
    restoreScroll: () => {}, // the position is restored from the saved CFI when the book opens
    collectChanges: async () => ({ kind: 'none' }),
    setAnnotations: (items) => {
      annotations.current = items
      draw()
    },
    gotoAnnotation: (id) => {
      const cfi = annotations.current.find((a) => a.id === id)?.cfi
      if (cfi) void rendition.current?.display(cfi)
    },
    gotoPlace: (cfi) => {
      void rendition.current
        ?.display(cfi)
        .then(() => {
          placeOnLeftPage(rendition.current, cfi)
          showPlace(rendition.current, cfi)
        })
        .catch((err: unknown) => cb.current.onError(err))
    },
    clearSelection: () => {
      const contents = rendition.current?.getContents() as unknown as { window: Window }[] | undefined
      for (const c of contents ?? []) c.window.getSelection()?.removeAllRanges()
    },
    // Ctrl+F searches the whole book, chapter by chapter (epub.js Section.find).
    find: async (query) => {
      clearFoundMark()
      found.current = []
      const book = bookRef.current
      if (!book || !query.trim()) return { index: 0, total: 0 }
      const spine = book.spine as unknown as { spineItems: SpineItem[] }
      for (const item of spine.spineItems) {
        await item.load(book.load.bind(book))
        found.current.push(...item.find(query.trim()).map((m) => m.cfi))
        item.unload()
      }
      foundIndex.current = 0
      return gotoFound()
    },
    findStep: async (dir) => {
      const n = found.current.length
      if (n) foundIndex.current = (foundIndex.current + dir + n) % n
      return gotoFound()
    },
    clearFind: () => {
      clearFoundMark()
      found.current = []
    }
  }))

  return (
    <div className="epub-view">
      <div ref={hostRef} className="epub-host" />
      {bookmarkHere && <div className="epub-ribbon" title={t('Trang này có dấu trang')} aria-hidden="true" />}
      <div className="epub-bar">
        <button className="icon-btn" title={t('Trang trước (←)')} onClick={prev}>
          ‹
        </button>
        <span className="epub-progress" title={progress.chapter}>
          {progress.chapter}
          {progress.percent !== null && <b>{progress.percent}%</b>}
        </span>
        <button
          className={`icon-btn epub-bookmark-btn ${bookmarkHere ? 'on' : ''}`}
          title={bookmarkHere ? t('Bỏ dấu trang ở đây (Ctrl+D)') : t('Đánh dấu trang này (Ctrl+D)')}
          aria-pressed={!!bookmarkHere}
          onClick={() => void toggleBookmark()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={bookmarkHere ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <path d="M6 3h12v18l-6-4.5L6 21z" />
          </svg>
        </button>
        <button className="icon-btn" title={t('Trang sau (→)')} onClick={next}>
          ›
        </button>
      </div>
    </div>
  )
})

export default EpubView
