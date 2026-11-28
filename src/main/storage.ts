// App-level JSON files in Electron's userData folder (%APPDATA%\Study Docs):
//  - settings.json: the folders in the workspace, appearance
//  - recent.json:   when you last opened each document, by absolute file path
// "Recently opened" changes on every click, so it is kept here instead of in the
// per-folder data (tags, notes) in data<folder key>.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_UI, type UiSettings } from '../shared/types'
import { pathKey } from './workspace'
import { languageForLocale } from '../shared/i18n'

interface Settings {
  /** Folders in the workspace. */
  libraryPaths?: string[]
  /** Files opened on their own ("File lẻ"), by absolute path. */
  looseFiles?: string[]
  /** Before v0.4 the workspace was a single folder; read once and migrated. */
  libraryPath?: string
  ui?: Partial<UiSettings>
  /** The workspace file (.studyws) open at the last start; none: the workspace kept here. */
  workspaceFile?: string | null
  /** Name you gave the workspace kept here (a workspace file has its own). */
  workspaceName?: string
  /** Workspace files opened lately, newest first. */
  recentWorkspaces?: string[]
  /** Workspace files whose network paths you allowed. */
  workspaceNetworkOk?: string[]
}

/** v2: { version: 2, files: { "<absolute path, lower-case on Windows>": timestamp } } */
interface RecentFileV2 {
  version: 2
  files: Record<string, number>
}
/** v1 (before v0.4): { "<library root>": { "<relative path>": timestamp } } */
type RecentFileV1 = Record<string, Record<string, number>>

const MAX_RECENT = 200
const file = (name: string): string => path.join(app.getPath('userData'), name)

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(name: string, data: unknown): Promise<void> {
  const target = file(name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(`${target}.tmp`, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(`${target}.tmp`, target)
}

export const loadSettings = (): Promise<Settings> => readJson<Settings>('settings.json', {})

/** Merges `patch` into settings.json so workspace and appearance don't overwrite each other. */
export async function saveSettings(patch: Settings): Promise<void> {
  await writeJson('settings.json', { ...(await loadSettings()), ...patch })
}

export async function loadWorkspacePaths(): Promise<string[]> {
  const s = await loadSettings()
  if (Array.isArray(s.libraryPaths)) return s.libraryPaths.filter((p) => typeof p === 'string')
  return s.libraryPath ? [s.libraryPath] : []
}

export async function saveWorkspacePaths(paths: string[]): Promise<void> {
  await saveSettings({ libraryPaths: paths, libraryPath: undefined }) // undefined is dropped from the JSON
}

export interface WorkspaceSettings {
  file: string | null
  name: string
  recent: string[]
  networkOk: string[]
}

export async function loadWorkspaceSettings(): Promise<WorkspaceSettings> {
  const s = await loadSettings()
  return {
    file: typeof s.workspaceFile === 'string' && s.workspaceFile ? s.workspaceFile : null,
    name: typeof s.workspaceName === 'string' ? s.workspaceName : '',
    recent: Array.isArray(s.recentWorkspaces) ? s.recentWorkspaces.filter((p) => typeof p === 'string') : [],
    networkOk: Array.isArray(s.workspaceNetworkOk) ? s.workspaceNetworkOk.filter((p) => typeof p === 'string') : []
  }
}

export async function saveWorkspaceSettings(w: Partial<WorkspaceSettings>): Promise<void> {
  const patch: Settings = {}
  if (w.file !== undefined) patch.workspaceFile = w.file
  if (w.name !== undefined) patch.workspaceName = w.name
  if (w.recent !== undefined) patch.recentWorkspaces = w.recent
  if (w.networkOk !== undefined) patch.workspaceNetworkOk = w.networkOk
  await saveSettings(patch)
}

export async function loadLooseFiles(): Promise<string[]> {
  const s = await loadSettings()
  return Array.isArray(s.looseFiles) ? s.looseFiles.filter((p) => typeof p === 'string') : []
}

export async function saveLooseFiles(files: string[]): Promise<void> {
  await saveSettings({ looseFiles: files })
}

const HEX = /^#[0-9a-f]{6}$/i

/** Reads appearance settings, replacing anything missing or invalid with the default. */
export async function loadUiSettings(): Promise<UiSettings> {
  // A new install starts in the language of Windows (Vietnamese or English).
  const ui = { ...DEFAULT_UI, language: languageForLocale(app.getLocale()), ...(await loadSettings()).ui }
  return sanitizeUi(ui)
}

export function sanitizeUi(ui: Partial<UiSettings>): UiSettings {
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
  return {
    theme: pick(ui.theme, ['system', 'light', 'dark'] as const, DEFAULT_UI.theme),
    accent: typeof ui.accent === 'string' && HEX.test(ui.accent) ? ui.accent : DEFAULT_UI.accent,
    readingSize: Math.min(24, Math.max(13, Math.round(Number(ui.readingSize) || DEFAULT_UI.readingSize))),
    readingFont: pick(ui.readingFont, ['sans', 'serif'] as const, DEFAULT_UI.readingFont),
    readingWidth: pick(ui.readingWidth, ['narrow', 'normal', 'wide'] as const, DEFAULT_UI.readingWidth),
    sidebarSort: pick(ui.sidebarSort, ['name', 'modified'] as const, DEFAULT_UI.sidebarSort),
    epubSpread: pick(ui.epubSpread, ['single', 'auto'] as const, DEFAULT_UI.epubSpread),
    showImages: typeof ui.showImages === 'boolean' ? ui.showImages : DEFAULT_UI.showImages,
    language: pick(ui.language, ['vi', 'en'] as const, DEFAULT_UI.language),
    newNoteKind: pick(ui.newNoteKind, ['md', 'html'] as const, DEFAULT_UI.newNoteKind),
    pasteImages: pick(ui.pasteImages, ['embed', 'assets'] as const, DEFAULT_UI.pasteImages)
  }
}

// recent.json is written one call at a time, same idea as MetaStore.
let recentQueue: Promise<unknown> = Promise.resolve()

/** Absolute file path -> last opened time. Converts the old per-library format on the fly. */
export async function loadRecent(): Promise<Record<string, number>> {
  const raw = await readJson<RecentFileV2 | RecentFileV1>('recent.json', { version: 2, files: {} })
  if ((raw as RecentFileV2).version === 2) return (raw as RecentFileV2).files ?? {}
  const files: Record<string, number> = {}
  for (const [root, entries] of Object.entries(raw as RecentFileV1)) {
    if (!entries || typeof entries !== 'object') continue
    for (const [rel, ts] of Object.entries(entries)) files[pathKey(path.join(root, rel))] = ts
  }
  return files
}

export function markOpened(absPath: string): Promise<Record<string, number>> {
  const run = recentQueue.then(async () => {
    const entries = Object.entries({ ...(await loadRecent()), [pathKey(absPath)]: Date.now() })
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_RECENT)
    const files = Object.fromEntries(entries)
    await writeJson('recent.json', { version: 2, files } satisfies RecentFileV2)
    return files
  })
  recentQueue = run.catch(() => undefined)
  return run
}
