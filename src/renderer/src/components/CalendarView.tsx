// The calendar page: a week or month view (FullCalendar), with a panel for the event you
// clicked. Events link to documents: for one class (its notes) or for the whole course
// (syllabus, slides). Drag a document from the sidebar onto an event to link it.
//
// The events themselves live in the main process (data\calendar.ics, see calendar-store.ts);
// this page asks for the occurrences of the dates on screen.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Calendar, type EventDropArg, type EventInput } from '@fullcalendar/core'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin, { type EventResizeDoneArg } from '@fullcalendar/interaction'
import viLocale from '@fullcalendar/core/locales/vi'
import enGbLocale from '@fullcalendar/core/locales/en-gb'
import {
  colorHex,
  describeRrule,
  formatShortDate,
  formatTimeRange,
  reminderLabel,
  shiftLocal,
  shiftRule,
  ymd,
  ymdhm,
  type CalEventData,
  type CalEventDetail,
  type CalLinkView,
  type CalOccurrence,
  type EditScope
} from '../../../shared/calendar'
import type { DocEntry, RootInfo } from '../../../shared/types'
import { getLanguage, t } from '../../../shared/i18n'
import { DOC_DRAG_TYPE, FOLDER_DRAG_TYPE, folderChoices, kindLabel, loadLocal, saveLocal } from '../lib/docs'
import { ask, confirmDialog } from '../lib/ask'
import EventDialog, { askScope, type EditTarget } from './EventDialog'
import DocPicker from './DocPicker'
import SubscriptionsDialog from './SubscriptionsDialog'

/** Where the calendar should go (a class chip on a document was clicked). `n` changes on every jump. */
export interface CalendarFocus {
  date: string
  uid?: string
  rid?: string
  n: number
}

/** Tells open documents that links changed (their class chips reload). */
export const CALENDAR_CHANGED = 'studydocs:calendar-changed'

interface Props {
  docs: DocEntry[]
  /** Workspace folders, so whole folders can be linked. */
  roots: RootInfo[]
  focus: CalendarFocus | null
  onOpenDoc: (id: string) => void
  onError: (err: unknown) => void
  onInfo: (text: string) => void
}

type ViewType = 'timeGridWeek' | 'dayGridMonth'
const keyOf = (uid: string, rid: string): string => `${uid}|${rid}`

