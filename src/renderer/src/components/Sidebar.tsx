import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AppInfo, DocEntry, LibrarySnapshot, RootInfo, SearchResult, SearchStatus } from '../../../shared/types'
import { WorkspaceMenu } from './WorkspaceMenu'
import { buildTree, kindLabel, loadLocal, metaOf, saveLocal, STATUSES, type TreeFolder, DOC_DRAG_TYPE, FOLDER_DRAG_TYPE } from '../lib/docs'
import { timeAgo } from '../lib/ui'
import type { StatusFilter } from '../App'
import { t } from '../../../shared/i18n'
import { confirmDialog } from '../lib/ask'

/** What the sidebar can do to files of the workspace (null when there is no workspace folder). */
export interface FileActions {
  newNote: (folderId: string) => void
  newFolder: (folderId: string) => void
  rename: (id: string, isFolder: boolean, name: string) => void
  move: (id: string, isFolder: boolean, targetFolderId: string) => void
  trash: (id: string, isFolder: boolean, name: string) => void
}

/** What was right-clicked: a folder (by its tree id) or a document. */
type MenuItem = { kind: 'folder'; id: string; name: string; isRoot: boolean } | { kind: 'doc'; doc: DocEntry }
type MenuTarget = MenuItem & { x: number; y: number }

export interface SearchHit {
  doc: DocEntry
  /** Text around the match; null when only the title, file name or a tag matched. */
  snippet: SearchResult['snippet']
}

