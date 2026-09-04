/**
 * Kanban board documents stored as book items (`kanban_board.source`) and as
 * ```kanban fenced blocks on a page. The server stores this JSON verbatim and
 * reads only titles/bodies (search) and the card count (tree badge).
 */

export const KANBAN_COLORS = ['accent', 'info', 'ok', 'warn', 'danger', 'muted'] as const
export type KanbanColor = (typeof KANBAN_COLORS)[number]

export type KanbanCard = {
  id: string
  title: string
  body: string
  color: KanbanColor | null
  /** Account id from `/api/users/directory`, or null when unassigned / free-text. */
  assigneeId: string | null
  /** Display-name snapshot so a deleted account still reads as a name. */
  assigneeName: string | null
}

export type KanbanColumn = {
  id: string
  title: string
  /** Work-in-progress limit. Null / omitted = unlimited. */
  wip: number | null
  cards: KanbanCard[]
}

export type KanbanDoc = {
  version: 1
  columns: KanbanColumn[]
}

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `${prefix}-${raw}`
}

export function emptyBoard(): KanbanDoc {
  return {
    version: 1,
    columns: [
      { id: newId('col'), title: 'To do', wip: null, cards: [] },
      { id: newId('col'), title: 'In progress', wip: null, cards: [] },
      { id: newId('col'), title: 'Done', wip: null, cards: [] },
    ],
  }
}

export type StarterLabels = {
  todo: string
  doing: string
  done: string
  card1: string
  card2: string
}

/** Three columns with a couple of sample cards so a new board is not blank. */
export function starterBoard(labels?: Partial<StarterLabels>): KanbanDoc {
  const todo = labels?.todo?.trim() || 'To do'
  const doing = labels?.doing?.trim() || 'In progress'
  const done = labels?.done?.trim() || 'Done'
  return {
    version: 1,
    columns: [
      {
        id: newId('col'),
        title: todo,
        wip: null,
        cards: [
          {
            id: newId('card'),
            title: labels?.card1?.trim() || 'Write the brief',
            body: '',
            color: null,
            assigneeId: null,
            assigneeName: null,
          },
        ],
      },
      {
        id: newId('col'),
        title: doing,
        wip: 3,
        cards: [
          {
            id: newId('card'),
            title: labels?.card2?.trim() || 'Draft the architecture',
            body: '',
            color: 'accent',
            assigneeId: null,
            assigneeName: null,
          },
        ],
      },
      { id: newId('col'), title: done, wip: null, cards: [] },
    ],
  }
}

export function starterBoardSource(labels?: Partial<StarterLabels>): string {
  return serializeBoard(starterBoard(labels))
}

export function serializeBoard(doc: KanbanDoc): string {
  return JSON.stringify(doc)
}

function asColor(value: unknown): KanbanColor | null {
  if (typeof value !== 'string') return null
  return (KANBAN_COLORS as readonly string[]).includes(value) ? (value as KanbanColor) : null
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asCard(raw: unknown): KanbanCard | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title : ''
  const body = typeof o.body === 'string' ? o.body : ''
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : newId('card')
  return {
    id,
    title,
    body,
    color: asColor(o.color),
    assigneeId: asOptionalString(o.assigneeId),
    assigneeName: asOptionalString(o.assigneeName),
  }
}

function asColumn(raw: unknown): KanbanColumn | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title : ''
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : newId('col')
  const wip =
    typeof o.wip === 'number' && Number.isFinite(o.wip) && o.wip > 0 ? Math.floor(o.wip) : null
  const cards = Array.isArray(o.cards)
    ? o.cards.map(asCard).filter((c): c is KanbanCard => c !== null)
    : []
  return { id, title, wip, cards }
}

export function parseBoard(source: string | null | undefined): KanbanDoc {
  if (!source?.trim()) return emptyBoard()
  try {
    const raw = JSON.parse(source) as unknown
    if (!raw || typeof raw !== 'object') return emptyBoard()
    const o = raw as Record<string, unknown>
    const columns = Array.isArray(o.columns)
      ? o.columns.map(asColumn).filter((c): c is KanbanColumn => c !== null)
      : []
    if (columns.length === 0) return emptyBoard()
    return { version: 1, columns }
  } catch {
    return emptyBoard()
  }
}

/** Display name for a card's assignee: stored snapshot, else a directory lookup. */
export function resolveAssigneeName(
  card: KanbanCard,
  users: Array<{ id: string; username: string; displayName: string | null }>,
): string | null {
  const snap = card.assigneeName?.trim()
  if (snap) return snap
  if (!card.assigneeId) return null
  const u = users.find((x) => x.id === card.assigneeId)
  if (!u) return null
  return u.displayName?.trim() || u.username
}

