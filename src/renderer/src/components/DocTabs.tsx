import { useEffect, useRef } from 'react'
import type { DocEntry } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { DOC_DRAG_TYPE, kindLabel } from '../lib/docs'

// The open documents, as tabs over the document. Only the selected one is loaded; the others
// open again where you were reading. A click selects, the middle button or × closes, dragging
// changes the order; a document dragged from the sidebar opens in a new tab.

const TAB_DRAG_TYPE = 'application/x-studydocs-tab'

interface Props {
  tabs: string[]
  docs: DocEntry[]
  selected: string | null
  /** The selected tab has unsaved edits. */
  dirty: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (tabs: string[]) => void
  onOpenInNewTab: (id: string) => void
}

export default function DocTabs({ tabs, docs, selected, dirty, onSelect, onClose, onReorder, onOpenInNewTab }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const byId = new Map(docs.map((d) => [d.path, d]))

  // The selected tab stays in view when there are many.
  useEffect(() => {
    barRef.current?.querySelector('.doc-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected, tabs.length])

  const dropAt = (e: React.DragEvent, index: number): void => {
    const from = e.dataTransfer.getData(TAB_DRAG_TYPE)
    if (from !== '') {
      e.preventDefault()
      const next = tabs.slice()
      const [moved] = next.splice(Number(from), 1)
      next.splice(index > Number(from) ? index - 1 : index, 0, moved)
      onReorder(next)
      return
    }
    const doc = e.dataTransfer.getData(DOC_DRAG_TYPE)
    if (doc) {
      e.preventDefault()
      onOpenInNewTab(doc)
    }
  }
  const accepts = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(TAB_DRAG_TYPE) || e.dataTransfer.types.includes(DOC_DRAG_TYPE)

  return (
    <div
      className="doc-tabs"
      role="tablist"
      ref={barRef}
      onDragOver={(e) => accepts(e) && e.preventDefault()}
      onDrop={(e) => dropAt(e, tabs.length)}
      // Scrolling the wheel over many tabs moves them sideways.
      onWheel={(e) => {
        if (barRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) barRef.current.scrollLeft += e.deltaY
      }}
    >
      {tabs.map((id, i) => {
        const doc = byId.get(id)
        const name = doc?.title || doc?.name || id.split('/').pop() || id
        const active = id === selected
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            className={`doc-tab ${active ? 'active' : ''}`}
            title={doc?.rel ?? id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DRAG_TYPE, String(i))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => accepts(e) && e.preventDefault()}
            onDrop={(e) => {
              e.stopPropagation()
              dropAt(e, i)
            }}
            onClick={() => !active && onSelect(id)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && onClose(id)}
          >
            {doc && <span className={`kind kind-${doc.kind}`}>{kindLabel(doc.kind, doc.path)}</span>}
            <span className="doc-tab-name">{name}</span>
            {active && dirty && <span className="doc-tab-dot" title={t('Có thay đổi chưa lưu')} />}
            <button
              className="doc-tab-close"
              aria-label={t('Đóng {0}', { 0: name })}
              title={t('Đóng (Ctrl+W)')}
              onClick={(e) => {
                e.stopPropagation()
                onClose(id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
