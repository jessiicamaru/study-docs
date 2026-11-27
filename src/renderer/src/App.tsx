import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_UI, type Annotation, type AppInfo, type DocEntry, type DocMeta, type LibrarySnapshot, type SearchStatus, type StudyStatus, type UiSettings } from '../../shared/types'
import { errorMessage, kindLabel, loadLocal, metaOf, normalize, saveLocal } from './lib/docs'
import { applyUiSettings, timeAgo } from './lib/ui'
import { moveReadingPositions, pruneReadingPositions } from './lib/positions'
import Sidebar, { type FileActions, type SearchHit } from './components/Sidebar'
import NameDialog, { type NameDialogOptions } from './components/NameDialog'
import DocView from './components/DocView'
import SettingsDialog, { type SettingsTab } from './components/SettingsDialog'
import { setLanguage, t } from '../../shared/i18n'
import { ask, confirmDialog } from './lib/ask'
import AskHost from './components/AskHost'
import { setCurrentUi } from './lib/settings'
import DocTabs from './components/DocTabs'
import { PanelIcon, SearchIcon } from './components/Sidebar'
import { requestWriting } from './lib/write-request'
import CalendarView, { type CalendarFocus } from './components/CalendarView'
import type { CalDocRef } from '../../shared/calendar'

export type StatusFilter = StudyStatus | 'all'

/** Shared empty list, so documents without notes don't get a new array (and a redraw) on every render. */
const NO_NOTES: Annotation[] = []

/** Where to scroll inside the open document. `n` changes on every jump so the same #hash can be reused. */
export interface ScrollTarget {
  hash: string
  n: number
}

interface Toast {
  id: number
  text: string
  kind: 'error' | 'info'
}

