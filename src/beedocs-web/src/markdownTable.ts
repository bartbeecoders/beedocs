import { splitTextWithImages, type TextPiece } from './media/imageIntake'

/**
 * GFM pipe-table parsing and serialization for the hybrid editor's table
 * designer. Storage stays plain Markdown — the designer is only a view over a
 * table found inside a text segment, exactly like image previews.
 */

export type ColumnAlign = 'left' | 'center' | 'right' | null

export type MarkdownTable = {
  header: string[]
  align: ColumnAlign[]
  rows: string[][]
  /** Visual style, persisted as a comment marker above the table. Null = default. */
  theme: string | null
  /** Per-header-cell style ids, parallel to `header`. Null = unstyled. */
  headerStyles: (string | null)[]
  /** Per-body-cell style ids, parallel to `rows`. Null = unstyled. */
  cellStyles: (string | null)[][]
  /** Header row height in px. Null = size to content. */
  headerHeight: number | null
  /** Per-body-row height in px, parallel to `rows`. Null = size to content. */
  rowHeights: (number | null)[]
}

/** Floor / ceiling for a designer-dragged row, in CSS pixels. */
export const MIN_MD_ROW_HEIGHT = 24
export const MAX_MD_ROW_HEIGHT = 480

export function clampMdRowHeight(n: number): number {
  return Math.max(MIN_MD_ROW_HEIGHT, Math.min(MAX_MD_ROW_HEIGHT, Math.round(n)))
}

/**
 * Table themes the designer offers. Each id maps to a `bee-tbl--<id>` CSS class
 * (and an `.export-page-body` print variant in export/pdf.ts); the marker
 * survives round-trips through any other Markdown renderer as an invisible
 * HTML comment.
 */
export const TABLE_THEMES: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Default' },
  { id: 'striped', label: 'Striped' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'forest', label: 'Forest' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'contrast', label: 'Contrast' },
]

/** Per-cell highlight styles: `bee-cell--<id>` CSS classes on one th/td. */
export const CELL_STYLES: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'None' },
  { id: 'accent', label: 'Accent' },
  { id: 'info', label: 'Blue' },
  { id: 'ok', label: 'Green' },
  { id: 'warn', label: 'Amber' },
  { id: 'danger', label: 'Red' },
  { id: 'muted', label: 'Muted' },
]

/** One styled cell in the marker: row 'h' = the header row. */
export type MarkerCell = { row: number | 'h'; col: number; style: string }

/** One row-height override in the marker: row 'h' = the header row. */
export type MarkerRowHeight = { row: number | 'h'; height: number }

export type TableMarker = {
  theme: string | null
  cells: MarkerCell[]
  rowHeights: MarkerRowHeight[]
}

const MARKER_LINE = /^<!--\s*bee-table:\s*(.*?)\s*-->$/
const THEME_TOKEN = /^theme=([a-z][a-z0-9-]*)$/
const CELLS_TOKEN = /^cells=(\S+)$/
const ROWS_TOKEN = /^rows=(\S+)$/
const CELL_REF = /^(?:h(\d+)|r(\d+)c(\d+)):([a-z][a-z0-9-]*)$/
const ROW_H_REF = /^(h|\d+):(\d+)$/

/**
 * Parse a `<!-- bee-table: theme=x cells=h0:accent,r1c2:ok rows=h:40,0:72 -->`
 * line. Null when the line is not a bee-table marker at all; unknown tokens are
 * skipped so a newer document degrades gracefully in an older build.
 */
