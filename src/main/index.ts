// Electron main process: owns the window, the file system and the `doc://` protocol.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, Notification, protocol, session, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs, readFileSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Annotation, Bookmark, DocEntry, DocMeta, HtmlBlockEdit, LibrarySnapshot, OcrData, RecoveryItem, SheetData, SheetSave, UiSettings } from '../shared/types'
import { applyXlsxEdits, loadSheet, parseCsv, SheetError, writeCsv } from './sheet'
import { translateText } from './translate'
import { decodeText } from '../shared/text'
import { applyHtmlEdits, editModeInjection, HtmlEditError } from './html-edit'
import { withReadingStyle } from './page-style'
import { printNotesInjection, viewModeInjection } from './view-helper'
import { emptyFolders, kindOf, listFolders, readFiles, resolveInLibrary, scanLibrary, type ScannedDoc } from './library'
import { MetaStore } from './meta-store'
import type { DocKeyed, DocStore } from './doc-store'
import { ScanCache } from './scan-cache'
import { SearchService } from './search'
import { NotesStore, sanitizeAnnotation, sanitizeBookmark } from './notes-store'
import { loadLooseFiles, loadRecent, loadUiSettings, loadWorkspacePaths, markOpened, sanitizeUi, saveLooseFiles, saveSettings, saveWorkspacePaths } from './storage'
import { isSameOrInside, labelRoots, normalizeRoot, pathKey, rootConflict, rootKeyOf, splitDocId } from './workspace'
import { canOpenWithDefaultApp } from './open-policy'
import { looksLikeSameFolder, matchScore, remapEntries, type Remembered } from './relink'
import { decodeUtf8Strict } from './text-file'
import { checkForUpdatesNow, getUpdateStatus, installUpdateNow, startAutoUpdate } from './updater'
import { setLanguage, t } from '../shared/i18n'
import { CalendarStore, nextStart, previewStarts, type CalendarBackup, type StoredLink } from './calendar-store'
import { checkName, noteFileName, noteTemplate, renamedFileName, type NoteKind } from './file-ops'
import { formatDate, formatShortDate, formatTimeRange, ymd, type CalDocRef, type CalEventData, type CalEventDetail, type CalLinkView, type EditScope } from '../shared/calendar'

// Tests run with their own settings folder so they never touch your real settings.
if (process.env.STUDYDOCS_USER_DATA) app.setPath('userData', process.env.STUDYDOCS_USER_DATA)

// Date and time fields (the calendar) are drawn in the app's language: dd/mm/yyyy and a
// 24-hour clock, not the US format. Must be set before the app is ready, so settings.json is
// read directly; a new install keeps Windows' own format.
try {
  const lang = (JSON.parse(readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) as { ui?: { language?: string } }).ui?.language
  if (lang === 'vi' || lang === 'en') app.commandLine.appendSwitch('lang', lang === 'vi' ? 'vi' : 'en-GB')
} catch {
  // no settings yet
}

// Documents are served as doc://library/<root key>/<path inside that folder>. A "standard" scheme means
// relative links inside an HTML document (images, other pages) resolve normally.
protocol.registerSchemesAsPrivileged([
  { scheme: 'doc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

/** Origin of Chromium's built-in PDF viewer, which shows PDF documents inside an iframe. */
const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'


let win: BrowserWindow | null = null

/**
 * One folder of the workspace, with its tags/notes stores and a watcher.
 * A "loose" root is the folder of files you opened on their own (Ctrl+O, drag and drop,
 * double-click in Explorer): only those files are documents, the rest of the folder is not
 * scanned (but its images/styles can still be loaded by those documents).
 */
interface Root {
  key: string
  path: string
  name: string
  loose: boolean
  /** Loose roots only: the files you opened, by absolute path. */
  files: string[]
  /** Documents with paths relative to this folder. */
  docs: ScannedDoc[]
  /** Folders without any document below them (workspace folders only), shown in the tree too. */
  emptyFolders: string[]
  /** Null when the folder could not be opened. */
  meta: MetaStore | null
  notes: NotesStore | null
  watcher: FSWatcher | null
  warning: string | null
}

let roots: Root[] = []
/** True while folders are being scanned (the UI shows "Đang quét…"). */
let scanning = false
/** Titles/hashes of files seen before, so unchanged files aren't read again. Set at startup. */
let scanCache: ScanCache | undefined
/** Full-text search in a background thread. Set at startup. */
let search: SearchService | undefined
/** The calendar (data\calendar.ics). Set at startup. */
let calendar: CalendarStore | undefined

// ---------- workspace ----------

const newRoot = (p: string, loose = false): Root => ({
  key: rootKeyOf(p),
  path: p,
  name: '',
  loose,
  files: [],
  docs: [],
  emptyFolders: [],
  meta: null,
  notes: null,
  watcher: null,
  warning: null
})
/** Workspace folders (not the folders of loose files). */
const folderRoots = (): Root[] => roots.filter((r) => !r.loose)
/** Path of a file inside a root, with "/" separators (the document id is "<root key>/<this>"). */
const relOf = (root: Root, abs: string): string => path.relative(root.path, abs).split(path.sep).join('/')

/**
 * Where a folder's tags and notes are kept: %APPDATA%\Study Docs\data\<folder key>\
 * (like Claude Code keeps one folder per project). The documents' own folders are never
 * written to. info.json says which folder it is, for people looking at these files.
 */
const dataDirOf = (key: string): string => path.join(app.getPath('userData'), 'data', key)
interface DataInfo {
  path?: string
  loose?: boolean
  /** This data was moved to the folder at that path (see offerRelink). */
  mergedInto?: string
  /** Keys of old data you said do not belong to this folder. */
  notThis?: string[]
  /** Tags/notes of v0.8 and older (.docs-*.json in the folder) were read in. */
  legacyImported?: boolean
}
async function readDataInfo(key: string): Promise<DataInfo> {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDirOf(key), 'info.json'), 'utf8')) as DataInfo
  } catch {
    return {}
  }
}
async function writeDataInfo(root: Pick<Root, 'key' | 'path' | 'loose'>, extra: Partial<DataInfo> = {}): Promise<void> {
  const file = path.join(dataDirOf(root.key), 'info.json')
  const info = { ...(await readDataInfo(root.key)), path: root.path, loose: root.loose, ...extra }
  await fs.writeFile(file, JSON.stringify(info, null, 2), 'utf8').catch(() => {})
}
/** The entries of a data file as stored (for data of folders that are not open). */
async function readStoredDocs(key: string, file: 'meta.json' | 'notes.json'): Promise<Record<string, Remembered>> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dataDirOf(key), file), 'utf8')) as { docs?: Record<string, Remembered> }).docs ?? {}
  } catch {
    return {}
  }
}

/** The root a file belongs to: its workspace folder, else its loose root (if it was opened). */
function rootOfFile(abs: string): Root | undefined {
  return roots
    .filter((r) => isSameOrInside(abs, r.path) && (!r.loose || r.files.some((f) => pathKey(f) === pathKey(abs))))
    .sort((a, b) => Number(a.loose) - Number(b.loose) || b.path.length - a.path.length)[0]
}

/** Finds a document id ("<root key>/<path>") in the workspace; null if it isn't in any folder. */
function locate(id: string): { root: Root; rel: string; abs: string } | null {
  const parts = splitDocId(id)
  const root = parts && roots.find((r) => r.key === parts.key)
  const abs = root && resolveInLibrary(root.path, parts.rel)
  if (!root || !abs) return null
  // A loose file's folder is not part of the library: only the files you opened, and the
  // pictures/styles/fonts/scripts a page needs (next to it or below), may be reached.
  if (root.loose && !root.files.some((f) => pathKey(f) === pathKey(abs)) && !LOOSE_RESOURCE.test(abs)) return null
  return { root, rel: parts.rel, abs }
}
/** What a loose HTML/Markdown file may load from around it. */
const LOOSE_RESOURCE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|css|js|mjs|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|m4a)$/i
const inLibrary = (id: string): string | null => locate(id)?.abs ?? null
const hasDoc = (id: string): boolean => {
  const loc = locate(id)
  return !!loc && loc.root.docs.some((d) => d.path === loc.rel)
}

/** Splits doc://library/<id>#part into { path: id, hash: 'part' }. */
function parseDocUrl(url: string): { path: string; hash: string } | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'doc:') return null
    return {
      path: decodeURIComponent(u.pathname).replace(/^\/+/, ''),
      hash: decodeURIComponent(u.hash.replace(/^#/, ''))
    }
  } catch {
    return null
  }
}

/** Document id -> last opened time, for documents currently in the workspace. */
function recentByDoc(byFile: Record<string, number>): Record<string, number> {
  const recent: Record<string, number> = {}
  for (const r of roots) {
    for (const d of r.docs) {
      const ts = byFile[pathKey(path.join(r.path, d.path))]
      if (ts) recent[`${r.key}/${d.path}`] = ts
    }
  }
  return recent
}

async function snapshot(): Promise<LibrarySnapshot> {
  const docs: DocEntry[] = []
  const meta: Record<string, DocMeta> = {}
  const notes: Record<string, Annotation[]> = {}
  const docNotes: Record<string, string> = {}
  const warnings: string[] = []
  const recovery: RecoveryItem[] = []
  let orphans = 0
  for (const r of roots) {
    for (const d of r.docs) docs.push({ ...d, path: `${r.key}/${d.path}`, root: r.key, rel: d.path })
    for (const [rel, m] of Object.entries(r.meta?.all() ?? {})) meta[`${r.key}/${rel}`] = m
    for (const [rel, items] of Object.entries(r.notes?.byDoc() ?? {})) notes[`${r.key}/${rel}`] = items
    for (const [rel, text] of Object.entries(r.notes?.docNotes() ?? {})) docNotes[`${r.key}/${rel}`] = text
    for (const [store, s] of [['meta', r.meta], ['notes', r.notes]] as const) {
      for (const file of (await s?.backups()) ?? []) recovery.push({ root: r.key, rootName: r.name, store, file })
    }
    // Only count once the folder is fully scanned and reachable, or every file would look gone.
    if (!scanning && !r.warning) orphans += storesOf(r).reduce((n, st) => n + st.orphans(knownPaths(r)).length, 0)
    for (const w of [r.meta?.warning, r.notes?.warning, r.warning]) if (w) warnings.push(roots.length > 1 ? `${r.name}: ${w}` : w)
  }
  if (calendar?.warning) warnings.push(calendar.warning)
  return {
    scanning,
    roots: roots.map((r) => ({ key: r.key, path: r.path, name: r.name, available: !!r.meta, loose: r.loose, emptyFolders: r.emptyFolders })),
    looseFiles: roots
      .filter((r) => r.loose)
      .flatMap((r) =>
        r.files.map((file) => {
          const rel = relOf(r, file)
          return { path: file, id: r.docs.some((d) => d.path === rel) ? `${r.key}/${rel}` : null }
        })
      ),
    docs,
    meta,
    recent: recentByDoc(await loadRecent()),
    notes,
    docNotes,
    warnings,
    recovery,
    orphans
  }
}

const storesOf = (r: Root): (MetaStore | NotesStore)[] => [r.meta, r.notes].filter((x): x is MetaStore | NotesStore => !!x)
/**
 * Documents whose tags/notes are kept: everything found in a folder; for loose files, every
 * file in the list even when it is missing right now (a USB drive that isn't plugged in).
 */
const knownPaths = (r: Root): string[] => (r.loose ? r.files.map((f) => relOf(r, f)) : r.docs.map((d) => d.path))