export default function App() {
  const [lib, setLib] = useState<LibrarySnapshot | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Open tabs (document ids), kept between runs. Only the selected one is loaded; the others
  // open again where you were reading (reading positions are kept per document).
  const [tabs, setTabs] = useState<string[]>(() => loadLocal<string[]>('tabs:workspace', []))
  useEffect(() => saveLocal('tabs:workspace', tabs), [tabs])
  // The sidebar can be hidden (Ctrl+\ or its button) for more room to read; remembered.
  const [sidebarHidden, setSidebarHidden] = useState(() => loadLocal<boolean>('sidebar-hidden', false))
  const showSidebar = useCallback((show: boolean) => {
    setSidebarHidden(!show)
    saveLocal('sidebar-hidden', !show)
  }, [])
  // The open document has unsaved edits (a dot on its tab).
  const [unsaved, setUnsaved] = useState(false)
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget>({ hash: '', n: 0 })
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [searchStatus, setSearchStatus] = useState<SearchStatus | null>(null)
  const [ui, setUi] = useState<UiSettings>(DEFAULT_UI)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined)
  const [recentOpen, setRecentOpen] = useState(false)
  // The main area shows documents or the calendar.
  const [view, setView] = useState<'docs' | 'calendar'>(() => loadLocal<'docs' | 'calendar'>('view', 'docs'))
  const [calendarFocus, setCalendarFocus] = useState<CalendarFocus | null>(null)
  const [nameDialog, setNameDialog] = useState<NameDialogOptions | null>(null)
  const changeView = (next: 'docs' | 'calendar'): void => {
    setView(next)
    // A class shown from a document is not shown again the next time the calendar opens.
    if (next === 'docs') setCalendarFocus(null)
    saveLocal('view', next)
  }
  // True while the open document has unsaved edits (text edit or raw editor).
  const dirtyRef = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)

  /** Shows a message in the bottom-right corner for a few seconds. */
  const showToast = useCallback((text: string, kind: Toast['kind']) => {
    const toast = { id: Date.now() + Math.random(), text, kind }
    setToasts((t) => [...t, toast])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), 6000)
  }, [])
  const notify = useCallback((err: unknown) => showToast(errorMessage(err), 'error'), [showToast])
  const inform = useCallback((text: string) => showToast(text, 'info'), [showToast])

  // Back/forward history of opened documents, like a browser.
  const history = useRef<{ entries: { path: string; hash: string }[]; index: number }>({ entries: [], index: -1 })
  const [historyPos, setHistoryPos] = useState({ canBack: false, canForward: false })
  const syncHistory = (): void => {
    const h = history.current
    setHistoryPos({ canBack: h.index > 0, canForward: h.index < h.entries.length - 1 })
  }

  // Load the library once, then follow changes on disk.
  useEffect(() => {
    window.api
      .getLibrary()
      .then((snap) => {
        setLib(snap)
        const last = loadLocal<string | null>('selected:workspace', null)
        setSelected(last)
        if (last) setTabs((prev) => (prev.includes(last) ? prev : [...prev, last]))
      })
      .catch(notify)
    return window.api.onLibraryChanged(setLib)
  }, [notify])

  // Clean up reading positions of documents that are gone, once a scan has finished (issue #8).
  // Only after seeing "scanning" turn off: before the first scan the list is still empty.
  const sawScanning = useRef(false)
  useEffect(() => {
    if (!lib) return
    if (lib.scanning) sawScanning.current = true
    else if (sawScanning.current) {
      sawScanning.current = false
      pruneReadingPositions(lib.docs, lib.roots)
    }
  }, [lib])

  // Background indexing of document text for search.
  // While texts are being indexed, the current search is run again so results fill in, but at
  // most every 2 seconds plus once at the end: each run scans all text (issue #11).
  const [indexTick, setIndexTick] = useState(0)
  const lastIndexTick = useRef(0)
  useEffect(
    () =>
      window.api.onSearchStatus((status) => {
        setSearchStatus(status)
        if (status.done >= status.total || Date.now() - lastIndexTick.current > 2000) {
          lastIndexTick.current = Date.now()
          setIndexTick((t) => t + 1)
        }
      }),
    []
  )

  // App version + auto-update progress.
  useEffect(() => {
    window.api.getAppInfo().then(setAppInfo).catch(notify)
    return window.api.onUpdateStatus((update) => setAppInfo((info) => info && { ...info, update }))
  }, [notify])

  // Appearance: load once, apply on every change, save shortly after the last change
  // (so dragging the font-size slider doesn't write the file on every pixel).
  useEffect(() => {
    window.api.getUiSettings().then(setUi).catch(notify)
  }, [notify])
  useEffect(() => applyUiSettings(ui), [ui])
  // Before drawing anything, so every t() below uses the chosen language.
  setLanguage(ui.language)
  setCurrentUi(ui)
  const saveUiTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Closing the window with unsaved edits: the main process asks what to do.
  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
    setUnsaved(dirty)
    window.api.setUnsaved(dirty)
    window.onbeforeunload = dirty
      ? (e) => {
          e.preventDefault()
          e.returnValue = false
        }
      : null
  }, [])

  const languageRef = useRef(ui.language)
  languageRef.current = ui.language
  const changeUi = useCallback(
    (next: UiSettings) => {
      const apply = (): void => {
        setUi(next)
        clearTimeout(saveUiTimer.current)
        saveUiTimer.current = setTimeout(() => window.api.setUiSettings(next).catch(notify), 250)
      }
      // A new language draws the whole window again, which drops text being edited: ask first.
      if (next.language !== languageRef.current && dirtyRef.current) {
        void confirmDialog({
          message: t('Đổi ngôn ngữ sẽ vẽ lại cửa sổ và bỏ các thay đổi chưa lưu của bài đang sửa. Vẫn đổi?'),
          ok: t('Vẫn đổi'),
          cancel: t('Ở lại'),
          danger: true
        }).then((yes) => {
          if (!yes) return
          setDirty(false)
          apply()
        })
        return
      }
      apply()
    },
    [notify, setDirty]
  )

  // Settings > Thanh bên can hide pictures (folders of notes often have many).
  const docs = useMemo(() => (lib?.docs ?? []).filter((d) => ui.showImages || d.kind !== 'image'), [lib?.docs, ui.showImages])
  const meta = lib?.meta ?? {}
  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of docs) for (const tag of metaOf(lib?.meta ?? {}, d.path).tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts].map(([tag, count]) => ({ tag, count }))
  }, [docs, lib?.meta])

  /** Opens a document; returns false if you chose to stay because of unsaved edits. */
  const openDoc = useCallback(
    async (path: string, hash = '', fromHistory = false, newTab = false): Promise<boolean> => {
      if (dirtyRef.current && path !== selected) {
        const yes = await confirmDialog({
          message: t('Bài đang mở có thay đổi chưa lưu. Chuyển bài và bỏ các thay đổi đó?'),
          ok: t('Bỏ thay đổi'),
          cancel: t('Ở lại'),
          danger: true
        })
        if (!yes) return false
        setDirty(false)
      }
      if (!fromHistory) {
        const h = history.current
        const cur = h.entries[h.index]
        if (!cur || cur.path !== path || cur.hash !== hash) {
          h.entries = [...h.entries.slice(0, h.index + 1), { path, hash }].slice(-100)
          h.index = h.entries.length - 1
          syncHistory()
        }
      }
      // Its tab: already open, or this one shows it (a new one with Ctrl+click / middle button).
      setTabs((prev) => {
        if (prev.includes(path)) return prev
        const at = selected ? prev.indexOf(selected) : -1
        const next = prev.slice()
        if (at < 0) next.push(path)
        else if (newTab) next.splice(at + 1, 0, path)
        else next[at] = path
        return next
      })
      setSelected(path)
      changeView('docs')
      setScrollTarget((t) => ({ hash, n: t.n + 1 }))
      saveLocal('selected:workspace', path)
      window.api
        .markOpened(path)
        .then((recent) => setLib((l) => l && { ...l, recent }))
        .catch(notify)
      return true
    },
    [notify, selected, setDirty]
  )

  /** Closes a tab; closing the open one shows the tab next to it (asks first if it has unsaved edits). */
  const closeTab = useCallback(
    async (path: string) => {
      const i = tabs.indexOf(path)
      if (i < 0) return
      const rest = tabs.filter((p) => p !== path)
      if (path === selected) {
        const next = rest[i] ?? rest[i - 1]
        if (next) {
          if (!(await openDoc(next))) return
        } else {
          if (dirtyRef.current) {
            const yes = await confirmDialog({
              message: t('Bài đang mở có thay đổi chưa lưu. Đóng và bỏ các thay đổi đó?'),
              ok: t('Bỏ thay đổi'),
              cancel: t('Ở lại'),
              danger: true
            })
            if (!yes) return
            setDirty(false)
          }
          setSelected(null)
          saveLocal('selected:workspace', null)
        }
      }
      setTabs((prev) => prev.filter((p) => p !== path))
    },
    [tabs, selected, openDoc, setDirty]
  )
  // Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab (sent by the main process, from anywhere in the window).
  useEffect(
    () =>
      window.api.onTabKey((key) => {
        if (key === 'sidebar') {
          showSidebar(sidebarHidden)
          return
        }
        if (view !== 'docs') return
        if (key === 'close') {
          if (selected) void closeTab(selected)
          return
        }
        if (!tabs.length) return
        const i = selected ? tabs.indexOf(selected) : -1
        const step = key === 'next' ? 1 : -1
        const target = tabs[(i + step + tabs.length) % tabs.length] ?? tabs[0]
        if (target !== selected) void openDoc(target)
      }),
    [tabs, selected, closeTab, openDoc, view, sidebarHidden, showSidebar]
  )
  // Tabs of documents that are gone (deleted, moved outside the app) close, once a scan is done.
  useEffect(() => {
    if (!lib || lib.scanning) return
    const known = new Set(lib.docs.map((d) => d.path))
    setTabs((prev) => {
      const next = prev.filter((p) => known.has(p))
      return next.length === prev.length ? prev : next
    })
  }, [lib])

  const goHistory = useCallback(
    (direction: 'back' | 'forward') => {
      const h = history.current
      const target = h.index + (direction === 'back' ? -1 : 1)
      const entry = h.entries[target]
      if (!entry) return
      void openDoc(entry.path, entry.hash, true).then((opened) => {
        if (!opened) return
        h.index = target
        syncHistory()
      })
    },
    [openDoc]
  )

  // A link clicked inside an HTML document points to another document.
  useEffect(() => window.api.onNavigate((path, hash) => openDoc(path, hash)), [openDoc])
  // Questions from the main process, shown in the same dialog.
  useEffect(() => window.api.onAsk((id, request) => void ask(request).then((index) => window.api.answerAsk(id, index))), [])
  // A reminder was clicked: show that class in the calendar.
  const showCalendarRef = useRef<(focus: Omit<CalendarFocus, 'n'>) => void>(() => {})
  useEffect(() => window.api.onCalendarFocus((target) => showCalendarRef.current(target)), [])
  // Mouse back/forward buttons.
  useEffect(() => window.api.onHistory(goHistory), [goHistory])

  /** Ctrl+O: pick documents anywhere on the PC (outside the workspace they go to "File lẻ"). */
  const openFiles = useCallback(async () => {
    try {
      const [first] = await window.api.openFiles()
      if (first) openDoc(first)
    } catch (err) {
      notify(err)
    }
  }, [notify, openDoc])

  /** Files dropped on the window open the same way. */
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const paths = [...e.dataTransfer!.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
      window.api
        .addFiles(paths)
        .then(([first]) => {
          if (first) void openDoc(first)
          else notify(new Error(t('Chỉ mở được tài liệu (.md, .html, .pdf, .docx, .txt, .epub, .mobi, .azw3) và ảnh.')))
        })
        .catch(notify)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [notify, openDoc])

  /**
   * App shortcuts. Also called with keys forwarded from inside an HTML document,
   * which has the keyboard focus while you read it.
   * Ctrl+K / Ctrl+P search (like VS Code), Ctrl+E recent, Ctrl+O open file, Ctrl+, settings, Alt+←/→ history.
   */
  const runShortcut = useCallback(
    (key: string) => {
      if (key === 'ctrl+k' || key === 'ctrl+p') {
        // Search lives in the sidebar: show it first if it is hidden.
        showSidebar(true)
        requestAnimationFrame(() => {
          searchRef.current?.focus()
          searchRef.current?.select()
        })
      } else if (key === 'ctrl+e') setRecentOpen((o) => !o)
      else if (key === 'ctrl+,') setSettingsOpen(true)
      else if (key === 'ctrl+o') void openFiles()
      else if (key === 'ctrl+n') newNoteRef.current()
      // Ctrl+F: the open document shows its find bar (DocView listens for this event).
      else if (key === 'ctrl+f') window.dispatchEvent(new Event('studydocs:find'))
      else if (key === 'back' || key === 'forward') goHistory(key)
    },
    [goHistory, openFiles, showSidebar]
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      let key: string | null = null
      if ((e.ctrlKey || e.metaKey) && ['k', 'p', 'e', ',', 'f', 'o', 'n'].includes(e.key.toLowerCase())) key = `ctrl+${e.key.toLowerCase()}`
      if (e.altKey && e.key === 'ArrowLeft') key = 'back'
      if (e.altKey && e.key === 'ArrowRight') key = 'forward'
      if (!key) return
      e.preventDefault()
      runShortcut(key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runShortcut])

  const addFolders = useCallback(async () => {
    try {
      const { snapshot, refused } = await window.api.addFolders()
      setLib(snapshot)
      refused.forEach((msg) => notify(msg))
    } catch (err) {
      notify(err)
    }
  }, [notify])

  const removeFolder = useCallback(
    async (key: string) => {
      if (dirtyRef.current && selected?.startsWith(`${key}/`)) {
        const yes = await confirmDialog({
          message: t('Bài đang mở trong thư mục này có thay đổi chưa lưu. Vẫn bỏ thư mục?'),
          ok: t('Vẫn bỏ'),
          cancel: t('Huỷ'),
          danger: true
        })
        if (!yes) return
        setDirty(false)
      }
      try {
        setLib(await window.api.removeFolder(key))
      } catch (err) {
        notify(err)
      }
    },
    [notify, selected, setDirty]
  )

  const updateMeta = useCallback(
    (path: string, patch: Partial<Pick<DocMeta, 'tags' | 'status'>>) => {
      window.api
        .updateMeta(path, patch)
        .then((m) => setLib((l) => l && { ...l, meta: m }))
        .catch(notify)
    },
    [notify]
  )

  const visibleDocs = useMemo(
    () =>
      docs.filter((d) => {
        const m = metaOf(meta, d.path)
        return (statusFilter === 'all' || m.status === statusFilter) && (!tagFilter || m.tags.includes(tagFilter))
      }),
    [docs, meta, statusFilter, tagFilter]
  )

  // Search runs in a background worker in the main process (window.api.search), so even
  // a big library never freezes the window. Tags are matched here (they change often).
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    let alive = true
    const timer = setTimeout(async () => {
      const results = await window.api.search(q).catch(() => [])
      if (!alive) return
      const visible = new Map(visibleDocs.map((d) => [d.path, d]))
      const nq = normalize(q)
      const out: SearchHit[] = visibleDocs
        .filter((d) => metaOf(meta, d.path).tags.some((t) => normalize(t).includes(nq)))
        .map((doc) => ({ doc, snippet: null }))
      const seen = new Set(out.map((h) => h.doc.path))
      for (const r of results) {
        const doc = visible.get(r.path)
        if (doc && !seen.has(r.path)) out.push({ doc, snippet: r.snippet })
      }
      setHits(out.slice(0, 100))
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, visibleDocs, meta, indexTick]) // indexTick: results improve while texts are being indexed

  const current = docs.find((d) => d.path === selected) ?? null

  // ---------- files: new note, new folder, rename, move, Recycle Bin ----------

  /** The open document is inside `id` (a document, or a folder and everything below it). */
  const touches = useCallback((id: string, isFolder: boolean) => !!selected && (selected === id || (isFolder && selected.startsWith(`${id}/`))), [selected])
  /** Unsaved edits of the open document: ask before renaming, moving or deleting it. */
  const okToChange = useCallback(
    async (id: string, isFolder: boolean): Promise<boolean> => {
      if (!touches(id, isFolder) || !dirtyRef.current) return true
      const yes = await confirmDialog({
        message: t('Bài đang mở có thay đổi chưa lưu. Tiếp tục và bỏ các thay đổi đó?'),
        ok: t('Bỏ thay đổi'),
        cancel: t('Ở lại'),
        danger: true
      })
      if (yes) setDirty(false)
      return yes
    },
    [setDirty, touches]
  )
  /** After a rename or move, the open document stays open at its new place. */
  const follow = useCallback(
    (oldId: string, newId: string, isFolder: boolean) => {
      if (oldId === newId) return
      moveReadingPositions(oldId, newId, isFolder)
      if (!selected) return
      if (selected === oldId) void openDoc(newId)
      else if (isFolder && selected.startsWith(`${oldId}/`)) void openDoc(newId + selected.slice(oldId.length))
    },
    [openDoc, selected]
  )

  showCalendarRef.current = (focus) => void showCalendar(focus)

  const files: FileActions = useMemo(
    () => ({
      newNote: (folderId) =>
        setNameDialog({
          title: t('Bài mới'),
          fields: [{ label: t('Tên bài'), value: '', placeholder: t('Ví dụ: Bài 3 - TCP và UDP') }],
          kind: ui.newNoteKind,
          okLabel: t('Tạo'),
          onSubmit: async ([name], kind) => {
            const id = await window.api.newNote(folderId, name, kind)
            if (kind !== ui.newNoteKind) changeUi({ ...ui, newNoteKind: kind })
            requestWriting(id)
            await openDoc(id)
          }
        }),
      newFolder: (folderId) =>
        setNameDialog({
          title: t('Thư mục mới'),
          fields: [
            { label: t('Tên thư mục'), value: '', placeholder: t('Ví dụ: Lập trình mạng') },
            { label: t('Bài đầu tiên trong thư mục (để trống nếu chưa cần)'), value: '' }
          ],
          kind: ui.newNoteKind,
          okLabel: t('Tạo'),
          onSubmit: async ([folderName, noteName], kind) => {
            const id = await window.api.newFolder(folderId, folderName, noteName, kind)
            if (!id) return
            if (kind !== ui.newNoteKind) changeUi({ ...ui, newNoteKind: kind })
            requestWriting(id)
            await openDoc(id)
          }
        }),
      rename: (id, isFolder, name) =>
        setNameDialog({
          title: isFolder ? t('Đổi tên thư mục') : t('Đổi tên bài'),
          fields: [{ label: t('Tên mới'), value: name }],
          hint: isFolder ? undefined : t('Bỏ phần đuôi (.md, .html…) thì app giữ đuôi cũ. Tag, ghi chú và lịch đi theo bài.'),
          okLabel: t('Đổi tên'),
          onSubmit: async ([next]) => {
            if (!(await okToChange(id, isFolder))) return
            follow(id, await window.api.renameItem(id, isFolder, next), isFolder)
          }
        }),
      move: async (id, isFolder, targetFolderId) => {
        if (!(await okToChange(id, isFolder))) return
        try {
          const newId = await window.api.moveItem(id, isFolder, targetFolderId)
          if (newId !== id) inform(t('Đã chuyển sang thư mục khác.'))
          follow(id, newId, isFolder)
        } catch (err) {
          notify(err)
        }
      },
      trash: async (id, isFolder, name) => {
        const yes = await confirmDialog({
          message: isFolder ? t('Chuyển thư mục "{0}" và mọi file trong đó vào Thùng rác?', { 0: name }) : t('Chuyển "{0}" vào Thùng rác?', { 0: name }),
          detail: t('Có thể khôi phục lại từ Thùng rác của Windows.'),
          ok: t('Xoá'),
          cancel: t('Huỷ'),
          danger: true
        })
        if (!yes) return
        if (touches(id, isFolder)) setDirty(false)
        window.api.trashItem(id, isFolder).catch(notify)
      }
    }),
    [changeUi, follow, inform, notify, okToChange, openDoc, setDirty, touches, ui]
  )

  /** Ctrl+N: a new note next to the open document, else in the first workspace folder. */
  const newNoteHere = useCallback(() => {
    const roots = (lib?.roots ?? []).filter((r) => !r.loose && r.available)
    const inWorkspace = current && roots.some((r) => r.key === current.root)
    const folderId = inWorkspace ? (current.rel.includes('/') ? `${current.root}/${current.rel.replace(/\/[^/]*$/, '')}` : current.root) : roots[0]?.key
    if (!folderId) {
      notify(new Error(t('Hãy thêm một thư mục vào workspace trước: bài mới được lưu trong thư mục đó.')))
      return
    }
    files.newNote(folderId)
  }, [current, files, lib?.roots, notify])
  const newNoteRef = useRef(newNoteHere)
  newNoteRef.current = newNoteHere

  /** Shows the calendar; a document with unsaved edits asks first (it is closed). */
  const showCalendar = useCallback(
    async (focus?: Omit<CalendarFocus, 'n'>) => {
      if (dirtyRef.current) {
        const yes = await confirmDialog({
          message: t('Bài đang mở có thay đổi chưa lưu. Mở lịch và bỏ các thay đổi đó?'),
          ok: t('Bỏ thay đổi'),
          cancel: t('Ở lại'),
          danger: true
        })
        if (!yes) return
        setDirty(false)
      }
      if (focus) setCalendarFocus((f) => ({ ...focus, n: (f?.n ?? 0) + 1 }))
      changeView('calendar')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setDirty]
  )
  const warnings = (lib?.warnings ?? []).filter((w) => !dismissed.includes(w))

  return (
    // The whole window is drawn again when the language changes (texts come from t()).
    <div className={`app ${sidebarHidden ? 'sidebar-hidden' : ''}`} key={ui.language}>
      {sidebarHidden && (
        <nav className="side-rail" aria-label={t('Thanh bên đang ẩn')}>
          <button className="icon-btn" title={t('Hiện thanh bên (Ctrl+\\)')} aria-label={t('Hiện thanh bên')} onClick={() => showSidebar(true)}>
            <PanelIcon />
          </button>
          <button className="icon-btn" title={t('Tìm tài liệu (Ctrl+K)')} aria-label={t('Tìm tài liệu')} onClick={() => runShortcut('ctrl+k')}>
            <SearchIcon />
          </button>
        </nav>
      )}
      <Sidebar
        onHide={() => showSidebar(false)}
        lib={lib}
        docs={visibleDocs}
        hits={hits}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        tagFilter={tagFilter}
        onTagFilter={setTagFilter}
        selected={selected}
        onOpen={(id, newTab) => void openDoc(id, '', false, newTab)}
        appInfo={appInfo}
        searchStatus={searchStatus}
        recentOpen={recentOpen}
        onRecentOpen={setRecentOpen}
        onAddFolders={addFolders}
        onRemoveFolder={removeFolder}
        onOpenSettings={() => setSettingsOpen(true)}
        calendarOpen={view === 'calendar'}
        onToggleCalendar={() => (view === 'calendar' ? changeView('docs') : void showCalendar())}
        onOpenFiles={openFiles}
        onRemoveLoose={(p) => window.api.removeLooseFile(p).catch(notify)}
        files={files}
        sort={ui.sidebarSort}
      />
      <main className="content">
        {appInfo?.update.state === 'ready' && (
          <div className="banner update" role="status">
            <span>{t('Đã tải xong bản')}{' '}{appInfo.update.version}{t('. Bản mới sẽ được cài khi bạn tắt app, hoặc cập nhật ngay:')}</span>
            <button className="btn primary small" onClick={() => window.api.installUpdate().catch(notify)}>{t('Khởi động lại để cập nhật')}</button>
          </div>
        )}
        {lib && lib.recovery.length > 0 && (
          <div className="banner" role="alert">
            <span>{t('Có {0} bản sao lưu dữ liệu bị hỏng chưa được gộp lại.', { 0: lib.recovery.length })}</span>
            <button
              className="btn small"
              onClick={() => {
                setSettingsTab('data')
                setSettingsOpen(true)
              }}
            >
              {t('Khôi phục…')}
            </button>
          </div>
        )}
        {warnings.map((w) => (
          <div key={w} className="banner" role="alert">
            <span>{w}</span>
            <button aria-label={t('Ẩn cảnh báo')} onClick={() => setDismissed((d) => [...d, w])}>
              ×
            </button>
          </div>
        ))}
        {view === 'docs' && tabs.length > 0 && (
          <DocTabs
            tabs={tabs}
            docs={lib?.docs ?? []}
            selected={selected}
            dirty={unsaved}
            onSelect={(id) => void openDoc(id)}
            onClose={(id) => void closeTab(id)}
            onReorder={setTabs}
            onOpenInNewTab={(id) => void openDoc(id, '', false, true)}
          />
        )}
        {view === 'calendar' ? (
          <CalendarView docs={docs} roots={lib?.roots ?? []} focus={calendarFocus} onOpenDoc={(id) => void openDoc(id)} onError={notify} onInfo={inform} />
        ) : current ? (
          <DocView
            key={current.path}
            doc={current}
            meta={metaOf(meta, current.path)}
            allDocs={docs}
            allTags={allTags}
            scrollTarget={scrollTarget}
            onUpdateMeta={(patch) => updateMeta(current.path, patch)}
            onOpenDoc={openDoc}
            onError={notify}
            onInfo={inform}
            onDirtyChange={setDirty}
            onShortcut={runShortcut}
            history={historyPos}
            onHistory={goHistory}
            annotations={lib?.notes[current.path] ?? NO_NOTES}
            onAnnotationsChange={(items) => setLib((l) => l && { ...l, notes: { ...l.notes, [current.path]: items } })}
            docNote={lib?.docNotes[current.path] ?? ''}
            onDocNoteChange={(text) => setLib((l) => l && { ...l, docNotes: { ...l.docNotes, [current.path]: text } })}
            onOpenCalendar={(ref: CalDocRef) => void showCalendar({ date: ref.start, uid: ref.uid, rid: ref.at })}
            rootName={(lib?.roots.length ?? 0) > 1 ? (lib?.roots.find((r) => r.key === current.root)?.name ?? null) : null}
          />
        ) : (
          <Welcome hasLibrary={(lib?.roots.length ?? 0) > 0} docs={docs} recent={lib?.recent ?? {}} onChoose={addFolders} onOpenFiles={openFiles} onOpen={openDoc} />
        )}
      </main>
      {settingsOpen && (
        <SettingsDialog
          startTab={settingsTab}
          ui={ui}
          onChange={changeUi}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsTab(undefined)
          }}
          roots={lib?.roots ?? []}
          onAddFolders={addFolders}
          onRemoveFolder={removeFolder}
          appInfo={appInfo}
          lib={lib}
        />
      )}
      {nameDialog && <NameDialog options={nameDialog} onClose={() => setNameDialog(null)} />}
      <AskHost />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