interface Props {
  lib: LibrarySnapshot | null
  docs: DocEntry[]
  hits: SearchHit[] | null
  query: string
  onQuery: (q: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  statusFilter: StatusFilter
  onStatusFilter: (s: StatusFilter) => void
  tagFilter: string | null
  onTagFilter: (t: string | null) => void
  selected: string | null
  onOpen: (path: string, newTab?: boolean) => void
  appInfo: AppInfo | null
  searchStatus: SearchStatus | null
  recentOpen: boolean
  onRecentOpen: (open: boolean) => void
  onOpenSettings: () => void
  /** Hides the sidebar (Ctrl+\); a thin bar stays to bring it back. */
  onHide: () => void
  /** The calendar is shown instead of a document. */
  calendarOpen: boolean
  onToggleCalendar: () => void
  onAddFolders: () => void
  onRemoveFolder: (key: string) => void
  sort: 'name' | 'modified'
  onOpenFiles: () => void
  onRemoveLoose: (path: string) => void
  onError: (err: unknown) => void
  files: FileActions
}

export default function Sidebar(props: Props) {
  const { lib, docs, hits, query, onQuery, selected, onOpen } = props
  const allDocs = lib?.docs ?? []
  const meta = lib?.meta ?? {}
  // Workspace folders; the folders of loose files only show in the "File lẻ" group.
  const roots = (lib?.roots ?? []).filter((r) => !r.loose)
  const autoName = roots.length === 0 ? t('Chưa có thư mục') : roots.length === 1 ? roots[0].name : t('Workspace · {0} thư mục', { 0: roots.length })
  const workspaceName = lib?.workspace.name || autoName
  const [wsMenu, setWsMenu] = useState(false)
  const rootNames = Object.fromEntries((lib?.roots ?? []).map((r) => [r.key, r.name]))
  const looseFiles = lib?.looseFiles ?? []
  const listRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const openMenu = (e: React.MouseEvent, target: MenuItem): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ ...target, x: e.clientX, y: e.clientY } as MenuTarget)
  }
  const tree = { files: props.files, openMenu }

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allDocs.length }
    for (const d of allDocs) {
      const s = metaOf(meta, d.path).status
      counts[s] = (counts[s] ?? 0) + 1
    }
    return counts
  }, [allDocs, meta])

  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of allDocs) for (const t of metaOf(meta, d.path).tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts].sort((a, b) => a[0].localeCompare(b[0], 'vi'))
  }, [allDocs, meta])

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <button
            className={`library-name ${wsMenu ? 'open' : ''}`}
            title={[lib?.workspace.file, ...roots.map((r) => r.path)].filter(Boolean).join('\n')}
            aria-haspopup="menu"
            aria-expanded={wsMenu}
            onClick={() => setWsMenu(!wsMenu)}
          >
            <span className="library-name-text">{workspaceName}</span>
            <span className="library-caret" aria-hidden>
              ▾
            </span>
          </button>
          <button className="icon-btn" title={t('Ẩn thanh bên (Ctrl+\\)')} aria-label={t('Ẩn thanh bên')} onClick={props.onHide}>
            <PanelIcon />
          </button>
        </div>
        <div className="sidebar-tools">
        <button className="icon-btn" title={t('Mở file… (Ctrl+O)')} onClick={props.onOpenFiles}>
          <FilePlusIcon />
        </button>
        <button className="icon-btn" title={t('Thêm thư mục vào workspace')} onClick={props.onAddFolders}>
          <FolderPlusIcon />
        </button>
        <button
          className={`icon-btn ${props.recentOpen ? 'active' : ''}`}
          title={t('Mở gần đây (Ctrl+E)')}
          aria-expanded={props.recentOpen}
          onClick={() => props.onRecentOpen(!props.recentOpen)}
        >
          <ClockIcon />
        </button>
        <button className={`icon-btn ${props.calendarOpen ? 'active' : ''}`} title={t('Lịch học')} aria-pressed={props.calendarOpen} onClick={props.onToggleCalendar}>
          <CalendarIcon />
        </button>
        <button className="icon-btn" title={t('Cài đặt')} onClick={props.onOpenSettings}>
          <GearIcon />
        </button>
        </div>
        {wsMenu && lib && <WorkspaceMenu info={lib.workspace} title={autoName} onClose={() => setWsMenu(false)} onError={props.onError} />}
        {props.recentOpen && (
          <RecentPopover lib={lib} selected={selected} onOpen={onOpen} onClose={() => props.onRecentOpen(false)} />
        )}
      </div>

      <div className="search">
        <input
          ref={props.searchRef}
          value={query}
          placeholder={t('Tìm tài liệu…  (Ctrl+K)')}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onQuery('')
            if (e.key === 'Enter' && hits?.[0]) onOpen(hits[0].doc.path)
            if (e.key === 'ArrowDown') {
              // Move into the list (issue #23).
              e.preventDefault()
              listRef.current?.querySelector<HTMLElement>(ROW)?.focus()
            }
          }}
        />
      </div>

      <div className="filters">
        <Chip active={props.statusFilter === 'all'} onClick={() => props.onStatusFilter('all')}>{t('Tất cả')}{' '}<span className="count">{statusCounts.all ?? 0}</span>
        </Chip>
        {STATUSES.map((s) => (
          <Chip
            key={s.id}
            className={`status-${s.id}`}
            active={props.statusFilter === s.id}
            onClick={() => props.onStatusFilter(props.statusFilter === s.id ? 'all' : s.id)}
          >
            {t(s.label)} <span className="count">{statusCounts[s.id] ?? 0}</span>
          </Chip>
        ))}
      </div>

      {tags.length > 0 && (
        <div className="filters tags">
          {tags.map(([t, n]) => (
            <Chip key={t} active={props.tagFilter === t} onClick={() => props.onTagFilter(props.tagFilter === t ? null : t)}>
              #{t} <span className="count">{n}</span>
            </Chip>
          ))}
        </div>
      )}

      <div
        className="doc-list"
        ref={listRef}
        onKeyDown={(e) => {
          // F2 renames the document or folder that has the focus (like Explorer).
          const el = document.activeElement as HTMLElement | null
          if (e.key === 'F2' && el?.dataset.id) {
            e.preventDefault()
            props.files.rename(el.dataset.id, !!el.dataset.folderId, el.dataset.name ?? '')
            return
          }
          onListKey(e, props.searchRef)
        }}
        // Right-click on the empty part of the list: the workspace folder (when there is one).
        onContextMenu={(e) => {
          if (roots.length === 1 && !hits) openMenu(e, { kind: 'folder', id: roots[0].key, name: roots[0].name, isRoot: true })
        }}
        {...(roots.length === 1 && !hits ? dropTarget(roots[0].key, props.files) : {})}
      >
        {hits ? (
          <SearchResults hits={hits} query={query} selected={selected} onOpen={onOpen} rootNames={roots.length > 1 || looseFiles.length ? rootNames : null} />
        ) : (
          <div className="group">
            <Tree roots={roots} docs={docs} selected={selected} onOpen={onOpen} onRemoveRoot={props.onRemoveFolder} sort={props.sort} actions={tree} showEmpty={props.statusFilter === 'all' && !props.tagFilter} />
            {docs.length === 0 && roots.length > 0 && <div className="empty">{t('Không có tài liệu nào khớp.')}</div>}
            {looseFiles.length > 0 && (
              <LooseFiles files={looseFiles} docs={docs} selected={selected} onOpen={onOpen} onRemove={props.onRemoveLoose} />
            )}
          </div>
        )}
      </div>

      {menu && <TreeMenu target={menu} files={props.files} onClose={() => setMenu(null)} />}

      {props.appInfo && (
        <div className="sidebar-foot">
          <span>Study Docs v{props.appInfo.version}</span>
          {lib?.scanning && <span className="update-progress">{t('Đang quét thư mục…')}</span>}
          {!lib?.scanning && props.searchStatus && props.searchStatus.done < props.searchStatus.total && (
            <span className="update-progress" title={t('Đọc nội dung tài liệu để tìm kiếm; tìm theo tên vẫn dùng được ngay')}>{t('Đang lập chỉ mục')}{' '}{props.searchStatus.done}/{props.searchStatus.total}
            </span>
          )}
          {props.appInfo.update.state === 'downloading' && (
            <span className="update-progress">{t('Đang tải bản')}{' '}{props.appInfo.update.version}… {props.appInfo.update.percent ?? 0}%
            </span>
          )}
        </div>
      )}
    </aside>
  )
}