/** The meta or notes store of a folder, for the recovery dialog. */
function storeFor(rootKey: string, store: string): MetaStore | NotesStore {
  const r = roots.find((x) => x.key === rootKey)
  const s = store === 'meta' ? r?.meta : store === 'notes' ? r?.notes : null
  if (!s) throw new Error(t('Thư mục này không còn trong workspace'))
  return s
}
/** Which store a backup file name belongs to. */
const storeOfBackup = (file: string): 'meta' | 'notes' => (String(file).startsWith('notes.') ? 'notes' : 'meta')

async function pushSnapshot(): Promise<void> {
  win?.webContents.send('library:changed', await snapshot())
  openPendingFile()
}

// ---------- opening a file from Explorer (issue #24) ----------

/** File types the installer associates with the app. */
const OPENABLE = /\.(md|markdown|html?|pdf|docx|txt|epub|mobi|azw3?|png|jpe?g|gif|webp|svg|bmp|avif)$/i
/** A file to show once the UI is ready and its folder has been scanned. */
let pendingFile: string | null = null
/** True once the UI asked for the library, so it is listening for doc:navigate. */
let uiReady = false

/** Document files in a command line ("Study Docs.exe" "C:\notes\a.md"). */
function filesInArgs(argv: string[], cwd = process.cwd()): string[] {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && OPENABLE.test(a))
    .map((a) => path.resolve(cwd, a))
}

/** Opens a file given on the command line; files outside the workspace ask to add their folder. */
async function openFromExplorer(abs: string): Promise<void> {
  try {
    if (!(await fs.stat(abs)).isFile()) return
  } catch {
    return
  }
  if (win?.isMinimized()) win.restore()
  win?.focus()
  // A file outside the workspace folders is added to "File lẻ", like opening a file in Word.
  await addFiles([abs])
  pendingFile = abs
  openPendingFile()
}

// ---------- questions shown in the app's own dialog ----------

/** Questions waiting for an answer from the window (see AskHost in the renderer). */
const pendingAsks = new Map<number, (index: number) => void>()
let nextAskId = 1

/**
 * Asks in the app's own dialog (same look as the app, in its language) instead of a Windows
 * message box. Falls back to the Windows box before the window is ready.
 * Resolves with the index of the button clicked.
 */
async function askInWindow(o: { message: string; detail?: string; buttons: string[]; cancelId: number; dangerId?: number }): Promise<number> {
  if (!win || win.isDestroyed() || !uiReady) {
    const { response } = await dialog.showMessageBox(win!, { type: 'question', message: o.message, detail: o.detail, buttons: o.buttons, cancelId: o.cancelId, defaultId: o.cancelId })
    return response
  }
  const id = nextAskId++
  return new Promise((resolve) => {
    pendingAsks.set(id, resolve)
    win!.webContents.send('dialog:ask', id, o)
  })
}

/** Shows the pending file once its folder is scanned and the UI is listening. */
function openPendingFile(): void {
  if (!pendingFile || !uiReady || !win) return
  const root = rootOfFile(pendingFile)
  if (!root) {
    pendingFile = null
    return
  }
  const rel = relOf(root, pendingFile)
  if (root.docs.some((d) => d.path === rel)) {
    pendingFile = null
    win.webContents.send('doc:navigate', `${root.key}/${rel}`, '')
  } else if (!scanning) {
    const name = path.basename(pendingFile)
    pendingFile = null
    void askInWindow({ message: t('Không mở được "{0}"', { 0: name }), detail: t('File nằm trong thư mục ẩn (tên bắt đầu bằng dấu chấm) hoặc không còn tồn tại.'), buttons: [t('Đóng')], cancelId: 0 })
  }
}

function relabel(): void {
  const folders = folderRoots()
  const labels = labelRoots(folders.map((r) => r.path))
  folders.forEach((r, i) => (r.name = labels[i]))
  // Loose files: the folder they are in, shown next to search results.
  for (const r of roots) if (r.loose) r.name = r.path
}

async function openRoot(root: Root): Promise<void> {
  try {
    // Loose files may be missing (then they show as "không tìm thấy"); a folder must exist.
    if (!root.loose && !(await fs.stat(root.path)).isDirectory()) throw new Error('not a folder')
    root.meta = await MetaStore.open(dataDirOf(root.key))
    root.notes = await NotesStore.open(dataDirOf(root.key))
    await writeDataInfo(root)
  } catch {
    root.warning = t('Không mở được thư mục này (bị xoá, đổi tên hoặc ổ đĩa chưa cắm). Nếu không dùng nữa, bỏ nó khỏi workspace trong Cài đặt.')
    return
  }
  await importLegacyData(root)
  root.docs = await scanRoot(root, [])
  await reconcileStores(root)
  // The folder may have been removed from the workspace while it was being scanned:
  // then don't start watching it, nobody would ever stop the watcher (issue #9).
  if (roots.includes(root)) watchRoot(root)
}

/**
 * Up to v0.8 tags and notes were kept inside the documents' folder (.docs-meta.json,
 * .docs-notes.json). Read them once into the app's data, so updating keeps everything.
 * The old files are left untouched (the app no longer writes into documents' folders);
 * info.json remembers it was done, so they are not read again.
 */
async function importLegacyData(root: Root): Promise<void> {
  if (root.loose || !root.meta || !root.notes) return
  if ((await readDataInfo(root.key)).legacyImported) return
  const read = async (name: string): Promise<string | null> => fs.readFile(path.join(root.path, name), 'utf8').catch(() => null)
  const [meta, notes] = await Promise.all([read('.docs-meta.json'), read('.docs-notes.json')])
  // recover() also reads files with a Git conflict or a stray comma.
  const metaDocs = meta ? root.meta.recover(meta) : null
  const notesDocs = notes ? root.notes.recover(notes) : null
  if (metaDocs) await root.meta.importDocs(metaDocs)
  if (notesDocs) await root.notes.importDocs(notesDocs)
  // A file too broken to read is copied to the data folder as a broken backup: the app then
  // shows "Khôi phục…" (fix it by hand, then merge it), as for its own data files.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const [raw, docs, store] of [
    [meta, metaDocs, 'meta'],
    [notes, notesDocs, 'notes']
  ] as const) {
    if (raw !== null && !docs) await fs.writeFile(path.join(dataDirOf(root.key), `${store}.corrupt-v08-${stamp}.json`), raw, 'utf8')
  }
  await writeDataInfo(root, { legacyImported: true })
}

/** The documents of a root: the whole folder, or only the files opened on their own. */
async function scanRoot(root: Root, previous = root.docs): Promise<ScannedDoc[]> {
  if (root.loose) return readFiles(root.path, root.files, previous, scanCache)
  const [docs, folders] = await Promise.all([scanLibrary(root.path, previous, scanCache), listFolders(root.path)])
  root.emptyFolders = emptyFolders(folders, docs)
  return docs
}

/** Lets tags and notes follow renamed/moved documents (inside a workspace folder). */
async function reconcileStores(root: Root): Promise<void> {
  if (root.loose) return // only the listed files are known; a missing one is not "moved"
  for (const store of [root.meta, root.notes]) await store?.reconcile(root.docs).catch((err) => console.error('reconcile failed', err))
}

function closeRoot(root: Root): void {
  root.watcher?.close()
  root.watcher = null
}

/** Tells the search worker about the current documents; it indexes new/changed ones in the background. */
function syncSearch(): void {
  search?.update(
    roots.flatMap((r) =>
      r.docs.map((d) => ({
        id: `${r.key}/${d.path}`,
        abs: path.join(r.path, d.path),
        kind: d.kind,
        title: d.title,
        name: d.name,
        rel: d.path,
        size: d.size,
        mtime: d.mtime,
        // Scanned PDFs: the text read by OCR (its time is part of the text cache's key).
        ...(d.kind === 'pdf' && ocrIndex.has(ocrKey(path.join(r.path, d.path)))
          ? { ocrFile: ocrFile(path.join(r.path, d.path)), ocrAt: ocrIndex.get(ocrKey(path.join(r.path, d.path))) }
          : {})
      }))
    ),
    !scanning
  )
}

/** Opens folders one by one, showing each in the UI as soon as it is scanned. */
async function openRoots(list: Root[]): Promise<void> {
  scanning = true
  await pushSnapshot()
  for (const root of list) {
    if (!roots.includes(root)) continue // removed before its turn
    await openRoot(root)
    syncSearch()
    await pushSnapshot()
    void offerRelink(root)
  }
  scanning = false
  syncSearch() // the full list now: lets the worker clean up texts of files that are gone
  await scanCache?.save()
  await pushSnapshot()
}

// ---------- finding a folder's data again after its path changed (see relink.ts) ----------

let uiIsReady: () => void = () => {}
const uiReadyPromise = new Promise<void>((resolve) => (uiIsReady = resolve))
const relinkAsked = new Set<string>()

/**
 * A workspace folder with no tags or notes yet: if old data (under another path) clearly
 * belongs to the same files, ask whether to move it here. Happens after renaming or moving
 * the folder, a USB drive getting another letter, or opening the folder on another PC.
 */
async function offerRelink(root: Root): Promise<void> {
  if (root.loose || !root.meta || !root.notes || relinkAsked.has(root.key) || !root.docs.length) return
  if (Object.keys(root.meta.all()).length || Object.keys(root.notes.all()).length) return
  relinkAsked.add(root.key)
  const declined = new Set((await readDataInfo(root.key)).notThis ?? [])
  let best: { key: string; path: string; matched: number; total: number } | null = null
  for (const key of await fs.readdir(path.join(app.getPath('userData'), 'data')).catch(() => [] as string[])) {
    if (key === root.key || declined.has(key) || roots.some((r) => r.key === key)) continue
    const info = await readDataInfo(key)
    if (!info.path || info.mergedInto || info.loose) continue
    const entries = { ...(await readStoredDocs(key, 'meta.json')), ...(await readStoredDocs(key, 'notes.json')) }
    const score = matchScore(entries, root.docs)
    if (looksLikeSameFolder(score) && (!best || score.matched > best.matched)) best = { key, path: info.path, matched: score.matched, total: score.total }
  }
  if (!best) return
  await uiReadyPromise
  if (!roots.includes(root)) return
  const answer = await askInWindow({
    message: t('Thư mục "{0}" có phải là "{1}" trước đây không?', { 0: root.name, 1: best.path }),
    detail: t('{0}/{1} bài có tag hoặc ghi chú ở đó trùng với file trong thư mục này (thư mục đã đổi tên, chuyển chỗ, ổ USB đổi ký tự, hoặc mở trên máy khác). Chuyển tag và ghi chú sang đây?', { 0: best.matched, 1: best.total }),
    buttons: [t('Chuyển sang đây'), t('Không phải')],
    cancelId: 1
  })
  if (answer !== 0) {
    await writeDataInfo(root, { notThis: [...declined, best.key] })
    return
  }
  const oldMeta = await MetaStore.open(dataDirOf(best.key))
  const oldNotes = await NotesStore.open(dataDirOf(best.key))
  await root.meta.importDocs(remapEntries(oldMeta.all(), root.docs))
  await root.notes.importDocs(remapEntries(oldNotes.all(), root.docs))
  // The old data stays on disk (nothing is deleted), marked so it isn't offered again.
  await writeDataInfo({ key: best.key, path: best.path, loose: false }, { mergedInto: root.path })
  await pushSnapshot()
}

/** Replaces the whole workspace (at startup). Duplicate or nested folders are skipped. */
async function openWorkspace(paths: string[], looseFiles: string[]): Promise<void> {
  roots.forEach(closeRoot)
  roots = []
  for (const p of paths) {
    const norm = normalizeRoot(p)
    if (!rootConflict(roots.map((r) => r.path), norm)) roots.push(newRoot(norm))
  }
  for (const file of looseFiles) addToLooseRoot(path.resolve(file))
  relabel()
  await openRoots(roots)
}

