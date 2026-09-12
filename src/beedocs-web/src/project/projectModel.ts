/**
 * Project-plan documents stored as book items (`project_plan.source`) and as
 * ```project fenced blocks on a page. The server stores this JSON verbatim and
 * reads only titles/assignee names (search) and the task count (tree badge).
 */

export type TaskKind = 'task' | 'milestone'

/** Same palette as kanban cards, so a colour means the same thing across a book. */
export const PROJECT_COLORS = ['accent', 'info', 'ok', 'warn', 'danger', 'muted'] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]

/** Columns of the WBS table whose width the user can drag. */
export const PROJECT_COLUMNS = ['name', 'kind', 'start', 'duration', 'finish', 'progress', 'predecessors', 'assignee'] as const
export type ProjectColumn = (typeof PROJECT_COLUMNS)[number]

/** Gantt time scales, coarse to fine — the order Ctrl+wheel steps through. */
export const PROJECT_SCALES = ['months', 'weeks', 'days', 'hours'] as const
export type ProjectScale = (typeof PROJECT_SCALES)[number]

export const COLUMN_MIN_WIDTH = 40
export const COLUMN_MAX_WIDTH = 800
export const TABLE_MIN_WIDTH = 160
export const TABLE_MAX_WIDTH = 1600

/**
 * Presentation the plan carries with it: pixel widths of the WBS columns and
 * of the table half of the split. Everything is optional — an absent entry
 * means the CSS default — so a plan written before the field existed, or by
 * an agent that never sets it, renders exactly as it did.
 */
export type ProjectLayout = {
  table?: number
  columns?: Partial<Record<ProjectColumn, number>>
  /** Gantt zoom; absent = days. */
  scale?: ProjectScale
}

export type ProjectTask = {
  id: string
  title: string
  kind: TaskKind
  /** Inclusive start, `YYYY-MM-DD`. Null = unscheduled (no Gantt bar). */
  start: string | null
  /** Calendar days. 0 for a milestone. Ignored on summary rows (derived). */
  duration: number
  /** 0–100. Summaries are a duration-weighted average of descendants. */
  progress: number
  parentId: string | null
  /** Finish-to-start predecessors (task ids). */
  predecessors: string[]
  assigneeId: string | null
  assigneeName: string | null
  /** Bar / diamond colour; null = the theme accent. */
  color: ProjectColor | null
}

export type ProjectDoc = {
  version: 1
  tasks: ProjectTask[]
  layout?: ProjectLayout
}

export type ResolvedTask = ProjectTask & {
  depth: number
  isSummary: boolean
  startDate: Date | null
  finishDate: Date | null
  durationDays: number
  progressPct: number
}

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `${prefix}-${raw}`
}

export function parseIsoDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() + n)
  return x
}

export function daysBetween(a: Date, b: Date): number {
  const ms = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  return Math.round(ms / 86400000)
}

export function todayIso(): string {
  return formatIsoDate(new Date())
}

/** Inclusive finish: start + duration − 1 for a task, start for a milestone. */
export function finishIso(start: string | null, duration: number, kind: TaskKind): string | null {
  const d = parseIsoDate(start)
  if (!d) return null
  if (kind === 'milestone' || duration <= 0) return formatIsoDate(d)
  return formatIsoDate(addDays(d, Math.max(1, duration) - 1))
}

export function emptyPlan(): ProjectDoc {
  return {
    version: 1,
    tasks: [
      {
        id: newId('task'),
        title: 'New task',
        kind: 'task',
        start: todayIso(),
        duration: 1,
        progress: 0,
        parentId: null,
        predecessors: [],
        assigneeId: null,
        assigneeName: null,
        color: null,
      },
    ],
  }
}

export type StarterLabels = {
  phase: string
  design: string
  build: string
  ready: string
  ship: string
}

