/**
 * Excel-style grid documents stored in ```excelgrid fenced blocks on a page.
 *
 * Only non-empty cells (and non-default sizes) are persisted so a 16×8 starter
 * stays a small JSON blob. The live editor keeps a Map for O(1) lookup.
 */

import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  type Cell,
  type CellFormatting,
  type CellType,
  type GridData,
  getCellKey,
} from './types'

export type ExcelGridDoc = {
  version: 1
  rowCount: number
  colCount: number
  cells: PersistedCell[]
  columnWidths?: Record<string, number>
  rowHeights?: Record<string, number>
}

export type PersistedCell = {
  r: number
  c: number
  v: string
  t?: CellType
  f?: CellFormatting
}

export type GridWorking = GridData & {
  columnWidths: Map<number, number>
  rowHeights: Map<number, number>
}

export const EMPTY_EXCEL_GRID_DOC: ExcelGridDoc = {
  version: 1,
  rowCount: DEFAULT_ROWS,
  colCount: DEFAULT_COLS,
  cells: [],
}

function starterCells(): PersistedCell[] {
  const headers = ['Item', 'Qty', 'Unit', 'Owner', 'Status', 'Notes']
  const sample: string[][] = [
    ['Widget A', '2', 'ea', '', 'Draft', ''],
    ['Widget B', '1', 'ea', '', 'Draft', ''],
  ]
  const headerFmt: CellFormatting = {
    bold: true,
    textAlign: 'center',
  }
  const cells: PersistedCell[] = headers.map((v, c) => ({
    r: 0,
    c,
    v,
    t: 'text' as const,
    f: headerFmt,
  }))
  sample.forEach((row, i) => {
    row.forEach((v, c) => {
      if (!v) return
      cells.push({ r: i + 1, c, v, t: c === 1 ? 'number' : 'text' })
    })
  })
  return cells
}

export function starterExcelGridDoc(): ExcelGridDoc {
  return {
    version: 1,
    rowCount: DEFAULT_ROWS,
    colCount: DEFAULT_COLS,
    cells: starterCells(),
    columnWidths: { '0': 160, '5': 220 },
  }
}

export function serializeExcelGridDoc(doc: ExcelGridDoc): string {
  const clean: ExcelGridDoc = {
    version: 1,
    rowCount: clampDim(doc.rowCount, 1, MAX_ROWS, DEFAULT_ROWS),
    colCount: clampDim(doc.colCount, 1, MAX_COLS, DEFAULT_COLS),
    cells: (doc.cells ?? [])
      .filter((c) => c && Number.isFinite(c.r) && Number.isFinite(c.c) && String(c.v ?? '') !== '')
      .map((c) => {
        const out: PersistedCell = { r: c.r, c: c.c, v: String(c.v) }
        if (c.t && c.t !== 'text') out.t = c.t
        if (c.f && Object.keys(c.f).length) out.f = c.f
        return out
      }),
  }
  if (doc.columnWidths && Object.keys(doc.columnWidths).length) clean.columnWidths = doc.columnWidths
  if (doc.rowHeights && Object.keys(doc.rowHeights).length) clean.rowHeights = doc.rowHeights
  return JSON.stringify(clean)
}

export function parseExcelGridDoc(source: string | null | undefined): ExcelGridDoc {
  if (!source?.trim()) return structuredClone(EMPTY_EXCEL_GRID_DOC)
  try {
    const raw = JSON.parse(source) as Partial<ExcelGridDoc>
    const rowCount = clampDim(Number(raw.rowCount), 1, MAX_ROWS, DEFAULT_ROWS)
    const colCount = clampDim(Number(raw.colCount), 1, MAX_COLS, DEFAULT_COLS)
    const cells: PersistedCell[] = []
    if (Array.isArray(raw.cells)) {
      for (const item of raw.cells) {
        if (!item || typeof item !== 'object') continue
        const r = Number((item as PersistedCell).r)
        const c = Number((item as PersistedCell).c)
        if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) continue
        if (r >= rowCount || c >= colCount) continue
        const v = String((item as PersistedCell).v ?? '')
        if (v === '') continue
        const t = (item as PersistedCell).t
        const f = (item as PersistedCell).f
        cells.push({
          r,
          c,
          v,
          t: t === 'number' || t === 'boolean' ? t : undefined,
          f: f && typeof f === 'object' ? f : undefined,
        })
      }
    }
    return {
      version: 1,
      rowCount,
      colCount,
      cells,
      columnWidths: mapSizes(raw.columnWidths, colCount),
      rowHeights: mapSizes(raw.rowHeights, rowCount),
    }
  } catch {
    return structuredClone(EMPTY_EXCEL_GRID_DOC)
  }
}

