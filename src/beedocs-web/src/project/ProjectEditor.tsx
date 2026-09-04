import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUserDirectory, userLabel } from '../hooks/useUserDirectory'
import { useI18n } from '../i18n'
import type { UserSummary } from '../types'
import {
  addTask,
  daysBetween,
  formatIsoDate,
  indentTask,
  isSummary,
  moveTask,
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
  type ResolvedTask,
  type TaskKind,
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

function commit(doc: ProjectDoc, onChange?: (next: string) => void) {
  onChange?.(serializePlan(doc))
}

export function ProjectEditor({ source, onChange, compact = false, readOnly = false }: Props) {
  const { t } = useI18n()
  const { users, loading: usersLoading } = useUserDirectory()
  const doc = useMemo(() => parsePlan(source), [source])
  const rows = useMemo(() => resolvePlan(doc), [doc])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const ganttRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)
  const dragBase = useRef<ProjectDoc | null>(null)

  const dayW = compact ? 16 : 22
  const rowH = compact ? 28 : 32
  const range = useMemo(() => planRange(rows), [rows])

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

  const months = useMemo(() => {
    const groups: { key: string; label: string; span: number }[] = []
    for (const d of days) {
      const key = `${d.getFullYear()}-${d.getMonth()}`
      const last = groups[groups.length - 1]
      if (last && last.key === key) last.span += 1
      else groups.push({ key, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, span: 1 })
    }
    return groups
  }, [days])

  const showAssignee = users.length > 0 || rows.some((r) => r.assigneeId) || usersLoading

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
        </div>
      )}
      <div className="project-split">
        <div
          className="project-table"
          ref={tableRef}
          onScroll={(e) => syncScroll('table', e.currentTarget.scrollTop)}
        >
          <table>
            <thead>
              <tr>
                <th className="project-col-name">{t('project.col.name')}</th>
                {!compact && <th className="project-col-kind">{t('project.col.kind')}</th>}
                <th className="project-col-date">{t('project.col.start')}</th>
                {!compact && <th className="project-col-dur">{t('project.col.duration')}</th>}
                {!compact && <th className="project-col-date">{t('project.col.finish')}</th>}
                <th className="project-col-pct">{t('project.col.progress')}</th>
                {!compact && (
                  <th className="project-col-pred" title={t('project.predHint')}>
                    {t('project.col.predecessors')}
                  </th>
                )}
                {showAssignee && !compact && <th className="project-col-who">{t('project.assignee')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TaskRow
                  key={row.id}
                  row={row}
                  doc={doc}
                  compact={compact}
                  readOnly={!editable}
                  selected={selectedId === row.id}
                  showAssignee={showAssignee && !compact}
                  users={users}
                  usersReady={!usersLoading}
                  rowH={rowH}
                  onSelect={() => setSelectedId(row.id)}
                  onChange={(patch) => apply(updateTask(doc, row.id, patch))}
                  onPredecessors={(text) =>
                    apply(updateTask(doc, row.id, { predecessors: predecessorsFromIndexText(doc, row.id, text) }))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
        <div
          className="project-gantt"
          ref={ganttRef}
          onScroll={(e) => {
            syncScroll('gantt', e.currentTarget.scrollTop)
          }}
        >
          <div className="project-gantt-inner" style={{ width: days.length * dayW, ['--project-row-h' as string]: `${rowH}px` }}>
            <div className="project-gantt-head">
              <div className="project-gantt-months">
                {months.map((m) => (
                  <div key={m.key} className="project-gantt-month" style={{ width: m.span * dayW }}>
                    {m.label}
                  </div>
                ))}
              </div>
              <div className="project-gantt-days">
                {days.map((d, i) => (
                  <div
                    key={i}
                    className={`project-gantt-day${d.getDay() === 0 || d.getDay() === 6 ? ' is-weekend' : ''}${i === todayOff ? ' is-today' : ''}`}
                    style={{ width: dayW }}
                  >
                    {d.getDate()}
                  </div>
                ))}
              </div>
            </div>
            <div className="project-gantt-body" style={{ height: rows.length * rowH }}>
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
    </div>
  )
}

function TaskRow({
  row,
  doc,
  compact,
  readOnly,
  selected,
  showAssignee,
  users,
  usersReady,
  rowH,
  onSelect,
  onChange,
  onPredecessors,
}: {
  row: ResolvedTask
  doc: ProjectDoc
  compact: boolean
  readOnly: boolean
  selected: boolean
  showAssignee: boolean
  users: UserSummary[]
  usersReady: boolean
  rowH: number
  onSelect: () => void
  onChange: (patch: Parameters<typeof updateTask>[2]) => void
  onPredecessors: (text: string) => void
}) {
  const { t } = useI18n()
  const known = users.some((u) => u.id === row.assigneeId)
  const who = resolveAssigneeName(row, users)
  const summary = row.isSummary || isSummary(doc, row.id)
  const predText = predecessorIndexText(doc, row.id)
  const [predDraft, setPredDraft] = useState<string | null>(null)

  return (
    <tr
      className={`project-row${selected ? ' is-selected' : ''}${summary ? ' is-summary' : ''}${row.kind === 'milestone' ? ' is-milestone' : ''}`}
      style={{ height: rowH }}
      onClick={onSelect}
    >
      <td className="project-col-name" style={{ paddingLeft: 8 + row.depth * 14 }}>
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
    if (readOnly) return
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
        className={`project-bar is-milestone${selected ? ' is-selected' : ''}`}
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
      className={`project-bar${row.isSummary ? ' is-summary' : ''}${selected ? ' is-selected' : ''}`}
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