/** A small WBS so a new plan is not a blank grid. */
export function starterPlan(labels?: Partial<StarterLabels>): ProjectDoc {
  const today = new Date()
  const t0 = formatIsoDate(today)
  const t5 = formatIsoDate(addDays(today, 5))
  const t13 = formatIsoDate(addDays(today, 13))
  const t14 = formatIsoDate(addDays(today, 14))
  const phase = newId('task')
  const design = newId('task')
  const build = newId('task')
  const ready = newId('task')
  const ship = newId('task')
  return {
    version: 1,
    tasks: [
      {
        id: phase,
        title: labels?.phase?.trim() || 'Delivery',
        kind: 'task',
        start: t0,
        duration: 1,
        progress: 0,
        parentId: null,
        predecessors: [],
        assigneeId: null,
        assigneeName: null,
        color: null,
      },
      {
        id: design,
        title: labels?.design?.trim() || 'Design',
        kind: 'task',
        start: t0,
        duration: 5,
        progress: 0,
        parentId: phase,
        predecessors: [],
        assigneeId: null,
        assigneeName: null,
        color: null,
      },
      {
        id: build,
        title: labels?.build?.trim() || 'Build',
        kind: 'task',
        start: t5,
        duration: 8,
        progress: 0,
        parentId: phase,
        predecessors: [design],
        assigneeId: null,
        assigneeName: null,
        color: null,
      },
      {
        id: ready,
        title: labels?.ready?.trim() || 'Ready',
        kind: 'milestone',
        start: t13,
        duration: 0,
        progress: 0,
        parentId: phase,
        predecessors: [build],
        assigneeId: null,
        assigneeName: null,
        color: null,
      },
      {
        id: ship,
        title: labels?.ship?.trim() || 'Ship',
        kind: 'task',
        start: t14,
        duration: 3,
        progress: 0,
        parentId: null,
        predecessors: [ready],
        assigneeId: null,
        assigneeName: null,
        color: null,
      },
    ],
  }
}

export function starterPlanSource(labels?: Partial<StarterLabels>): string {
  return serializePlan(starterPlan(labels))
}

export function serializePlan(doc: ProjectDoc): string {
  return JSON.stringify(doc)
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asKind(value: unknown): TaskKind {
  return value === 'milestone' ? 'milestone' : 'task'
}

function asDuration(value: unknown, kind: TaskKind): number {
  if (kind === 'milestone') return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(1, Math.floor(value))
}

function asProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function asColor(value: unknown): ProjectColor | null {
  if (typeof value !== 'string') return null
  return (PROJECT_COLORS as readonly string[]).includes(value) ? (value as ProjectColor) : null
}

function asWidth(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.max(min, Math.min(max, value)))
}

function asLayout(raw: unknown): ProjectLayout | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const out: ProjectLayout = {}
  const table = asWidth(o.table, TABLE_MIN_WIDTH, TABLE_MAX_WIDTH)
  if (table != null) out.table = table
  if (typeof o.scale === 'string' && (PROJECT_SCALES as readonly string[]).includes(o.scale)) out.scale = o.scale as ProjectScale
  if (o.columns && typeof o.columns === 'object') {
    const cols: Partial<Record<ProjectColumn, number>> = {}
    for (const key of PROJECT_COLUMNS) {
      const w = asWidth((o.columns as Record<string, unknown>)[key], COLUMN_MIN_WIDTH, COLUMN_MAX_WIDTH)
      if (w != null) cols[key] = w
    }
    if (Object.keys(cols).length > 0) out.columns = cols
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function asStart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return parseIsoDate(value) ? formatIsoDate(parseIsoDate(value)!) : null
}

function asTask(raw: unknown): ProjectTask | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const kind = asKind(o.kind)
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : newId('task')
  const preds = Array.isArray(o.predecessors)
    ? o.predecessors.filter((p): p is string => typeof p === 'string' && p.trim() !== '' && p !== id)
    : []
  return {
    id,
    title: typeof o.title === 'string' ? o.title : '',
    kind,
    start: asStart(o.start),
    duration: asDuration(o.duration, kind),
    progress: asProgress(o.progress),
    parentId: asOptionalString(o.parentId),
    predecessors: [...new Set(preds)],
    assigneeId: asOptionalString(o.assigneeId),
    assigneeName: asOptionalString(o.assigneeName),
    color: asColor(o.color),
  }
}

