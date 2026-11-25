// Pick what to link to a class: documents of the library, whole folders of the workspace
// (every document in them, also ones added later), or files anywhere on the PC.
// Search as you type, accents optional.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocEntry } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { kindLabel, normalize, type FolderChoice } from '../lib/docs'

type Scope = 'this' | 'series'

interface Props {
  docs: DocEntry[]
  folders: FolderChoice[]
  /** Offer "this class / whole course" (repeating events only). */
  recurring: boolean
  onPick: (docId: string, scope: Scope) => void
  onPickFolder: (folderId: string, scope: Scope) => void
  /** Choose files anywhere on the PC (a file picker of Windows). */
  onPickFiles: (scope: Scope) => void
  onClose: () => void
}

export default function DocPicker({ docs, folders, recurring, onPick, onPickFolder, onPickFiles, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('this')
  useEffect(() => ref.current?.showModal(), [])
  const chosenScope: Scope = recurring ? scope : 'series'

  const q = normalize(query.trim())
  const shownFolders = useMemo(() => (q ? folders.filter((f) => normalize(`${f.name} ${f.rel} ${f.rootName}`).includes(q)) : folders).slice(0, 40), [folders, q])
  const shownDocs = useMemo(() => (q ? docs.filter((d) => normalize(`${d.title} ${d.rel}`).includes(q)) : docs).slice(0, 200), [docs, q])

  return (
    <dialog
      ref={ref}
      className="settings doc-picker"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onKeyDown={(e) => e.nativeEvent.stopPropagation()}
    >
      <header>
        <h2>{t('Gắn tài liệu')}</h2>
        <button className="icon-btn" aria-label={t('Đóng')} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="doc-picker-top">
        <input
          autoFocus
          placeholder={t('Tìm tài liệu hoặc thư mục…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && shownDocs[0] && onPick(shownDocs[0].path, chosenScope)}
        />
        {recurring && (
          <div className="segmented plain" role="group" aria-label={t('Gắn vào')}>
            <button className={scope === 'this' ? 'active' : ''} onClick={() => setScope('this')}>
              {t('Buổi này')}
            </button>
            <button className={scope === 'series' ? 'active' : ''} onClick={() => setScope('series')}>
              {t('Cả môn')}
            </button>
          </div>
        )}
      </div>
      <div className="settings-body doc-picker-list">
        {shownFolders.length > 0 && (
          <>
            <div className="picker-group">{t('Thư mục (gồm cả tài liệu thêm vào sau)')}</div>
            {shownFolders.map((f) => (
              <button key={f.id} className="row doc picker-folder" title={f.rel || f.rootName} onClick={() => onPickFolder(f.id, chosenScope)}>
                <span className="kind kind-folder">{t('THƯ MỤC')}</span>
                <span className="row-title">{f.name}</span>
                <span className="row-time">{t('{0} tài liệu', { 0: f.count })}</span>
              </button>
            ))}
          </>
        )}
        <div className="picker-group">{t('Tài liệu')}</div>
        {shownDocs.length === 0 && <p className="hint">{t('Không có tài liệu nào khớp.')}</p>}
        {shownDocs.map((d) => (
          <button key={d.path} className="row doc" title={d.rel} onClick={() => onPick(d.path, chosenScope)}>
            <span className={`kind kind-${d.kind}`}>{kindLabel(d.kind, d.path)}</span>
            <span className="row-title">{d.title}</span>
            <span className="row-time">{d.rel}</span>
          </button>
        ))}
      </div>
      <footer>
        <span className="hint">{t('File ngoài workspace sẽ được thêm vào "File lẻ".')}</span>
        <button className="btn small" onClick={() => onPickFiles(chosenScope)}>
          {t('Chọn file trên máy…')}
        </button>
      </footer>
    </dialog>
  )
}