export function countCards(doc: KanbanDoc): number {
  return doc.columns.reduce((n, c) => n + c.cards.length, 0)
}

export function addColumn(doc: KanbanDoc, title: string): KanbanDoc {
  return {
    ...doc,
    columns: [...doc.columns, { id: newId('col'), title: title.trim() || 'Column', wip: null, cards: [] }],
  }
}

export function renameColumn(doc: KanbanDoc, columnId: string, title: string): KanbanDoc {
  return {
    ...doc,
    columns: doc.columns.map((c) => (c.id === columnId ? { ...c, title } : c)),
  }
}

export function setColumnWip(doc: KanbanDoc, columnId: string, wip: number | null): KanbanDoc {
  return {
    ...doc,
    columns: doc.columns.map((c) => (c.id === columnId ? { ...c, wip } : c)),
  }
}

export function removeColumn(doc: KanbanDoc, columnId: string): KanbanDoc {
  if (doc.columns.length <= 1) return doc
  return { ...doc, columns: doc.columns.filter((c) => c.id !== columnId) }
}

export function moveColumn(doc: KanbanDoc, columnId: string, toIndex: number): KanbanDoc {
  const from = doc.columns.findIndex((c) => c.id === columnId)
  if (from < 0) return doc
  const next = [...doc.columns]
  const [col] = next.splice(from, 1)
  const clamped = Math.max(0, Math.min(toIndex, next.length))
  next.splice(clamped, 0, col)
  return { ...doc, columns: next }
}

export function addCard(doc: KanbanDoc, columnId: string, title: string): KanbanDoc {
  const card: KanbanCard = {
    id: newId('card'),
    title: title.trim() || 'New card',
    body: '',
    color: null,
    assigneeId: null,
    assigneeName: null,
  }
  return {
    ...doc,
    columns: doc.columns.map((c) => (c.id === columnId ? { ...c, cards: [...c.cards, card] } : c)),
  }
}

export function updateCard(
  doc: KanbanDoc,
  cardId: string,
  patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'color' | 'assigneeId' | 'assigneeName'>>,
): KanbanDoc {
  return {
    ...doc,
    columns: doc.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)),
    })),
  }
}

export function removeCard(doc: KanbanDoc, cardId: string): KanbanDoc {
  return {
    ...doc,
    columns: doc.columns.map((c) => ({ ...c, cards: c.cards.filter((card) => card.id !== cardId) })),
  }
}

/** Move a card to `toColumnId`, inserting at `toIndex` (end if omitted). */
export function moveCard(
  doc: KanbanDoc,
  cardId: string,
  toColumnId: string,
  toIndex?: number,
): KanbanDoc {
  let moving: KanbanCard | null = null
  const stripped = doc.columns.map((c) => {
    const found = c.cards.find((card) => card.id === cardId)
    if (!found) return c
    moving = found
    return { ...c, cards: c.cards.filter((card) => card.id !== cardId) }
  })
  if (!moving) return doc
  return {
    ...doc,
    columns: stripped.map((c) => {
      if (c.id !== toColumnId) return c
      const next = [...c.cards]
      const idx = toIndex == null ? next.length : Math.max(0, Math.min(toIndex, next.length))
      next.splice(idx, 0, moving!)
      return { ...c, cards: next }
    }),
  }
}

/** HTML snapshot for PDF / print export. */
export function kanbanToHtml(source: string, title?: string): string {
  const doc = parseBoard(source)
  const cols = doc.columns
    .map((col) => {
      const cards = col.cards
        .map((card) => {
          const color = card.color ? ` data-color="${esc(card.color)}"` : ''
          const body = card.body.trim()
            ? `<p class="export-kanban-body">${esc(card.body)}</p>`
            : ''
          const who = card.assigneeName?.trim()
            ? `<p class="export-kanban-assignee">${esc(card.assigneeName.trim())}</p>`
            : ''
          return `<li class="export-kanban-card"${color}><strong>${esc(card.title) || '…'}</strong>${body}${who}</li>`
        })
        .join('')
      const wip =
        col.wip != null ? ` <span class="export-kanban-wip">${col.cards.length}/${col.wip}</span>` : ''
      return `<section class="export-kanban-col"><h4>${esc(col.title) || 'Column'}${wip}</h4><ol>${cards}</ol></section>`
    })
    .join('')
  const caption = title ? `<figcaption>${esc(title)}</figcaption>` : ''
  return `<figure class="export-diagram export-kanban">${caption}<div class="export-kanban-board">${cols}</div></figure>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