export function parseTableMarker(line: string): TableMarker | null {
  const m = MARKER_LINE.exec(line.trim())
  if (!m) return null
  const marker: TableMarker = { theme: null, cells: [], rowHeights: [] }
  for (const token of m[1].split(/\s+/).filter(Boolean)) {
    const t = THEME_TOKEN.exec(token)
    if (t) {
      marker.theme = t[1]
      continue
    }
    const cs = CELLS_TOKEN.exec(token)
    if (cs) {
      for (const ref of cs[1].split(',')) {
        const r = CELL_REF.exec(ref)
        if (!r) continue
        marker.cells.push(
          r[1] != null
            ? { row: 'h', col: Number(r[1]), style: r[4] }
            : { row: Number(r[2]), col: Number(r[3]), style: r[4] },
        )
      }
      continue
    }
    const rs = ROWS_TOKEN.exec(token)
    if (!rs) continue
    for (const ref of rs[1].split(',')) {
      const r = ROW_H_REF.exec(ref)
      if (!r) continue
      const n = Number(r[2])
      if (!Number.isFinite(n) || n < MIN_MD_ROW_HEIGHT) continue
      marker.rowHeights.push({
        row: r[1] === 'h' ? 'h' : Number(r[1]),
        height: clampMdRowHeight(n),
      })
    }
  }
  return marker
}

/** Pixel height stored for `row`, or null when that row sizes to its content. */
export function markerRowHeight(
  marker: TableMarker | null | undefined,
  row: number | 'h',
): number | null {
  const hit = marker?.rowHeights.find((x) => x.row === row)
  return hit ? hit.height : null
}

function serializeTableMarker(table: MarkdownTable): string | null {
  const parts: string[] = []
  if (table.theme) parts.push(`theme=${table.theme}`)
  const refs: string[] = []
  table.headerStyles.forEach((s, c) => {
    if (s) refs.push(`h${c}:${s}`)
  })
  table.cellStyles.forEach((row, r) =>
    row.forEach((s, c) => {
      if (s) refs.push(`r${r}c${c}:${s}`)
    }),
  )
  if (refs.length) parts.push(`cells=${refs.join(',')}`)
  const rowRefs: string[] = []
  if (table.headerHeight != null) rowRefs.push(`h:${table.headerHeight}`)
  table.rowHeights.forEach((h, r) => {
    if (h != null) rowRefs.push(`${r}:${h}`)
  })
  if (rowRefs.length) parts.push(`rows=${rowRefs.join(',')}`)
  return parts.length ? `<!-- bee-table: ${parts.join(' ')} -->` : null
}

/** CSS class for a theme id ('' for none/default — ids are marker-validated). */
export function tableThemeClass(theme: string | null | undefined): string {
  return theme && /^[a-z][a-z0-9-]*$/.test(theme) ? `bee-tbl--${theme}` : ''
}

/** CSS class for a cell style id ('' for none). */
export function cellStyleClass(style: string | null | undefined): string {
  return style && /^[a-z][a-z0-9-]*$/.test(style) ? `bee-cell--${style}` : ''
}

export type TableMatch = {
  index: number
  length: number
  raw: string
}

/**
 * A pipe-table cell cannot hold a real newline, so `<br>` is how a line break
 * is stored — the GFM-standard encoding, which any other renderer of the page
 * honours too. The designer's cell model uses real newlines (that is what a
 * textarea edits), decoded here on parse and re-encoded in `esc` on serialize.
 */
const BR_TAG = /<br\s*\/?>/gi

export function decodeCellBreaks(cell: string): string {
  return cell.replace(BR_TAG, '\n')
}

/** Split one table row into trimmed cells, honouring `\|` escapes. */
function splitRowCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/**
 * A line that can belong to a table: not blank, not an indented code block,
 * and containing a pipe. The pipe requirement also keeps `---` (a thematic
 * break or setext underline) from reading as a one-column separator.
 */
function isTableLine(line: string): boolean {
  if (/^ {4,}/.test(line)) return false
  return line.includes('|') && line.trim() !== ''
}

const SEPARATOR_CELL = /^:?-+:?$/

