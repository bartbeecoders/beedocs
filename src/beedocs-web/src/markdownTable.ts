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
}

export type TableMatch = {
  index: number
  length: number
  raw: string
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
    const start = offsets[i]
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
  if (lines.length < 2) return null
  const header = splitRowCells(lines[0])
  const align = parseSeparator(lines[1])
  if (!align || align.length !== header.length) return null
  const rows = lines.slice(2).map((l) => normalizeRow(splitRowCells(l), header.length))
  return { header, align, rows }
}

/** Serialize a cell model back to padded, aligned pipe-table Markdown. */
export function serializeMarkdownTable(table: MarkdownTable): string {
  const esc = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
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
  return [row(grid[0]), sep, ...grid.slice(1).map(row)].join('\n')
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