// ---------- files opened on their own ("File lẻ") ----------

/** Puts a file in the loose root of its folder (made if needed); false if a workspace folder has it. */
function addToLooseRoot(abs: string): Root | null {
  if (folderRoots().some((r) => isSameOrInside(abs, r.path))) return null
  const dir = normalizeRoot(path.dirname(abs))
  let root = roots.find((r) => r.loose && pathKey(r.path) === pathKey(dir))
  if (!root) {
    root = newRoot(dir, true)
    roots.push(root)
  }
  if (!root.files.some((f) => pathKey(f) === pathKey(abs))) root.files.push(abs)
  return root
}

const saveLoose = (): Promise<void> => saveLooseFiles(roots.filter((r) => r.loose).flatMap((r) => r.files))

/**
 * Opens documents by path (Ctrl+O, drag and drop, Explorer). Files inside a workspace folder
 * are simply found there; others are added to "File lẻ". Resolves with their document ids.
 */
async function addFiles(paths: string[]): Promise<string[]> {
  const ids: string[] = []
  const changed = new Set<Root>()
  for (const p of paths) {
    const abs = path.resolve(String(p))
    if (!kindOf(abs)) continue
    try {
      if (!(await fs.stat(abs)).isFile()) continue
    } catch {
      continue
    }
    const folder = folderRoots().find((r) => isSameOrInside(abs, r.path))
    if (folder) {
      ids.push(`${folder.key}/${relOf(folder, abs)}`)
      continue
    }
    const root = addToLooseRoot(abs)!
    changed.add(root)
    ids.push(`${root.key}/${relOf(root, abs)}`)
  }
  if (!changed.size) return ids
  relabel()
  await saveLoose()
  for (const root of changed) {
    if (!root.meta) await openRoot(root)
    else root.docs = await scanRoot(root)
  }
  syncSearch()
  await pushSnapshot()
  return ids
}

/** Removes a file from "File lẻ" (the file itself is not touched; its notes are kept). */
async function removeLooseFile(abs: string): Promise<void> {
  const root = roots.find((r) => r.loose && r.files.some((f) => pathKey(f) === pathKey(abs)))
  if (!root) return
  root.files = root.files.filter((f) => pathKey(f) !== pathKey(abs))
  if (root.files.length) {
    root.docs = await scanRoot(root)
  } else {
    closeRoot(root)
    roots = roots.filter((r) => r !== root)
  }
  await saveLoose()
  syncSearch()
  await pushSnapshot()
}

/**
 * A workspace folder was added: loose files inside it now belong to it. Their tags and notes
 * move along (their paths inside the folder get the sub-folder in front).
 */
async function absorbLooseRoots(folder: Root): Promise<void> {
  for (const loose of roots.filter((r) => r.loose && isSameOrInside(r.path, folder.path))) {
    closeRoot(loose)
    roots = roots.filter((r) => r !== loose)
    if (loose.key === folder.key) continue // same folder: same data folder already
    const prefix = relOf(folder, loose.path)
    const moved = <V>(docs: Record<string, V>): Record<string, V> =>
      Object.fromEntries(Object.entries(docs).map(([rel, v]) => [prefix ? `${prefix}/${rel}` : rel, v]))
    if (loose.meta) await folder.meta?.importDocs(moved(loose.meta.all()))
    if (loose.notes) await folder.notes?.importDocs(moved(loose.notes.all()))
  }
  await saveLoose()
}

/** Adds folders; returns a message for each folder that was refused. */
async function addRoots(paths: string[]): Promise<string[]> {
  const refused: string[] = []
  const added: Root[] = []
  for (const p of paths) {
    const norm = normalizeRoot(p)
    const conflict = rootConflict([...folderRoots(), ...added].map((r) => r.path), norm)
    if (conflict) refused.push(conflict)
    else added.push(newRoot(norm))
  }
  roots.push(...added)
  relabel()
  await saveWorkspacePaths(folderRoots().map((r) => r.path))
  await openRoots(added)
  for (const folder of added) if (folder.meta) await absorbLooseRoots(folder)
  if (added.length) {
    syncSearch()
    await pushSnapshot()
  }
  return refused
}

async function removeRoot(key: string): Promise<void> {
  const root = roots.find((r) => r.key === key && !r.loose)
  if (!root) return
  closeRoot(root)
  roots = roots.filter((r) => r !== root)
  relabel()
  await saveWorkspacePaths(folderRoots().map((r) => r.path))
  syncSearch()
}

function watchRoot(root: Root): void {
  let rescanTimer: NodeJS.Timeout | undefined
  const stillOpen = (): boolean => roots.includes(root)

  const rescan = async (): Promise<void> => {
    if (!stillOpen()) return
    root.docs = await scanRoot(root)
    await reconcileStores(root)
    syncSearch()
    await pushSnapshot()
  }

  try {
    // Windows supports recursive watching natively, no extra dependency needed.
    // Loose files: only their own folder level matters, and only the files in the list.
    root.watcher = watch(root.path, { recursive: !root.loose }, (_event, filename) => {
      const name = String(filename ?? '')
      if (root.loose && !root.files.some((f) => path.basename(f).toLowerCase() === name.toLowerCase())) return
      // Hidden files (temp files, .git) and node_modules are not documents.
      if (name.split(/[\\/]/).some((p) => p.startsWith('.') || p === 'node_modules')) return
      clearTimeout(rescanTimer)
      rescanTimer = setTimeout(() => void rescan(), 400)
    })
    // Happens when the folder is deleted, renamed or on a USB drive that was removed.
    root.watcher.on('error', (err) => {
      console.error('watcher error', err)
      closeRoot(root)
      // Loose files simply show as "không tìm thấy"; a workspace folder gets a warning.
      if (!root.loose) root.warning = t('Mất kết nối với thư mục này (bị xoá, đổi tên hoặc rút ổ). App không còn tự cập nhật khi file trong đó thay đổi.')
      void pushSnapshot()
    })
  } catch (err) {
    console.error('Cannot watch folder', err)
    if (!root.loose) root.warning = t('Không theo dõi được thư mục này; app sẽ không tự cập nhật khi file trong đó thay đổi.')
  }
}

// ---------- files: new notes, folders, rename, move, Recycle Bin ----------

/** A folder of the workspace by its id in the sidebar tree ("<root key>" or "<root key>/<sub/folder>"). */
function folderOf(folderId: string): { root: Root; rel: string; abs: string } {
  const [key, ...rest] = String(folderId).split('/')
  const root = folderRoots().find((r) => r.key === key && !!r.meta)
  const rel = rest.join('/')
  const abs = root && (rel ? resolveInLibrary(root.path, rel) : root.path)
  if (!root || !abs) throw new Error(t('Thư mục này không nằm trong workspace.'))
  return { root, rel, abs }
}

/** A document, or a folder below a workspace folder, by id. Only inside workspace folders. */
function itemOf(id: string, isFolder: boolean): { root: Root; rel: string; abs: string } {
  if (isFolder) {
    const f = folderOf(id)
    if (!f.rel) throw new Error(t('Không đổi được chính thư mục gốc của workspace; hãy làm trong Explorer.'))
    return f
  }
  const loc = locate(String(id))
  if (!loc || loc.root.loose || !loc.root.meta) throw new Error(t('Chỉ làm được với file trong thư mục workspace.'))
  return loc
}

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

/** Reads a folder again right away (the watcher would too, a moment later) and tells the window. */
async function refreshRoot(root: Root): Promise<void> {
  root.docs = await scanRoot(root)
  await reconcileStores(root)
  syncSearch()
  await pushSnapshot()
}

/** Tags, notes, calendar links and OCR text follow a file or folder that the app renamed or moved. */
async function followMove(root: Root, fromRel: string, toRel: string, fromAbs: string, toAbs: string): Promise<void> {
  for (const store of storesOf(root)) await store.moveEntries(fromRel, toRel)
  await calendar?.movePath(fromAbs, toAbs, pathKey)
  await moveOcr(fromAbs, toAbs, docsUnder(root, fromRel), root.path)
}

/** Paths of the documents that are `rel` or below it (before a move). */
const docsUnder = (root: Root, rel: string): string[] => root.docs.filter((d) => d.path === rel || d.path.startsWith(`${rel}/`)).map((d) => d.path)

/** Creates a note in a folder. Resolves with its id. */
async function newNote(folderId: string, name: string, kind: NoteKind): Promise<string> {
  const folder = folderOf(folderId)
  const file = noteFileName(name, kind)
  const abs = path.join(folder.abs, file)
  if (await exists(abs)) throw new Error(t('Đã có "{0}" trong thư mục này.', { 0: file }))
  await fs.mkdir(folder.abs, { recursive: true })
  await fs.writeFile(abs, noteTemplate(file, kind), { encoding: 'utf8', flag: 'wx' })
  await refreshRoot(folder.root)
  return `${folder.root.key}/${relOf(folder.root, abs)}`
}

async function renameItem(id: string, isFolder: boolean, name: string): Promise<string> {
  const item = itemOf(id, isFolder)
  const next = isFolder ? checkName(name) : renamedFileName(name, path.basename(item.abs))
  const target = path.join(path.dirname(item.abs), next)
  if (target === item.abs) return id
  // Only the letter case changes: same file on Windows, so no clash.
  if (pathKey(target) !== pathKey(item.abs) && (await exists(target))) throw new Error(t('Đã có "{0}" trong thư mục này.', { 0: next }))
  await fs.rename(item.abs, target)
  const toRel = relOf(item.root, target)
  await followMove(item.root, item.rel, toRel, item.abs, target)
  await refreshRoot(item.root)
  return `${item.root.key}/${toRel}`
}