export function parsePlan(source: string | null | undefined): ProjectDoc {
  if (!source?.trim()) return emptyPlan()
  try {
    const raw = JSON.parse(source) as unknown
    if (!raw || typeof raw !== 'object') return emptyPlan()
    const o = raw as Record<string, unknown>
    const tasks = Array.isArray(o.tasks)
      ? o.tasks.map(asTask).filter((t): t is ProjectTask => t !== null)
      : []
    if (tasks.length === 0) return emptyPlan()
    const layout = asLayout(o.layout)
    return sanitizePlan(layout ? { version: 1, tasks, layout } : { version: 1, tasks })
  } catch {
    return emptyPlan()
  }
}

/** Drop dangling parents/preds and break parent cycles. */
export function sanitizePlan(doc: ProjectDoc): ProjectDoc {
  const ids = new Set(doc.tasks.map((t) => t.id))
  const byId = new Map(doc.tasks.map((t) => [t.id, t]))
  const tasks = doc.tasks.map((t) => {
    let parentId = t.parentId && ids.has(t.parentId) && t.parentId !== t.id ? t.parentId : null
    const seen = new Set<string>([t.id])
    let walk = parentId
    while (walk) {
      if (seen.has(walk)) {
        parentId = null
        break
      }
      seen.add(walk)
      walk = byId.get(walk)?.parentId ?? null
    }
    return {
      ...t,
      parentId,
      predecessors: t.predecessors.filter((p) => ids.has(p) && p !== t.id),
      duration: t.kind === 'milestone' ? 0 : Math.max(1, t.duration),
    }
  })
  return doc.layout ? { version: 1, tasks, layout: doc.layout } : { version: 1, tasks }
}

/** Merge widths in; a null/undefined entry clears that width back to the default. */
export function updateLayout(
  doc: ProjectDoc,
  patch: { table?: number | null; columns?: Partial<Record<ProjectColumn, number | null>>; scale?: ProjectScale | null },
): ProjectDoc {
  const next: ProjectLayout = { ...(doc.layout ?? {}) }
  if (patch.scale !== undefined) {
    if (patch.scale == null) delete next.scale
    else next.scale = patch.scale
  }
  if (patch.table !== undefined) {
    const w = asWidth(patch.table, TABLE_MIN_WIDTH, TABLE_MAX_WIDTH)
    if (w == null) delete next.table
    else next.table = w
  }
  if (patch.columns) {
    const cols: Partial<Record<ProjectColumn, number>> = { ...(next.columns ?? {}) }
    for (const key of PROJECT_COLUMNS) {
      if (!(key in patch.columns)) continue
      const w = asWidth(patch.columns[key], COLUMN_MIN_WIDTH, COLUMN_MAX_WIDTH)
      if (w == null) delete cols[key]
      else cols[key] = w
    }
    if (Object.keys(cols).length > 0) next.columns = cols
    else delete next.columns
  }
  const { layout: _dropped, ...rest } = doc
  void _dropped
  return Object.keys(next).length > 0 ? { ...rest, layout: next } : rest
}

export function countTasks(doc: ProjectDoc): number {
  return doc.tasks.length
}

export function isSummary(doc: ProjectDoc, id: string): boolean {
  return doc.tasks.some((t) => t.parentId === id)
}

export function taskDepth(doc: ProjectDoc, id: string): number {
  const byId = new Map(doc.tasks.map((t) => [t.id, t]))
  let depth = 0
  const seen = new Set<string>()
  let walk: string | null = id
  while (walk) {
    if (seen.has(walk)) break
    seen.add(walk)
    const parent: string | null = byId.get(walk)?.parentId ?? null
    if (!parent) break
    depth += 1
    walk = parent
    if (depth > 16) break
  }
  return depth
}

export function isDescendantOf(doc: ProjectDoc, id: string, ancestorId: string): boolean {
  if (id === ancestorId) return false
  const byId = new Map(doc.tasks.map((t) => [t.id, t]))
  const seen = new Set<string>()
  let walk: string | null = id
  while (walk) {
    if (seen.has(walk)) return false
    seen.add(walk)
    const parent: string | null = byId.get(walk)?.parentId ?? null
    if (parent === ancestorId) return true
    walk = parent
  }
  return false
}

function descendantIds(doc: ProjectDoc, id: string): string[] {
  return doc.tasks.filter((t) => isDescendantOf(doc, t.id, id)).map((t) => t.id)
}

/** Index one past the task at `index` and all its descendants (they always follow it). */
export function taskBlockEnd(doc: ProjectDoc, index: number): number {
  return blockEnd(doc, index)
}

