// Small helpers used across the UI.

import { DEFAULT_META, type DocEntry, type DocMeta, type StudyStatus } from '../../../shared/types'
import { t } from '../../../shared/i18n'

export const STATUSES: { id: StudyStatus; label: string }[] = [
  { id: 'new', label: 'Chưa học' },
  { id: 'learning', label: 'Đang học' },
  { id: 'review', label: 'Cần ôn' },
  { id: 'done', label: 'Đã thuộc' }
]

export const statusLabel = (s: StudyStatus): string => STATUSES.find((x) => x.id === s)?.label ?? s

export function metaOf(meta: Record<string, DocMeta>, path: string): DocMeta {
  return { ...DEFAULT_META, ...meta[path] }
}

/** URL the main process serves a document at (see protocol.handle in src/main/index.ts). */
export function docUrl(path: string): string {
  return 'doc://library/' + path.split('/').map(encodeURIComponent).join('/')
}

/** Inverse of docUrl: returns the library-relative path and #hash, or null for non-library URLs. */
export function parseDocUrl(url: string): { path: string; hash: string } | null {
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

/** Error from window.api calls without Electron's "Error invoking remote method ..." prefix. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ---------- search ----------
// Searching itself runs in a background worker in the main process (window.api.search).

export { normalize, makeSnippet, type Snippet } from '../../../shared/text'

// ---------- folder tree ----------

export interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  docs: DocEntry[]
}

/**
 * Groups documents into nested folders by their path inside their workspace folder (doc.rel).
 * `prefix` is put in front of every folder path, so folders of different workspace
 * folders get distinct ids (used to remember which ones are collapsed).
 * Folders are sorted by name; documents by title, or newest change first (issue #23).
 */
export function buildTree(docs: DocEntry[], prefix = '', order: 'name' | 'modified' = 'name', empty: string[] = []): TreeFolder {
  const root: TreeFolder = { name: '', path: prefix, folders: [], docs: [] }
  // Folders without documents ("a/b") get their nodes too.
  for (const rel of empty) {
    let cur = root
    for (const part of rel.split('/')) {
      let next = cur.folders.find((f) => f.name === part)
      if (!next) {
        next = { name: part, path: cur.path ? `${cur.path}/${part}` : part, folders: [], docs: [] }
        cur.folders.push(next)
      }
      cur = next
    }
  }
  for (const doc of docs) {
    const parts = doc.rel.split('/')
    let cur = root
    for (const part of parts.slice(0, -1)) {
      let next = cur.folders.find((f) => f.name === part)
      if (!next) {
        next = { name: part, path: cur.path ? `${cur.path}/${part}` : part, folders: [], docs: [] }
        cur.folders.push(next)
      }
      cur = next
    }
    cur.docs.push(doc)
  }
  const sort = (f: TreeFolder): void => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name, 'vi'))
    f.docs.sort((a, b) => (order === 'modified' && b.mtime !== a.mtime ? b.mtime - a.mtime : a.title.localeCompare(b.title, 'vi')))
    f.folders.forEach(sort)
  }
  sort(root)
  return root
}

// ---------- tiny localStorage wrapper (never throws) ----------

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function saveLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** Short badge text for a document type. */
export function kindLabel(kind: DocEntry['kind'], path?: string): string {
  if (kind === 'sheet') return path?.toLowerCase().endsWith('.csv') ? 'CSV' : 'XLSX'
  return kind === 'image' ? t('ẢNH') : kind.toUpperCase()
}

/** Drag data type of a document dragged from the sidebar (dropped on a calendar event to link it). */
export const DOC_DRAG_TYPE = 'application/x-studydocs-doc'
/** Drag data type of a folder dragged from the sidebar tree (its id there: "<root key>/<sub/folder>"). */
export const FOLDER_DRAG_TYPE = 'application/x-studydocs-folder'

/** A folder of the workspace that can be linked to a calendar event. */
export interface FolderChoice {
  /** Id in the sidebar tree: "<root key>" or "<root key>/<sub/folder>". */
  id: string
  name: string
  /** Path inside the workspace folder ('' for the workspace folder itself). */
  rel: string
  rootName: string
  /** Documents inside it, sub-folders included. */
  count: number
}

/** Every workspace folder and every folder with documents inside one, by path. */
export function folderChoices(docs: DocEntry[], roots: { key: string; name: string; loose: boolean }[]): FolderChoice[] {
  const out = new Map<string, FolderChoice>()
  for (const r of roots) if (!r.loose) out.set(r.key, { id: r.key, name: r.name, rel: '', rootName: r.name, count: 0 })
  for (const d of docs) {
    const root = out.get(d.root)
    if (!root) continue
    root.count++
    const parts = d.rel.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join('/')
      const id = `${d.root}/${rel}`
      const f = out.get(id) ?? { id, name: parts[i - 1], rel, rootName: root.rootName, count: 0 }
      f.count++
      out.set(id, f)
    }
  }
  return [...out.values()].sort((a, b) => a.rootName.localeCompare(b.rootName, 'vi') || a.rel.localeCompare(b.rel, 'vi'))
}
