import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUserDirectory, userLabel } from '../hooks/useUserDirectory'
import { useI18n, type MessageKey } from '../i18n'
import type { UserSummary } from '../types'
import {
  COLUMN_MAX_WIDTH,
  COLUMN_MIN_WIDTH,
  PROJECT_COLORS,
  PROJECT_SCALES,
  TABLE_MIN_WIDTH,
  TABLE_MAX_WIDTH,
  addDays,
  addTask,
  daysBetween,
  formatIsoDate,
  indentTask,
  isSummary,
  moveTask,
  moveTaskBefore,
  outdentTask,
  parsePlan,
  predecessorIndexText,
  predecessorsFromIndexText,
  planRange,
  removeTask,
  resizeTask,
  resolveAssigneeName,
  resolvePlan,
  serializePlan,
  shiftTask,
  taskBlockEnd,
  type ProjectColor,
  type ProjectColumn,
  type ProjectLayout,
  type ProjectScale,
  type ResolvedTask,
  type TaskKind,
  updateLayout,
  updateTask,
  type ProjectDoc,
} from './projectModel'
import '../styles/project.css'

type Props = {
  source: string
  onChange?: (next: string) => void
  compact?: boolean
  readOnly?: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Kanban's colour names double as the bar colour names — one glossary per book. */
const COLOR_KEYS: Record<ProjectColor, MessageKey> = {
  accent: 'kanban.color.accent',
  info: 'kanban.color.info',
  ok: 'kanban.color.ok',
  warn: 'kanban.color.warn',
  danger: 'kanban.color.danger',
  muted: 'kanban.color.muted',
}

const SCALE_KEYS: Record<ProjectScale, MessageKey> = {
  months: 'project.scale.months',
  weeks: 'project.scale.weeks',
  days: 'project.scale.days',
  hours: 'project.scale.hours',
}

/**
 * Pixels per day at each zoom, plus how much calendar the chart pads around
 * the plan: a months view of a two-week plan should still show a year, an
 * hours view of the same plan should not be a mile of empty grid.
 */
const SCALES: Record<ProjectScale, { dayW: number; compactDayW: number; padBefore: number; padAfter: number; minDays: number }> = {
  months: { dayW: 4, compactDayW: 3, padBefore: 30, padAfter: 60, minDays: 365 },
  weeks: { dayW: 9, compactDayW: 7, padBefore: 14, padAfter: 28, minDays: 140 },
  days: { dayW: 22, compactDayW: 16, padBefore: 7, padAfter: 14, minDays: 42 },
  hours: { dayW: 168, compactDayW: 120, padBefore: 2, padAfter: 4, minDays: 14 },
}

/** Pixel widths a column has until someone drags it. Compact embeds start narrower. */
const DEFAULT_WIDTHS: Record<ProjectColumn, number> = {
  name: 176,
  kind: 104,
  start: 120,
  duration: 56,
  finish: 120,
  progress: 58,
  predecessors: 68,
  assignee: 128,
}
const COMPACT_WIDTHS: Partial<Record<ProjectColumn, number>> = { name: 150, start: 104, progress: 50 }

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
/** Only used as the drag baseline when the table has not been measured yet. */
const DEFAULT_TABLE_WIDTH = 420

type HeaderCell = { key: string; label: string; width: number; cls?: string }

/** Two header rows for a scale: coarse on top, the unit of the grid below. */
function buildHeader(days: Date[], scale: ProjectScale, dayW: number, todayOff: number): { top: HeaderCell[]; bottom: HeaderCell[] } {
  const group = (keyOf: (d: Date, i: number) => string, labelOf: (d: Date, i: number) => string, clsOf?: (d: Date, i: number) => string) => {
    const cells: HeaderCell[] = []
    days.forEach((d, i) => {
      const key = keyOf(d, i)
      const last = cells[cells.length - 1]
      if (last && last.key === key) last.width += dayW
      else cells.push({ key, label: labelOf(d, i), width: dayW, cls: clsOf?.(d, i) })
    })
    return cells
  }
  const byMonth = () => group((d) => `${d.getFullYear()}-${d.getMonth()}`, (d) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`)

  switch (scale) {
    case 'months':
      return {
        top: group((d) => String(d.getFullYear()), (d) => String(d.getFullYear())),
        bottom: group(
          (d) => `${d.getFullYear()}-${d.getMonth()}`,
          (d) => MONTHS[d.getMonth()],
          (d) => (d.getMonth() === days[todayOff]?.getMonth() && d.getFullYear() === days[todayOff]?.getFullYear() ? 'is-today' : ''),
        ),
      }
    case 'weeks': {
      // ISO-style weeks starting Monday; the first cell may be a partial week.
      const monday = (d: Date) => formatIsoDate(addDays(d, -((d.getDay() + 6) % 7)))
      return {
        top: byMonth(),
        bottom: group(monday, (d) => String(d.getDate()), (d) => (monday(d) === monday(days[todayOff] ?? new Date(0)) ? 'is-today' : '')),
      }
    }
    case 'hours': {
      const hourW = dayW / 4
      const bottom: HeaderCell[] = []
      days.forEach((d, i) => {
        for (const h of [0, 6, 12, 18]) {
          bottom.push({ key: `${i}-${h}`, label: `${h}h`, width: hourW, cls: d.getDay() === 0 || d.getDay() === 6 ? 'is-weekend' : '' })
        }
      })
      return {
        top: group(
          (_d, i) => String(i),
          (d) => `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`,
          (_d, i) => (i === todayOff ? 'is-today' : ''),
        ),
        bottom,
      }
    }
    default:
      return {
        top: byMonth(),
        bottom: group(
          (_d, i) => String(i),
          (d) => String(d.getDate()),
          (d, i) => `${d.getDay() === 0 || d.getDay() === 6 ? 'is-weekend' : ''}${i === todayOff ? ' is-today' : ''}`,
        ),
      }
  }
}

function commit(doc: ProjectDoc, onChange?: (next: string) => void) {
  onChange?.(serializePlan(doc))
}

type Menu = { x: number; y: number; rowId: string | null }

export function ProjectEditor({ source, onChange, compact = false, readOnly = false }: Props) {
  const { t } = useI18n()
  const { users, loading: usersLoading } = useUserDirectory()
  const doc = useMemo(() => parsePlan(source), [source])
  const rows = useMemo(() => resolvePlan(doc), [doc])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const ganttRef = useRef<HTMLDivElement>(null)
  const ganttBodyRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)
  const dragBase = useRef<ProjectDoc | null>(null)

  // Widths and zoom live in the document so every reader sees the same
  // table, but a drag renders from local state and commits once on
  // pointer-up — one saved revision per drag, not one per pixel. A read-only
  // view keeps its changes locally, which is why this is state rather than
  // derived from `doc`.
  const [layout, setLayout] = useState<ProjectLayout>(() => doc.layout ?? {})
  useEffect(() => {
    setLayout(doc.layout ?? {})
  }, [doc.layout])
  const splitRef = useRef<HTMLDivElement>(null)
  const resize = useRef<{ kind: 'column'; key: ProjectColumn; originX: number; base: number } | { kind: 'table'; originX: number; base: number } | null>(null)

  const columnWidth = (key: ProjectColumn) =>
    layout.columns?.[key] ?? (compact ? COMPACT_WIDTHS[key] : undefined) ?? DEFAULT_WIDTHS[key]

  const scale: ProjectScale = layout.scale ?? 'days'
  const scaleCfg = SCALES[scale]
  const dayW = compact ? scaleCfg.compactDayW : scaleCfg.dayW
  const rowH = compact ? 28 : 32
  const range = useMemo(
    () => planRange(rows, scaleCfg.padBefore, scaleCfg.padAfter, scaleCfg.minDays),
    [rows, scaleCfg],
  )

  const syncScroll = (from: 'table' | 'gantt', top: number) => {
    if (syncing.current) return
    syncing.current = true
    const other = from === 'table' ? ganttRef.current : tableRef.current
    if (other) other.scrollTop = top
    syncing.current = false
  }

  const selected = rows.find((r) => r.id === selectedId) ?? null
  const editable = !readOnly && Boolean(onChange)

  const apply = useCallback(
    (next: ProjectDoc) => {
      if (!editable) return
      commit(next, onChange)
    },
    [editable, onChange],
  )

  // ----- column / split resizing -----

  const startColumnResize = (key: ProjectColumn) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resize.current = { kind: 'column', key, originX: e.clientX, base: columnWidth(key) }
  }

  const startTableResize = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const base = tableRef.current?.getBoundingClientRect().width ?? DEFAULT_TABLE_WIDTH
    resize.current = { kind: 'table', originX: e.clientX, base }
  }

  const onResizeMove = (e: React.PointerEvent<HTMLElement>) => {
    const st = resize.current
    if (!st) return
    const dx = e.clientX - st.originX
    if (st.kind === 'column') {
      const w = clamp(st.base + dx, COLUMN_MIN_WIDTH, COLUMN_MAX_WIDTH)
      setLayout((l) => ({ ...l, columns: { ...(l.columns ?? {}), [st.key]: w } }))
    } else {
      // Leave the Gantt at least a few days wide whatever the container is.
      const room = (splitRef.current?.getBoundingClientRect().width ?? Infinity) - 160
      const w = clamp(st.base + dx, TABLE_MIN_WIDTH, Math.min(TABLE_MAX_WIDTH, room))
      setLayout((l) => ({ ...l, table: w }))
    }
  }

  const onResizeEnd = () => {
    const st = resize.current
    if (!st) return
    resize.current = null
    if (!editable) return
    if (st.kind === 'column') {
      const w = layout.columns?.[st.key]
      if (w != null && w !== (doc.layout?.columns?.[st.key] ?? null)) apply(updateLayout(doc, { columns: { [st.key]: w } }))
    } else if (layout.table != null && layout.table !== doc.layout?.table) {
      apply(updateLayout(doc, { table: layout.table }))
    }
  }

  // Double-click a handle to forget the stored width for that column / the split.
  const resetColumn = (key: ProjectColumn) => {
    setLayout((l) => {
      const cols = { ...(l.columns ?? {}) }
      delete cols[key]
      return { ...l, columns: cols }
    })
    if (editable && doc.layout?.columns?.[key] != null) apply(updateLayout(doc, { columns: { [key]: null } }))
  }
  const resetTable = () => {
    setLayout((l) => {
      const { table: _t, ...rest } = l
      void _t
      return rest
    })
    if (editable && doc.layout?.table != null) apply(updateLayout(doc, { table: null }))
  }

  // ----- zoom -----

  // The calendar instant under the cursor (or the viewport centre) before a
  // zoom, restored by the layout effect after the new scale has rendered.
  const zoomAnchor = useRef<{ ms: number; px: number } | null>(null)
  const zoomTo = useCallback(
    (next: ProjectScale, clientX?: number) => {
      if (next === scale) return
      const gantt = ganttRef.current
      if (gantt) {
        const rect = gantt.getBoundingClientRect()
        const px = clientX != null ? clientX - rect.left : rect.width / 2
        const dayFloat = (gantt.scrollLeft + px) / dayW
        zoomAnchor.current = { ms: range.start.getTime() + dayFloat * 86400000, px }
      }
      setLayout((l) => ({ ...l, scale: next }))
      if (editable) apply(updateLayout(doc, { scale: next }))
    },
    [apply, dayW, doc, editable, range.start, scale],
  )
  const zoomToRef = useRef(zoomTo)
  zoomToRef.current = zoomTo
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const gantt = ganttRef.current
    if (!anchor || !gantt) return
    zoomAnchor.current = null
    const off = (anchor.ms - range.start.getTime()) / 86400000
    gantt.scrollLeft = Math.max(0, off * dayW - anchor.px)
  }, [dayW, range.start])

  useEffect(() => {
    const el = ganttRef.current
    if (!el) return
    let last = 0
    // Native listener so preventDefault works (React wheel is passive) — the
    // browser must not page-zoom on Ctrl+wheel. One level per 200 ms so a
    // flick of the wheel steps, rather than jumping months→hours.
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const now = Date.now()
      if (now - last < 200) return
      last = now
      const idx = PROJECT_SCALES.indexOf(scaleRef.current)
      const next = PROJECT_SCALES[clamp(idx + (e.deltaY < 0 ? 1 : -1), 0, PROJECT_SCALES.length - 1)]
      zoomToRef.current(next, e.clientX)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const stepZoom = (dir: -1 | 1) => {
    const idx = PROJECT_SCALES.indexOf(scale)
    zoomTo(PROJECT_SCALES[clamp(idx + dir, 0, PROJECT_SCALES.length - 1)])
  }

  const goToToday = () => {
    const gantt = ganttRef.current
    if (!gantt) return
    const off = daysBetween(range.start, today)
    gantt.scrollTo({ left: Math.max(0, off * dayW - gantt.clientWidth / 4), behavior: 'smooth' })
  }

  // ----- context menu -----

  const [menu, setMenu] = useState<Menu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const openMenu = (e: React.MouseEvent, rowId: string | null) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    // Inputs keep the browser's own cut/copy/paste menu.
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    e.preventDefault()
    e.stopPropagation()
    if (rowId) setSelectedId(rowId)
    setMenu({ x: e.clientX, y: e.clientY, rowId })
  }

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const pad = 8
    const rect = el.getBoundingClientRect()
    const x = Math.min(menu.x, window.innerWidth - rect.width - pad)
    const y = Math.min(menu.y, window.innerHeight - rect.height - pad)
    el.style.left = `${Math.max(pad, x)}px`
    el.style.top = `${Math.max(pad, y)}px`
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const onGanttContextMenu = (e: React.MouseEvent) => {
    const body = ganttBodyRef.current
    let rowId: string | null = null
    if (body) {
      const idx = Math.floor((e.clientY - body.getBoundingClientRect().top) / rowH)
      rowId = idx >= 0 && idx < rows.length ? rows[idx].id : null
    }
    openMenu(e, rowId)
  }

  // ----- row drag (reorder) -----

  const rowDrag = useRef<{ id: string; blockStart: number; blockEnd: number } | null>(null)
  const [dragging, setDragging] = useState<{ id: string; dropIdx: number | null; top: number } | null>(null)

  const onGripDown = (row: ResolvedTask) => (e: React.PointerEvent<HTMLElement>) => {
    if (!editable) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const idx = rows.findIndex((r) => r.id === row.id)
    rowDrag.current = { id: row.id, blockStart: idx, blockEnd: taskBlockEnd(doc, idx) }
    setSelectedId(row.id)
    setDragging({ id: row.id, dropIdx: null, top: 0 })
  }

  const onGripMove = (e: React.PointerEvent<HTMLElement>) => {
    const st = rowDrag.current
    const tbody = tbodyRef.current
    const table = tableRef.current
    if (!st || !tbody || !table) return
    const bodyRect = tbody.getBoundingClientRect()
    const tableRect = table.getBoundingClientRect()
    let idx = clamp(Math.round((e.clientY - bodyRect.top) / rowH), 0, rows.length)
    // Every slot inside the dragged block is the same "nowhere" — snap it to
    // the block's own position so the line does not flicker through it.
    if (idx > st.blockStart && idx <= st.blockEnd) idx = st.blockStart
    const top = bodyRect.top - tableRect.top + table.scrollTop + idx * rowH
    setDragging({ id: st.id, dropIdx: idx, top })
    // Nudge the list when the pointer sits near an edge.
    if (e.clientY < tableRect.top + 28) table.scrollTop -= 8
    else if (e.clientY > tableRect.bottom - 28) table.scrollTop += 8
  }

  const onGripUp = () => {
    const st = rowDrag.current
    rowDrag.current = null
    const drop = dragging
    setDragging(null)
    if (!st || !drop || drop.dropIdx == null) return
    if (drop.dropIdx === st.blockStart) return
    const beforeId = rows[drop.dropIdx]?.id ?? null
    apply(moveTaskBefore(doc, st.id, beforeId))
  }

  // ----- keyboard -----

  useEffect(() => {
    if (!selectedId && rows[0]) setSelectedId(rows[0].id)
  }, [rows, selectedId])

  useEffect(() => {
    if (!editable) return
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'Tab') {
        e.preventDefault()
        apply(e.shiftKey ? outdentTask(doc, selectedId) : indentTask(doc, selectedId))
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        apply(moveTask(doc, selectedId, e.key === 'ArrowUp' ? -1 : 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [apply, doc, editable, selectedId])

  // ----- calendar -----

  const days: Date[] = useMemo(() => {
    const list: Date[] = []
    for (let i = 0; i < range.days; i += 1) {
      const d = new Date(range.start)
      d.setDate(d.getDate() + i)
      list.push(d)
    }
    return list
  }, [range])

  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])
  const todayOff = daysBetween(range.start, today)

  const header = useMemo(() => buildHeader(days, scale, dayW, todayOff), [days, scale, dayW, todayOff])

  const showAssignee = users.length > 0 || rows.some((r) => r.assigneeId) || usersLoading

  const columns: { key: ProjectColumn; label: string; className: string; title?: string }[] = [
    { key: 'name', label: t('project.col.name'), className: 'project-col-name' },
    ...(compact ? [] : [{ key: 'kind' as const, label: t('project.col.kind'), className: 'project-col-kind' }]),
    { key: 'start', label: t('project.col.start'), className: 'project-col-date' },
    ...(compact ? [] : [{ key: 'duration' as const, label: t('project.col.duration'), className: 'project-col-dur' }]),
    ...(compact ? [] : [{ key: 'finish' as const, label: t('project.col.finish'), className: 'project-col-date' }]),
    { key: 'progress', label: t('project.col.progress'), className: 'project-col-pct' },
    ...(compact
      ? []
      : [{ key: 'predecessors' as const, label: t('project.col.predecessors'), className: 'project-col-pred', title: t('project.predHint') }]),
    ...(showAssignee && !compact ? [{ key: 'assignee' as const, label: t('project.assignee'), className: 'project-col-who' }] : []),
  ]
  const tableWidth = columns.reduce((sum, c) => sum + columnWidth(c.key), 0)

  const menuRow = menu?.rowId ? rows.find((r) => r.id === menu.rowId) ?? null : null
  const closeAnd = (fn: () => void) => () => {
    fn()
    setMenu(null)
  }

  return (
    <div className={`project${compact ? ' is-compact' : ''}${readOnly ? ' is-readonly' : ''}`}>
      {editable && (
        <div className="project-toolbar">
          <button type="button" className="btn sm" onClick={() => apply(addTask(doc, selectedId, 'task', t('project.newTask')))}>
            {t('project.addTask')}
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => apply(addTask(doc, selectedId, 'milestone', t('project.newMilestone')))}
          >
            {t('project.addMilestone')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={!selected}
            onClick={() => selected && apply(indentTask(doc, selected.id))}
          >
            {t('project.indent')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={!selected}
            onClick={() => selected && apply(outdentTask(doc, selected.id))}
          >
            {t('project.outdent')}
          </button>
          <div className="project-colors" role="group" aria-label={t('project.color')} title={t('project.color')}>
            <button
              type="button"
              className={`project-swatch none${selected && !selected.color ? ' is-on' : ''}`}
              disabled={!selected}
              title={t('project.colorNone')}
              aria-label={t('project.colorNone')}
              onClick={() => selected && apply(updateTask(doc, selected.id, { color: null }))}
            />
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`project-swatch color-${c}${selected?.color === c ? ' is-on' : ''}`}
                disabled={!selected}
                title={t(COLOR_KEYS[c])}
                aria-label={t(COLOR_KEYS[c])}
                onClick={() => selected && apply(updateTask(doc, selected.id, { color: c }))}
              />
            ))}
          </div>
          <button
            type="button"
            className="btn sm ghost danger"
            disabled={!selected || doc.tasks.length <= 1}
            onClick={() => {
              if (!selected) return
              apply(removeTask(doc, selected.id))
              setSelectedId(null)
            }}
          >
            {t('project.deleteTask')}
          </button>
          <div className="project-zoom" role="group" aria-label={t('project.zoom')} title={t('project.zoomHint')}>
            <button type="button" className="btn sm ghost" disabled={scale === 'months'} aria-label={t('project.zoomOut')} onClick={() => stepZoom(-1)}>
              −
            </button>
            <span className="project-zoom-level">{t(SCALE_KEYS[scale])}</span>
            <button type="button" className="btn sm ghost" disabled={scale === 'hours'} aria-label={t('project.zoomIn')} onClick={() => stepZoom(1)}>
              +
            </button>
          </div>
        </div>
      )}
      <div className="project-split" ref={splitRef}>
        <div
          className="project-table"
          ref={tableRef}
          style={layout.table != null ? { width: `min(${layout.table}px, calc(100% - 160px))` } : undefined}
          onScroll={(e) => syncScroll('table', e.currentTarget.scrollTop)}
          onContextMenu={(e) => openMenu(e, null)}
        >
          <table style={{ width: tableWidth }}>
            <colgroup>
              {columns.map((c) => (
                <col key={c.key} style={{ width: columnWidth(c.key) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={c.className} title={c.title}>
                    {c.label}
                    <span
                      className="project-col-resizer"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t('project.resizeColumn', { name: c.label })}
                      title={t('project.resizeHint')}
                      onPointerDown={startColumnResize(c.key)}
                      onPointerMove={onResizeMove}
                      onPointerUp={onResizeEnd}
                      onPointerCancel={onResizeEnd}
                      onDoubleClick={() => resetColumn(c.key)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {rows.map((row) => (
                <TaskRow
                  key={row.id}
                  row={row}
                  doc={doc}
                  compact={compact}
                  readOnly={!editable}
                  selected={selectedId === row.id}
                  dragging={dragging?.id === row.id}
                  showAssignee={showAssignee && !compact}
                  users={users}
                  usersReady={!usersLoading}
                  rowH={rowH}
                  onSelect={() => setSelectedId(row.id)}
                  onChange={(patch) => apply(updateTask(doc, row.id, patch))}
                  onPredecessors={(text) =>
                    apply(updateTask(doc, row.id, { predecessors: predecessorsFromIndexText(doc, row.id, text) }))
                  }
                  onContextMenu={(e) => openMenu(e, row.id)}
                  onGripDown={onGripDown(row)}
                  onGripMove={onGripMove}
                  onGripUp={onGripUp}
                />
              ))}
            </tbody>
          </table>
          {dragging?.dropIdx != null && <div className="project-drop-line" style={{ top: dragging.top }} />}
        </div>
        <div
          className="project-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('project.resizeSplit')}
          title={t('project.resizeHint')}
          onPointerDown={startTableResize}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={resetTable}
        />
        <div
          className="project-gantt"
          ref={ganttRef}
          title={t('project.zoomHint')}
          onScroll={(e) => {
            syncScroll('gantt', e.currentTarget.scrollTop)
          }}
          onContextMenu={onGanttContextMenu}
        >
          <div className="project-gantt-inner" style={{ width: days.length * dayW, ['--project-row-h' as string]: `${rowH}px` }}>
            <div className="project-gantt-head">
              <div className="project-gantt-months">
                {header.top.map((c) => (
                  <div key={c.key} className={`project-gantt-month${c.cls ? ` ${c.cls}` : ''}`} style={{ width: c.width }}>
                    {c.label}
                  </div>
                ))}
              </div>
              <div className="project-gantt-days">
                {header.bottom.map((c) => (
                  <div key={c.key} className={`project-gantt-day${c.cls ? ` ${c.cls}` : ''}`} style={{ width: c.width }}>
                    {c.label}
                  </div>
                ))}
              </div>
            </div>
            <div className="project-gantt-body" ref={ganttBodyRef} style={{ height: rows.length * rowH }}>
              {todayOff >= 0 && todayOff < days.length && (
                <div className="project-today" style={{ left: todayOff * dayW + dayW / 2 }} />
              )}
              <svg className="project-deps" width={days.length * dayW} height={rows.length * rowH}>
                {rows.flatMap((row, ri) =>
                  row.predecessors.map((pid) => {
                    const pred = rows.find((r) => r.id === pid)
                    const pi = pred ? rows.indexOf(pred) : -1
                    if (!pred?.finishDate || !row.startDate || pi < 0) return null
                    const x1 = (daysBetween(range.start, pred.finishDate) + (pred.kind === 'milestone' ? 0.5 : 1)) * dayW
                    const x2 = daysBetween(range.start, row.startDate) * dayW
                    const y1 = pi * rowH + rowH / 2
                    const y2 = ri * rowH + rowH / 2
                    const mid = x1 + Math.max(8, (x2 - x1) / 2)
                    const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
                    return <path key={`${pid}-${row.id}`} d={d} />
                  }),
                )}
              </svg>
              {rows.map((row, ri) => (
                <GanttBar
                  key={row.id}
                  row={row}
                  top={ri * rowH}
                  dayW={dayW}
                  rowH={rowH}
                  rangeStart={range.start}
                  selected={selectedId === row.id}
                  readOnly={!editable}
                  onSelect={() => setSelectedId(row.id)}
                  onDragStart={() => {
                    dragBase.current = doc
                  }}
                  onShift={(days) => {
                    if (!dragBase.current) return
                    apply(shiftTask(dragBase.current, row.id, days))
                  }}
                  onResize={(edge, days) => {
                    if (!dragBase.current) return
                    apply(resizeTask(dragBase.current, row.id, edge, days))
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {menu && (
        <div ref={menuRef} className="tree-context-menu project-context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          {menuRow && <div className="tree-context-heading">{menuRow.title || '…'}</div>}
          {editable && menuRow && (
            <>
              <MenuItem label={t('project.addTaskBelow')} onClick={closeAnd(() => apply(addTask(doc, menuRow.id, 'task', t('project.newTask'))))} />
              <MenuItem
                label={t('project.addMilestoneBelow')}
                onClick={closeAnd(() => apply(addTask(doc, menuRow.id, 'milestone', t('project.newMilestone'))))}
              />
              <div className="tree-context-sep" />
              <MenuItem label={t('project.indent')} onClick={closeAnd(() => apply(indentTask(doc, menuRow.id)))} />
              <MenuItem label={t('project.outdent')} disabled={!menuRow.parentId} onClick={closeAnd(() => apply(outdentTask(doc, menuRow.id)))} />
              <MenuItem label={t('project.moveUp')} onClick={closeAnd(() => apply(moveTask(doc, menuRow.id, -1)))} />
              <MenuItem label={t('project.moveDown')} onClick={closeAnd(() => apply(moveTask(doc, menuRow.id, 1)))} />
              <div className="tree-context-sep" />
              <div className="project-colors" role="group" aria-label={t('project.color')}>
                <button
                  type="button"
                  className={`project-swatch none${!menuRow.color ? ' is-on' : ''}`}
                  title={t('project.colorNone')}
                  aria-label={t('project.colorNone')}
                  onClick={closeAnd(() => apply(updateTask(doc, menuRow.id, { color: null })))}
                />
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`project-swatch color-${c}${menuRow.color === c ? ' is-on' : ''}`}
                    title={t(COLOR_KEYS[c])}
                    aria-label={t(COLOR_KEYS[c])}
                    onClick={closeAnd(() => apply(updateTask(doc, menuRow.id, { color: c })))}
                  />
                ))}
              </div>
              <div className="tree-context-sep" />
              <MenuItem
                label={t('project.deleteTask')}
                danger
                disabled={doc.tasks.length <= 1}
                onClick={closeAnd(() => {
                  apply(removeTask(doc, menuRow.id))
                  setSelectedId(null)
                })}
              />
              <div className="tree-context-sep" />
            </>
          )}
          {editable && !menuRow && (
            <>
              <MenuItem label={t('project.addTask')} onClick={closeAnd(() => apply(addTask(doc, null, 'task', t('project.newTask'))))} />
              <MenuItem
                label={t('project.addMilestone')}
                onClick={closeAnd(() => apply(addTask(doc, null, 'milestone', t('project.newMilestone'))))}
              />
              <div className="tree-context-sep" />
            </>
          )}
          <div className="tree-context-heading">{t('project.zoom')}</div>
          {PROJECT_SCALES.map((s) => (
            <MenuItem key={s} label={t(SCALE_KEYS[s])} on={s === scale} onClick={closeAnd(() => zoomTo(s, menu.x))} />
          ))}
          <div className="tree-context-sep" />
          <MenuItem label={t('project.goToToday')} onClick={closeAnd(goToToday)} />
        </div>
      )}
    </div>
  )
}

function MenuItem({ label, onClick, disabled, danger, on }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; on?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`tree-context-item project-context-item${danger ? ' danger' : ''}${on ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function TaskRow({
  row,
  doc,
  compact,
  readOnly,
  selected,
  dragging,
  showAssignee,
  users,
  usersReady,
  rowH,
  onSelect,
  onChange,
  onPredecessors,
  onContextMenu,
  onGripDown,
  onGripMove,
  onGripUp,
}: {
  row: ResolvedTask
  doc: ProjectDoc
  compact: boolean
  readOnly: boolean
  selected: boolean
  dragging: boolean
  showAssignee: boolean
  users: UserSummary[]
  usersReady: boolean
  rowH: number
  onSelect: () => void
  onChange: (patch: Parameters<typeof updateTask>[2]) => void
  onPredecessors: (text: string) => void
  onContextMenu: (e: React.MouseEvent) => void
  onGripDown: (e: React.PointerEvent<HTMLElement>) => void
  onGripMove: (e: React.PointerEvent<HTMLElement>) => void
  onGripUp: () => void
}) {
  const { t } = useI18n()
  const known = users.some((u) => u.id === row.assigneeId)
  const who = resolveAssigneeName(row, users)
  const summary = row.isSummary || isSummary(doc, row.id)
  const predText = predecessorIndexText(doc, row.id)
  const [predDraft, setPredDraft] = useState<string | null>(null)

  return (
    <tr
      className={`project-row${selected ? ' is-selected' : ''}${summary ? ' is-summary' : ''}${row.kind === 'milestone' ? ' is-milestone' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{ height: rowH }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <td className="project-col-name" style={{ paddingLeft: 8 + row.depth * 14 }}>
        <span className="project-name-wrap">
          {!readOnly && (
            <span
              className="project-grip"
              title={t('project.dragHandle')}
              aria-label={t('project.dragHandle')}
              onPointerDown={onGripDown}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
              onPointerCancel={onGripUp}
            />
          )}
          {row.color ? <span className={`project-color-dot color-${row.color}`} aria-hidden="true" /> : null}
          {readOnly ? (
            <span className="project-name">{row.title || '…'}</span>
          ) : (
            <input
              className="project-name-input"
              value={row.title}
              aria-label={t('project.col.name')}
              onChange={(e) => onChange({ title: e.target.value })}
              onFocus={onSelect}
            />
          )}
        </span>
      </td>
      {!compact && (
        <td className="project-col-kind">
          {summary ? (
            <span className="muted sm">{t('project.kind.summary')}</span>
          ) : readOnly ? (
            <span>{t(`project.kind.${row.kind}`)}</span>
          ) : (
            <select
              value={row.kind}
              aria-label={t('project.col.kind')}
              onChange={(e) => onChange({ kind: e.target.value as TaskKind })}
              onFocus={onSelect}
            >
              <option value="task">{t('project.kind.task')}</option>
              <option value="milestone">{t('project.kind.milestone')}</option>
            </select>
          )}
        </td>
      )}
      <td className="project-col-date">
        {summary || readOnly ? (
          <span>{row.startDate ? formatIsoDate(row.startDate) : '—'}</span>
        ) : (
          <input
            type="date"
            value={row.start ?? ''}
            onChange={(e) => onChange({ start: e.target.value || null })}
            onFocus={onSelect}
          />
        )}
      </td>
      {!compact && (
        <td className="project-col-dur">
          {summary || row.kind === 'milestone' || readOnly ? (
            <span>{row.kind === 'milestone' ? '0' : String(row.durationDays)}</span>
          ) : (
            <input
              type="number"
              min={1}
              value={row.duration}
              onChange={(e) => onChange({ duration: Number(e.target.value) || 1 })}
              onFocus={onSelect}
            />
          )}
        </td>
      )}
      {!compact && (
        <td className="project-col-date">
          <span>{row.finishDate ? formatIsoDate(row.finishDate) : '—'}</span>
        </td>
      )}
      <td className="project-col-pct">
        {summary || readOnly ? (
          <span>{row.progressPct}%</span>
        ) : (
          <input
            type="number"
            min={0}
            max={100}
            value={row.progress}
            onChange={(e) => onChange({ progress: Number(e.target.value) || 0 })}
            onFocus={onSelect}
          />
        )}
      </td>
      {!compact && (
        <td className="project-col-pred">
          {readOnly ? (
            <span>{predText}</span>
          ) : (
            <input
              type="text"
              inputMode="numeric"
              aria-label={t('project.col.predecessors')}
              title={t('project.predHint')}
              value={predDraft ?? predText}
              onChange={(e) => setPredDraft(e.target.value)}
              onFocus={() => {
                onSelect()
                setPredDraft(predText)
              }}
              onBlur={() => {
                if (predDraft !== null) onPredecessors(predDraft)
                setPredDraft(null)
              }}
            />
          )}
        </td>
      )}
      {showAssignee && (
        <td className="project-col-who">
          {readOnly ? (
            <span>{who ?? ''}</span>
          ) : (
            (users.length > 0 || row.assigneeId || !usersReady) && (
              <select
                value={row.assigneeId ?? ''}
                aria-label={t('project.assignee')}
                onChange={(e) => {
                  const id = e.target.value
                  if (!id) {
                    onChange({ assigneeId: null, assigneeName: null })
                    return
                  }
                  const u = users.find((x) => x.id === id)
                  onChange({
                    assigneeId: id,
                    assigneeName: u ? userLabel(u) : row.assigneeName,
                  })
                }}
                onFocus={onSelect}
              >
                <option value="">{t('props.unassigned')}</option>
                {row.assigneeId && !known && (
                  <option value={row.assigneeId}>{row.assigneeName || t('props.unknownAccount')}</option>
                )}
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {userLabel(u)}
                  </option>
                ))}
              </select>
            )
          )}
        </td>
      )}
    </tr>
  )
}

function GanttBar({
  row,
  top,
  dayW,
  rowH,
  rangeStart,
  selected,
  readOnly,
  onSelect,
  onDragStart,
  onShift,
  onResize,
}: {
  row: ResolvedTask
  top: number
  dayW: number
  rowH: number
  rangeStart: Date
  selected: boolean
  readOnly: boolean
  onSelect: () => void
  onDragStart: () => void
  onShift: (days: number) => void
  onResize: (edge: 'start' | 'end', days: number) => void
}) {
  const drag = useRef<{ mode: 'move' | 'start' | 'end'; originX: number; last: number } | null>(null)

  if (!row.startDate) return null
  const startOff = daysBetween(rangeStart, row.startDate)
  const span = row.kind === 'milestone' ? 0 : Math.max(1, row.durationDays)
  const left = startOff * dayW
  const width = row.kind === 'milestone' ? dayW : span * dayW
  const progressW = row.kind === 'milestone' ? 0 : (width * row.progressPct) / 100

  const onPointerDown = (mode: 'move' | 'start' | 'end') => (e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onSelect()
    onDragStart()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { mode, originX: e.clientX, last: 0 }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const st = drag.current
    if (!st) return
    const delta = Math.round((e.clientX - st.originX) / dayW)
    if (delta === st.last) return
    st.last = delta
    if (st.mode === 'move') onShift(delta)
    else onResize(st.mode, delta)
  }

  const onPointerUp = () => {
    drag.current = null
  }

  if (row.kind === 'milestone' && !row.isSummary) {
    return (
      <div
        className={`project-bar is-milestone${selected ? ' is-selected' : ''}${row.color ? ` color-${row.color}` : ''}`}
        style={{ top, left: left + dayW / 2 - 7, height: rowH }}
        onPointerDown={onPointerDown('move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title={row.title}
      >
        <span className="project-diamond" />
      </div>
    )
  }

  return (
    <div
      className={`project-bar${row.isSummary ? ' is-summary' : ''}${selected ? ' is-selected' : ''}${row.color ? ` color-${row.color}` : ''}`}
      style={{ top, left, width, height: rowH - 8, marginTop: 4 }}
      onPointerDown={onPointerDown('move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={row.title}
    >
      {!readOnly && !row.isSummary && (
        <span className="project-bar-handle is-start" onPointerDown={onPointerDown('start')} />
      )}
      <span className="project-bar-progress" style={{ width: progressW }} />
      <span className="project-bar-label">{row.title}</span>
      {!readOnly && !row.isSummary && (
        <span className="project-bar-handle is-end" onPointerDown={onPointerDown('end')} />
      )}
    </div>
  )
}
