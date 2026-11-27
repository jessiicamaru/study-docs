// Reading positions kept in localStorage, and cleaning them up (issue #8).
//
// Keys: "pos:<doc id>" (scroll position), "epubpos:<doc id>" (place in a book),
// "epubloc:<doc id>:<mtime>" (a book's "% read" table, for one version of the file).
// Without cleanup they pile up until localStorage is full and positions silently stop saving.

import type { DocEntry, RootInfo } from '../../../shared/types'

const PREFIXES = ['pos:', 'epubpos:', 'epubloc:']

/**
 * Keys that can go: documents that no longer exist, and "% read" tables of an older version of
 * a book. Folders that are only temporarily missing (USB drive unplugged), or not in the open
 * workspace (another workspace file may have them), keep their positions.
 */
export function staleKeys(keys: string[], docs: Pick<DocEntry, 'path' | 'mtime'>[], roots: Pick<RootInfo, 'key' | 'available'>[]): string[] {
  const mtimes = new Map(docs.map((d) => [d.path, d.mtime]))
  const rootState = new Map(roots.map((r) => [r.key, r.available]))
  return keys.filter((key) => {
    const prefix = PREFIXES.find((p) => key.startsWith(p))
    if (!prefix) return false
    let id = key.slice(prefix.length)
    let version: string | null = null
    if (prefix === 'epubloc:') {
      const cut = id.lastIndexOf(':')
      version = id.slice(cut + 1)
      id = id.slice(0, cut)
    }
    const available = rootState.get(id.split('/')[0])
    // A folder not in this workspace may be in another workspace file: keep its positions.
    if (available === undefined) return false
    if (!available) return false // folder temporarily unavailable: keep
    if (!mtimes.has(id)) return true // document gone
    return version !== null && version !== String(mtimes.get(id))
  })
}

/** Removes stale reading positions from localStorage. Never throws. */
export function pruneReadingPositions(docs: DocEntry[], roots: RootInfo[]): number {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter(Boolean)
    const stale = staleKeys(keys, docs, roots)
    for (const k of stale) localStorage.removeItem(k)
    return stale.length
  } catch {
    return 0
  }
}

/**
 * Keys to move when a document (or a folder, with everything below it) is renamed or moved in
 * the app: [old key, new key] pairs.
 */
export function movedKeys(keys: string[], from: string, to: string, isFolder: boolean): [string, string][] {
  const out: [string, string][] = []
  for (const key of keys) {
    const prefix = PREFIXES.find((p) => key.startsWith(p))
    if (!prefix) continue
    const rest = key.slice(prefix.length)
    if (rest === from || rest.startsWith(`${from}:`)) out.push([key, `${prefix}${to}${rest.slice(from.length)}`])
    else if (isFolder && rest.startsWith(`${from}/`)) out.push([key, `${prefix}${to}${rest.slice(from.length)}`])
  }
  return out
}

/** Reading positions follow a document or folder that was renamed or moved. Never throws. */
export function moveReadingPositions(from: string, to: string, isFolder: boolean): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter(Boolean)
    for (const [oldKey, newKey] of movedKeys(keys, from, to, isFolder)) {
      const value = localStorage.getItem(oldKey)
      if (value !== null) localStorage.setItem(newKey, value)
      localStorage.removeItem(oldKey)
    }
  } catch {
    // positions are a convenience
  }
}
