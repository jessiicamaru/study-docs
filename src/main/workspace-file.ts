// A workspace saved as a file (like VS Code's .code-workspace): its name, its folders and its
// loose files. Notes, tags and bookmarks are NOT in it: they stay with each folder in the app's
// data (data\<folder key>\), so a folder in two workspaces has one set of notes, and losing or
// copying a workspace file loses nothing.
//
//   { "version": 1, "name": "Học kỳ 1", "folders": ["System_Design", "D:/Notes"], "files": ["../Sách/DDIA.epub"] }
//
// Paths are kept relative to the workspace file when they are on the same drive, so a folder
// copied to another PC along with its workspace file still opens.

import { promises as fs } from 'node:fs'
import path from 'node:path'

export const WORKSPACE_EXT = '.studyws'
const MAX_NAME = 80

export interface WorkspaceData {
  name: string
  /** Absolute paths. */
  folders: string[]
  /** Absolute paths. */
  files: string[]
}

/** The name a workspace file gets when it has none: its file name. */
export const nameFromFile = (file: string): string => path.basename(file).replace(/\.studyws$/i, '')

export function cleanName(name: unknown): string {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
}

const sameDrive = (a: string, b: string): boolean => path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase()

/** A path as written in the file: relative to the file's folder when possible, with "/". */
function toStored(abs: string, dir: string): string {
  const p = sameDrive(abs, dir) ? path.relative(dir, abs) || '.' : abs
  return p.split(path.sep).join('/')
}

const fromStored = (p: string, dir: string): string => path.resolve(dir, p)

/** Reads the text of a workspace file; throws a readable error when it isn't one. */
export function parseWorkspace(text: string, file: string): WorkspaceData {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('not-json')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not-workspace')
  const o = raw as Record<string, unknown>
  const dir = path.dirname(file)
  const list = (v: unknown): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of Array.isArray(v) ? v : []) {
      if (typeof p !== 'string' || !p.trim()) continue
      const abs = fromStored(p.trim(), dir)
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs
      if (seen.has(key)) continue
      seen.add(key)
      out.push(abs)
    }
    return out
  }
  return { name: cleanName(o.name) || nameFromFile(file), folders: list(o.folders), files: list(o.files) }
}

export function serializeWorkspace(data: WorkspaceData, file: string): string {
  const dir = path.dirname(file)
  return (
    JSON.stringify(
      {
        version: 1,
        name: cleanName(data.name) || nameFromFile(file),
        folders: data.folders.map((p) => toStored(p, dir)),
        files: data.files.map((p) => toStored(p, dir))
      },
      null,
      2
    ) + '\n'
  )
}

export async function readWorkspaceFile(file: string): Promise<WorkspaceData> {
  return parseWorkspace(await fs.readFile(file, 'utf8'), file)
}

/** Written to a temporary file first, so a crash never leaves half a workspace file. */
export async function writeWorkspaceFile(file: string, data: WorkspaceData): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, serializeWorkspace(data, file), 'utf8')
  await fs.rename(tmp, file)
}