/** Rows you can move between with the arrow keys. */
const ROW = 'button.row, button.hit'

/**
 * Arrow keys in the document list (issue #23): Up/Down move, Enter opens (the row is a
 * button), Left closes a folder or goes to its parent, Right opens a folder.
 */
function onListKey(e: React.KeyboardEvent<HTMLDivElement>, searchRef: RefObject<HTMLInputElement | null>): void {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(ROW)]
  const current = document.activeElement as HTMLElement | null
  const i = current ? rows.indexOf(current) : -1
  if (i < 0) return
  const depth = (el: HTMLElement): number => Number(el.dataset.depth ?? 0)
  const go = (el: HTMLElement | undefined): void => {
    if (!el) return
    e.preventDefault()
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
  }
  if (e.key === 'ArrowDown') go(rows[i + 1])
  else if (e.key === 'ArrowUp') {
    if (i === 0) {
      e.preventDefault()
      searchRef.current?.focus()
    } else go(rows[i - 1])
  } else if (e.key === 'Home') go(rows[0])
  else if (e.key === 'End') go(rows[rows.length - 1])
  else if (e.key === 'ArrowRight' && current!.dataset.folder) {
    e.preventDefault()
    if (current!.dataset.folder === 'closed') current!.click()
    else go(rows[i + 1])
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    if (current!.dataset.folder === 'open') current!.click()
    else go(rows.slice(0, i).reverse().find((r) => r.dataset.folder && depth(r) < depth(current!)))
  }
}