/** Parse a separator line into per-column alignment, or null if it isn't one. */
function parseSeparator(line: string): ColumnAlign[] | null {
  if (!isTableLine(line)) return null
  const cells = splitRowCells(line)
  if (cells.length === 0) return null
  const align: ColumnAlign[] = []
  for (const cell of cells) {
    if (!SEPARATOR_CELL.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return align
}

/** Pad or truncate a row to the header's column count. */
function normalizeRow(cells: string[], cols: number): string[] {
  const row = cells.slice(0, cols)
  while (row.length < cols) row.push('')
  return row
}

/**
 * Locate GFM pipe tables in a run of Markdown: a header line whose cell count
 * matches the separator line under it, followed by any number of row lines.
 * Matches are non-overlapping and cover the exact table lines (no trailing
 * newline), so replacing `raw` in place round-trips the surrounding text.
 */
export function findMarkdownTables(text: string): TableMatch[] {
  const lines = text.split('\n')
  const offsets: number[] = []
  let off = 0
  for (const line of lines) {
    offsets.push(off)
    off += line.length + 1
  }

  const out: TableMatch[] = []
  let i = 0
  while (i < lines.length - 1) {
    const align = isTableLine(lines[i]) ? parseSeparator(lines[i + 1]) : null
    if (!align || splitRowCells(lines[i]).length !== align.length) {
      i++
      continue
    }
    let end = i + 2
    while (end < lines.length && isTableLine(lines[end]) && parseSeparator(lines[end]) == null) end++
    // A style marker directly above the header travels with the table, so the
    // designer edits it as one block and edit mode never shows it as raw text.
    // It has no pipe, so it can never already belong to the previous match.
    const startLine = i > 0 && parseTableMarker(lines[i - 1]) != null ? i - 1 : i
    const start = offsets[startLine]
    const stop = offsets[end - 1] + lines[end - 1].length
    out.push({ index: start, length: stop - start, raw: text.slice(start, stop) })
    i = end
  }
  return out
}

/** Parse a table's raw Markdown into a cell model. Null if it isn't a table. */
export function parseMarkdownTable(raw: string): MarkdownTable | null {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '')
  const marker = lines.length > 0 ? parseTableMarker(lines[0]) : null
  if (marker != null) lines.shift()
  if (lines.length < 2) return null
  const header = splitRowCells(lines[0])
  const align = parseSeparator(lines[1])
  if (!align || align.length !== header.length) return null
  const rows = lines
    .slice(2)
    .map((l) => normalizeRow(splitRowCells(l), header.length).map(decodeCellBreaks))
  // Styles live in arrays parallel to header/rows, so every structural edit
  // (add/remove/reorder) transforms them the same way and refs never desync.
  const headerStyles: (string | null)[] = header.map(() => null)
  const cellStyles: (string | null)[][] = rows.map((row) => row.map(() => null))
  for (const c of marker?.cells ?? []) {
    if (c.col >= header.length) continue
    if (c.row === 'h') headerStyles[c.col] = c.style
    else if (c.row < rows.length) cellStyles[c.row][c.col] = c.style
  }
  const headerHeight = markerRowHeight(marker, 'h')
  const rowHeights: (number | null)[] = rows.map((_, r) => markerRowHeight(marker, r))
  return {
    header,
    align,
    rows,
    theme: marker?.theme ?? null,
    headerStyles,
    cellStyles,
    headerHeight,
    rowHeights,
  }
}

/** Serialize a cell model back to padded, aligned pipe-table Markdown. */
export function serializeMarkdownTable(table: MarkdownTable): string {
  const esc = (s: string) => s.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|')
  const cols = table.header.length
  const grid = [table.header, ...table.rows].map((r) => normalizeRow(r, cols).map(esc))
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...grid.map((r) => r[c].length)),
  )
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
  const sepCell = (a: ColumnAlign, w: number) => {
    if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':'
    if (a === 'right') return '-'.repeat(Math.max(1, w - 1)) + ':'
    if (a === 'left') return ':' + '-'.repeat(Math.max(1, w - 1))
    return '-'.repeat(w)
  }
  const row = (r: string[]) => '| ' + r.map((c, i) => pad(c, widths[i])).join(' | ') + ' |'
  const sep = '| ' + table.align.map((a, i) => sepCell(a, widths[i])).join(' | ') + ' |'
  const md = [row(grid[0]), sep, ...grid.slice(1).map(row)].join('\n')
  const marker = serializeTableMarker(table)
  return marker ? `${marker}\n${md}` : md
}

export type RichTextPiece = TextPiece | { kind: 'table'; raw: string }