function blockEnd(doc: ProjectDoc, index: number): number {
  const id = doc.tasks[index]?.id
  if (!id) return index + 1
  let i = index + 1
  while (i < doc.tasks.length && isDescendantOf(doc, doc.tasks[i].id, id)) i += 1
  return i
}

export function resolvePlan(doc: ProjectDoc): ResolvedTask[] {
  const clean = sanitizePlan(doc)
  const childOf = new Map<string, ProjectTask[]>()
  for (const t of clean.tasks) {
    if (!t.parentId) continue
    const list = childOf.get(t.parentId) ?? []
    list.push(t)
    childOf.set(t.parentId, list)
  }

  const memo = new Map<string, { start: Date | null; finish: Date | null; progress: number; duration: number }>()

  const rollup = (id: string): { start: Date | null; finish: Date | null; progress: number; duration: number } => {
    const hit = memo.get(id)
    if (hit) return hit
    const task = clean.tasks.find((t) => t.id === id)
    if (!task) return { start: null, finish: null, progress: 0, duration: 0 }
    const kids = childOf.get(id) ?? []
    if (kids.length === 0) {
      const start = parseIsoDate(task.start)
      const duration = task.kind === 'milestone' ? 0 : Math.max(1, task.duration)
      const finish = start
        ? task.kind === 'milestone' || duration <= 0
          ? start
          : addDays(start, duration - 1)
        : null
      const row = { start, finish, progress: task.progress, duration }
      memo.set(id, row)
      return row
    }
    let start: Date | null = null
    let finish: Date | null = null
    let weighted = 0
    let weight = 0
    for (const kid of kids) {
      const r = rollup(kid.id)
      if (r.start && (!start || r.start < start)) start = r.start
      if (r.finish && (!finish || r.finish > finish)) finish = r.finish
      const w = Math.max(r.duration, kid.kind === 'milestone' ? 1 : 0)
      weighted += r.progress * w
      weight += w
    }
    const duration = start && finish ? Math.max(0, daysBetween(start, finish) + 1) : 0
    const row = {
      start,
      finish,
      progress: weight > 0 ? Math.round(weighted / weight) : 0,
      duration,
    }
    memo.set(id, row)
    return row
  }

  return clean.tasks.map((t) => {
    const summary = (childOf.get(t.id) ?? []).length > 0
    const r = rollup(t.id)
    return {
      ...t,
      depth: taskDepth(clean, t.id),
      isSummary: summary,
      startDate: r.start,
      finishDate: r.finish,
      durationDays: r.duration,
      progressPct: r.progress,
    }
  })
}

export function planRange(rows: ResolvedTask[], padBefore = 7, padAfter = 14, minDays = 42): { start: Date; days: number } {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  let min = today
  let max = addDays(today, minDays - 1)
  for (const r of rows) {
    if (r.startDate && r.startDate < min) min = r.startDate
    if (r.finishDate && r.finishDate > max) max = r.finishDate
  }
  min = addDays(min, -padBefore)
  max = addDays(max, padAfter)
  const days = Math.max(minDays, daysBetween(min, max) + 1)
  return { start: min, days }
}

export function resolveAssigneeName(
  task: Pick<ProjectTask, 'assigneeId' | 'assigneeName'>,
  users: Array<{ id: string; username: string; displayName: string | null }>,
): string | null {
  const snap = task.assigneeName?.trim()
  if (snap) return snap
  if (!task.assigneeId) return null
  const u = users.find((x) => x.id === task.assigneeId)
  if (!u) return null
  return u.displayName?.trim() || u.username
}

function patchTask(doc: ProjectDoc, id: string, patch: Partial<ProjectTask>): ProjectDoc {
  return sanitizePlan({
    ...doc,
    tasks: doc.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })
}

