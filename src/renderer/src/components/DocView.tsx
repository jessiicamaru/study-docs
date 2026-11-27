import { useCallback, useEffect, useRef, useState } from 'react'
import type { Annotation, DocEntry, DocMeta, HighlightColor, TranslateResult } from '../../../shared/types'
import { errorMessage, loadLocal, saveLocal, STATUSES } from '../lib/docs'
import type { ScrollTarget } from '../App'
import HtmlView from './HtmlView'
import MarkdownView from './MarkdownView'
import RawEditor from './RawEditor'
import MarkdownEditor from './MarkdownEditor'
import { takeWritingRequest } from '../lib/write-request'
import { imageSource } from '../lib/paste-image'
import { currentUi } from '../lib/settings'
import EpubView from './EpubView'
import PdfView from './PdfView'
import ArticleView from './ArticleView'
import ImageView from './ImageView'
import SheetView from './SheetView'
import FindBar from './FindBar'
import { HighlightToolbar, NotePopover, NotesPanel, TranslatePopover } from './Annotations'
import { newAnnotationId, type OutlineItem, type ReaderHandle, type ScreenRect, type TextSelection } from './reader'
import { t } from '../../../shared/i18n'
import { normalize } from '../../../shared/text'
import { confirmDialog } from '../lib/ask'
import { colorHex, formatShortDate, type CalDocRef } from '../../../shared/calendar'
import { CALENDAR_CHANGED } from './CalendarView'

/** view = read; edit = change text in place; raw = source editor next to a preview. */
/** view: reading; edit: text edits on the page; raw: source; write: the Markdown editor. */
type Mode = 'view' | 'edit' | 'raw' | 'write'

interface Props {
  doc: DocEntry
  meta: DocMeta
  allDocs: DocEntry[]
  /** Every tag of the workspace and how many documents have it (to pick one again). */
  allTags: TagCount[]
  scrollTarget: ScrollTarget
  onUpdateMeta: (patch: Partial<Pick<DocMeta, 'tags' | 'status'>>) => void
  onOpenDoc: (path: string, hash?: string) => void
  onError: (err: unknown) => void
  onInfo: (text: string) => void
  /** Tells the app whether there are unsaved changes (to warn before leaving). */
  onDirtyChange: (dirty: boolean) => void
  /** App shortcuts typed while an HTML document has the keyboard focus. */
  onShortcut: (key: string) => void
  history: { canBack: boolean; canForward: boolean }
  onHistory: (direction: 'back' | 'forward') => void
  /** Name of the workspace folder this doc is in; null when the workspace has only one folder. */
  rootName: string | null
  /** Highlights and notes of this document. */
  annotations: Annotation[]
  onAnnotationsChange: (items: Annotation[]) => void
  /** Note about the whole document (Markdown). */
  docNote: string
  onDocNoteChange: (text: string) => void
  /** A class chip was clicked: show it in the calendar. */
  onOpenCalendar: (ref: CalDocRef) => void
}

const positionKey = (path: string): string => `pos:${path}`

