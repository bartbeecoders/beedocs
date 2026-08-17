/**
 * Page grid layout: a page can arrange its blocks in a COLS×ROWS grid of cells
 * instead of one top-to-bottom flow.
 *
 * The whole feature lives inside the page's Markdown as HTML comment markers,
 * so a page with a layout is still one plain-text document — it round-trips
 * through the API, MCP tools, exports and revision history unchanged, and any
 * renderer that doesn't know the markers shows the cells one after another
 * (HTML comments render as nothing).
 *
 *   <!-- bee:layout 2x2 -->
 *   <!-- bee:cell 0 -->
 *   ## Left top …
 *   <!-- bee:cell 1 -->
 *   ## Right top …
 *
 * A page without a layout marker is exactly what it was before this feature.
 * Markers only count outside fenced code blocks, so diagram JSON (or a code
 * sample about this very syntax) can never tear a page apart.
 */

export type PageLayout = {
  /** Columns, 1–4. */
  cols: number
  /** Rows, 1–4. */
  rows: number
}

export type ParsedPageLayout = {
  layout: PageLayout
  /** One Markdown string per cell, row-major, always exactly cols×rows long. */
  cells: string[]
}

export const MAX_LAYOUT_COLS = 4
export const MAX_LAYOUT_ROWS = 4

/** Layouts offered in the editor's picker. Anything within the caps parses. */
export const LAYOUT_PRESETS: { spec: string; label: string }[] = [
  { spec: '1x1', label: '1 × 1 · single flow' },
  { spec: '2x1', label: '2 × 1 · two columns' },
  { spec: '3x1', label: '3 × 1 · three columns' },
  { spec: '2x2', label: '2 × 2 · four cells' },
  { spec: '3x2', label: '3 × 2 · six cells' },
]

const LAYOUT_MARKER_RE = /^<!--\s*bee:layout\s+(\d+)\s*[x×]\s*(\d+)\s*-->\s*$/
const CELL_MARKER_RE = /^<!--\s*bee:cell\s+(\d+)\s*-->\s*$/

export function cellCount(layout: PageLayout): number {
  return layout.cols * layout.rows
}

/** Parse "2x2" (or "2×2"), clamped to the supported range. Null when malformed. */
export function parseLayoutSpec(spec: string): PageLayout | null {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(spec)
  if (!m) return null
  return clampLayout(Number(m[1]), Number(m[2]))
}

export function formatLayoutSpec(layout: PageLayout): string {
  return `${layout.cols}x${layout.rows}`
}

function clampLayout(cols: number, rows: number): PageLayout {
  const c = Math.min(MAX_LAYOUT_COLS, Math.max(1, Math.floor(cols) || 1))
  const r = Math.min(MAX_LAYOUT_ROWS, Math.max(1, Math.floor(rows) || 1))
  return { cols: c, rows: r }
}

/** True for a line that is one of our layout/cell markers. */
export function isLayoutMarkerLine(line: string): boolean {
  const t = line.trim()
  return LAYOUT_MARKER_RE.test(t) || CELL_MARKER_RE.test(t)
}

/**
 * Split a page into its grid cells. Returns null when the page has no layout
 * marker — the caller renders the single flow it always did.
 *
 * Tolerant by design: content before the first cell marker lands in cell 0,
 * missing cells come back empty, and content addressed past the grid is
 * appended to the last cell rather than dropped.
 */
export function parsePageLayout(markdown: string): ParsedPageLayout | null {
  const src = markdown.replace(/\r\n/g, '\n')
  if (!src.includes('bee:layout')) return null

  const lines = src.split('\n')
  let inFence = false
  let layout: PageLayout | null = null
  /** Buffers per declared cell index, in the order markers appeared. */
  const buffers = new Map<number, string[]>()
  let current: string[] = []
  buffers.set(0, current)

  for (const line of lines) {
    if (!inFence && line.startsWith('```')) {
      inFence = true
      current.push(line)
      continue
    }
    if (inFence) {
      if (/^```[ \t]*$/.test(line)) inFence = false
      current.push(line)
      continue
    }

    const t = line.trim()
    const lm = LAYOUT_MARKER_RE.exec(t)
    if (lm && !layout) {
      layout = clampLayout(Number(lm[1]), Number(lm[2]))
      continue
    }
    const cm = layout ? CELL_MARKER_RE.exec(t) : null
    if (cm) {
      const idx = Number(cm[1])
      current = buffers.get(idx) ?? []
      // Re-opening a cell appends — keep a blank line so paragraphs stay apart.
      if (current.length > 0 && current[current.length - 1] !== '') current.push('')
      buffers.set(idx, current)
      continue
    }
    current.push(line)
  }

  if (!layout) return null

  const n = cellCount(layout)
  const cells: string[] = new Array(n).fill('')
  const overflow: string[] = []
  const indices = [...buffers.keys()].sort((a, b) => a - b)
  for (const idx of indices) {
    const text = trimCell(buffers.get(idx)!.join('\n'))
    if (!text) continue
    if (idx < n) {
      cells[idx] = cells[idx] ? `${cells[idx]}\n\n${text}` : text
    } else {
      overflow.push(text)
    }
  }
  if (overflow.length) {
    const tail = overflow.join('\n\n')
    cells[n - 1] = cells[n - 1] ? `${cells[n - 1]}\n\n${tail}` : tail
  }
  return { layout, cells }
}

/**
 * Serialize a grid back to Markdown. A 1×1 layout serializes as the bare cell
 * content — no markers — so switching a page back to a single flow leaves a
 * clean document, byte-identical to a page that never had a grid.
 */
export function serializePageLayout(layout: PageLayout, cells: string[]): string {
  const n = cellCount(layout)
  if (n <= 1) return trimCell(cells[0] ?? '')

  const parts: string[] = [`<!-- bee:layout ${formatLayoutSpec(layout)} -->`]
  for (let i = 0; i < n; i++) {
    parts.push(`<!-- bee:cell ${i} -->`)
    const body = trimCell(cells[i] ?? '')
    if (body) parts.push(body)
  }
  return parts.join('\n\n')
}

/**
 * Re-flow cell contents into a different cell count: growing pads with empty
 * cells, shrinking folds the surplus cells into the last remaining one so no
 * content is ever lost by changing the layout.
 */
export function reflowCells(cells: string[], nextCount: number): string[] {
  const n = Math.max(1, nextCount)
  const filled = cells.map(trimCell)
  if (filled.length <= n) {
    return [...filled, ...new Array(n - filled.length).fill('')]
  }
  const kept = filled.slice(0, n)
  const tail = filled.slice(n).filter(Boolean)
  if (tail.length) {
    const joined = [kept[n - 1], ...tail].filter(Boolean).join('\n\n')
    kept[n - 1] = joined
  }
  return kept
}

function trimCell(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}