export function addTask(doc: ProjectDoc, afterId: string | null, kind: TaskKind, title: string): ProjectDoc {
  const task: ProjectTask = {
    id: newId('task'),
    title: title.trim() || (kind === 'milestone' ? 'Milestone' : 'New task'),
    kind,
    start: todayIso(),
    duration: kind === 'milestone' ? 0 : 1,
    progress: 0,
    parentId: null,
    predecessors: [],
    assigneeId: null,
    assigneeName: null,
    color: null,
  }
  if (!afterId) return { ...doc, tasks: [...doc.tasks, task] }
  const idx = doc.tasks.findIndex((t) => t.id === afterId)
  if (idx < 0) return { ...doc, tasks: [...doc.tasks, task] }
  task.parentId = doc.tasks[idx].parentId
  const end = blockEnd(doc, idx)
  const next = [...doc.tasks]
  next.splice(end, 0, task)
  return sanitizePlan({ ...doc, tasks: next })
}

/** MS Project-style predecessor cell: 1-based row numbers, comma-separated. */
export function predecessorIndexText(doc: ProjectDoc, id: string): string {
  const ids = doc.tasks.map((t) => t.id)
  const task = doc.tasks.find((t) => t.id === id)
  if (!task) return ''
  return task.predecessors
    .map((p) => ids.indexOf(p) + 1)
    .filter((n) => n > 0)
    .join(',')
}

export function predecessorsFromIndexText(doc: ProjectDoc, id: string, text: string): string[] {
  const ids = doc.tasks.map((t) => t.id)
  const out: string[] = []
  for (const part of text.split(/[,;\s]+/)) {
    const n = Number.parseInt(part, 10)
    if (!Number.isFinite(n) || n < 1 || n > ids.length) continue
    const pid = ids[n - 1]
    if (!pid || pid === id || out.includes(pid)) continue
    out.push(pid)
  }
  return out
}

export function updateTask(
  doc: ProjectDoc,
  id: string,
  patch: Partial<Pick<ProjectTask, 'title' | 'kind' | 'start' | 'duration' | 'progress' | 'assigneeId' | 'assigneeName' | 'predecessors' | 'color'>>,
): ProjectDoc {
  const current = doc.tasks.find((t) => t.id === id)
  if (!current) return doc
  const nextKind = patch.kind ?? current.kind
  const duration =
    nextKind === 'milestone' ? 0 : patch.duration != null ? Math.max(1, Math.floor(patch.duration)) : current.duration
  return patchTask(doc, id, { ...patch, kind: nextKind, duration })
}

export function removeTask(doc: ProjectDoc, id: string): ProjectDoc {
  if (doc.tasks.length <= 1) return doc
  const doomed = new Set([id, ...descendantIds(doc, id)])
  if (doomed.size >= doc.tasks.length) return doc
  const parentId = doc.tasks.find((t) => t.id === id)?.parentId ?? null
  const tasks = doc.tasks
    .filter((t) => !doomed.has(t.id))
    .map((t) => ({
      ...t,
      parentId: t.parentId && doomed.has(t.parentId) ? parentId : t.parentId,
      predecessors: t.predecessors.filter((p) => !doomed.has(p)),
    }))
  return sanitizePlan({ ...doc, tasks })
}

export function indentTask(doc: ProjectDoc, id: string): ProjectDoc {
  const idx = doc.tasks.findIndex((t) => t.id === id)
  if (idx <= 0) return doc
  const task = doc.tasks[idx]
  const depth = taskDepth(doc, id)
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = doc.tasks[i]
    if (isDescendantOf(doc, id, prev.id)) continue
    if (taskDepth(doc, prev.id) === depth && prev.parentId === task.parentId) {
      return patchTask(doc, id, { parentId: prev.id })
    }
    if (taskDepth(doc, prev.id) < depth) break
  }
  return doc
}

export function outdentTask(doc: ProjectDoc, id: string): ProjectDoc {
  const task = doc.tasks.find((t) => t.id === id)
  if (!task?.parentId) return doc
  const parent = doc.tasks.find((t) => t.id === task.parentId)
  return patchTask(doc, id, { parentId: parent?.parentId ?? null })
}

export function moveTask(doc: ProjectDoc, id: string, dir: -1 | 1): ProjectDoc {
  const idx = doc.tasks.findIndex((t) => t.id === id)
  if (idx < 0) return doc
  const end = blockEnd(doc, idx)
  const block = doc.tasks.slice(idx, end)
  if (dir < 0) {
    if (idx === 0) return doc
    let dest = idx - 1
    while (dest > 0 && isDescendantOf(doc, doc.tasks[dest].id, doc.tasks[dest - 1].id)) dest -= 1
    const next = [...doc.tasks]
    next.splice(idx, block.length)
    next.splice(dest, 0, ...block)
    return sanitizePlan({ ...doc, tasks: next })
  }
  if (end >= doc.tasks.length) return doc
  const after = blockEnd(doc, end)
  const next = [...doc.tasks]
  next.splice(idx, block.length)
  next.splice(after - block.length, 0, ...block)
  return sanitizePlan({ ...doc, tasks: next })
}