async function moveItem(id: string, isFolder: boolean, targetFolderId: string): Promise<string> {
  const item = itemOf(id, isFolder)
  const folder = folderOf(targetFolderId)
  if (isFolder && isSameOrInside(folder.abs, item.abs)) throw new Error(t('Không chuyển được thư mục vào chính nó.'))
  const target = path.join(folder.abs, path.basename(item.abs))
  if (pathKey(target) === pathKey(item.abs)) return id
  if (await exists(target)) throw new Error(t('Đã có "{0}" trong thư mục này.', { 0: path.basename(item.abs) }))
  try {
    await fs.rename(item.abs, target)
  } catch (err) {
    // Another drive: copy, then remove the original (only once the copy is complete).
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.cp(item.abs, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await fs.rm(item.abs, { recursive: true })
  }
  const toRel = relOf(folder.root, target)
  if (folder.root === item.root) {
    await followMove(item.root, item.rel, toRel, item.abs, target)
  } else {
    // Into another workspace folder: tags and notes move to that folder's data.
    const moveData = async <V extends DocKeyed>(from: DocStore<V> | null, to: DocStore<V> | null): Promise<void> => {
      if (!from || !to) return
      const taken = await from.takeEntries(item.rel)
      await to.importDocs(Object.fromEntries(Object.entries(taken).map(([suffix, v]) => [toRel + suffix, v])))
    }
    await moveData(item.root.meta, folder.root.meta)
    await moveData(item.root.notes, folder.root.notes)
    await calendar?.movePath(item.abs, target, pathKey)
    await moveOcr(item.abs, target, docsUnder(item.root, item.rel), item.root.path)
    await refreshRoot(item.root)
  }
  await refreshRoot(folder.root)
  return `${folder.root.key}/${toRel}`
}

/** To the Recycle Bin (can be restored from there; tags and notes are kept until cleaned up). */
async function trashItem(id: string, isFolder: boolean): Promise<void> {
  const item = itemOf(id, isFolder)
  await shell.trashItem(item.abs)
  await refreshRoot(item.root)
}

/**
 * A pasted image saved next to a note (Settings: "save in assets/"): <note folder>\assets\<note>-<n>.<ext>.
 * Resolves with the path to write in the note ("assets/…", forward slashes).
 */
async function saveAsset(docId: string, bytes: Uint8Array, ext: string): Promise<string> {
  const loc = locate(String(docId))
  if (!loc || !loc.root.docs.some((d) => d.path === loc.rel)) throw new Error(t('Không tìm thấy tài liệu này.'))
  if (!['webp', 'png', 'jpg', 'gif'].includes(ext)) throw new Error(t('Định dạng ảnh không được hỗ trợ.'))
  if (!(bytes instanceof Uint8Array) || bytes.length > 50 * 1024 * 1024) throw new Error(t('Ảnh quá lớn.'))
  const dir = path.join(path.dirname(loc.abs), 'assets')
  await fs.mkdir(dir, { recursive: true })
  // Spaces and brackets would need escaping in a Markdown link.
  const base = path.basename(loc.abs).replace(/\.[^.]+$/, '').replace(/[\s#?%()[\]<>"'`]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'image'
  for (let n = 1; n < 10000; n++) {
    const name = `${base}-${n}.${ext}`
    try {
      await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' })
      return `assets/${name}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(t('Không lưu được ảnh.'))
}

// ---------- OCR of scanned PDFs (the reading itself runs in the window, see lib/ocr.ts) ----------

const ocrDir = (): string => path.join(app.getPath('userData'), 'ocr')
/** OCR results are kept by file path: <ocr>\<sha1 of the path>.json. */
const ocrKey = (abs: string): string => createHash('sha1').update(pathKey(abs)).digest('hex')
const ocrFile = (abs: string): string => path.join(ocrDir(), `${ocrKey(abs)}.json`)
/** Which files have OCR text (key -> when it was saved), so search can include it. */
const ocrIndex = new Map<string, number>()

async function loadOcrIndex(): Promise<void> {
  for (const name of await fs.readdir(ocrDir()).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    const st = await fs.stat(path.join(ocrDir(), name)).catch(() => null)
    if (st) ocrIndex.set(name.slice(0, -5), st.mtimeMs)
  }
}

/** Checks what the window sends: pages of words with numeric boxes. */
function cleanOcr(data: unknown): OcrData {
  const d = data as Partial<OcrData>
  if (!d || !Array.isArray(d.pages)) throw new Error(t('Kết quả nhận dạng không hợp lệ.'))
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    version: 1,
    at: Date.now(),
    pages: d.pages.slice(0, 5000).map((p) => ({
      n: Math.max(1, Math.floor(num(p?.n))),
      words: (Array.isArray(p?.words) ? p.words : []).slice(0, 20000).map((w) => ({ t: String(w?.t ?? '').slice(0, 200), x0: num(w?.x0), y0: num(w?.y0), x1: num(w?.x1), y1: num(w?.y1) }))
    }))
  }
}

/** OCR text follows a PDF (or the PDFs in a folder) that the app renamed or moved. */
async function moveOcr(fromAbs: string, toAbs: string, rels: string[], fromRoot: string): Promise<void> {
  for (const rel of rels) {
    const from = path.join(fromRoot, rel)
    const key = ocrKey(from)
    if (!ocrIndex.has(key)) continue
    const to = path.join(toAbs, path.relative(fromAbs, from))
    await fs.rename(ocrFile(from), ocrFile(to)).catch(() => {})
    ocrIndex.set(ocrKey(to), ocrIndex.get(key)!)
    ocrIndex.delete(key)
  }
}

function registerFileIpc(): void {
  ipcMain.handle('ocr:load', async (_e, id: string) => {
    const loc = locate(String(id))
    if (!loc) return null
    try {
      return JSON.parse(await fs.readFile(ocrFile(loc.abs), 'utf8')) as OcrData
    } catch {
      return null
    }
  })
  ipcMain.handle('ocr:save', async (_e, id: string, data: unknown) => {
    const loc = locate(String(id))
    if (!loc || kindOf(loc.abs) !== 'pdf') throw new Error(t('Không tìm thấy tài liệu này.'))
    const clean = cleanOcr(data)
    await fs.mkdir(ocrDir(), { recursive: true })
    await fs.writeFile(ocrFile(loc.abs), JSON.stringify(clean), 'utf8')
    ocrIndex.set(ocrKey(loc.abs), clean.at)
    syncSearch() // the search worker reads the new text
  })
  ipcMain.handle('doc:saveAsset', (_e, docId: string, bytes: Uint8Array, ext: string) => saveAsset(String(docId), bytes, String(ext)))
  const str = (v: unknown): string => String(v ?? '')
  const kindOfNote = (v: unknown): NoteKind => (v === 'html' ? 'html' : 'md')
  ipcMain.handle('fs:newNote', (_e, folderId: string, name: string, kind: NoteKind) => newNote(str(folderId), str(name), kindOfNote(kind)))
  // A new folder, with a first note in it when a name is given. Resolves with the note's id, or null.
  ipcMain.handle('fs:newFolder', async (_e, folderId: string, folderName: string, noteName: string, kind: NoteKind) => {
    const folder = folderOf(str(folderId))
    const name = checkName(str(folderName))
    const abs = path.join(folder.abs, name)
    if (await exists(abs)) throw new Error(t('Đã có "{0}" trong thư mục này.', { 0: name }))
    const note = str(noteName).trim()
    if (note) noteFileName(note, kindOfNote(kind)) // check the note's name before creating anything
    await fs.mkdir(abs)
    const rel = relOf(folder.root, abs)
    if (!note) {
      await refreshRoot(folder.root)
      return null
    }
    return newNote(`${folder.root.key}/${rel}`, note, kindOfNote(kind))
  })
  ipcMain.handle('fs:rename', (_e, id: string, isFolder: boolean, name: string) => renameItem(str(id), !!isFolder, str(name)))
  ipcMain.handle('fs:move', (_e, id: string, isFolder: boolean, targetFolderId: string) => moveItem(str(id), !!isFolder, str(targetFolderId)))
  ipcMain.handle('fs:trash', (_e, id: string, isFolder: boolean) => trashItem(str(id), !!isFolder))
}

// ---------- calendar ----------

const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b)
const cal = (): CalendarStore => {
  if (!calendar) throw new Error(t('Lịch chưa sẵn sàng, hãy thử lại.'))
  return calendar
}

/** What is remembered of a document linked to an event: its path, plus hash and name to find it after a move. */
function linkOfDoc(id: string): StoredLink {
  const loc = locate(String(id))
  const doc = loc?.root.docs.find((d) => d.path === loc.rel)
  if (!loc || !doc) throw new Error(t('Không tìm thấy tài liệu này.'))
  return { path: loc.abs, name: doc.name, ...(doc.hash ? { hash: doc.hash } : {}) }
}

/**
 * Finds a linked file: at its path, else (renamed or moved, a folder that changed drive letter)
 * the one document with the same content. The new path is remembered.
 */
function resolveLink(l: StoredLink): { id: string; title: string; abs: string } | null {
  const root = rootOfFile(l.path)
  if (root) {
    const rel = relOf(root, l.path)
    const d = root.docs.find((x) => x.path === rel)
    if (d) return { id: `${root.key}/${rel}`, title: d.title, abs: l.path }
  }
  if (l.hash) {
    const found = roots.flatMap((r) => r.docs.filter((d) => d.hash === l.hash).map((d) => ({ r, d })))
    if (found.length === 1) {
      const { r, d } = found[0]
      const abs = path.join(r.path, d.path)
      void calendar?.updateLinkPath(l.path, { path: abs, name: d.name, hash: l.hash })
      return { id: `${r.key}/${d.path}`, title: d.title, abs }
    }
  }
  return null
}

/** A folder of the workspace by its id in the sidebar tree ("<root key>" or "<root key>/<sub/folder>"). */
async function folderLink(folderId: string): Promise<StoredLink> {
  const [key, ...rest] = String(folderId).split('/')
  const root = folderRoots().find((r) => r.key === key)
  const rel = rest.join('/')
  const abs = root && (rel ? resolveInLibrary(root.path, rel) : root.path)
  const isDir = abs ? await fs.stat(abs).then((st) => st.isDirectory(), () => false) : false
  if (!root || !abs || !isDir) throw new Error(t('Thư mục này không nằm trong workspace.'))
  return { path: abs, name: rel ? path.basename(abs) : root.name, kind: 'folder' }
}

/** The documents in a linked folder now (it must be in a workspace folder). */
function resolveFolder(l: StoredLink): { id: string; docs: { id: string; title: string; kind: string }[] } | null {
  const root = folderRoots()
    .filter((r) => isSameOrInside(l.path, r.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!root) return null
  const rel = relOf(root, l.path)
  const docs = root.docs
    .filter((d) => !rel || d.path.startsWith(`${rel}/`))
    .sort((a, b) => a.path.localeCompare(b.path, 'vi'))
    .map((d) => ({ id: `${root.key}/${d.path}`, title: d.title, kind: d.kind }))
  return { id: rel ? `${root.key}/${rel}` : root.key, docs }
}

function calendarDetail(uid: string, rid: string): CalEventDetail {
  const store = cal()
  const occurrence = store.occurrence(uid, rid)
  const series = store.series(uid)
  if (!occurrence || !series) throw new Error(t('Sự kiện này không còn trong lịch.'))
  const links = store.linksOf(uid, rid).map(({ scope, link }): CalLinkView => {
    if (link.kind === 'folder') {
      const folder = resolveFolder(link)
      return { kind: 'folder', id: folder?.id ?? null, path: link.path, title: link.name, scope, docs: folder?.docs ?? [] }
    }
    const found = resolveLink(link)
    return { kind: 'file', id: found?.id ?? null, path: found?.abs ?? link.path, title: found?.title ?? link.name, scope }
  })
  return { occurrence, series, links, notesFolder: store.notesFolder(uid) }
}

/** The classes (and courses) a document is linked to. */
function calendarRefsFor(id: string): CalDocRef[] {
  if (!calendar) return []
  const loc = locate(String(id))
  if (!loc) return []
  const hash = loc.root.docs.find((d) => d.path === loc.rel)?.hash
  const own = (l: StoredLink): boolean => l.kind !== 'folder' && (samePath(l.path, loc.abs) || (!!hash && l.hash === hash && resolveLink(l)?.abs === loc.abs))
  const inFolder = (l: StoredLink): boolean => l.kind === 'folder' && isSameOrInside(loc.abs, l.path) && !loc.root.loose
  const out: CalDocRef[] = []
  for (const { uid, rid } of calendar.refsTo((l) => own(l) || inFolder(l))) {
    const occ = rid ? calendar.occurrence(uid, rid) : nextStart(calendar, uid)
    if (!occ || out.some((r) => r.uid === uid && r.rid === rid)) continue
    // Linked on its own, or only through a folder it is in (the chip then names the folder).
    const here = calendar.linksOf(uid, rid ?? '').filter((x) => x.scope === (rid ? 'this' : 'series')).map((x) => x.link)
    const viaFolder = here.some(own) ? null : (here.find(inFolder)?.name ?? null)
    out.push({ uid, rid, at: occ.rid, summary: occ.summary, color: occ.color, start: occ.start, allDay: occ.allDay, folder: viaFolder })
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1))
}

async function chooseNotesFolder(uid: string): Promise<string | null> {
  const store = cal()
  const summary = store.series(uid)?.summary ?? ''
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: t('Chọn thư mục lưu ghi chép của "{0}"', { 0: summary }),
    defaultPath: store.notesFolder(uid) ?? folderRoots()[0]?.path,
    properties: ['openDirectory', 'createDirectory']
  })
  if (canceled || !filePaths[0]) return null
  await store.setNotesFolder(uid, filePaths[0])
  return filePaths[0]
}

/**
 * "Notes for this class": <notes folder>\<course>\<date>.md, created from a small template
 * (an existing file is opened, never overwritten) and linked to the class. Resolves with its id.
 */
async function classNotes(uid: string, rid: string): Promise<string | null> {
  const store = cal()
  const occ = store.occurrence(uid, rid)
  if (!occ) throw new Error(t('Sự kiện này không còn trong lịch.'))
  let folder = store.notesFolder(uid)
  const isDir = folder ? await fs.stat(folder).then((st) => st.isDirectory(), () => false) : false
  if (!folder || !isDir) folder = await chooseNotesFolder(uid)
  if (!folder) return null
  const course = occ.summary.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/[. ]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Lich'
  const file = path.join(folder, course, `${occ.start.slice(0, 10)}.md`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const lines = [
    `# ${occ.summary} — ${formatDate(occ.start)}`,
    '',
    `- ${t('Thời gian')}: ${formatTimeRange(occ.start, occ.end, occ.allDay)}`,
    ...(occ.location ? [`- ${t('Địa điểm')}: ${occ.location}`] : []),
    '',
    `## ${t('Ghi chép')}`,
    '',
    ''
  ]
  try {
    await fs.writeFile(file, lines.join('\n'), { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  await store.link(uid, rid, { path: file, name: path.basename(file) }, samePath)
  const inFolder = folderRoots().find((r) => isSameOrInside(file, r.path))
  if (inFolder) {
    inFolder.docs = await scanRoot(inFolder)
    syncSearch()
    await pushSnapshot()
    return `${inFolder.key}/${relOf(inFolder, file)}`
  }
  const [id] = await addFiles([file])
  return id ?? null
}

// ---------- calendars followed by link ----------

/** A calendar bigger than this is refused (a link to the wrong file must not fill the memory). */
const MAX_SUBSCRIPTION_BYTES = 20 * 1024 * 1024

/**
 * The body of a response as text, read piece by piece: stops (and cancels the download) as soon
 * as it is bigger than `max` bytes, instead of reading it all first.
 */
async function readLimited(res: Response, max: number, controller: AbortController): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > max) {
    controller.abort()
    throw new Error(t('Lịch quá lớn.'))
  }
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      controller.abort()
      throw new Error(t('Lịch quá lớn.'))
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

/** Downloads one subscribed calendar (webcal:// is https://). Never throws; the error is kept. */
async function fetchSubscription(id: string): Promise<void> {
  const sub = calendar?.subscriptions().find((s) => s.id === id)
  if (!sub || !calendar) return
  try {
    const url = new URL(sub.url.replace(/^webcals?:\/\//i, 'https://'))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(t('Chỉ theo dõi được link http(s) hoặc webcal.'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await net.fetch(url.href, { signal: controller.signal })
      if (!res.ok) throw new Error(t('Máy chủ trả về lỗi {0}.', { 0: res.status }))
      const ics = await readLimited(res, MAX_SUBSCRIPTION_BYTES, controller)
      await calendar.setSubscriptionData(id, { ics })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    await calendar.setSubscriptionData(id, { error: err instanceof Error && err.name !== 'TimeoutError' && err.name !== 'AbortError' ? err.message : t('Không tải được (mất mạng hoặc link sai).') })
  }
}

async function refreshSubscriptions(): Promise<void> {
  for (const s of calendar?.subscriptions() ?? []) await fetchSubscription(s.id)
  win?.webContents.send('calendar:changed')
}

// ---------- reminders ----------

/** Reminders already shown in this run (uid|rid|minutes -> when it was due), forgotten after two days. */
const remindersShown = new Map<string, number>()

/**
 * Shows a Windows notification for every class whose reminder time has come (in the last five
 * minutes, so a reminder missed while the PC slept or the app was closed is not shown late).
 * Clicking it opens that class in the calendar.
 */
function checkReminders(): void {
  if (!calendar || !Notification.isSupported()) return
  const now = Date.now()
  const today = new Date()
  const from = ymd(new Date(now - 86_400_000))
  const to = ymd(new Date(now + 2 * 86_400_000))
  for (const [key, at] of remindersShown) if (now - at > 2 * 86_400_000) remindersShown.delete(key)
  for (const o of calendar.occurrences(from, to)) {
    if (o.reminder < 0) continue
    const start = new Date(o.allDay ? `${o.start}T00:00` : o.start).getTime()
    const at = start - o.reminder * 60_000
    const key = `${o.uid}|${o.rid}|${o.reminder}`
    if (now < at || now - at > 5 * 60_000 || remindersShown.has(key)) continue
    remindersShown.set(key, at)
    const when = o.allDay ? formatShortDate(o.start) : `${o.start.slice(0, 10) === ymd(today) ? '' : `${formatShortDate(o.start)} `}${formatTimeRange(o.start, o.end, false)}`
    const note = new Notification({ title: o.summary, body: [when, o.location].filter(Boolean).join(' · '), silent: false })
    note.on('click', () => {
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('calendar:focus', { date: o.start, uid: o.uid, rid: o.rid })
    })
    note.show()
  }
}

function registerCalendarIpc(): void {
  ipcMain.handle('calendar:subscriptions', () => cal().subscriptions())
  ipcMain.handle('calendar:addSubscription', async (_e, name: string, url: string, color: string) => {
    const link = String(url ?? '').trim()
    if (!/^(https?|webcals?):\/\/\S+$/i.test(link)) throw new Error(t('Hãy dán link của lịch (bắt đầu bằng https:// hoặc webcal://).'))
    const id = await cal().addSubscription(String(name ?? ''), link, /^[a-z]{3,20}$/i.test(String(color)) ? String(color) : '')
    await fetchSubscription(id)
    return cal().subscriptions()
  })
  ipcMain.handle('calendar:removeSubscription', async (_e, id: string) => {
    await cal().removeSubscription(String(id))
    return cal().subscriptions()
  })
  ipcMain.handle('calendar:refreshSubscriptions', async () => {
    await refreshSubscriptions()
    return cal().subscriptions()
  })
  const str = (v: unknown): string => String(v ?? '')
  const scopeOf = (v: unknown): EditScope => (v === 'this' || v === 'following' ? v : 'all')
  ipcMain.handle('calendar:range', (_e, from: string, to: string) => cal().occurrences(str(from), str(to)))
  ipcMain.handle('calendar:detail', (_e, uid: string, rid: string) => calendarDetail(str(uid), str(rid)))
  ipcMain.handle('calendar:create', (_e, data: CalEventData) => cal().create(data))
  ipcMain.handle('calendar:update', (_e, uid: string, rid: string, scope: EditScope, shownStart: string, data: CalEventData) =>
    cal().update(str(uid), str(rid), scopeOf(scope), str(shownStart), data)
  )
  ipcMain.handle('calendar:delete', (_e, uid: string, rid: string, scope: EditScope) => cal().delete(str(uid), str(rid), scopeOf(scope)))
  ipcMain.handle('calendar:preview', (_e, data: CalEventData) => previewStarts(data))
  ipcMain.handle('calendar:link', (_e, uid: string, rid: string | null, docId: string) => cal().link(str(uid), rid ? str(rid) : null, linkOfDoc(docId), samePath))
  ipcMain.handle('calendar:linkFolder', async (_e, uid: string, rid: string | null, folderId: string) =>
    cal().link(str(uid), rid ? str(rid) : null, await folderLink(str(folderId)), samePath)
  )
  // Files from anywhere on the PC: opened like Ctrl+O (outside the workspace they go to "File lẻ"), then linked.
  ipcMain.handle('calendar:linkFiles', async (_e, uid: string, rid: string | null) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: t('Chọn tài liệu để gắn vào lịch'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('Tài liệu'), extensions: ['md', 'markdown', 'html', 'htm', 'pdf', 'docx', 'txt', 'csv', 'xlsx', 'epub', 'mobi', 'azw3', 'azw'] },
        { name: t('Ảnh'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] }
      ]
    })
    if (canceled || !filePaths.length) return 0
    const ids = await addFiles(filePaths)
    for (const id of ids) await cal().link(str(uid), rid ? str(rid) : null, linkOfDoc(id), samePath)
    return ids.length
  })
  ipcMain.handle('calendar:unlink', (_e, uid: string, rid: string | null, file: string) => cal().unlink(str(uid), rid ? str(rid) : null, str(file), samePath))
  ipcMain.handle('calendar:forDoc', (_e, id: string) => calendarRefsFor(id))
  ipcMain.handle('calendar:classNotes', (_e, uid: string, rid: string) => classNotes(str(uid), str(rid)))
  ipcMain.handle('calendar:notesFolder', (_e, uid: string) => chooseNotesFolder(str(uid)))
  ipcMain.handle('calendar:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: t('Xuất lịch ra file .ics'),
      defaultPath: path.join(app.getPath('documents'), 'Study Docs.ics'),
      filters: [{ name: t('Lịch iCalendar'), extensions: ['ics'] }]
    })
    if (canceled || !filePath) return null
    await fs.writeFile(filePath, cal().toIcs(), 'utf8')
    return filePath
  })
  ipcMain.handle('calendar:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: t('Nhập lịch từ file .ics'),
      properties: ['openFile'],
      filters: [{ name: t('Lịch iCalendar'), extensions: ['ics'] }]
    })
    if (canceled || !filePaths[0]) return null
    return cal().merge({ ics: await fs.readFile(filePaths[0], 'utf8') })
  })
}