export function toWorking(doc: ExcelGridDoc): GridWorking {
  const cells = new Map<string, Cell>()
  for (const c of doc.cells) {
    cells.set(getCellKey(c.r, c.c), {
      row: c.r,
      col: c.c,
      value: c.v,
      type: c.t,
      formatting: c.f,
    })
  }
  return {
    cells,
    rowCount: doc.rowCount,
    colCount: doc.colCount,
    columnWidths: numberMap(doc.columnWidths),
    rowHeights: numberMap(doc.rowHeights),
  }
}

export function fromWorking(w: GridWorking): ExcelGridDoc {
  const cells: PersistedCell[] = []
  w.cells.forEach((cell) => {
    if (!cell.value) return
    if (cell.row < 0 || cell.col < 0 || cell.row >= w.rowCount || cell.col >= w.colCount) return
    const item: PersistedCell = { r: cell.row, c: cell.col, v: cell.value }
    if (cell.type && cell.type !== 'text') item.t = cell.type
    if (cell.formatting && Object.keys(cell.formatting).length) item.f = cell.formatting
    cells.push(item)
  })
  cells.sort((a, b) => (a.r === b.r ? a.c - b.c : a.r - b.r))
  return {
    version: 1,
    rowCount: w.rowCount,
    colCount: w.colCount,
    cells,
    columnWidths: fromNumberMap(w.columnWidths),
    rowHeights: fromNumberMap(w.rowHeights),
  }
}

export function cloneWorking(w: GridWorking): GridWorking {
  const cells = new Map<string, Cell>()
  w.cells.forEach((c, k) => cells.set(k, { ...c, formatting: c.formatting ? { ...c.formatting } : undefined }))
  return {
    cells,
    rowCount: w.rowCount,
    colCount: w.colCount,
    columnWidths: new Map(w.columnWidths),
    rowHeights: new Map(w.rowHeights),
  }
}

/** Plain text of every cell, for search / outline labels. */
export function excelGridPlainText(source: string): string {
  const doc = parseExcelGridDoc(source)
  return doc.cells
    .map((c) => c.v.trim())
    .filter(Boolean)
    .join('\n')
}

/** HTML table for PDF/HTML export. */
export function excelGridToHtml(source: string, title?: string): string {
  const doc = parseExcelGridDoc(source)
  const w = toWorking(doc)
  const caption = title
    ? `<figcaption style="font-size:0.9rem;color:#555;margin-bottom:0.35em">${escText(title)}</figcaption>`
    : ''
  const rows: string[] = []
  for (let r = 0; r < w.rowCount; r++) {
    const cells: string[] = []
    let any = false
    for (let c = 0; c < w.colCount; c++) {
      const cell = w.cells.get(getCellKey(r, c))
      if (cell?.value) any = true
      cells.push(renderExportCell(cell, r === 0))
    }
    if (any || r === 0) rows.push(`<tr>${cells.join('')}</tr>`)
  }
  // Drop trailing empty rows already skipped; if the sheet is empty, keep one blank row.
  if (rows.length === 0) {
    rows.push(`<tr>${'<td></td>'.repeat(Math.max(1, w.colCount))}</tr>`)
  }
  return (
    `<figure class="export-diagram export-excelgrid">` +
    caption +
    `<table class="export-excelgrid-table">${rows.join('')}</table></figure>`
  )
}

function renderExportCell(cell: Cell | undefined, headerish: boolean): string {
  const f = cell?.formatting
  const tag = headerish || f?.bold ? 'th' : 'td'
  const styles: string[] = []
  if (f?.fillColor) styles.push(`background:${escAttr(f.fillColor)}`)
  if (f?.textColor) styles.push(`color:${escAttr(f.textColor)}`)
  if (f?.textAlign) styles.push(`text-align:${f.textAlign}`)
  if (f?.italic) styles.push('font-style:italic')
  if (f?.underline) styles.push('text-decoration:underline')
  if (f?.fontSize) styles.push(`font-size:${f.fontSize}px`)
  if (f?.fontFamily) styles.push(`font-family:${escAttr(f.fontFamily)}`)
  const style = styles.length ? ` style="${styles.join(';')}"` : ''
  return `<${tag}${style}>${escText(cell?.value ?? '')}</${tag}>`
}

function clampDim(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function mapSizes(raw: Record<string, number> | undefined, limit: number): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    const i = Number(k)
    const n = Number(v)
    if (!Number.isInteger(i) || i < 0 || i >= limit) continue
    if (!Number.isFinite(n)) continue
    out[String(i)] = Math.round(n)
  }
  return Object.keys(out).length ? out : undefined
}

function numberMap(raw: Record<string, number> | undefined): Map<number, number> {
  const m = new Map<number, number>()
  if (!raw) return m
  for (const [k, v] of Object.entries(raw)) m.set(Number(k), v)
  return m
}

function fromNumberMap(m: Map<number, number>): Record<string, number> | undefined {
  if (m.size === 0) return undefined
  const out: Record<string, number> = {}
  m.forEach((v, k) => {
    out[String(k)] = v
  })
  return out
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
