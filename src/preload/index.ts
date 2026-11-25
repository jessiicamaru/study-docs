// The only bridge between the UI and Node. The UI can call exactly these functions
// and nothing else, so a document can never reach the file system on its own.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AskRequest, DocsApi, LibrarySnapshot, SearchStatus, UpdateStatus } from '../shared/types'

/** Subscribes to a main-process event and returns an unsubscribe function. */
function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DocsApi = {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  addFolders: () => ipcRenderer.invoke('workspace:add'),
  removeFolder: (key) => ipcRenderer.invoke('workspace:remove', key),
  readDoc: (path) => ipcRenderer.invoke('doc:read', path),
  updateMeta: (path, patch) => ipcRenderer.invoke('meta:update', path, patch),
  markOpened: (path) => ipcRenderer.invoke('doc:opened', path),
  openPath: (path) => ipcRenderer.invoke('doc:openPath', path),
  revealInFolder: (path) => ipcRenderer.invoke('doc:reveal', path),
  onLibraryChanged: (cb) => listen<[LibrarySnapshot]>('library:changed', cb),
  onNavigate: (cb) => listen<[string, string]>('doc:navigate', cb),
  onHistory: (cb) => listen<['back' | 'forward']>('nav:history', cb),
  onTabKey: (cb) => listen<['close' | 'next' | 'prev']>('nav:tab', cb),
  exportPdf: (path, withNotes) => ipcRenderer.invoke('doc:exportPdf', path, withNotes),
  saveAnnotation: (path, annotation) => ipcRenderer.invoke('notes:save', path, annotation),
  deleteAnnotation: (path, id) => ipcRenderer.invoke('notes:delete', path, id),
  saveDocNote: (path, text) => ipcRenderer.invoke('notes:docNote', path, text),
  renameTag: (from, to) => ipcRenderer.invoke('tags:rename', from, to),
  deleteTag: (tag) => ipcRenderer.invoke('tags:delete', tag),
  cleanOrphans: () => ipcRenderer.invoke('library:cleanOrphans'),
  restoreBackup: (root, file) => ipcRenderer.invoke('recovery:restore', root, file),
  discardBackup: (root, file) => ipcRenderer.invoke('recovery:discard', root, file),
  revealBackup: (root, file) => ipcRenderer.invoke('recovery:reveal', root, file),
  onAsk: (cb) => listen<[number, AskRequest]>('dialog:ask', cb),
  answerAsk: (id, index) => ipcRenderer.invoke('dialog:answer', id, index),
  setUnsaved: (dirty) => ipcRenderer.send('app:dirty', dirty),
  openFiles: () => ipcRenderer.invoke('files:open'),
  addFiles: (paths) => ipcRenderer.invoke('files:add', paths),
  removeLooseFile: (path) => ipcRenderer.invoke('files:remove', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  readBinary: (path) => ipcRenderer.invoke('doc:readBinary', path),
  search: (query) => ipcRenderer.invoke('search', query),
  onSearchStatus: (cb) => listen<[SearchStatus]>('search:status', cb),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  onUpdateStatus: (cb) => listen<[UpdateStatus]>('update:status', cb),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  getUiSettings: () => ipcRenderer.invoke('settings:get'),
  setUiSettings: (ui) => ipcRenderer.invoke('settings:set', ui),
  writeDoc: (path, content, expectedMtime) => ipcRenderer.invoke('doc:write', path, content, expectedMtime),
  saveHtmlEdits: (path, edits, expectedMtime) => ipcRenderer.invoke('doc:saveHtmlEdits', path, edits, expectedMtime),
  loadSheet: (path) => ipcRenderer.invoke('sheet:load', path),
  saveSheet: (path, payload, expectedMtime) => ipcRenderer.invoke('sheet:save', path, payload, expectedMtime),
  newNote: (folderId, name, kind) => ipcRenderer.invoke('fs:newNote', folderId, name, kind),
  newFolder: (folderId, folderName, noteName, kind) => ipcRenderer.invoke('fs:newFolder', folderId, folderName, noteName, kind),
  renameItem: (id, isFolder, name) => ipcRenderer.invoke('fs:rename', id, isFolder, name),
  moveItem: (id, isFolder, targetFolderId) => ipcRenderer.invoke('fs:move', id, isFolder, targetFolderId),
  trashItem: (id, isFolder) => ipcRenderer.invoke('fs:trash', id, isFolder),
  ocrLoad: (docId) => ipcRenderer.invoke('ocr:load', docId),
  ocrSave: (docId, data) => ipcRenderer.invoke('ocr:save', docId, data),
  saveAsset: (docId, bytes, ext) => ipcRenderer.invoke('doc:saveAsset', docId, bytes, ext),
  calendarRange: (from, to) => ipcRenderer.invoke('calendar:range', from, to),
  calendarDetail: (uid, rid) => ipcRenderer.invoke('calendar:detail', uid, rid),
  calendarCreate: (data) => ipcRenderer.invoke('calendar:create', data),
  calendarUpdate: (uid, rid, scope, shownStart, data) => ipcRenderer.invoke('calendar:update', uid, rid, scope, shownStart, data),
  calendarDelete: (uid, rid, scope) => ipcRenderer.invoke('calendar:delete', uid, rid, scope),
  calendarPreview: (data) => ipcRenderer.invoke('calendar:preview', data),
  calendarLink: (uid, rid, docId) => ipcRenderer.invoke('calendar:link', uid, rid, docId),
  calendarLinkFolder: (uid, rid, folderId) => ipcRenderer.invoke('calendar:linkFolder', uid, rid, folderId),
  calendarLinkFiles: (uid, rid) => ipcRenderer.invoke('calendar:linkFiles', uid, rid),
  calendarUnlink: (uid, rid, filePath) => ipcRenderer.invoke('calendar:unlink', uid, rid, filePath),
  calendarForDoc: (docId) => ipcRenderer.invoke('calendar:forDoc', docId),
  calendarClassNotes: (uid, rid) => ipcRenderer.invoke('calendar:classNotes', uid, rid),
  calendarChooseNotesFolder: (uid) => ipcRenderer.invoke('calendar:notesFolder', uid),
  calendarExport: () => ipcRenderer.invoke('calendar:export'),
  calendarImport: () => ipcRenderer.invoke('calendar:import'),
  calendarSubscriptions: () => ipcRenderer.invoke('calendar:subscriptions'),
  calendarAddSubscription: (name, url, color) => ipcRenderer.invoke('calendar:addSubscription', name, url, color),
  calendarRemoveSubscription: (id) => ipcRenderer.invoke('calendar:removeSubscription', id),
  calendarRefreshSubscriptions: () => ipcRenderer.invoke('calendar:refreshSubscriptions'),
  onCalendarChanged: (cb) => listen<[]>('calendar:changed', cb),
  onCalendarFocus: (cb) => listen<[{ date: string; uid: string; rid: string }]>('calendar:focus', cb)
}

contextBridge.exposeInMainWorld('api', api)
