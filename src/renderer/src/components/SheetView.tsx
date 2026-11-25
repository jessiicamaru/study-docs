import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocEntry, SheetData, SheetSave } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { errorMessage } from '../lib/docs'

// A CSV or XLSX file as a grid. Cells are edited in place (Enter / F2 / typing; Enter goes
// down, Tab goes right, Esc cancels); a block copied from Excel can be pasted. CSV files can
// also get or lose rows and columns. Formula cells (XLSX) show the value Excel saved and are
// read-only: nothing is calculated here.

interface Props {
  doc: DocEntry
  onError: (err: unknown) => void
  onInfo?: (text: string) => void
  onDirty: (dirty: boolean) => void
  onReady?: () => void
}

interface CsvRow {
  orig?: number
  cells: string[]
}

/** Zero-based column -> "A", "B", ... "AA". */
const colName = (col: number): string => {
  let s = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
const PAGE = 300

export default function SheetView({ doc, onError, onInfo, onDirty, onReady }: Props) {
  const [data, setData] = useState<SheetData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState(0)
  // XLSX: edited cells ("sheet:row:col" -> text). CSV: the rows as they are now.
  const [edits, setEdits] = useState<Map<string, string>>(new Map())
  const [rows, setRows] = useState<CsvRow[]>([])
  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const [editing, setEditing] = useState<{ r: number; c: number; draft: string } | null>(null)
  const [shown, setShown] = useState(PAGE)
  const [saving, setSaving] = useState(false)
  // Ctrl+S: saved after the next render, so a cell just typed in is part of it.
  const [saveTick, setSaveTick] = useState(0)
  const gridRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const d = await window.api.loadSheet(doc.path)
      setData(d)
      setLoadError(null)
      setEdits(new Map())
      setRows(d.format === 'csv' ? d.sheets[0].rows.map((r, i) => ({ orig: i, cells: r.map((c) => c.text) })) : [])
      setEditing(null)
    } catch (err) {
      setLoadError(errorMessage(err))
    }
  }, [doc.path])
  useEffect(() => {
    void load().then(() => onReady?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const sheet = data?.sheets[tab]
  const isCsv = data?.format === 'csv'
  const readOnly = sheet?.readOnly
  const original = useMemo(() => (isCsv && data ? data.sheets[0].rows.map((r) => r.map((c) => c.text)) : []), [data, isCsv])

  const rowCount = isCsv ? rows.length : (sheet?.rows.length ?? 0)
  const colCount = isCsv ? Math.max(1, ...rows.map((r) => r.cells.length)) : (sheet?.cols ?? 1)
  // A few empty rows and columns past the data, to type into (XLSX).
  const shownRows = Math.min(shown, rowCount + (isCsv ? 0 : 20))
  const shownCols = colCount + (isCsv ? 0 : 3)

  const baseCell = (r: number, c: number) => sheet?.rows[r]?.[c]
  const valueAt = (r: number, c: number): string =>
    isCsv ? (rows[r]?.cells[c] ?? '') : (edits.get(`${tab}:${r}:${c}`) ?? baseCell(r, c)?.text ?? '')
  const isFormula = (r: number, c: number): boolean => !isCsv && baseCell(r, c)?.kind === 'formula'
  const isChanged = (r: number, c: number): boolean =>
    isCsv ? rows[r]?.orig === undefined || (rows[r]?.cells[c] ?? '') !== (original[rows[r].orig!]?.[c] ?? '') : edits.has(`${tab}:${r}:${c}`)

  const csvDirty = useMemo(() => {
    if (!isCsv) return false
    if (rows.length !== original.length) return true
    return rows.some((r, i) => r.orig !== i || r.cells.length !== original[i].length || r.cells.some((v, j) => v !== original[i][j]))
  }, [rows, original, isCsv])
  const dirty = isCsv ? csvDirty : edits.size > 0
  const changeCount = isCsv ? rows.filter((r, i) => r.orig !== i || r.cells.join('\u0000') !== (original[i] ?? []).join('\u0000')).length + Math.max(0, original.length - rows.length) : edits.size
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  /** Sets a cell; an XLSX cell set back to what the file has is no longer an edit. */
  const setCell = (r: number, c: number, text: string): void => {
    if (readOnly || isFormula(r, c)) return
    if (isCsv) {
      setRows((prev) => {
        const next = prev.slice()
        while (next.length <= r) next.push({ cells: [] })
        const cells = next[r].cells.slice()
        while (cells.length <= c) cells.push('')
        cells[c] = text
        next[r] = { ...next[r], cells }
        return next
      })
    } else {
      setEdits((prev) => {
        const next = new Map(prev)
        const key = `${tab}:${r}:${c}`
        if (text === (baseCell(r, c)?.text ?? '')) next.delete(key)
        else next.set(key, text)
        return next
      })
    }
  }

  const focusGrid = (): void => gridRef.current?.focus()
  const move = (dr: number, dc: number): void => {
    setSel((s) => ({ r: Math.max(0, Math.min(Math.max(shownRows - 1, 0), s.r + dr)), c: Math.max(0, Math.min(shownCols - 1, s.c + dc)) }))
  }
  const startEdit = (r: number, c: number, draft?: string): void => {
    if (readOnly) return onInfo?.(readOnly)
    if (isFormula(r, c)) return onInfo?.(t('Ô này có công thức: app chỉ hiện kết quả Excel đã lưu. Hãy sửa công thức trong Excel.'))
    setEditing({ r, c, draft: draft ?? valueAt(r, c) })
  }
  // While a cell closes, the grid takes the focus back right away (not a frame later, or a key
  // typed fast after Enter/Tab would land in the closing cell); the cell's blur is then ignored.
  const closing = useRef(false)
  const closeCell = (keep: boolean, dr: number, dc: number): void => {
    if (!editing || closing.current) return
    closing.current = true
    if (keep) setCell(editing.r, editing.c, editing.draft)
    setEditing(null)
    move(dr, dc)
    focusGrid()
    closing.current = false
  }
  const commit = (dr: number, dc: number): void => closeCell(true, dr, dc)

  // Keep the selected cell in view.
  useEffect(() => {
    if (sel.r >= shown - 5) setShown((n) => n + PAGE)
    gridRef.current?.querySelector(`[data-cell="${sel.r}:${sel.c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [sel, shown])

  const save = async (): Promise<void> => {
    if (!data || !dirty || saving) return
    setSaving(true)
    try {
      const payload: SheetSave = isCsv
        ? { format: 'csv', rows }
        : {
            format: 'xlsx',
            edits: [...edits].map(([key, text]) => {
              const [s, r, c] = key.split(':').map(Number)
              return { sheet: s, row: r, col: c, text }
            })
          }
      await window.api.saveSheet(doc.path, payload, data.mtime)
      await load()
      onInfo?.(t('Đã lưu.'))
    } catch (err) {
      onError(err)
      // Changed outside the app meanwhile: show the file as it is now (the message says so).
      const now = await window.api.loadSheet(doc.path).catch(() => null)
      if (now && Math.abs(now.mtime - data.mtime) > 1) await load()
    } finally {
      setSaving(false)
    }
  }
  useEffect(() => {
    if (saveTick) void save()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveTick])
  const discard = (): void => {
    if (data) {
      setEdits(new Map())
      setRows(isCsv ? data.sheets[0].rows.map((r, i) => ({ orig: i, cells: r.map((c) => c.text) })) : [])
      setEditing(null)
    }
  }

  // ---------- CSV rows and columns ----------
  const addRow = (): void => {
    setRows((prev) => {
      const next = prev.slice()
      next.splice(Math.min(sel.r + 1, next.length), 0, { cells: Array(colCount).fill('') })
      return next
    })
    setSel((s) => ({ r: s.r + 1, c: 0 }))
  }
  const deleteRow = (): void => {
    if (rows.length <= 1) return
    setRows((prev) => prev.filter((_, i) => i !== sel.r))
    setSel((s) => ({ ...s, r: Math.min(s.r, rows.length - 2) }))
  }
  const addCol = (): void => {
    setRows((prev) => prev.map((r) => {
      const cells = r.cells.slice()
      while (cells.length < colCount) cells.push('')
      cells.splice(sel.c + 1, 0, '')
      return { ...r, cells }
    }))
    setSel((s) => ({ ...s, c: s.c + 1 }))
  }
  const deleteCol = (): void => {
    if (colCount <= 1) return
    setRows((prev) => prev.map((r) => (r.cells.length > sel.c ? { ...r, cells: r.cells.filter((_, j) => j !== sel.c) } : r)))
    setSel((s) => ({ ...s, c: Math.min(s.c, colCount - 2) }))
  }

  /** Buttons of the bar leave the keyboard in the grid: typing goes on in the cells. */
  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()
  const tool = (action: () => void): void => {
    if (editing) commit(0, 0)
    action()
    focusGrid()
  }
  // Ctrl+S anywhere in the sheet (the grid, a cell being typed in, a button of the bar).
  const onSaveKey = (e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      if (editing) {
        setCell(editing.r, editing.c, editing.draft)
        setEditing(null)
      }
      setSaveTick((n) => n + 1)
    }
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editing) return
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      void navigator.clipboard.writeText(valueAt(sel.r, sel.c)).catch(() => {})
      return
    }
    if (ctrl) return
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (moves[e.key]) {
      e.preventDefault()
      move(...moves[e.key])
    } else if (e.key === 'Tab') {
      e.preventDefault()
      move(0, e.shiftKey ? -1 : 1)
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit(sel.r, sel.c)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      setCell(sel.r, sel.c, '')
    } else if (e.key.length === 1 && !e.altKey) {
      e.preventDefault()
      startEdit(sel.r, sel.c, e.key)
    }
  }

  // A block copied from Excel (tab-separated lines) fills the cells from the selected one.
  const onPaste = (e: React.ClipboardEvent): void => {
    if (editing || readOnly) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
    lines.forEach((line, i) => line.split('\t').forEach((v, j) => setCell(sel.r + i, sel.c + j, v)))
  }

  if (loadError) return <div className="sheet-error">{loadError}</div>
  if (!data || !sheet) return <div className="sheet-loading">{t('Đang mở…')}</div>

  const cellRef = `${colName(sel.c)}${sel.r + 1}`
  return (
    <div className="sheet-view" onKeyDownCapture={onSaveKey}>
      <div className="sheet-bar">
        <span className="sheet-ref" title={t('Ô đang chọn')}>{cellRef}</span>
        <span className={`sheet-value ${isFormula(sel.r, sel.c) ? 'formula' : ''}`} title={valueAt(sel.r, sel.c)}>
          {isFormula(sel.r, sel.c) && <span className="fx">ƒ</span>}
          {valueAt(sel.r, sel.c)}
        </span>
        {isCsv && !readOnly && (
          <span className="sheet-tools">
            <button className="btn small" onMouseDown={keepFocus} onClick={() => tool(addRow)} title={t('Thêm hàng bên dưới ô đang chọn')}>{t('+ Hàng')}</button>
            <button className="btn small" onMouseDown={keepFocus} onClick={() => tool(addCol)} title={t('Thêm cột bên phải ô đang chọn')}>{t('+ Cột')}</button>
            <button className="btn small" onMouseDown={keepFocus} onClick={() => tool(deleteRow)} disabled={rows.length <= 1} title={t('Xoá hàng đang chọn')}>{t('− Hàng')}</button>
            <button className="btn small" onMouseDown={keepFocus} onClick={() => tool(deleteCol)} disabled={colCount <= 1} title={t('Xoá cột đang chọn')}>{t('− Cột')}</button>
          </span>
        )}
        <span className="spacer" />
        {dirty && <span className="sheet-dirty">{t('{0} thay đổi chưa lưu', { 0: changeCount })}</span>}
        {dirty && (
          <button className="btn small" onClick={discard} disabled={saving}>
            {t('Huỷ thay đổi')}
          </button>
        )}
        <button className="btn primary small" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? t('Đang lưu…') : t('Lưu (Ctrl+S)')}
        </button>
      </div>
      {(readOnly || sheet.truncated) && (
        <div className="sheet-note">{readOnly ?? t('File lớn: chỉ hiện {0} hàng và {1} cột đầu.', { 0: 5000, 1: 200 })}</div>
      )}
      <div
        className="sheet-grid"
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 400 && shown < rowCount + 20) setShown((n) => n + PAGE)
        }}
      >
        <table>
          <thead>
            <tr>
              <th className="corner" />
              {Array.from({ length: shownCols }, (_, c) => (
                <th key={c} className={c === sel.c ? 'on' : ''}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: Math.max(shownRows, 1) }, (_, r) => (
              <tr key={r}>
                <th className={r === sel.r ? 'on' : ''}>{r + 1}</th>
                {Array.from({ length: shownCols }, (_, c) => {
                  const kind = isCsv ? (/^-?[\d.,]+%?$/.test(valueAt(r, c)) ? 'number' : 'text') : (baseCell(r, c)?.kind ?? 'empty')
                  const selected = sel.r === r && sel.c === c
                  const isEditing = editing && editing.r === r && editing.c === c
                  return (
                    <td
                      key={c}
                      data-cell={`${r}:${c}`}
                      className={[
                        `k-${kind}`,
                        selected ? 'sel' : '',
                        isChanged(r, c) ? 'changed' : ''
                      ].join(' ')}
                      title={kind === 'formula' ? t('Công thức (chỉ xem): {0}', { 0: valueAt(r, c) }) : valueAt(r, c).length > 30 ? valueAt(r, c) : undefined}
                      onMouseDown={() => {
                        if (editing && !isEditing) commit(0, 0)
                        setSel({ r, c })
                      }}
                      onDoubleClick={() => startEdit(r, c)}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          className="sheet-input"
                          value={editing.draft}
                          onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commit(e.shiftKey ? -1 : 1, 0)
                            } else if (e.key === 'Tab') {
                              e.preventDefault()
                              commit(0, e.shiftKey ? -1 : 1)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              e.stopPropagation()
                              closeCell(false, 0, 0)
                            }
                          }}
                          onBlur={() => commit(0, 0)}
                        />
                      ) : (
                        valueAt(r, c)
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.format === 'xlsx' && data.sheets.length > 1 && (
        <div className="sheet-tabs" role="tablist">
          {data.sheets.map((s, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === tab}
              className={i === tab ? 'active' : ''}
              onClick={() => {
                if (editing) commit(0, 0)
                setTab(i)
                setSel({ r: 0, c: 0 })
                setShown(PAGE)
              }}
            >
              {s.name}
              {[...edits.keys()].some((k) => k.startsWith(`${i}:`)) && <span className="dot" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