// ---------- backup ("Sao lưu dữ liệu") ----------

/** A backup file: every folder's tags/status and highlights/notes, keyed by the folder's path. */
interface BackupFile {
  app: 'study-docs'
  kind: 'backup'
  version: 1
  exported: string
  folders: { path: string; loose: boolean; meta: Record<string, unknown>; notes: Record<string, unknown> }[]
  /** The calendar and the documents linked to it (since v0.12). */
  calendar?: CalendarBackup
}

/** Everything in the data folder, also of folders that are not in the workspace right now. */
async function exportData(): Promise<BackupFile> {
  const folders: BackupFile['folders'] = []
  const base = path.join(app.getPath('userData'), 'data')
  const readDocs = async (file: string): Promise<Record<string, unknown>> => {
    try {
      return (JSON.parse(await fs.readFile(file, 'utf8')) as { docs?: Record<string, unknown> }).docs ?? {}
    } catch {
      return {}
    }
  }
  for (const key of await fs.readdir(base).catch(() => [] as string[])) {
    const open = roots.find((r) => r.key === key)
    let info: { path?: string; loose?: boolean } = {}
    try {
      info = JSON.parse(await fs.readFile(path.join(base, key, 'info.json'), 'utf8'))
    } catch {
      // unknown folder: skipped below
    }
    const folderPath = open?.path ?? info.path
    if (typeof folderPath !== 'string') continue
    const meta = open?.meta ? open.meta.all() : await readDocs(path.join(base, key, 'meta.json'))
    const notes = open?.notes ? open.notes.all() : await readDocs(path.join(base, key, 'notes.json'))
    if (Object.keys(meta).length || Object.keys(notes).length) folders.push({ path: folderPath, loose: open?.loose ?? !!info.loose, meta, notes })
  }
  return { app: 'study-docs', kind: 'backup', version: 1, exported: new Date().toISOString(), folders, ...(calendar ? { calendar: calendar.backup() } : {}) }
}

