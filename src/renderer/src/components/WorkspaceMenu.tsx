// The menu under the workspace name: rename it, save it as a workspace file (.studyws), open
// another one, or go back to the workspace kept in the app.
import { useEffect, useRef, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import { t } from '../../../shared/i18n'

export function WorkspaceMenu({ info, title, onClose, onError }: { info: WorkspaceInfo; title: string; onClose: () => void; onError: (err: unknown) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [name, setName] = useState(info.name || title)
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!ref.current?.contains(target) && !target.closest('.library-name')) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const run = (action: () => Promise<unknown>) => (): void => {
    onClose()
    action().catch(onError)
  }
  const saveName = (): void => {
    setRenaming(false)
    if (name.trim() !== (info.name || title)) window.api.renameWorkspace(name).catch(onError)
  }

  return (
    <div ref={ref} className="popover workspace-menu" role="menu" aria-label={t('Workspace')}>
      <div className="workspace-current">
        {renaming ? (
          <input
            autoFocus
            value={name}
            maxLength={80}
            aria-label={t('Tên workspace')}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setName(info.name || title)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <button className="workspace-name-btn" title={t('Đổi tên')} onClick={() => setRenaming(true)}>
            <b>{info.name || title}</b>
            <span>{t('Đổi tên')}</span>
          </button>
        )}
        <div className="workspace-file" title={info.file ?? ''}>
          {info.file ?? t('Lưu trong app (chưa có file workspace)')}
        </div>
      </div>
      <button role="menuitem" onClick={run(() => window.api.saveWorkspaceAs())}>
        {info.file ? t('Lưu thành file workspace khác…') : t('Lưu workspace thành file…')}
      </button>
      <button role="menuitem" onClick={run(() => window.api.openWorkspace())}>
        {t('Mở workspace…')}
      </button>
      <button role="menuitem" onClick={run(() => window.api.newWorkspace())}>
        {t('Workspace mới…')}
      </button>
      {info.file && (
        <button role="menuitem" onClick={run(() => window.api.closeWorkspaceFile())}>
          {t('Về workspace trong app')}
        </button>
      )}
      {info.recent.length > 0 && (
        <>
          <div className="group-title">{t('Workspace gần đây')}</div>
          {info.recent.map((w) => (
            <div key={w.path} className="workspace-recent">
              <button role="menuitem" title={w.path} onClick={run(() => window.api.openWorkspace(w.path))}>
                {w.name}
              </button>
              <button className="icon-btn small" aria-label={t('Bỏ khỏi danh sách')} title={t('Bỏ khỏi danh sách')} onClick={() => window.api.forgetWorkspace(w.path).catch(onError)}>
                ×
              </button>
            </div>
          ))}
        </>
      )}
      <div className="workspace-hint">{t('Ghi chú, tag và dấu trang được lưu theo từng thư mục, nên thư mục nằm trong nhiều workspace vẫn dùng chung một bộ ghi chú.')}</div>
    </div>
  )
}