export default function CalendarView({ docs, roots, focus, onOpenDoc, onError, onInfo }: Props) {
  const folders = useMemo(() => folderChoices(docs, roots), [docs, roots])
  const hostRef = useRef<HTMLDivElement>(null)
  const calRef = useRef<Calendar | null>(null)
  const [title, setTitle] = useState('')
  const [viewType, setViewType] = useState<ViewType>(() => loadLocal<ViewType>('cal:view', 'timeGridWeek'))
  const [selected, setSelected] = useState<{ uid: string; rid: string } | null>(null)
  const [detail, setDetail] = useState<CalEventDetail | null>(null)
  const [version, setVersion] = useState(0)
  const [dialog, setDialog] = useState<{ initial: CalEventData; editing: EditTarget | null } | null>(null)
  const [picker, setPicker] = useState(false)
  const [subsOpen, setSubsOpen] = useState(false)

  const refresh = useCallback(() => {
    calRef.current?.refetchEvents()
    setVersion((v) => v + 1)
    window.dispatchEvent(new Event(CALENDAR_CHANGED))
  }, [])

  const newEvent = useCallback((start: string, end: string, allDay: boolean) => {
    setDialog({
      initial: { summary: '', allDay, start, end, location: '', description: '', color: '', rrule: '', exdates: [], reminder: -1 },
      editing: null
    })
  }, [])

  // Handlers FullCalendar calls; kept in a ref so the calendar is created only once.
  const handlers = useRef({
    select: (_o: { uid: string; rid: string }) => {},
    newEvent,
    move: async (_arg: EventDropArg | EventResizeDoneArg) => {},
    dropDoc: async (_o: CalOccurrence, _id: string, _kind: 'file' | 'folder') => {}
  })
  const selectedKey = selected ? keyOf(selected.uid, selected.rid) : ''
  const selectedKeyRef = useRef(selectedKey)
  selectedKeyRef.current = selectedKey

  handlers.current.select = (o) => setSelected({ uid: o.uid, rid: o.rid })
  handlers.current.newEvent = newEvent

  handlers.current.move = async (arg) => {
    const o = arg.event.extendedProps.occ as CalOccurrence
    const ev = arg.event
    const allDay = ev.allDay
    const start = allDay ? ymd(ev.start!) : ymdhm(ev.start!)
    const end = ev.end ? (allDay ? ymd(ev.end) : ymdhm(ev.end)) : allDay ? shiftLocal(start, 1440) : shiftLocal(start, 60)
    let scope: EditScope = 'all'
    if (o.recurring) {
      const chosen = await askScope(t('Dời sự kiện lặp lại'))
      if (!chosen) {
        arg.revert()
        return
      }
      scope = chosen
    }
    try {
      const d = await window.api.calendarDetail(o.uid, o.rid)
      const base: CalEventData = scope === 'this' ? { ...o, rrule: '', exdates: [] } : d.series
      const data: CalEventData = { ...base, allDay, start, end, rrule: scope === 'this' ? '' : shiftRule(d.series.rrule, o.start, start, allDay) }
      const uid = await window.api.calendarUpdate(o.uid, o.rid, scope, o.start, data)
      if (selectedKeyRef.current === keyOf(o.uid, o.rid)) setSelected({ uid, rid: scope === 'this' ? o.rid : start })
      refresh()
    } catch (err) {
      arg.revert()
      onError(err)
    }
  }

  handlers.current.dropDoc = async (o, id, kind) => {
    let rid: string | null = o.rid
    const name = kind === 'folder' ? (folders.find((f) => f.id === id)?.name ?? id) : (docs.find((d) => d.path === id)?.title ?? id)
    if (o.recurring) {
      const answer = await ask({
        message:
          kind === 'folder'
            ? t('Gắn thư mục "{0}" vào buổi {1} hay cả môn "{2}"?', { 0: name, 1: formatShortDate(o.start), 2: o.summary })
            : t('Gắn tài liệu vào buổi {0} hay cả môn "{1}"?', { 0: formatShortDate(o.start), 1: o.summary }),
        buttons: [t('Buổi này'), t('Cả môn'), t('Huỷ')],
        cancelId: 2,
        defaultId: 0
      })
      if (answer === 2) return
      rid = answer === 0 ? o.rid : null
    } else rid = null
    try {
      if (kind === 'folder') await window.api.calendarLinkFolder(o.uid, rid, id)
      else await window.api.calendarLink(o.uid, rid, id)
      onInfo(t('Đã gắn "{0}" vào "{1}".', { 0: name, 1: o.summary }))
      setSelected({ uid: o.uid, rid: o.rid })
      refresh()
    } catch (err) {
      onError(err)
    }
  }

  // Create the calendar once.
  useEffect(() => {
    const host = hostRef.current!
    const cal = new Calendar(host, {
      plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
      locale: getLanguage() === 'vi' ? viLocale : enGbLocale,
      initialView: loadLocal<ViewType>('cal:view', 'timeGridWeek'),
      initialDate: focus?.date ?? loadLocal<string>('cal:date', ymd(new Date())),
      headerToolbar: false,
      height: '100%',
      firstDay: 1,
      nowIndicator: true,
      scrollTime: '06:30:00',
      slotDuration: '00:30:00',
      slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      allDayText: t('Cả ngày'),
      dayMaxEvents: true,
      eventDisplay: 'block',
      selectable: true,
      selectMirror: true,
      editable: true,
      events: (info, success, failure) => {
        window.api
          .calendarRange(ymd(info.start), ymd(info.end))
          .then((list) => success(list.map(toInput)))
          .catch(failure)
      },
      eventContent: (arg) => {
        const o = arg.event.extendedProps.occ as CalOccurrence
        const box = document.createElement('div')
        box.className = 'sd-event'
        const line = (cls: string, text: string): void => {
          const el = document.createElement('div')
          el.className = cls
          el.textContent = text
          box.appendChild(el)
        }
        // Month view: one line per event ("07:00 Lập trình mạng").
        if (arg.view.type === 'dayGridMonth') {
          line('sd-event-title', `${arg.timeText && !arg.event.allDay ? `${arg.timeText} ` : ''}${o.summary}`)
          return { domNodes: [box] }
        }
        if (arg.timeText && !arg.event.allDay) line('sd-event-time', arg.timeText)
        line('sd-event-title', `${o.summary}${o.recurring ? ' ↻' : ''}`)
        if (o.location) line('sd-event-where', o.location)
        if (o.links) line('sd-event-links', t('{0} tài liệu', { 0: o.links }))
        return { domNodes: [box] }
      },
      eventDidMount: (arg) => {
        const o = arg.event.extendedProps.occ as CalOccurrence
        const el = arg.el
        el.dataset.key = keyOf(o.uid, o.rid)
        el.classList.toggle('is-selected', el.dataset.key === selectedKeyRef.current)
        el.title = `${o.summary}\n${formatTimeRange(o.start, o.end, o.allDay)}${o.location ? `\n${o.location}` : ''}`
        const accepts = (e: DragEvent): boolean => !!e.dataTransfer && (e.dataTransfer.types.includes(DOC_DRAG_TYPE) || e.dataTransfer.types.includes(FOLDER_DRAG_TYPE))
        el.addEventListener('dragover', (e) => {
          if (!accepts(e)) return
          e.preventDefault()
          e.dataTransfer!.dropEffect = 'link'
          el.classList.add('drop-target')
        })
        el.addEventListener('dragleave', () => el.classList.remove('drop-target'))
        el.addEventListener('drop', (e) => {
          el.classList.remove('drop-target')
          const doc = e.dataTransfer?.getData(DOC_DRAG_TYPE)
          const folder = e.dataTransfer?.getData(FOLDER_DRAG_TYPE)
          if (!doc && !folder) return
          e.preventDefault()
          e.stopPropagation()
          void handlers.current.dropDoc(o, (doc || folder)!, doc ? 'file' : 'folder')
        })
      },
      eventClick: (arg) => {
        arg.jsEvent.preventDefault()
        handlers.current.select(arg.event.extendedProps.occ as CalOccurrence)
      },
      select: (arg) => {
        cal.unselect()
        const month = arg.view.type === 'dayGridMonth'
        const oneDay = arg.allDay && ymd(arg.end) === shiftLocal(ymd(arg.start), 1440)
        // A click on a day of the month view: a class at 07:00 that day (change it in the dialog).
        if (month && oneDay) handlers.current.newEvent(`${ymd(arg.start)}T07:00`, `${ymd(arg.start)}T08:00`, false)
        else if (arg.allDay) handlers.current.newEvent(ymd(arg.start), ymd(arg.end), true)
        else handlers.current.newEvent(ymdhm(arg.start), ymdhm(arg.end), false)
      },
      eventDrop: (arg) => void handlers.current.move(arg),
      eventResize: (arg) => void handlers.current.move(arg),
      datesSet: (arg) => {
        setTitle(arg.view.title)
        setViewType(arg.view.type as ViewType)
        saveLocal('cal:view', arg.view.type)
        saveLocal('cal:date', ymd(arg.view.currentStart))
      }
    })
    cal.render()
    calRef.current = cal
    // The page can change size (sidebar, window); FullCalendar measures again.
    const ro = new ResizeObserver(() => cal.updateSize())
    ro.observe(host)
    return () => {
      ro.disconnect()
      cal.destroy()
      calRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribed calendars were downloaded again.
  useEffect(() => window.api.onCalendarChanged(refresh), [refresh])

  // A class chip on a document was clicked: go to that date and show the class.
  useEffect(() => {
    if (!focus) return
    calRef.current?.gotoDate(focus.date.slice(0, 10))
    if (focus.uid && focus.rid) setSelected({ uid: focus.uid, rid: focus.rid })
  }, [focus])

  // Mark the selected event.
  useEffect(() => {
    hostRef.current?.querySelectorAll<HTMLElement>('.fc-event').forEach((el) => el.classList.toggle('is-selected', el.dataset.key === selectedKey))
  }, [selectedKey, version])

  // Load the panel of the selected event.
  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let alive = true
    window.api
      .calendarDetail(selected.uid, selected.rid)
      .then((d) => alive && setDetail(d))
      .catch(() => {
        if (!alive) return
        setDetail(null)
        setSelected(null)
      })
    return () => {
      alive = false
    }
  }, [selected, version])

  const nowStart = (): { start: string; end: string } => {
    const d = new Date()
    d.setMinutes(0, 0, 0)
    d.setHours(d.getHours() + 1)
    const start = ymdhm(d)
    return { start, end: shiftLocal(start, 60) }
  }

  const removeEvent = async (): Promise<void> => {
    if (!detail) return
    const o = detail.occurrence
    let scope: EditScope = 'all'
    if (o.recurring) {
      const chosen = await askScope(t('Xoá sự kiện lặp lại "{0}"', { 0: o.summary }))
      if (!chosen) return
      scope = chosen
    } else if (!(await confirmDialog({ message: t('Xoá sự kiện "{0}"?', { 0: o.summary }), detail: t('Tài liệu đã gắn không bị xoá, chỉ bỏ liên kết.'), ok: t('Xoá'), cancel: t('Huỷ'), danger: true }))) return
    try {
      await window.api.calendarDelete(o.uid, o.rid, scope)
      setSelected(null)
      refresh()
    } catch (err) {
      onError(err)
    }
  }

  const editEvent = (): void => {
    if (!detail) return
    const o = detail.occurrence
    setDialog({
      initial: {
        summary: o.summary,
        allDay: o.allDay,
        start: o.start,
        end: o.end,
        location: o.location,
        reminder: o.reminder,
        description: o.description,
        color: o.color,
        rrule: o.recurring ? detail.series.rrule : '',
        exdates: o.recurring ? detail.series.exdates : []
      },
      editing: { uid: o.uid, rid: o.rid, recurring: o.recurring, shownStart: o.start }
    })
  }

  const run = (work: () => Promise<unknown>): void => {
    work().then(refresh, onError)
  }

  return (
    <div className="calendar-view">
      <div className="calendar-main">
        <div className="calendar-toolbar">
          <button className="btn small" onClick={() => calRef.current?.today()}>
            {t('Hôm nay')}
          </button>
          <button className="icon-btn" aria-label={t('Trước')} title={t('Trước')} onClick={() => calRef.current?.prev()}>
            ‹
          </button>
          <button className="icon-btn" aria-label={t('Sau')} title={t('Sau')} onClick={() => calRef.current?.next()}>
            ›
          </button>
          <h1 className="calendar-title">{title}</h1>
          <div className="spacer" />
          <div className="segmented plain" role="group" aria-label={t('Kiểu xem')}>
            <button className={viewType === 'timeGridWeek' ? 'active' : ''} onClick={() => calRef.current?.changeView('timeGridWeek')}>
              {t('Tuần')}
            </button>
            <button className={viewType === 'dayGridMonth' ? 'active' : ''} onClick={() => calRef.current?.changeView('dayGridMonth')}>
              {t('Tháng')}
            </button>
          </div>
          <button
            className="btn small"
            title={t('Thêm sự kiện từ file .ics (thời khoá biểu của trường, Google Calendar…)')}
            onClick={() =>
              window.api
                .calendarImport()
                .then((n) => {
                  if (n === null) return
                  onInfo(t('Đã nhập {0} sự kiện.', { 0: n }))
                  refresh()
                })
                .catch(onError)
            }
          >
            {t('Nhập .ics…')}
          </button>
          <button className="btn small" title={t('Xem lịch Google, thời khoá biểu… bằng link (tự cập nhật)')} onClick={() => setSubsOpen(true)}>
            {t('Lịch theo dõi…')}
          </button>
          <button
            className="btn small"
            title={t('Lưu cả lịch ra file .ics để mở bằng Google Calendar, Outlook, điện thoại…')}
            onClick={() =>
              window.api
                .calendarExport()
                .then((p) => p && onInfo(t('Đã xuất lịch ra {0}', { 0: p })))
                .catch(onError)
            }
          >
            {t('Xuất .ics…')}
          </button>
          <button
            className="btn primary small"
            onClick={() => {
              const { start, end } = nowStart()
              newEvent(start, end, false)
            }}
          >
            {t('+ Sự kiện')}
          </button>
        </div>
        <div className="calendar-host" ref={hostRef} />
      </div>

      {detail && (
        <EventPanel
          detail={detail}
          onClose={() => setSelected(null)}
          onEdit={editEvent}
          onDelete={() => void removeEvent()}
          onOpenDoc={onOpenDoc}
          onAddDoc={() => setPicker(true)}
          onUnlink={(l) => run(() => window.api.calendarUnlink(detail.occurrence.uid, l.scope === 'this' ? detail.occurrence.rid : null, l.path))}
          onClassNotes={() =>
            window.api
              .calendarClassNotes(detail.occurrence.uid, detail.occurrence.rid)
              .then((id) => {
                refresh()
                if (id) onOpenDoc(id)
              })
              .catch(onError)
          }
          onChangeFolder={() => run(() => window.api.calendarChooseNotesFolder(detail.occurrence.uid))}
        />
      )}

      {dialog && (
        <EventDialog
          initial={dialog.initial}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onError={onError}
          onSaved={(uid, rid) => {
            setDialog(null)
            setSelected({ uid, rid })
            calRef.current?.gotoDate(rid.slice(0, 10))
            refresh()
          }}
        />
      )}

      {subsOpen && <SubscriptionsDialog onClose={() => setSubsOpen(false)} onChanged={refresh} />}

      {picker && detail && (
        <DocPicker
          docs={docs}
          folders={folders}
          recurring={detail.occurrence.recurring}
          onClose={() => setPicker(false)}
          onPick={(id, scope) => {
            setPicker(false)
            run(() => window.api.calendarLink(detail.occurrence.uid, scope === 'this' ? detail.occurrence.rid : null, id))
          }}
          onPickFolder={(id, scope) => {
            setPicker(false)
            run(() => window.api.calendarLinkFolder(detail.occurrence.uid, scope === 'this' ? detail.occurrence.rid : null, id))
          }}
          onPickFiles={(scope) => {
            setPicker(false)
            run(() => window.api.calendarLinkFiles(detail.occurrence.uid, scope === 'this' ? detail.occurrence.rid : null))
          }}
        />
      )}
    </div>
  )
}

/** An occurrence as FullCalendar wants it. */
function toInput(o: CalOccurrence): EventInput {
  const color = colorHex(o.color) ?? 'var(--accent)'
  return {
    id: keyOf(o.uid, o.rid),
    title: o.summary,
    start: o.start,
    end: o.end,
    allDay: o.allDay,
    backgroundColor: color,
    // Events of a subscribed calendar are changed there, not here.
    editable: !o.readOnly,
    borderColor: color,
    extendedProps: { occ: o }
  }
}

interface PanelProps {
  detail: CalEventDetail
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenDoc: (id: string) => void
  onAddDoc: () => void
  onUnlink: (link: CalLinkView) => void
  onClassNotes: () => void
  onChangeFolder: () => void
}

function EventPanel({ detail, onClose, onEdit, onDelete, onOpenDoc, onAddDoc, onUnlink, onClassNotes, onChangeFolder }: PanelProps) {
  const o = detail.occurrence
  const own = detail.links.filter((l) => l.scope === 'this')
  const course = detail.links.filter((l) => l.scope === 'series')
  return (
    <aside className="event-panel" aria-label={t('Chi tiết sự kiện')}>
      <div className="event-panel-head">
        <span className="event-dot" style={{ background: colorHex(o.color) ?? 'var(--accent)' }} />
        <h2>{o.summary}</h2>
        <button className="icon-btn" aria-label={t('Đóng')} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="event-meta">
        <div>
          {formatShortDate(o.start)} · {formatTimeRange(o.start, o.end, o.allDay)}
        </div>
        {o.recurring && <div className="event-repeat">{describeRrule(detail.series.rrule, detail.series.start)}</div>}
        {o.overridden && <div className="hint">{t('Buổi này đã được đổi riêng.')}</div>}
        {o.location && <div>{o.location}</div>}
        {o.reminder >= 0 && <div>{t('Nhắc {0}', { 0: reminderLabel(o.reminder) })}</div>}
        {o.source && <div className="hint">{t('Từ lịch theo dõi "{0}" (chỉ xem; sửa ở lịch gốc).', { 0: o.source })}</div>}
        {o.description && <p className="event-desc">{o.description}</p>}
      </div>
      {!o.readOnly && (
        <div className="event-actions">
          <button className="btn small" onClick={onEdit}>
            {t('Sửa')}
          </button>
          <button className="btn small danger" onClick={onDelete}>
            {t('Xoá')}
          </button>
        </div>
      )}

      <section>
        <h3>{o.recurring ? t('Buổi này') : t('Tài liệu')}</h3>
        <LinkList links={o.recurring ? own : detail.links} onOpenDoc={onOpenDoc} onUnlink={onUnlink} />
        <div className="event-link-buttons">
          <button className="btn primary small" onClick={onClassNotes} title={t('Tạo (hoặc mở) file ghi chép .md cho buổi này')}>
            {t('Ghi chép buổi này')}
          </button>
          <button className="btn small" onClick={onAddDoc}>
            {t('+ Gắn tài liệu…')}
          </button>
        </div>
      </section>

      {o.recurring && (
        <section>
          <h3>{t('Cả môn')}</h3>
          <LinkList links={course} onOpenDoc={onOpenDoc} onUnlink={onUnlink} />
        </section>
      )}

      <p className="hint">
        {detail.notesFolder ? (
          <>
            {t('Ghi chép lưu ở')} <span className="path">{detail.notesFolder}</span>{' '}
            <button className="link-btn" onClick={onChangeFolder}>
              {t('Đổi…')}
            </button>
          </>
        ) : (
          t('Lần đầu bấm "Ghi chép buổi này", app sẽ hỏi lưu ghi chép của môn ở thư mục nào.')
        )}
      </p>
      <p className="hint">{t('Mẹo: kéo một tài liệu hoặc thư mục từ thanh bên thả vào sự kiện để gắn nhanh.')}</p>
    </aside>
  )
}

function LinkList({ links, onOpenDoc, onUnlink }: { links: CalLinkView[]; onOpenDoc: (id: string) => void; onUnlink: (l: CalLinkView) => void }) {
  if (!links.length) return <p className="hint">{t('Chưa có tài liệu nào.')}</p>
  return (
    <ul className="event-links">
      {links.map((l) =>
        l.kind === 'folder' ? (
          <FolderLink key={`${l.scope}:${l.path}`} link={l} onOpenDoc={onOpenDoc} onUnlink={onUnlink} />
        ) : (
        <li key={`${l.scope}:${l.path}`}>
          {l.id ? (
            <button className="link-btn" title={l.path} onClick={() => onOpenDoc(l.id!)}>
              {l.title}
            </button>
          ) : (
            <span className="missing" title={l.path}>
              {l.title} {t('(không tìm thấy)')}
            </span>
          )}
          <button className="icon-btn small" aria-label={t('Bỏ liên kết')} title={t('Bỏ liên kết (file không bị xoá)')} onClick={() => onUnlink(l)}>
            ×
          </button>
        </li>
        )
      )}
    </ul>
  )
}

/** A linked folder: its name, then the documents in it now (folded after a few). */
function FolderLink({ link, onOpenDoc, onUnlink }: { link: CalLinkView; onOpenDoc: (id: string) => void; onUnlink: (l: CalLinkView) => void }) {
  const [open, setOpen] = useState(false)
  const docs = link.docs ?? []
  const shown = open ? docs : docs.slice(0, 5)
  return (
    <li className="folder-link">
      <div className="folder-link-head">
        <span className="kind kind-folder">{t('THƯ MỤC')}</span>
        <span className={link.id ? 'folder-name' : 'missing'} title={link.path}>
          {link.title} {link.id ? `· ${t('{0} tài liệu', { 0: docs.length })}` : t('(không tìm thấy)')}
        </span>
        <button className="icon-btn small" aria-label={t('Bỏ liên kết')} title={t('Bỏ liên kết (thư mục không bị xoá)')} onClick={() => onUnlink(link)}>
          ×
        </button>
      </div>
      {shown.length > 0 && (
        <ul className="folder-docs">
          {shown.map((d) => (
            <li key={d.id}>
              <span className={`kind kind-${d.kind}`}>{kindLabel(d.kind as DocEntry['kind'], d.id)}</span>
              <button className="link-btn" onClick={() => onOpenDoc(d.id)}>
                {d.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {docs.length > 5 && (
        <button className="link-btn small" onClick={() => setOpen(!open)}>
          {open ? t('Thu gọn') : t('Xem cả {0} tài liệu', { 0: docs.length })}
        </button>
      )}
    </li>
  )
}