function Chip(props: { active: boolean; onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button className={`chip ${props.className ?? ''} ${props.active ? 'active' : ''}`} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

interface TreeProps {
  roots: RootInfo[]
  docs: DocEntry[]
  selected: string | null
  onOpen: (p: string, newTab?: boolean) => void
  onRemoveRoot: (key: string) => void
  sort: 'name' | 'modified'
  actions: { files: FileActions; openMenu: (e: React.MouseEvent, target: MenuItem) => void }
  showEmpty: boolean
}

/**
 * One folder: its documents as a plain tree, like before.
 * Several folders: each one is a top-level node (like a VS Code multi-root workspace).
 */
function Tree({ roots, docs, selected, onOpen, onRemoveRoot, sort, actions, showEmpty }: TreeProps) {
  // Remember which folders you collapsed. Folder ids start with their root key, so they never clash.
  const storageKey = 'collapsed:workspace'
  const [collapsed, setCollapsed] = useState<string[]>(() => loadLocal(storageKey, []))
  const toggle = (path: string): void => {
    const next = collapsed.includes(path) ? collapsed.filter((p) => p !== path) : [...collapsed, path]
    setCollapsed(next)
    saveLocal(storageKey, next)
  }

  const renderFolder = (folder: TreeFolder, depth: number): ReactNode => (
    <>
      {folder.folders.map((f) => {
        const open = !collapsed.includes(f.path)
        return (
          <div key={f.path}>
            <button
              className="row folder"
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggle(f.path)}
              draggable
              onDragStart={(e) => dragFolder(e, f.path)}
              onContextMenu={(e) => actions.openMenu(e, { kind: 'folder', id: f.path, name: f.name, isRoot: false })}
              {...dropTarget(f.path, actions.files)}
              data-id={f.path}
              data-folder-id={f.path}
              data-name={f.name}
              data-folder={open ? 'open' : 'closed'}
              data-depth={depth}
              aria-expanded={open}
            >
              <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
              <span className="row-title">{f.name}</span>
            </button>
            {open && renderFolder(f, depth + 1)}
          </div>
        )
      })}
      {folder.docs.map((d) => (
        <DocRow key={d.path} doc={d} depth={depth} selected={selected === d.path} onOpen={onOpen} onMenu={(e) => actions.openMenu(e, { kind: 'doc', doc: d })} />
      ))}
    </>
  )

  // Built only when the documents change, not on every render (issue #11).
  // Empty folders show too, except while filtering by status or tag.
  const trees = useMemo(
    () => new Map(roots.map((r) => [r.key, buildTree(docs.filter((d) => d.root === r.key), r.key, sort, showEmpty ? (r.emptyFolders ?? []) : [])])),
    [roots, docs, sort, showEmpty]
  )
  const treeOf = (root: RootInfo): TreeFolder => trees.get(root.key)!

  if (roots.length === 1) return <>{renderFolder(treeOf(roots[0]), 0)}</>

  return (
    <>
      {roots.map((root) => {
        const open = !collapsed.includes(root.key)
        const tree = treeOf(root)
        const empty = tree.folders.length === 0 && tree.docs.length === 0
        return (
          <div key={root.key} className="root-group">
            <div className="root-row">
              <button
                className="row folder root"
                onClick={() => toggle(root.key)}
                title={root.path}
                draggable={!root.loose}
                onDragStart={(e) => dragFolder(e, root.key)}
                onContextMenu={(e) => actions.openMenu(e, { kind: 'folder', id: root.key, name: root.name, isRoot: true })}
                data-folder-id={root.key}
                {...dropTarget(root.key, actions.files)}
                data-folder={open ? 'open' : 'closed'}
                data-depth={0}
                aria-expanded={open}
              >
                <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
                <span className="row-title">{root.name}</span>
                {!root.available && <span className="root-missing">{t('không tìm thấy')}</span>}
              </button>
              <button
                className="icon-btn small root-remove"
                title={t('Bỏ thư mục này khỏi workspace (không xoá file)')}
                aria-label={t('Bỏ {0} khỏi workspace', { 0: root.name })}
                onClick={async () => {
                  const yes = await confirmDialog({ message: t('Bỏ thư mục "{0}" khỏi workspace?\n\n{1}\n\nFile trên ổ đĩa không bị xoá.', { 0: root.name, 1: root.path }), ok: t('Bỏ khỏi workspace'), cancel: t('Huỷ') })
                  if (yes) onRemoveRoot(root.key)
                }}
              >
                ×
              </button>
            </div>
            {open && renderFolder(tree, 1)}
            {open && empty && root.available && <div className="empty indent">{t('Không có tài liệu nào khớp.')}</div>}
          </div>
        )
      })}
    </>
  )
}

/** Files opened on their own, below the workspace folders. */
function LooseFiles({
  files,
  docs,
  selected,
  onOpen,
  onRemove
}: {
  files: LibrarySnapshot['looseFiles']
  docs: DocEntry[]
  selected: string | null
  onOpen: (p: string, newTab?: boolean) => void
  onRemove: (path: string) => void
}) {
  const byId = new Map(docs.map((d) => [d.path, d]))
  // Filters (status, tag) apply here too; missing files always show so they can be removed.
  const rows = files.filter((f) => !f.id || byId.has(f.id))
  if (!rows.length) return null
  const name = (p: string): string => p.split(/[\\/]/).pop() ?? p
  return (
    <div className="loose-group">
      <div className="group-title">{t('File lẻ')}</div>
      {rows.map((f) => {
        const doc = f.id ? byId.get(f.id) : undefined
        return (
          <div key={f.path} className="loose-row">
            {doc ? (
              <DocRow doc={doc} depth={0} selected={selected === doc.path} onOpen={onOpen} title={f.path} />
            ) : (
              <div className="row doc missing" title={f.path}>
                <span className="row-title">{name(f.path)}</span>
                <span className="root-missing">{t('không tìm thấy')}</span>
              </div>
            )}
            <button className="icon-btn small root-remove" title={t('Bỏ khỏi danh sách (không xoá file)')} aria-label={t('Bỏ {0} khỏi danh sách', { 0: name(f.path) })} onClick={() => onRemove(f.path)}>
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** A folder dropped on a calendar event links every document in it; on another folder it moves there. */
function dragFolder(e: React.DragEvent, id: string): void {
  e.dataTransfer.setData(FOLDER_DRAG_TYPE, id)
  e.dataTransfer.effectAllowed = 'linkMove'
}

/** Props that make a folder row accept documents and folders dragged from the tree (they move into it). */
function dropTarget(folderId: string, files: FileActions) {
  const dragged = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(DOC_DRAG_TYPE) || e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!dragged(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      ;(e.currentTarget as HTMLElement).classList.add('drop-into')
    },
    onDragLeave: (e: React.DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-into'),
    onDrop: (e: React.DragEvent) => {
      ;(e.currentTarget as HTMLElement).classList.remove('drop-into')
      const doc = e.dataTransfer.getData(DOC_DRAG_TYPE)
      const folder = e.dataTransfer.getData(FOLDER_DRAG_TYPE)
      if (!doc && !folder) return
      e.preventDefault()
      e.stopPropagation()
      const id = doc || folder
      if (id === folderId) return
      files.move(id, !doc, folderId)
    }
  }
}

/** The right-click menu of the tree. */
function TreeMenu({ target, files, onClose }: { target: MenuTarget; files: FileActions; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // Keep the menu inside the window.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`
    if (r.right > window.innerWidth) el.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`
  }, [])
  const run = (f: () => void) => () => {
    onClose()
    f()
  }
  const folderId = target.kind === 'folder' ? target.id : target.doc.rel.includes('/') ? `${target.doc.root}/${target.doc.rel.replace(/\/[^/]*$/, '')}` : target.doc.root
  return (
    <div ref={ref} className="popover menu tree-menu" role="menu" style={{ left: target.x, top: target.y }}>
      <button role="menuitem" onClick={run(() => files.newNote(folderId))}>
        {t('Bài mới…')}
        <kbd>Ctrl+N</kbd>
      </button>
      <button role="menuitem" onClick={run(() => files.newFolder(folderId))}>
        {t('Thư mục mới…')}
      </button>
      {!(target.kind === 'folder' && target.isRoot) && (
        <>
          <hr />
          <button role="menuitem" onClick={run(() => (target.kind === 'doc' ? files.rename(target.doc.path, false, target.doc.name) : files.rename(target.id, true, target.name)))}>
            {t('Đổi tên…')}
            <kbd>F2</kbd>
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={run(() => (target.kind === 'doc' ? files.trash(target.doc.path, false, target.doc.name) : files.trash(target.id, true, target.name)))}
          >
            {t('Xoá (vào Thùng rác)')}
          </button>
        </>
      )}
    </div>
  )
}

function DocRow({
  doc,
  depth,
  selected,
  onOpen,
  title,
  onMenu
}: {
  doc: DocEntry
  depth: number
  selected: boolean
  onOpen: (p: string, newTab?: boolean) => void
  title?: string
  onMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      className={`row doc ${selected ? 'selected' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 + 14 }}
      // Ctrl+click or the middle button: in a new tab.
      onClick={(e) => onOpen(doc.path, e.ctrlKey || e.metaKey)}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => e.button === 1 && onOpen(doc.path, true)}
      onContextMenu={onMenu}
      title={title ?? doc.rel}
      data-depth={depth}
      data-id={onMenu ? doc.path : undefined}
      data-name={doc.name}
      draggable
      onDragStart={(e) => {
        // Dropped on a calendar event it links the document; on a folder of the tree it moves there.
        e.dataTransfer.setData(DOC_DRAG_TYPE, doc.path)
        e.dataTransfer.effectAllowed = 'linkMove'
      }}
    >
      <span className={`kind kind-${doc.kind}`}>{kindLabel(doc.kind, doc.path)}</span>
      <span className="row-title">{doc.title}</span>
    </button>
  )
}

interface SearchResultsProps {
  hits: SearchHit[]
  query: string
  selected: string | null
  onOpen: (p: string, newTab?: boolean) => void
  /** Folder names to show in front of the path, when the workspace has several folders. */
  rootNames: Record<string, string> | null
}

function SearchResults({ hits, query, selected, onOpen, rootNames }: SearchResultsProps) {
  if (hits.length === 0) return <div className="empty">{t('Không tìm thấy kết quả.')}</div>
  return (
    <div className="group">
      <div className="group-title">{hits.length}{' '}{t('kết quả')}</div>
      {hits.map(({ doc, snippet }) => {
        const inside = doc.rel.includes('/') ? doc.rel.slice(0, doc.rel.lastIndexOf('/')) : ''
        const folder = rootNames ? [rootNames[doc.root], inside].filter(Boolean).join(' / ') : inside
        return (
          <button key={doc.path} className={`hit ${selected === doc.path ? 'selected' : ''}`} onClick={() => onOpen(doc.path)}>
            <div className="hit-title">
              <span className={`kind kind-${doc.kind}`}>{kindLabel(doc.kind, doc.path)}</span>
              {doc.title}
            </div>
            {folder && <div className="hit-path">{folder}</div>}
            {snippet && (
              <div className="hit-snippet">
                {snippet.before}
                <mark>{snippet.match}</mark>
                {snippet.after}
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Floating list of recently opened documents; closes on outside click or Escape. */
function RecentPopover({ lib, selected, onOpen, onClose }: { lib: LibrarySnapshot | null; selected: string | null; onOpen: (p: string, newTab?: boolean) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const times = lib?.recent ?? {}
  const recent = (lib?.docs ?? [])
    .filter((d) => times[d.path])
    .sort((a, b) => times[b.path] - times[a.path])
    .slice(0, 12)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!ref.current?.contains(target) && !target.closest('.sidebar-head .icon-btn')) onClose()
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

  return (
    <div ref={ref} className="popover recent-popover" role="dialog" aria-label={t('Mở gần đây')}>
      <div className="group-title">{t('Mở gần đây')}</div>
      {recent.length === 0 && <div className="empty">{t('Chưa mở bài nào.')}</div>}
      {recent.map((d) => (
        <button
          key={d.path}
          className={`row doc ${selected === d.path ? 'selected' : ''}`}
          title={d.rel}
          onClick={() => {
            onOpen(d.path)
            onClose()
          }}
        >
          <span className={`kind kind-${d.kind}`}>{kindLabel(d.kind, d.path)}</span>
          <span className="row-title">{d.title}</span>
          <span className="row-time">{timeAgo(times[d.path])}</span>
        </button>
      ))}
    </div>
  )
}

const iconProps = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function FilePlusIcon() {
  return (
    <svg {...iconProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9 14h6" />
    </svg>
  )
}

function FolderPlusIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <path d="M12 10.5v6M9 13.5h6" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </svg>
  )
}

/** A window with its left panel: shows / hides the sidebar. */
export function PanelIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

/** A magnifying glass: search. */
export function SearchIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}