export default function DocView(props: Props) {
  const { doc, meta, allDocs, scrollTarget, onUpdateMeta, onOpenDoc, onError, onInfo, onDirtyChange, rootName } = props
  const [mode, setMode] = useState<Mode>('view')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // File version the text edit started from; the save is refused if the file changed since.
  const [editMtime, setEditMtime] = useState<number | null>(null)
  /** Modified time of the file after our own last save. */
  const savedMtime = useRef(0)
  const [rawDraft, setRawDraft] = useState<string | null>(null)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [activeHeading, setActiveHeading] = useState(-1)
  const [outlineOpen, setOutlineOpen] = useState(() => loadLocal('outline-open', true))
  const [exporting, setExporting] = useState(false)
  // HTML edit mode: the link being typed (Ctrl+K or the toolbar), null when closed.
  const [linkInput, setLinkInput] = useState<string | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const readerRef = useRef<ReaderHandle>(null)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [noteEditor, setNoteEditor] = useState<{ id: string; rect: ScreenRect } | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [panelTab, setPanelTab] = useState<'outline' | 'notes'>(() => loadLocal('panel-tab', 'outline'))
  const { annotations, onAnnotationsChange } = props
  /** md and html can be edited and exported; pdf and epub are read-only. */
  const canEdit = doc.kind === 'md' || doc.kind === 'html'

  const updateDirty = useCallback(
    (value: boolean) => {
      setDirty(value)
      onDirtyChange(value)
    },
    [onDirtyChange]
  )

  // ---------- text editing ----------

  const startEdit = (): void => {
    setEditMtime(Math.max(doc.mtime, savedMtime.current))
    setMode('edit')
  }
  // A note just created opens ready for writing.
  useEffect(() => {
    if (!takeWritingRequest(doc.path)) return
    if (doc.kind === 'md') setMode('write')
    else if (doc.kind === 'html') {
      setEditMtime(Math.max(doc.mtime, savedMtime.current))
      setMode('edit')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path])
  const stopEdit = useCallback((): void => {
    setMode('view')
    setEditMtime(null)
    updateDirty(false)
  }, [updateDirty])

  const cancelEdit = useCallback(async (): Promise<void> => {
    if (dirty && !(await confirmDialog({ message: t('Bỏ các thay đổi chưa lưu?'), ok: t('Bỏ thay đổi'), cancel: t('Tiếp tục sửa'), danger: true }))) return
    stopEdit()
  }, [dirty, stopEdit])

  const saveEdit = useCallback(async (): Promise<void> => {
    if (mode !== 'edit' || editMtime === null || saving) return
    setSaving(true)
    try {
      const change = await readerRef.current?.collectChanges()
      // The file's new version: editing again right away starts from it (the library may not have
      // seen the change yet).
      if (change?.kind === 'html' && change.edits.length) savedMtime.current = await window.api.saveHtmlEdits(doc.path, change.edits, editMtime)
      stopEdit()
    } catch (err) {
      onError(err)
      // If the file changed under us, there is nothing safe to retry: reload it.
      if (String(err).includes(t('thay đổi bên ngoài'))) stopEdit()
    } finally {
      setSaving(false)
    }
  }, [mode, editMtime, saving, doc.path, stopEdit, onError])

  // Ctrl+S saves and Esc cancels while editing text (the HTML page sends these itself).
  useEffect(() => {
    if (mode !== 'edit') return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveEdit()
      }
      if (e.key === 'Escape') cancelEdit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, saveEdit, cancelEdit])

  // ---------- find (Ctrl+F) ----------

  const [findOpen, setFindOpen] = useState(false)
  const [findFocus, setFindFocus] = useState(0)
  useEffect(() => {
    // App sends this for Ctrl+F (typed in the app, an HTML page or a book).
    // Reading, or editing an HTML page (Markdown has its own find while writing).
    const open = (): void => {
      if (mode !== 'view' && !(mode === 'edit' && doc.kind === 'html')) return
      setFindOpen(true)
      setFindFocus((n) => n + 1)
    }
    window.addEventListener('studydocs:find', open)
    return () => window.removeEventListener('studydocs:find', open)
  }, [mode, doc.kind])
  // The page is reloaded when switching between reading and editing: its matches are gone.
  useEffect(() => setFindOpen(false), [mode])

  // ---------- outline + reading position ----------

  // The document finished rendering: go back to where you stopped reading last time
  // (unless you followed a link to a specific #section).
  const onReady = useCallback(() => {
    if (scrollTarget.hash || mode !== 'view') return
    const y = loadLocal<number>(positionKey(doc.path), 0)
    if (y > 0) readerRef.current?.restoreScroll(y)
  }, [doc.path, scrollTarget.hash, mode])

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onReading = useCallback(
    (y: number, active: number) => {
      setActiveHeading(active)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => saveLocal(positionKey(doc.path), y), 300)
    },
    [doc.path]
  )

  const toggleOutline = (): void => {
    setOutlineOpen(!outlineOpen)
    saveLocal('outline-open', !outlineOpen)
  }

  // ---------- highlights + notes ----------

  // Draw the highlights whenever they change, and again after text editing ends.
  useEffect(() => {
    if (mode !== 'edit') readerRef.current?.setAnnotations(annotations)
  }, [annotations, mode])

  const saveAnnotation = useCallback(
    async (a: Annotation): Promise<boolean> => {
      try {
        onAnnotationsChange(await window.api.saveAnnotation(doc.path, a))
        return true
      } catch (err) {
        onError(err)
        return false
      }
    },
    [doc.path, onAnnotationsChange, onError]
  )

  /** Turns the current selection into a highlight; optionally opens its note right away. */
  const createHighlight = async (color: HighlightColor, openNote: boolean, from: TextSelection | null = selection, note = ''): Promise<void> => {
    const sel = from
    if (!sel) return
    const now = Date.now()
    const a: Annotation = {
      id: newAnnotationId(),
      color,
      note,
      quote: sel.quote,
      prefix: sel.prefix,
      suffix: sel.suffix,
      ...(sel.cfi ? { cfi: sel.cfi } : {}),
      ...(sel.page ? { page: sel.page } : {}),
      created: now,
      updated: now
    }
    const rect = sel.rect
    setSelection(null)
    readerRef.current?.clearSelection()
    if ((await saveAnnotation(a)) && openNote) setNoteEditor({ id: a.id, rect })
  }

  // ---------- translating the selected text ----------
  const [translation, setTranslation] = useState<{ sel: TextSelection; loading: boolean; result: TranslateResult | null; error: string | null } | null>(null)
  const translate = async (sel: TextSelection, to: 'vi' | 'en'): Promise<void> => {
    setTranslation({ sel, loading: true, result: null, error: null })
    saveLocal('translate-to', to)
    try {
      const result = await window.api.translate(sel.quote, to)
      setTranslation((cur) => (cur && cur.sel === sel ? { sel, loading: false, result, error: null } : cur))
    } catch (err) {
      setTranslation((cur) => (cur && cur.sel === sel ? { sel, loading: false, result: null, error: errorMessage(err) } : cur))
    }
  }
  const closeTranslation = useCallback(() => setTranslation(null), [])

  const deleteAnnotation = async (id: string): Promise<void> => {
    setNoteEditor(null)
    try {
      onAnnotationsChange(await window.api.deleteAnnotation(doc.path, id))
    } catch (err) {
      onError(err)
    }
  }

  const showPanelTab = (tab: 'outline' | 'notes'): void => {
    setPanelTab(tab)
    saveLocal('panel-tab', tab)
  }
  const editedAnnotation = noteEditor ? annotations.find((a) => a.id === noteEditor.id) : undefined

  // ---------- export ----------

  const exportPdf = async (withNotes: boolean): Promise<void> => {
    if (dirty) return onError(new Error(t('Hãy lưu thay đổi trước khi xuất PDF.')))
    setExporting(true)
    try {
      const file = await window.api.exportPdf(doc.path, withNotes)
      if (file) onInfo(t('Đã xuất PDF: {0}', { 0: file }))
    } catch (err) {
      onError(err)
    } finally {
      setExporting(false)
    }
  }

  // ---------- layout ----------

  const readerProps = {
    ref: readerRef,
    onOutline: setOutline,
    onReading: (y: number, active: number) => {
      setSelection(null) // the toolbar would float away from the text while scrolling
      onReading(y, active)
    },
    onReady,
    onSelection: setSelection,
    onAnnotationClick: (id: string, rect: ScreenRect) => {
      setSelection(null)
      setNoteEditor({ id, rect })
    },
    onAnchored: setMissing
  }
  const preview =
    doc.kind === 'pdf' ? (
      <PdfView {...readerProps} doc={doc} onError={onError} />
    ) : doc.kind === 'docx' || doc.kind === 'txt' ? (
      <ArticleView {...readerProps} doc={doc} onError={onError} />
    ) : doc.kind === 'image' ? (
      <ImageView {...readerProps} doc={doc} onError={onError} />
    ) : doc.kind === 'sheet' ? (
      <SheetView doc={doc} onError={onError} onInfo={props.onInfo} onDirty={updateDirty} />
    ) : doc.kind === 'epub' || doc.kind === 'mobi' ? (
      <EpubView {...readerProps} doc={doc} onError={onError} />
    ) : doc.kind === 'html' ? (
      <HtmlView
        {...readerProps}
        doc={doc}
        hash={scrollTarget.hash}
        editMtime={mode === 'edit' ? editMtime : null}
        onDirty={updateDirty}
        onSaveShortcut={() => void saveEdit()}
        onCancelShortcut={cancelEdit}
        onShortcut={props.onShortcut}
        onLinkRequest={() => setLinkInput('https://')}
        onError={onError}
      />
    ) : (
      <MarkdownView
        {...readerProps}
        doc={doc}
        allDocs={allDocs}
        scrollTarget={scrollTarget}
        sourceOverride={mode === 'raw' ? rawDraft : null}
        onOpenDoc={onOpenDoc}
        onError={onError}
      />
    )

  const showOutline = mode === 'view' && outlineOpen

  return (
    <div className="doc-view">
      <header className="doc-header">
        <div className="doc-title-row">
          <div className="history-buttons">
            <button className="icon-btn" title={t('Quay lại (Alt+←)')} disabled={!props.history.canBack} onClick={() => props.onHistory('back')}>
              ‹
            </button>
            <button className="icon-btn" title={t('Tiến tới (Alt+→)')} disabled={!props.history.canForward} onClick={() => props.onHistory('forward')}>
              ›
            </button>
          </div>
          <div className="doc-heading">
            <h1 title={doc.title}>{doc.title}</h1>
            <div className="doc-where">
              {rootName && (
                <span className="doc-root" title={t('Thư mục trong workspace')}>
                  {rootName}
                </span>
              )}
              <span className="doc-path">{doc.rel}</span>
              <ClassChips docId={doc.path} onOpen={props.onOpenCalendar} />
            </div>
          </div>
        </div>

        {mode === 'edit' ? (
          <div className="doc-controls edit-bar">
            {doc.kind === 'html' ? (
              <div className="html-format" role="toolbar" aria-label={t('Định dạng')}>
                <select
                  className="block-type"
                  aria-label={t('Kiểu đoạn')}
                  title={t('Kiểu của đoạn vừa thêm (Enter để thêm đoạn)')}
                  value=""
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (e.target.value) readerRef.current?.setBlockType?.(e.target.value)
                    e.target.value = ''
                  }}
                >
                  <option value="">{t('Kiểu đoạn…')}</option>
                  <option value="p">{t('Đoạn văn')}</option>
                  <option value="h2">{t('Tiêu đề mục')}</option>
                  <option value="h3">{t('Tiêu đề nhỏ')}</option>
                  <option value="ul">{t('Danh sách')}</option>
                  <option value="ol">{t('Danh sách đánh số')}</option>
                </select>
                {(
                  [
                    ['B', 'bold', t('Đậm (Ctrl+B)')],
                    ['I', 'italic', t('Nghiêng (Ctrl+I)')],
                    ['U', 'underline', t('Gạch chân (Ctrl+U)')],
                    ['S', 'strikeThrough', t('Gạch ngang')]
                  ] as const
                ).map(([label, cmd, title]) => (
                  <button key={cmd} className={`md-tool fmt-${cmd}`} title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={() => readerRef.current?.format?.(cmd)}>
                    {label}
                  </button>
                ))}
                <button className="md-tool" title={t('Link (Ctrl+K)')} onMouseDown={(e) => e.preventDefault()} onClick={() => setLinkInput('https://')}>
                  {t('Link')}
                </button>
                <button className="md-tool" title={t('Chèn ảnh (hoặc dán ảnh bằng Ctrl+V)')} onMouseDown={(e) => e.preventDefault()} onClick={() => imageInputRef.current?.click()}>
                  {t('Ảnh')}
                </button>
                <button className="md-tool" title={t('Chèn bảng sau đoạn đang sửa (Tab chuyển ô)')} onMouseDown={(e) => e.preventDefault()} onClick={() => readerRef.current?.insertTable?.()}>
                  {t('Bảng')}
                </button>
                <button className="md-tool" title={t('Bỏ định dạng')} onMouseDown={(e) => e.preventDefault()} onClick={() => readerRef.current?.format?.('removeFormat')}>
                  T̸
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    imageSource(doc.path, file, currentUi().pasteImages)
                      .then((src) => src && readerRef.current?.insertImage?.(src))
                      .catch(onError)
                  }}
                />
                {linkInput !== null && (
                  <form
                    className="link-form"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const url = linkInput.trim()
                      readerRef.current?.format?.(url && url !== 'https://' ? 'createLink' : 'unlink', url)
                      setLinkInput(null)
                    }}
                  >
                    <input
                      autoFocus
                      value={linkInput}
                      aria-label={t('Địa chỉ link')}
                      onChange={(e) => setLinkInput(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Escape') setLinkInput(null)
                      }}
                    />
                    <button className="btn small">{t('Gắn link')}</button>
                  </form>
                )}
                <span className="edit-hint">{t('Enter: đoạn mới · Shift+Enter: xuống dòng · bố cục khác thì dùng Raw.')}</span>
              </div>
            ) : (
              <span className="edit-hint">
                <b>{t('Đang sửa chữ.')}</b>{' '}{t('Bấm vào đoạn văn (hoặc chữ trong sơ đồ) để sửa; Enter và định dạng bị tắt. Muốn đổi bố cục thì dùng Raw.')}</span>
            )}
            <div className="spacer" />
            {dirty && <span className="dirty-dot" title={t('Chưa lưu')} />}
            <button className="btn small" onClick={cancelEdit}>{t('Huỷ (Esc)')}</button>
            <button className="btn primary small" disabled={saving} onClick={() => void saveEdit()}>
              {saving ? t('Đang lưu…') : t('Lưu (Ctrl+S)')}
            </button>
          </div>
        ) : (
          <div className="doc-controls">
            <div className="segmented" role="group" aria-label={t('Trạng thái học')}>
              {STATUSES.map((s) => (
                <button
                  key={s.id}
                  className={`status-${s.id} ${meta.status === s.id ? 'active' : ''}`}
                  onClick={() => onUpdateMeta({ status: s.id })}
                >
                  {t(s.label)}
                </button>
              ))}
            </div>
            <TagEditor tags={meta.tags} allTags={props.allTags} onChange={(tags) => onUpdateMeta({ tags })} />
            <div className="spacer" />
            {doc.kind !== 'sheet' && <button className={`btn ${showOutline ? 'active' : ''}`} onClick={toggleOutline} disabled={mode !== 'view'} title={t('Hiện/ẩn mục lục và ghi chú')}>{t('Mục lục')}{annotations.length > 0 && t(' · {0} ghi chú', { 0: annotations.length })}
            </button>}
            {doc.kind === 'md' && (
              <button className="btn primary-soft" onClick={() => setMode('write')} disabled={mode === 'raw'} title={t('Viết và định dạng bài (Markdown, xem trước ngay khi gõ)')}>
                {t('Viết')}
              </button>
            )}
            {canEdit && (
              <>
                {doc.kind === 'html' && (
                  <button className="btn" onClick={startEdit} disabled={mode === 'raw'} title={t('Sửa chữ ngay trên bài')}>{t('Sửa chữ')}</button>
                )}
                <button
                  className={`btn ${mode === 'raw' ? 'active' : ''}`}
                  onClick={() => (mode === 'raw' ? setMode('view') : setMode('raw'))}
                  title={t('Mở mã nguồn để sửa bố cục, sơ đồ...')}
                >
                  Raw
                </button>
              </>
            )}
            <MoreMenu doc={doc} onError={onError} onExport={canEdit ? exportPdf : null} hasNotes={annotations.length > 0 || !!props.docNote} exporting={exporting} />
          </div>
        )}
      </header>

      {mode === 'write' ? (
        <div className="doc-body">
          <div className="pane">
            <MarkdownEditor doc={doc} onClose={() => setMode('view')} onDirty={updateDirty} onError={onError} />
          </div>
        </div>
      ) : mode === 'raw' ? (
        <div className="doc-body split">
          <div className="pane">{preview}</div>
          <div className="pane">
            <RawEditor doc={doc} onClose={() => setMode('view')} onDirty={updateDirty} onDraft={setRawDraft} onError={onError} />
          </div>
        </div>
      ) : (
        <div className={`doc-body ${showOutline && doc.kind !== 'sheet' ? 'with-outline' : ''}`}>
          <div className="pane">{preview}</div>
          {showOutline && doc.kind !== 'sheet' && (
            <nav className="outline" aria-label={t('Mục lục và ghi chú')}>
              <div className="panel-tabs" role="tablist">
                <button role="tab" aria-selected={panelTab === 'outline'} className={panelTab === 'outline' ? 'active' : ''} onClick={() => showPanelTab('outline')}>{t('Mục lục')}</button>
                <button role="tab" aria-selected={panelTab === 'notes'} className={panelTab === 'notes' ? 'active' : ''} onClick={() => showPanelTab('notes')}>{t('Ghi chú')}{annotations.length > 0 && ` (${annotations.length})`}
                </button>
              </div>
              {panelTab === 'notes' && (
                <NotesPanel
                  annotations={annotations}
                  missing={missing}
                  onGoto={(a) => readerRef.current?.gotoAnnotation(a.id)}
                  onEdit={(a, rect) => setNoteEditor({ id: a.id, rect })}
                  docNote={props.docNote}
                  onSaveDocNote={async (text) => {
                    try {
                      props.onDocNoteChange(await window.api.saveDocNote(doc.path, text))
                    } catch (err) {
                      onError(err)
                      throw err
                    }
                  }}
                />
              )}
              {panelTab === 'outline' && outline.length === 0 && <div className="empty">{t('Bài này không có tiêu đề nào.')}</div>}
              {panelTab === 'outline' && outline.map((item, i) => (
                <button
                  key={i}
                  className={`outline-item level-${item.level} ${i === activeHeading ? 'active' : ''}`}
                  onClick={() => readerRef.current?.gotoHeading(i)}
                  title={item.text}
                >
                  {item.text}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}

      {findOpen && doc.kind !== 'sheet' && (mode === 'view' || (mode === 'edit' && doc.kind === 'html')) && <FindBar reader={readerRef} focusKey={findFocus} onClose={() => setFindOpen(false)} />}
      {selection && mode === 'view' && !translation && (
        <HighlightToolbar
          rect={selection.rect}
          onPick={(c) => void createHighlight(c, false)}
          onNote={() => void createHighlight('yellow', true)}
          onTranslate={() => void translate(selection, loadLocal<'vi' | 'en'>('translate-to', 'vi'))}
        />
      )}
      {translation && (
        <TranslatePopover
          rect={translation.sel.rect}
          quote={translation.sel.quote}
          loading={translation.loading}
          result={translation.result}
          error={translation.error}
          onOtherWay={() => void translate(translation.sel, translation.result?.to === 'en' ? 'vi' : 'en')}
          onKeep={() => {
            const { sel, result } = translation
            setTranslation(null)
            if (result) void createHighlight('blue', false, sel, result.text).then(() => onInfo(t('Đã thêm bản dịch vào ghi chú.')))
          }}
          onClose={closeTranslation}
        />
      )}
      {editedAnnotation && noteEditor && (
        <NotePopover
          key={editedAnnotation.id}
          annotation={editedAnnotation}
          rect={noteEditor.rect}
          missing={missing.includes(editedAnnotation.id)}
          onSave={(patch) => void saveAnnotation({ ...editedAnnotation, ...patch })}
          onDelete={() => void deleteAnnotation(editedAnnotation.id)}
          onClose={() => setNoteEditor(null)}
        />
      )}
    </div>
  )
}

interface MoreMenuProps {
  doc: DocEntry
  onError: (err: unknown) => void
  /** null when the document can't be exported (PDF, EPUB). */
  onExport: ((withNotes: boolean) => Promise<void>) | null
  hasNotes: boolean
  exporting: boolean
}

function MoreMenu({ doc, onError, onExport, hasNotes, exporting }: MoreMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="more" ref={ref}>
      <button className="btn" aria-label={t('Thêm')} aria-expanded={open} onClick={() => setOpen(!open)}>
        {exporting ? t('Đang xuất PDF…') : '⋯'}
      </button>
      {open && (
        <div className="popover menu">
          {onExport && (
            <button disabled={exporting} onClick={() => (setOpen(false), void onExport(false))}>{t('Xuất PDF…')}</button>
          )}
          {onExport && hasNotes && (
            <button disabled={exporting} onClick={() => (setOpen(false), void onExport(true))}>{t('Xuất PDF kèm highlight và ghi chú…')}</button>
          )}
          <button onClick={() => (setOpen(false), window.api.openPath(doc.path).catch(onError))}>{t('Mở bằng app mặc định')}</button>
          <button onClick={() => (setOpen(false), window.api.revealInFolder(doc.path).catch(onError))}>{t('Hiện trong thư mục')}</button>
        </div>
      )}
    </div>
  )
}

/** A tag of the workspace and how many documents have it. */
export interface TagCount {
  tag: string
  count: number
}

/**
 * The tags you may pick for a typed text: those containing it (accents optional), the ones
 * starting with it first, then the most used. With nothing typed, the most used tags.
 */
export function suggestTags(all: TagCount[], typed: string, taken: string[], limit = 8): TagCount[] {
  const q = normalize(typed.trim().replace(/^#/, ''))
  return all
    .filter((x) => !taken.includes(x.tag) && (!q || normalize(x.tag).includes(q)))
    .map((x) => ({ x, starts: q ? normalize(x.tag).startsWith(q) : true }))
    .sort((p, r) => Number(r.starts) - Number(p.starts) || r.x.count - p.x.count || p.x.tag.localeCompare(r.x.tag, 'vi'))
    .slice(0, limit)
    .map((p) => p.x)
}

function TagEditor({ tags, allTags, onChange }: { tags: string[]; allTags: TagCount[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  // The suggestion picked with the arrow keys (-1: none, Enter adds what was typed).
  const [active, setActive] = useState(-1)
  const typed = draft.trim().replace(/^#/, '')
  const suggestions = open ? suggestTags(allTags, draft, tags) : []
  // "New tag" when what was typed is not a tag yet.
  const isNew = !!typed && !tags.includes(typed) && !allTags.some((x) => x.tag === typed)
  const choices: { tag: string; count: number | null }[] = [...suggestions, ...(isNew ? [{ tag: typed, count: null }] : [])]
  const addTag = (tag: string): void => {
    const clean = tag.trim().replace(/^#/, '')
    if (clean && !tags.includes(clean)) onChange([...tags, clean])
    setDraft('')
    setActive(-1)
  }
  /** The typed text with the part matching it in bold. */
  const marked = (tag: string): React.ReactNode => {
    const q = normalize(typed)
    const at = q ? normalize(tag).indexOf(q) : -1
    if (at < 0) return tag
    return (
      <>
        {tag.slice(0, at)}
        <b>{tag.slice(at, at + typed.length)}</b>
        {tag.slice(at + typed.length)}
      </>
    )
  }
  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          #{tag}
          <button aria-label={t('Xoá tag {0}', { 0: tag })} onClick={() => onChange(tags.filter((x) => x !== tag))}>
            ×
          </button>
        </span>
      ))}
      <span className="tag-input">
        <input
          value={draft}
          placeholder="+ tag"
          role="combobox"
          aria-expanded={open && choices.length > 0}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setDraft(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
              if (!choices.length) return
              // Down from the last one (or up from the first) goes back to what was typed.
              const last = choices.length - 1
              setActive((i) => (e.key === 'ArrowDown' ? (i >= last ? -1 : i + 1) : i <= -1 ? last : i - 1))
              return
            }
            if (e.key === 'Escape' && open && choices.length) {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
              setActive(-1)
              return
            }
            if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && active >= 0)) {
              e.preventDefault()
              addTag(active >= 0 && choices[active] ? choices[active].tag : draft)
            }
            if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1))
          }}
          onBlur={() => {
            setOpen(false)
            if (typed) addTag(draft)
          }}
        />
        {open && choices.length > 0 && (
          <div className="tag-suggest" role="listbox">
            {!typed && <div className="tag-suggest-title">{t('Tag đã có')}</div>}
            {choices.map((c, i) => (
              <button
                key={(c.count === null ? 'new:' : '') + c.tag}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`tag-suggest-item${i === active ? ' active' : ''}${c.count === null ? ' new' : ''}`}
                // Keep the focus in the box: picking a tag goes on typing the next one.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => addTag(c.tag)}
              >
                {c.count === null ? (
                  <span className="tag-suggest-name">{t('Tạo tag mới')} <b>#{c.tag}</b></span>
                ) : (
                  <>
                    <span className="tag-suggest-name">#{marked(c.tag)}</span>
                    <span className="tag-suggest-count" title={t('{0} tài liệu có tag này', { 0: c.count })}>
                      {c.count}
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  )
}

/** The classes (or courses) of the calendar this document is linked to. */
function ClassChips({ docId, onOpen }: { docId: string; onOpen: (ref: CalDocRef) => void }) {
  const [refs, setRefs] = useState<CalDocRef[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.api
        .calendarForDoc(docId)
        .then((r) => alive && setRefs(r))
        .catch(() => {})
    }
    load()
    window.addEventListener(CALENDAR_CHANGED, load)
    return () => {
      alive = false
      window.removeEventListener(CALENDAR_CHANGED, load)
    }
  }, [docId])
  if (!refs.length) return null
  return (
    <span className="class-chips">
      {refs.slice(0, 4).map((r) => (
        <button
          key={`${r.uid}|${r.rid ?? ''}`}
          className="class-chip"
          style={{ '--chip': colorHex(r.color) ?? 'var(--accent)' } as React.CSSProperties}
          title={[
            r.rid ? t('Tài liệu của buổi học này. Bấm để xem trong lịch.') : t('Tài liệu của cả môn. Bấm để xem buổi tới trong lịch.'),
            r.folder ? t('Gắn qua thư mục "{0}".', { 0: r.folder }) : ''
          ]
            .filter(Boolean)
            .join('\n')}
          onClick={() => onOpen(r)}
        >
          {r.summary} · {r.rid ? formatShortDate(r.start) : t('cả môn')}
        </button>
      ))}
      {refs.length > 4 && <span className="class-chip more">+{refs.length - 4}</span>}
    </span>
  )
}