/** Merges a backup into the current data (nothing current is lost). Returns how many documents it had. */
async function importData(raw: string): Promise<number> {
  let backup: BackupFile
  try {
    backup = JSON.parse(raw)
  } catch {
    throw new Error(t('File này không phải bản sao lưu của Study Docs.'))
  }
  if (backup?.app !== 'study-docs' || !Array.isArray(backup.folders)) throw new Error(t('File này không phải bản sao lưu của Study Docs.'))
  const STATUSES = ['new', 'learning', 'review', 'done']
  let n = 0
  for (const folder of backup.folders) {
    if (typeof folder?.path !== 'string') continue
    const key = rootKeyOf(folder.path)
    const cleanMeta: Record<string, DocMeta> = {}
    for (const [rel, m] of Object.entries(folder.meta ?? {})) {
      const v = m as Partial<DocMeta>
      if (!v || typeof v !== 'object') continue
      cleanMeta[rel] = {
        tags: Array.isArray(v.tags) ? v.tags.map(String).slice(0, 100) : [],
        status: STATUSES.includes(v.status as string) ? (v.status as DocMeta['status']) : 'new',
        ...(typeof v.hash === 'string' ? { hash: v.hash } : {}),
        ...(typeof v.name === 'string' ? { name: v.name } : {})
      }
    }
    const cleanNotes: Parameters<NotesStore['importDocs']>[0] = {}
    for (const [rel, e] of Object.entries(folder.notes ?? {})) {
      const v = e as { items?: Partial<Annotation>[]; docNote?: { text?: unknown; updated?: unknown }; hash?: unknown; name?: unknown }
      if (!v || typeof v !== 'object') continue
      const items: Annotation[] = []
      for (const item of Array.isArray(v.items) ? v.items : []) {
        try {
          // Keep the original time, so the newer copy wins when the same note exists here too.
          items.push({ ...sanitizeAnnotation(item), updated: typeof item.updated === 'number' ? item.updated : 0 })
        } catch {
          // skip broken entries
        }
      }
      const text = typeof v.docNote?.text === 'string' ? v.docNote.text.slice(0, 50000) : ''
      cleanNotes[rel] = {
        items,
        ...(text ? { docNote: { text, updated: typeof v.docNote?.updated === 'number' ? v.docNote.updated : 0 } } : {}),
        ...(typeof v.hash === 'string' ? { hash: v.hash } : {}),
        ...(typeof v.name === 'string' ? { name: v.name } : {})
      }
    }

    // Where it goes: the folder at that path; else (another PC, a renamed folder...) a folder
    // of the workspace whose files match, if you pick it; else kept under the old path.
    let target = roots.find((r) => r.key === key)
    if (!target) {
      const entries: Record<string, Remembered> = { ...cleanMeta, ...cleanNotes }
      const candidates = folderRoots()
        .filter((r) => r.meta)
        .map((r) => ({ r, score: matchScore(entries, r.docs) }))
        .filter((c) => looksLikeSameFolder(c.score))
        .sort((a, b) => b.score.matched - a.score.matched)
        .slice(0, 3)
      if (candidates.length) {
        const answer = await askInWindow({
          message: t('Bản sao lưu có dữ liệu của "{0}", thư mục này không có trong workspace.', { 0: folder.path }),
          detail: t('Các thư mục dưới đây có file trùng với dữ liệu đó. Gắn tag và ghi chú vào thư mục nào?'),
          buttons: [...candidates.map((c) => c.r.name), t('Giữ theo đường dẫn cũ')],
          cancelId: candidates.length
        })
        target = candidates[answer]?.r
      }
    }
    const moved = !!target && target.key !== key
    if (!target) {
      await fs.mkdir(dataDirOf(key), { recursive: true })
      await writeDataInfo({ key, path: normalizeRoot(folder.path), loose: !!folder.loose })
    }
    const meta = target?.meta ?? (await MetaStore.open(dataDirOf(key)))
    const notes = target?.notes ?? (await NotesStore.open(dataDirOf(key)))
    await meta.importDocs(moved ? remapEntries(cleanMeta, target!.docs) : cleanMeta)
    await notes.importDocs(moved ? remapEntries(cleanNotes, target!.docs) : cleanNotes)
    n += new Set([...Object.keys(cleanMeta), ...Object.keys(cleanNotes)]).size
  }
  if (backup.calendar && typeof backup.calendar === 'object' && calendar) n += await calendar.merge(backup.calendar)
  return n
}

/**
 * Opens a library file with its default app. Only safe types are opened (see open-policy.ts);
 * anything else is shown in Explorer. `fromPage`: the request came from inside a document
 * (a link or a script in an HTML page), not from you clicking in the app, so ask first.
 */
async function openLibraryFile(rel: string, fromPage = false): Promise<void> {
  const abs = inLibrary(rel)
  if (!abs) throw new Error(t('File nằm ngoài thư mục tài liệu'))
  if (!canOpenWithDefaultApp(abs)) {
    shell.showItemInFolder(abs)
    return
  }
  if (fromPage && win) {
    const response = await askInWindow({
      message: t('Bài đang đọc muốn mở "{0}" bằng ứng dụng mặc định của Windows.', { 0: path.basename(abs) }),
      buttons: [t('Mở'), t('Không')],
      cancelId: 1
    })
    if (response !== 0) return
  }
  const error = await shell.openPath(abs)
  if (error) throw new Error(error)
}

/**
 * Writes a document only if it still has the modified time the editor started from,
 * so an edit never silently overwrites a change made in another program.
 * Writes to a hidden temp file first, then renames it over the original.
 */
async function writeDocChecked(rel: string, build: (current: string) => string, expectedMtime: number): Promise<number> {
  const abs = inLibrary(rel)
  const kind = abs ? kindOf(abs) : null
  if (!abs || (kind !== 'md' && kind !== 'html')) throw new Error(t('Chỉ sửa được file .md / .html trong thư mục tài liệu.'))
  const stat = await fs.stat(abs)
  if (Math.abs(stat.mtimeMs - expectedMtime) > 1) {
    throw new Error(t('File vừa bị thay đổi bên ngoài app. Bài đã được tải lại; hãy sửa lại thay đổi của bạn.'))
  }
  // Refuse files that aren't UTF-8: saving them as UTF-8 would garble their text (issue #4).
  const content = build(decodeUtf8Strict(await fs.readFile(abs)))
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.studydocs-tmp`)
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, abs)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw friendlyWriteError(err)
  }
  return (await fs.stat(abs)).mtimeMs
}

/**
 * The accent colour of the reading style of HTML notes (page-style.ts). Kept here, set at start
 * and when the settings change: a page being served must not wait on, or fail with, the
 * settings file (it may be in the middle of being written).
 */
let pageAccent = '#b4531f'

/** Spreadsheets bigger than this are not opened in the app. */
const MAX_SHEET_BYTES = 30 * 1024 * 1024

/**
 * Saves a spreadsheet: CSV rows (unchanged ones byte for byte) or XLSX cell edits. Like
 * writeDocChecked, refused if the file changed since it was read; written through a temp file.
 */
async function saveSheet(rel: string, payload: SheetSave, expectedMtime: number): Promise<number> {
  const abs = inLibrary(rel)
  if (!abs || kindOf(abs) !== 'sheet') throw new Error(t('Không phải file CSV / XLSX.'))
  const isXlsx = abs.toLowerCase().endsWith('.xlsx')
  const stat = await fs.stat(abs)
  if (Math.abs(stat.mtimeMs - expectedMtime) > 1) {
    throw new Error(t('File vừa bị thay đổi bên ngoài app. Bài đã được tải lại; hãy sửa lại thay đổi của bạn.'))
  }
  const current = await fs.readFile(abs)
  let content: Uint8Array | string
  if (payload?.format === 'csv' && !isXlsx && Array.isArray(payload.rows)) {
    const file = parseCsv(decodeUtf8Strict(current))
    const rows = payload.rows.map((r) => ({
      orig: Number.isInteger(r?.orig) && r.orig! >= 0 && r.orig! < file.rows.length ? r.orig : undefined,
      cells: Array.isArray(r?.cells) ? r.cells.map((c) => String(c ?? '')) : []
    }))
    content = writeCsv(file, rows)
  } else if (payload?.format === 'xlsx' && isXlsx && Array.isArray(payload.edits)) {
    const edits = payload.edits.map((e) => ({ sheet: Number(e?.sheet), row: Number(e?.row), col: Number(e?.col), text: String(e?.text ?? '') }))
    content = await applyXlsxEdits(current, edits)
  } else {
    throw new Error(t('Không phải file CSV / XLSX.'))
  }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.studydocs-tmp`)
  try {
    await fs.writeFile(tmp, content)
    await fs.rename(tmp, abs)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw friendlyWriteError(err)
  }
  return (await fs.stat(abs)).mtimeMs
}

/** Export to PDF: the page may draw itself, but not read other files or open connections. */
/**
 * The hidden windows that print a page to PDF. A page there is not in the sandboxed iframe,
 * so it could read pictures of the library (through a canvas) and send them out in the
 * address of an image. So these windows may not reach the internet at all, except the
 * Google Fonts servers many pages use for their fonts. Pictures from the web are left out
 * of the PDF; pictures on the PC are shown as usual.
 */
/**
 * Export windows, with the web pictures each may load: for a Markdown note any picture (the app
 * draws it, no script of the note runs); for an HTML page only the pictures written in its file.
 * A page's script could otherwise draw another picture of the library on a canvas and send it
 * out in an address it makes up.
 */
const printContents = new Map<number, Set<string> | 'any'>()

/** Web pictures written in an HTML file (<img src>, srcset, CSS url()). */
function webPicturesIn(source: string): Set<string> {
  const out = new Set<string>()
  const add = (u: string): void => {
    try {
      const url = new URL(u.replace(/&amp;/g, '&'))
      if (url.protocol === 'http:' || url.protocol === 'https:') out.add(url.href)
    } catch {
      // not a full address
    }
  }
  for (const m of source.matchAll(/\b(?:src|href|poster)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) add(m[1])
  for (const m of source.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0])
  for (const m of source.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)/gi)) add(m[1])
  return out
}
const PRINT_ALLOWED_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])
function blockNetworkForPrinting(): void {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const allowed = details.webContentsId === undefined ? undefined : printContents.get(details.webContentsId)
    if (allowed === undefined) return callback({})
    let host = ''
    try {
      host = new URL(details.url).hostname
    } catch {
      // not a URL: blocked
    }
    // Pictures of the note itself load, so the PDF has them as the screen does (see printContents).
    const picture = details.resourceType === 'image' && (allowed === 'any' ? /^https?:$/.test(new URL(details.url).protocol) : allowed.has(details.url))
    callback({ cancel: !(details.method === 'GET' && (PRINT_ALLOWED_HOSTS.has(host) || picture)) })
  })
}

const PRINT_CSP = "connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'"

/**
 * Prints a document to PDF in a hidden window: HTML pages as they are (without the app's
 * helper script), Markdown through the app's own renderer (#print=<id>, see PrintPage.tsx).
 * Always in light colours, whatever theme the app uses.
 */