/**
 * Split a text segment into text / image / table pieces for edit-mode rendering.
 * Tables are cut first so a cell containing `![alt](url)` stays one table cell
 * rather than being torn apart by the image splitter.
 */
export function splitTextWithImagesAndTables(text: string): RichTextPiece[] {
  const tables = findMarkdownTables(text)
  if (tables.length === 0) return splitTextWithImages(text)

  const out: RichTextPiece[] = []
  let cursor = 0
  const pushText = (t: string) => {
    if (t !== '') out.push(...splitTextWithImages(t))
  }
  for (const tm of tables) {
    if (tm.index > cursor) pushText(text.slice(cursor, tm.index))
    out.push({ kind: 'table', raw: tm.raw })
    cursor = tm.index + tm.length
  }
  if (cursor < text.length) pushText(text.slice(cursor))
  return out
}

/** Structural subset of an mdast node — enough for the theme-marker rewrite. */
type MdNode = {
  type: string
  value?: string
  data?: { hProperties?: Record<string, unknown> }
  children?: MdNode[]
}

const addClass = (node: MdNode, cls: string) => {
  node.data = {
    ...node.data,
    hProperties: { ...node.data?.hProperties, className: [cls] },
  }
}

/** Append a CSS declaration onto an mdast node's hProperties.style string. */
const appendStyle = (node: MdNode, extra: string) => {
  const hp = node.data?.hProperties ?? {}
  const prev = typeof hp.style === 'string' ? hp.style.trim() : ''
  const sep = prev && !prev.endsWith(';') ? ';' : ''
  node.data = {
    ...node.data,
    hProperties: { ...hp, style: `${prev}${sep}${extra}` },
  }
}

/**
 * remark plugin: a marker comment before a table becomes a `bee-tbl--x` class
 * on the rendered `<table>`, `bee-cell--x` classes on the referenced cells, and
 * a pixel height on any row the designer resized. The transfer must happen on
 * the mdast tree — by the time react-markdown maps components, the comment and
 * the table are unrelated elements. The marker node itself is dropped
 * (react-markdown skips raw HTML anyway, but not under a future rehype-raw).
 */
/**
 * remark plugin: an inline `<br>` becomes a hard-break node. react-markdown
 * drops raw HTML, so without this the line breaks the table designer stores in
 * cells (Shift+Enter) would silently vanish from the reading view. Not scoped
 * to tables — a hand-typed `<br>` in prose earns the same break.
 */
export function remarkHtmlBreaks() {
  const isBrNode = (n: MdNode) =>
    n.type === 'html' && n.value != null && /^<br\s*\/?>$/i.test(n.value.trim())
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (!node.children) return
      for (let i = 0; i < node.children.length; i++) {
        const n = node.children[i]
        if (isBrNode(n)) node.children[i] = { type: 'break' }
        else visit(n)
      }
    }
    visit(tree)
  }
}

export function remarkTableThemes() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      const kids = node.children
      if (!kids) return
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i]
        const marker = n.type === 'html' && n.value ? parseTableMarker(n.value) : null
        const next = kids[i + 1]
        if (marker && next?.type === 'table') {
          const themeCls = tableThemeClass(marker.theme)
          if (themeCls) addClass(next, themeCls)
          const tableRows = next.children ?? []
          for (const ref of marker.cells) {
            // mdast table rows: [0] is the header row, body rows follow.
            const rowNode = ref.row === 'h' ? tableRows[0] : tableRows[ref.row + 1]
            const cellNode = rowNode?.children?.[ref.col]
            const cls = cellStyleClass(ref.style)
            if (cellNode && cls) addClass(cellNode, cls)
          }
          for (const rh of marker.rowHeights) {
            const rowNode = rh.row === 'h' ? tableRows[0] : tableRows[rh.row + 1]
            if (!rowNode) continue
            appendStyle(rowNode, `height:${rh.height}px`)
            for (const cell of rowNode.children ?? []) {
              appendStyle(cell, `min-height:${rh.height}px`)
            }
          }
          kids.splice(i, 1)
          i--
          continue
        }
        visit(n)
      }
    }
    visit(tree)
  }
}