interface WelcomeProps {
  hasLibrary: boolean
  docs: DocEntry[]
  recent: Record<string, number>
  onChoose: () => void
  onOpenFiles: () => void
  onOpen: (path: string) => void
}

function Welcome({ hasLibrary, docs, recent, onChoose, onOpenFiles, onOpen }: WelcomeProps) {
  const recentDocs = docs
    .filter((d) => recent[d.path])
    .sort((a, b) => recent[b.path] - recent[a.path])
    .slice(0, 8)
  if (!hasLibrary) {
    return (
      <div className="welcome">
        <h1>Study Docs</h1>
        <p>{t('Thêm một hoặc nhiều thư mục chứa tài liệu học của bạn, ở bất kỳ ổ đĩa nào, hoặc mở từng file (Markdown, HTML, PDF, EPUB, Kindle). Có thể kéo thả file vào cửa sổ. App không sửa file nếu bạn không bấm Sửa chữ hoặc Raw.')}</p>
        <div className="welcome-actions">
          <button className="btn primary" onClick={onChoose}>{t('Thêm thư mục tài liệu')}</button>
          <button className="btn" onClick={onOpenFiles}>{t('Mở file… (Ctrl+O)')}</button>
        </div>
      </div>
    )
  }
  return (
    <div className="welcome">
      <h1>{docs.length}{' '}{t('tài liệu')}</h1>
      <p>{t('Chọn một bài ở thanh bên trái, hoặc nhấn')}{' '}<kbd>Ctrl</kbd> + <kbd>K</kbd>{' '}{t('để tìm kiếm. Tìm không cần gõ dấu: "su kien" vẫn ra "sự kiện".')}</p>
      {recentDocs.length > 0 && (
        <div className="welcome-recent">
          <div className="group-title">{t('Mở gần đây')}</div>
          {recentDocs.map((d) => (
            <button key={d.path} className="row doc" onClick={() => onOpen(d.path)} title={d.rel}>
              <span className={`kind kind-${d.kind}`}>{kindLabel(d.kind, d.path)}</span>
              <span className="row-title">{d.title}</span>
              <span className="row-time">{timeAgo(recent[d.path])}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