async function printToPdf(id: string, kind: 'md' | 'html', withNotes: boolean): Promise<Buffer> {
  const printWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Markdown is rendered by the app's own page, which reads the file through window.api.
      preload: kind === 'md' ? path.join(__dirname, '../preload/index.js') : undefined
    }
  })
  const wc = printWin.webContents
  const printId = wc.id
  const loc = locate(id)
  printContents.set(printId, kind === 'md' ? 'any' : webPicturesIn(loc ? await fs.readFile(loc.abs, 'utf8').catch(() => '') : ''))
  const debug = (msg: string): void => {
    if (process.env.STUDYDOCS_DEBUG) console.log(`[printToPdf] ${msg}`)
  }
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
  try {
    debug('load')
    const printHash = `print=${encodeURIComponent(id)}${withNotes ? '&notes=1' : ''}`
    if (kind === 'html') {
      await printWin.loadURL(`doc://library/${id.split('/').map(encodeURIComponent).join('/')}?print=1${withNotes ? '&notes=1' : ''}`)
    } else if (process.env.ELECTRON_RENDERER_URL) {
      await printWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${printHash}`)
    } else {
      await printWin.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: printHash })
    }
    // HTML pages that have a dark mode: print them light. Done after loading and given at
    // most 3 s, so a debugger hiccup can never block the export (the page then prints as is).
    if (kind === 'html') {
      debug('emulate light')
      try {
        wc.debugger.attach('1.3')
        await Promise.race([
          wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ])
      } catch (err) {
        debug(`could not force light colours: ${(err as Error).message}`)
      }
    }

    // Wait for web fonts, images and (Markdown) diagrams before printing, but never more
    // than 15 s: a page that keeps loading must not block the export.
    debug('wait for content')
    await wc.executeJavaScript(`(async () => {
      const ready = (async () => {
        await document.fonts.ready
        await Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r })))
        if (window.__studydocsPrintReady) await window.__studydocsPrintReady
      })()
      await Promise.race([ready, new Promise((r) => setTimeout(r, 15000))])
      await new Promise((r) => setTimeout(r, 250))
    })()`)
    debug('print')

    return await wc.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.55, bottom: 0.6, left: 0.5, right: 0.5 },
      generateDocumentOutline: true, // PDF bookmarks from the headings...
      generateTaggedPDF: true, // ...which Chromium builds from the tagged structure
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#888;text-align:center;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    })
  } finally {
    printContents.delete(printId)
    printWin.destroy()
  }
}

/** Turns low-level file errors into a message that makes sense in the UI. */
function friendlyWriteError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new Error(t('Không lưu được: thư mục tài liệu chỉ đọc, hoặc file đang bị app khác khoá.'))
  }
  return new Error(t('Không lưu được: {0}', { 0: (err as Error).message }))
}

// ---------- IPC handlers (called through window.api in the UI) ----------

/** True while the window has an unsaved edit (it tells us through 'app:dirty'). */
let unsavedEdits = false

function registerIpc(): void {
  ipcMain.on('app:dirty', (_e, dirty: unknown) => {
    unsavedEdits = dirty === true
  })
  ipcMain.handle('dialog:answer', (_e, id: number, index: number) => {
    const resolve = pendingAsks.get(Number(id))
    pendingAsks.delete(Number(id))
    resolve?.(Number(index))
  })

  ipcMain.handle('library:get', async () => {
    const snap = await snapshot()
    uiReady = true
    uiIsReady()
    setTimeout(openPendingFile, 0) // after the UI got the library, so the document is in its list
    return snap
  })

  ipcMain.handle('workspace:add', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: t('Thêm thư mục vào workspace'),
      buttonLabel: t('Thêm thư mục'),
      properties: ['openDirectory', 'multiSelections']
    })
    const refused = result.canceled ? [] : await addRoots(result.filePaths)
    return { snapshot: await snapshot(), refused }
  })

  ipcMain.handle('workspace:remove', async (_e, key: string) => {
    await removeRoot(key)
    return snapshot()
  })

  // ---------- files opened on their own, backup ----------
  ipcMain.handle('files:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: t('Mở tài liệu'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('Tài liệu'), extensions: ['md', 'markdown', 'html', 'htm', 'pdf', 'docx', 'txt', 'csv', 'xlsx', 'epub', 'mobi', 'azw3', 'azw'] },
        { name: t('Ảnh'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] }
      ]
    })
    return canceled ? [] : addFiles(filePaths)
  })
  ipcMain.handle('files:add', (_e, paths: unknown) => addFiles(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []))
  ipcMain.handle('files:remove', (_e, abs: string) => removeLooseFile(String(abs)))
  ipcMain.handle('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10)
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: t('Sao lưu tag và ghi chú'),
      defaultPath: path.join(app.getPath('documents'), t('Study Docs - sao lưu {0}.json', { 0: stamp })),
      filters: [{ name: t('Sao lưu Study Docs'), extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    await fs.writeFile(filePath, JSON.stringify(await exportData(), null, 2), 'utf8')
    return filePath
  })
  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: t('Khôi phục tag và ghi chú'),
      properties: ['openFile'],
      filters: [{ name: t('Sao lưu Study Docs'), extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) return null
    const n = await importData(await fs.readFile(filePaths[0], 'utf8'))
    await pushSnapshot()
    return n
  })

  ipcMain.handle('doc:read', async (_e, rel: string) => {
    const abs = inLibrary(rel)
    if (!abs) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    return fs.readFile(abs, 'utf8')
  })

  ipcMain.handle('meta:update', async (_e, id: string, patch: Partial<DocMeta>) => {
    const loc = locate(id)
    if (!loc?.root.meta) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    // Only tags and status can be changed from the UI.
    const clean: Partial<DocMeta> = {}
    if (Array.isArray(patch.tags)) clean.tags = patch.tags.map(String)
    if (patch.status) clean.status = patch.status
    try {
      await loc.root.meta.update(loc.rel, clean, loc.root.docs.find((d) => d.path === loc.rel))
      return (await snapshot()).meta
    } catch (err) {
      throw friendlyWriteError(err)
    }
  })

  ipcMain.handle('doc:opened', async (_e, id: string) => {
    const loc = locate(id)
    if (!loc) return {}
    try {
      return recentByDoc(await markOpened(loc.abs))
    } catch (err) {
      throw friendlyWriteError(err)
    }
  })

  ipcMain.handle('doc:openPath', (_e, rel: string) => openLibraryFile(rel))

  ipcMain.handle('search', (_e, query: string) => search?.search(String(query)) ?? [])

  ipcMain.handle('doc:readBinary', async (_e, id: string) => {
    const abs = inLibrary(id)
    if (!abs) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    return new Uint8Array(await fs.readFile(abs))
  })

  ipcMain.handle('notes:save', async (_e, id: string, input: Partial<Annotation>) => {
    const loc = locate(id)
    if (!loc?.root.notes) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    const annotation = sanitizeAnnotation(input)
    try {
      return await loc.root.notes.save(loc.rel, annotation, loc.root.docs.find((d) => d.path === loc.rel))
    } catch (err) {
      throw friendlyWriteError(err)
    }
  })

  ipcMain.handle('notes:delete', async (_e, id: string, annotationId: string) => {
    const loc = locate(id)
    if (!loc?.root.notes) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    try {
      return await loc.root.notes.remove(loc.rel, String(annotationId))
    } catch (err) {
      throw friendlyWriteError(err)
    }
  })

  // Bookmarks of a book (EPUB / Kindle), kept with its highlights and notes.
  ipcMain.handle('bookmarks:list', (_e, id: string) => locate(String(id))?.root.notes?.bookmarks(locate(String(id))!.rel) ?? [])
  ipcMain.handle('bookmarks:add', async (_e, id: string, input: Partial<Bookmark>) => {
    const loc = locate(String(id))
    if (!loc?.root.notes) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    try {
      return await loc.root.notes.addBookmark(loc.rel, sanitizeBookmark(input), loc.root.docs.find((d) => d.path === loc.rel))
    } catch (err) {
      throw friendlyWriteError(err)
    }
  })
  ipcMain.handle('bookmarks:remove', async (_e, id: string, bookmarkId: string) => {
    const loc = locate(String(id))
    if (!loc?.root.notes) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    try {
      return await loc.root.notes.removeBookmark(loc.rel, String(bookmarkId))
    } catch (err) {
      throw friendlyWriteError(err)
    }
  })
  ipcMain.handle('notes:docNote', async (_e, id: string, text: string) => {
    const loc = locate(id)
    if (!loc?.root.notes) throw new Error(t('File nằm ngoài thư mục tài liệu'))
    try {
      return await loc.root.notes.setDocNote(loc.rel, String(text ?? ''), loc.root.docs.find((d) => d.path === loc.rel))
    } catch (err) {
      throw friendlyWriteError(err)
    }
  })

  // ---------- workspace-wide tags and clean-up (issue #22) ----------
  ipcMain.handle('tags:rename', async (_e, from: string, to: string) => {
    const a = String(from ?? '').trim()
    const b = String(to ?? '').trim()
    if (!a || !b) throw new Error(t('Tên tag không được trống'))
    let n = 0
    try {
      for (const r of roots) n += (await r.meta?.renameTag(a, b)) ?? 0
    } catch (err) {
      throw friendlyWriteError(err)
    }
    await pushSnapshot()
    return n
  })
  ipcMain.handle('tags:delete', async (_e, tag: string) => {
    let n = 0
    try {
      for (const r of roots) n += (await r.meta?.deleteTag(String(tag ?? ''))) ?? 0
    } catch (err) {
      throw friendlyWriteError(err)
    }
    await pushSnapshot()
    return n
  })
  ipcMain.handle('library:cleanOrphans', async () => {
    if (scanning) throw new Error(t('Đang quét thư mục, đợi quét xong rồi thử lại'))
    let n = 0
    try {
      for (const r of roots) {
        if (r.warning) continue // folder unreachable: its files only look missing
        for (const st of storesOf(r)) n += await st.pruneOrphans(knownPaths(r))
      }
    } catch (err) {
      throw friendlyWriteError(err)
    }
    await pushSnapshot()
    return n
  })

  // ---------- recovery of broken data files (issue #25) ----------
  ipcMain.handle('recovery:restore', async (_e, rootKey: string, file: string) => {
    const n = await storeFor(rootKey, storeOfBackup(file)).restoreBackup(String(file))
    await pushSnapshot()
    return n
  })
  ipcMain.handle('recovery:discard', async (_e, rootKey: string, file: string) => {
    const st = storeFor(rootKey, storeOfBackup(file))
    await shell.trashItem(st.backupPath(String(file)))
    if (!(await st.backups()).length) st.warning = null
    await pushSnapshot()
  })
  ipcMain.handle('recovery:reveal', (_e, rootKey: string, file: string) => {
    shell.showItemInFolder(storeFor(rootKey, storeOfBackup(file)).backupPath(String(file)))
  })

  ipcMain.handle('doc:exportPdf', async (_e, id: string, withNotes: boolean) => {
    const loc = locate(id)
    const doc = loc?.root.docs.find((d) => d.path === loc.rel)
    if (!loc || !doc || (doc.kind !== 'md' && doc.kind !== 'html')) throw new Error(t('Chỉ xuất PDF được bài .md hoặc .html.'))
    const safeName = doc.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || path.parse(doc.name).name
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: t('Xuất PDF'),
      defaultPath: path.join(path.dirname(loc.abs), `${safeName}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return null
    const pdf = await printToPdf(id, doc.kind, withNotes === true)
    try {
      await fs.writeFile(filePath, pdf)
    } catch (err) {
      throw friendlyWriteError(err)
    }
    return filePath
  })

  ipcMain.handle('doc:reveal', (_e, rel: string) => {
    const abs = inLibrary(rel)
    if (abs) shell.showItemInFolder(abs)
  })

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), update: getUpdateStatus() }))
  ipcMain.handle('update:install', () => installUpdateNow())
  ipcMain.handle('update:check', () => checkForUpdatesNow())

  ipcMain.handle('settings:get', () => loadUiSettings())
  ipcMain.handle('settings:set', async (_e, ui: UiSettings) => {
    const clean = sanitizeUi(ui)
    await saveSettings({ ui: clean })
    nativeTheme.themeSource = clean.theme // also switches prefers-color-scheme for the pages
    pageAccent = clean.accent
    setLanguage(clean.language)
    return clean
  })

  ipcMain.handle('doc:write', (_e, rel: string, content: string, expectedMtime: number) => {
    if (typeof content !== 'string') throw new Error(t('Nội dung không hợp lệ'))
    return writeDocChecked(rel, () => content, expectedMtime)
  })

  // Selected text, translated with Google Translate (only that text is sent).
  ipcMain.handle('translate', (_e, text: string, to: string) =>
    translateText(String(text ?? ''), to === 'en' ? 'en' : 'vi', (url, init) => net.fetch(url, init))
  )
  // Spreadsheets (CSV, XLSX): read into a grid; saved with only the edited cells or rows changed.
  ipcMain.handle('sheet:load', async (_e, rel: string): Promise<SheetData> => {
    const abs = inLibrary(String(rel))
    if (!abs || kindOf(abs) !== 'sheet') throw new Error(t('Không phải file CSV / XLSX.'))
    const stat = await fs.stat(abs)
    if (stat.size > MAX_SHEET_BYTES) throw new Error(t('File quá lớn để mở trong app (trên {0} MB); hãy mở bằng Excel.', { 0: MAX_SHEET_BYTES / 1024 / 1024 }))
    try {
      const data = await loadSheet(await fs.readFile(abs), path.extname(abs).toLowerCase(), path.basename(abs), (b) => {
        try {
          return { text: decodeUtf8Strict(b), editable: true }
        } catch {
          return { text: decodeText(b), editable: false }
        }
      })
      return { ...data, mtime: stat.mtimeMs }
    } catch (err) {
      if (err instanceof SheetError) throw new Error(err.message)
      throw err
    }
  })
  ipcMain.handle('sheet:save', async (_e, rel: string, payload: SheetSave, expectedMtime: number) => {
    try {
      return await saveSheet(String(rel), payload, Number(expectedMtime))
    } catch (err) {
      if (err instanceof SheetError) throw new Error(err.message)
      throw err
    }
  })
  ipcMain.handle('doc:saveHtmlEdits', async (_e, rel: string, edits: HtmlBlockEdit[], expectedMtime: number) => {
    if (kindOf(rel) !== 'html') throw new Error(t('Không phải file HTML'))
    try {
      return await writeDocChecked(rel, (current) => applyHtmlEdits(current, edits), expectedMtime)
    } catch (err) {
      if (err instanceof HtmlEditError) throw new Error(err.message)
      throw err
    }
  })
}