/**
 * Drop a task (with its descendants) in front of `beforeId`, taking that
 * row's parent so it lands as a sibling of what it was dropped on; null puts
 * it last at the root. Dropping onto its own subtree is a no-op.
 */
export function moveTaskBefore(doc: ProjectDoc, id: string, beforeId: string | null): ProjectDoc {
  const idx = doc.tasks.findIndex((t) => t.id === id)
  if (idx < 0 || beforeId === id) return doc
  if (beforeId && isDescendantOf(doc, beforeId, id)) return doc
  const end = blockEnd(doc, idx)
  const block = doc.tasks.slice(idx, end)
  const rest = [...doc.tasks.slice(0, idx), ...doc.tasks.slice(end)]
  let insertAt = rest.length
  let parentId: string | null = null
  if (beforeId) {
    insertAt = rest.findIndex((t) => t.id === beforeId)
    if (insertAt < 0) return doc
    parentId = rest[insertAt].parentId
  }
  const moved = block.map((t, i) => (i === 0 ? { ...t, parentId } : t))
  rest.splice(insertAt, 0, ...moved)
  return sanitizePlan({ ...doc, tasks: rest })
}

/** Shift a leaf (or a summary and all descendants) by calendar days. */
export function shiftTask(doc: ProjectDoc, id: string, days: number): ProjectDoc {
  if (days === 0) return doc
  const ids = new Set([id, ...descendantIds(doc, id)])
  return sanitizePlan({
    ...doc,
    tasks: doc.tasks.map((t) => {
      if (!ids.has(t.id) || !t.start) return t
      const d = parseIsoDate(t.start)
      if (!d) return t
      return { ...t, start: formatIsoDate(addDays(d, days)) }
    }),
  })
}

export function resizeTask(doc: ProjectDoc, id: string, edge: 'start' | 'end', days: number): ProjectDoc {
  if (days === 0) return doc
  const task = doc.tasks.find((t) => t.id === id)
  if (!task || task.kind === 'milestone' || isSummary(doc, id) || !task.start) return doc
  const start = parseIsoDate(task.start)
  if (!start) return doc
  if (edge === 'end') {
    return patchTask(doc, id, { duration: Math.max(1, task.duration + days) })
  }
  const nextStart = addDays(start, days)
  const finish = addDays(start, task.duration - 1)
  const duration = Math.max(1, daysBetween(nextStart, finish) + 1)
  return patchTask(doc, id, { start: formatIsoDate(nextStart), duration })
}

export function projectToHtml(source: string, title?: string): string {
  const rows = resolvePlan(parsePlan(source))
  const body = rows
    .map((r) => {
      const indent = '&nbsp;'.repeat(r.depth * 4)
      const kind = r.isSummary ? 'summary' : r.kind
      const start = r.startDate ? formatIsoDate(r.startDate) : '—'
      const finish = r.finishDate ? formatIsoDate(r.finishDate) : '—'
      const who = r.assigneeName?.trim() ? esc(r.assigneeName.trim()) : ''
      const color = r.color ? ` data-color="${esc(r.color)}"` : ''
      return `<tr data-kind="${esc(kind)}"${color}><td>${indent}${esc(r.title) || '…'}</td><td>${esc(kind)}</td><td>${start}</td><td>${r.durationDays}</td><td>${finish}</td><td>${r.progressPct}%</td><td>${who}</td></tr>`
    })
    .join('')
  const caption = title ? `<figcaption>${esc(title)}</figcaption>` : ''
  return `<figure class="export-diagram export-project">${caption}<table class="export-project-table"><thead><tr><th>Name</th><th>Kind</th><th>Start</th><th>Dur</th><th>Finish</th><th>%</th><th>Assignee</th></tr></thead><tbody>${body}</tbody></table></figure>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
