import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { DocEntry, HtmlBlockEdit } from '../../../shared/types'
import { docUrl } from '../lib/docs'
import type { FindResult, ReaderCallbacks, ReaderHandle, ScreenRect } from './reader'
import { t } from '../../../shared/i18n'
import { imageSource } from '../lib/paste-image'
import { currentUi } from '../lib/settings'

interface Props extends ReaderCallbacks {
  doc: DocEntry
  hash: string
  /** When set, the page is shown in text-edit mode, pinned to this file version. */
  editMtime: number | null
  onDirty: (dirty: boolean) => void
  onSaveShortcut: () => void
  onCancelShortcut: () => void
  /** App shortcuts typed while the page has the keyboard focus. */
  onShortcut: (key: string) => void
  /** Edit mode: Ctrl+K in the page asks for a link. */
  onLinkRequest?: () => void
  onError?: (err: unknown) => void
}

/**
 * HTML documents run in a sandboxed iframe without "allow-same-origin": the page can use
 * its own CSS/JS but cannot touch the app or your files. ?v= reloads it when the file
 * changes; #hash jumps to a section when you followed a link like other.html#part.
 *
 * The app talks to the page only through postMessage, with a helper script the doc://
 * protocol appends to the page (src/main/view-helper.ts, or html-edit.ts in edit mode).
 */
const HtmlView = forwardRef<ReaderHandle, Props>(function HtmlView(props, ref) {
  const { doc, hash, editMtime } = props
  const frameRef = useRef<HTMLIFrameElement>(null)
  const pending = useRef(new Map<number, (edits: HtmlBlockEdit[]) => void>())
  // Latest callbacks, so the message listener below is registered only once.
  const cb = useRef(props)
  cb.current = props

  const post = (msg: object): void => frameRef.current?.contentWindow?.postMessage({ source: 'studydocs-app', ...msg }, '*')
  /** Rectangles from inside the page are relative to the iframe; convert to window coordinates. */
  const toScreen = (r: ScreenRect): ScreenRect => {
    const f = frameRef.current!.getBoundingClientRect()
    return { left: r.left + f.left, right: r.right + f.left, top: r.top + f.top, bottom: r.bottom + f.top }
  }
  // Highlights to draw once the page is ready (the page may load after they are set).
  const annotations = useRef<object[]>([])
  /** Find requests: the page answers with a "find-result" message. */
  const findReply = useRef<((r: FindResult) => void) | null>(null)
  const askPage = (msg: object): Promise<FindResult> =>
    new Promise((resolve) => {
      findReply.current = resolve
      post(msg)
      setTimeout(() => {
        if (findReply.current === resolve) {
          findReply.current = null
          resolve({ index: 0, total: 0 }) // page not ready
        }
      }, 2000)
    })

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow || e.data?.source !== 'studydocs') return
      const msg = e.data
      const p = cb.current
      switch (msg.type) {
        case 'outline':
          p.onOutline(msg.items)
          break
        case 'scroll':
          p.onReading(msg.y, msg.active)
          break
        case 'ready':
          post({ type: 'annotations', items: annotations.current })
          p.onReady()
          break
        case 'selection':
          p.onSelection(msg.info ? { ...msg.info, rect: toScreen(msg.info.rect) } : null)
          break
        case 'annotation-click':
          p.onAnnotationClick(msg.id, toScreen(msg.rect))
          break
        case 'anchored':
          p.onAnchored(msg.missing)
          break
        case 'find-result':
          findReply.current?.({ index: msg.index, total: msg.total })
          findReply.current = null
          break
        case 'key':
          // Take the focus back from the page first, and act on the next turn: the shortcut
          // may switch documents, which removes this iframe.
          frameRef.current?.blur()
          window.focus()
          setTimeout(() => p.onShortcut(msg.key), 0)
          break
        case 'dirty':
          p.onDirty(msg.count > 0)
          break
        case 'save':
          p.onSaveShortcut()
          break
        case 'cancel':
          p.onCancelShortcut()
          break
        case 'edits':
          pending.current.get(msg.id)?.(msg.edits)
          pending.current.delete(msg.id)
          break
        case 'link':
          p.onLinkRequest?.()
          break
        case 'notice':
          if (typeof msg.text === 'string') p.onError?.(new Error(msg.text))
          break
        case 'block-refused':
          p.onError?.(new Error(t('Đoạn có sẵn trong trang chỉ đổi được qua lại giữa đoạn văn, tiêu đề và trích dẫn. Muốn thành danh sách thì đổi trong Raw.')))
          break
        case 'image':
          // A picture pasted in the page: shrunk and embedded (or saved in assets/) here, then sent back.
          if (!(msg.file instanceof Blob)) break
          imageSource(p.doc.path, msg.file, currentUi().pasteImages)
            .then((src) => post({ type: 'image-src', id: msg.id, src }))
            .catch((err) => {
              post({ type: 'image-src', id: msg.id, src: null })
              p.onError?.(err)
            })
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The edit-mode page has no outline helper; clear the panel while editing.
  useEffect(() => {
    if (editMtime !== null) cb.current.onOutline([])
  }, [editMtime])

  useImperativeHandle(ref, () => ({
    gotoHeading: (index) => post({ type: 'goto', index }),
    restoreScroll: (y) => post({ type: 'restore', y }),
    setAnnotations: (items) => {
      annotations.current = items
      post({ type: 'annotations', items })
    },
    gotoAnnotation: (id) => post({ type: 'goto-annotation', id }),
    clearSelection: () => post({ type: 'clear-selection' }),
    find: (query) => askPage({ type: 'find', query }),
    findStep: (dir) => askPage({ type: 'find-step', dir }),
    clearFind: () => post({ type: 'find-clear' }),
    format: (cmd, value) => post({ type: 'format', cmd, value }),
    insertImage: (src) => post({ type: 'insert-image', src }),
    insertDivider: () => {
      frameRef.current?.focus()
      post({ type: 'insert-hr' })
    },
    insertTable: () => {
      frameRef.current?.focus()
      post({ type: 'insert-table' })
    },
    setBlockType: (tag) => {
      // The paragraph-type menu took the focus: give it back to the page, where the caret is.
      frameRef.current?.focus()
      post({ type: 'block', tag })
      // Once the menu has finished closing too (it can take the focus back for a moment).
      setTimeout(() => frameRef.current?.focus(), 0)
    },
    collectChanges: () =>
      new Promise((resolve, reject) => {
        const win = frameRef.current?.contentWindow
        if (!win) return reject(new Error(t('Trang chưa tải xong')))
        const id = Date.now() + Math.random()
        pending.current.set(id, (edits) => resolve({ kind: 'html', edits }))
        post({ type: 'collect', id })
        setTimeout(() => {
          if (pending.current.delete(id)) reject(new Error(t('Trang không phản hồi, chưa lưu được.')))
        }, 3000)
      })
  }))

  const fragment = hash ? `#${encodeURIComponent(hash)}` : ''
  const src = editMtime !== null ? `${docUrl(doc.path)}?edit=1&v=${editMtime}` : `${docUrl(doc.path)}?v=${doc.mtime}${fragment}`

  return (
    <iframe
      ref={frameRef}
      className={`html-frame ${editMtime !== null ? 'editing' : ''}`}
      src={src}
      sandbox="allow-scripts allow-popups"
      title={doc.title}
    />
  )
})

export default HtmlView