// ---------- window ----------

function openInBrowser(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 520,
    title: 'Study Docs',
    // The installed app takes its icon from the .exe; in `npm run dev` use the PNG directly.
    icon: app.isPackaged ? undefined : path.join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d21' : '#f6f4ef',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const { webContents } = win

  // The app window itself never navigates away; web links open in your normal browser.
  webContents.on('will-navigate', (e) => {
    e.preventDefault()
    openInBrowser(e.url)
  })

  // Navigation inside the document iframe.
  webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || e.url.startsWith('about:')) return
    // The built-in PDF viewer is an internal extension page that loads the PDF itself.
    if (e.url.startsWith(PDF_VIEWER) || e.initiator?.url.startsWith(PDF_VIEWER)) return
    if (!e.url.startsWith('doc://')) {
      e.preventDefault()
      openInBrowser(e.url)
      return
    }
    // The app itself set the iframe's src: let it load.
    const initiator = e.initiator
    if (!initiator || initiator.frameTreeNodeId === webContents.mainFrame.frameTreeNodeId) return

    // A link clicked inside the document: let the UI switch documents so the
    // title, tags and status always belong to what you are reading.
    e.preventDefault()
    const target = parseDocUrl(e.url)
    if (!target) return
    if (hasDoc(target.path)) {
      webContents.send('doc:navigate', target.path, target.hash)
    } else {
      openLibraryFile(target.path, true).catch((err) => console.error('open failed', err))
    }
  })

  // Links that open a new window go to the browser. A page could call window.open() in a
  // loop to flood the browser with tabs, so: 2 within 10 seconds open right away, the 3rd
  // asks first, and more than that within those 10 seconds are dropped.
  const recentOpens: number[] = []
  webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' }
    const now = Date.now()
    while (recentOpens.length && now - recentOpens[0] > 10_000) recentOpens.shift()
    recentOpens.push(now)
    if (recentOpens.length <= 2) openInBrowser(url)
    else if (recentOpens.length === 3) {
      void askInWindow({
        message: t('Bài đang đọc muốn mở liên tiếp nhiều trang web trong trình duyệt.'),
        detail: url,
        buttons: [t('Mở trang này'), t('Chặn')],
        cancelId: 1
      }).then((answer) => answer === 0 && openInBrowser(url))
    }
    return { action: 'deny' }
  })

  // Tabs: Ctrl+W closes the open tab (not the window), Ctrl+Tab / Ctrl+Shift+Tab switch tabs,
  // Ctrl+\ shows or hides the sidebar;
  // wherever the keyboard focus is, inside a page too.
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const key = input.key.toLowerCase()
    if (key === 'w' && !input.shift) {
      event.preventDefault()
      webContents.send('nav:tab', 'close')
    } else if (key === 'tab') {
      event.preventDefault()
      webContents.send('nav:tab', input.shift ? 'prev' : 'next')
    } else if (key === '\\' && !input.shift) {
      // Ctrl+\: show / hide the sidebar.
      event.preventDefault()
      webContents.send('nav:tab', 'sidebar')
    }
  })

  // Back/forward buttons on the mouse (Windows sends them as "app commands").
  win.on('app-command', (_e, command) => {
    if (command === 'browser-backward') webContents.send('nav:history', 'back')
    if (command === 'browser-forward') webContents.send('nav:history', 'forward')
  })

  // Closing with unsaved edits: asked in the app's own dialog. The window tells us when an
  // edit is unsaved ('app:dirty'); "Quit" closes without asking again.
  let closing = false
  win.on('close', (e) => {
    if (!unsavedEdits || closing || !uiReady) return
    e.preventDefault()
    void askInWindow({
      message: t('Bạn đang có thay đổi chưa lưu.'),
      detail: t('Thoát bây giờ sẽ mất các thay đổi đó.'),
      buttons: [t('Ở lại'), t('Thoát, bỏ thay đổi')],
      cancelId: 0,
      dangerId: 1
    }).then((answer) => {
      if (answer !== 1 || !win || win.isDestroyed()) return
      closing = true
      win.destroy() // no beforeunload: already asked
    })
  })

  // Fallback (the window had not told us yet): Windows' own question.
  webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question',
      title: t('Thay đổi chưa lưu'),
      message: t('Bạn đang có thay đổi chưa lưu.'),
      detail: t('Thoát bây giờ sẽ mất các thay đổi đó.'),
      buttons: [t('Ở lại'), t('Thoát, bỏ thay đổi')],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 1) e.preventDefault() // preventDefault here means "close anyway"
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => (win = null))
}

// ---------- startup ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Opening another file from Explorer while the app runs starts a second copy, which quits
  // at once and hands its command line over to this one.
  app.on('second-instance', (_e, argv, cwd) => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
    const [file] = filesInArgs(argv, cwd)
    if (file) void openFromExplorer(file)
  })

  app.whenReady().then(async () => {
    protocol.handle('doc', (request) =>
      serveDoc(request).catch((err: unknown) => {
        console.error('doc:// failed', request.url, err)
        return new Response(`<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;padding:24px;color:#c24a4a">${String(err instanceof Error ? err.message : err).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</p>`, {
          status: 500,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        })
      })
    )
    async function serveDoc(request: Request): Promise<Response> {
      const target = parseDocUrl(request.url) // null for malformed URLs such as a stray "%"
      // Hidden files and folders (.git, old .docs-*.json...) are never served to a page.
      const hidden = target?.path.split('/').some((part) => part.startsWith('.'))
      const abs = target && !hidden ? inLibrary(target.path) : null
      if (!abs) return new Response('Not found', { status: 404 })

      // ?edit=1 on an HTML doc: serve it with the inline editor script, and switch off the
      // page's own scripts (only the script with this nonce may run).
      if (new URL(request.url).searchParams.get('edit') === '1' && kindOf(abs) === 'html') {
        const nonce = randomBytes(16).toString('base64')
        const source = await fs.readFile(abs, 'utf8')
        return new Response(withReadingStyle(source, pageAccent) + editModeInjection(nonce), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': `script-src 'nonce-${nonce}'; object-src 'none'`
          }
        })
      }
      if (kindOf(abs) === 'html') {
        const params = new URL(request.url).searchParams
        const html = (body: string, csp?: string): Response =>
          new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...(csp ? { 'Content-Security-Policy': csp } : {}) } })
        const source = await fs.readFile(abs, 'utf8')
        // Export to PDF: the page as it is, plus (if asked) its highlights and notes.
        if (params.get('print') === '1') {
          const loc = locate(target!.path)
          const withNotes = params.get('notes') === '1'
          const notes = withNotes ? (loc?.root.notes?.byDoc()[loc.rel] ?? []) : []
          const docNote = withNotes ? (loc?.root.notes?.docNotes()[loc.rel] ?? '') : ''
          // When printing, the page is not in the sandboxed iframe, so it must not be able to
          // read other files (fetch, frames, workers) and send them anywhere. Fonts, images
          // and styles still load so the PDF looks right.
          return html(notes.length || docNote ? source + printNotesInjection(notes, docNote) : source, PRINT_CSP)
        }
        // Reading mode: add the helper for outline, highlights, reading position and shortcuts.
        // App notes and pages without a style of their own get the reading style (not written to the file).
        return html(withReadingStyle(source, pageAccent) + viewModeInjection())
      }
      return net.fetch(pathToFileURL(abs).toString())
    }

    registerIpc()
    registerCalendarIpc()
    registerFileIpc()
    blockNetworkForPrinting()
    const startUi = await loadUiSettings()
    nativeTheme.themeSource = startUi.theme
    pageAccent = startUi.accent
    setLanguage(startUi.language)

    scanCache = new ScanCache(path.join(app.getPath('userData'), 'scan-cache.json'))
    await scanCache.load()
    await loadOcrIndex()
    calendar = await CalendarStore.open(path.join(app.getPath('userData'), 'data'))
    await calendar.loadSubscriptions()
    // Windows shows notifications and the taskbar button under this id (the installer uses the
    // same one). A dev or test run (node_modules\electron) gets its own, or Windows would give
    // the installed app the name and icon "Electron".
    app.setAppUserModelId(app.isPackaged ? 'local.studydocs.app' : 'local.studydocs.app.dev')
    search = new SearchService(path.join(app.getPath('userData'), 'text-cache'), (status) =>
      win?.webContents.send('search:status', status)
    )

    // Show the window right away; folders are scanned in the background and appear as they finish.
    createWindow()
    startAutoUpdate(() => win)

    // DOCS_LIBRARY lets you (or the smoke test) open folders directly, separated by ";".
    const fromEnv = (process.env.DOCS_LIBRARY ?? '').split(path.delimiter).filter(Boolean)
    await openWorkspace(fromEnv.length ? fromEnv : await loadWorkspacePaths(), await loadLooseFiles())

    // Calendars followed by link: fresh copies now and every 30 minutes; reminders every 30 s.
    void refreshSubscriptions()
    setInterval(() => void refreshSubscriptions(), 30 * 60_000)
    checkReminders()
    setInterval(checkReminders, 30_000)

    // Started by double-clicking a document in Explorer.
    const [file] = filesInArgs(process.argv)
    if (file) await openFromExplorer(file)
  })

  app.on('window-all-closed', () => app.quit())
  // Keep what was learned about the files for the next start.
  app.on('before-quit', () => scanCache?.saveSync())
}
