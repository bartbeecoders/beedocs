/** Cell and formatting types for the inline Excel-style grid. */

export type CellType = 'text' | 'number' | 'boolean'

export type TextAlign = 'left' | 'center' | 'right'

export type BorderLineStyle = 'solid' | 'dashed' | 'dotted'

export type BorderLine = {
  width: number
  color: string
  style: BorderLineStyle
}

export type BorderStyle = {
  top?: BorderLine
  right?: BorderLine
  bottom?: BorderLine
  left?: BorderLine
}

export type CellFormatting = {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  textColor?: string
  fillColor?: string
  borderStyle?: BorderStyle
  textAlign?: TextAlign
}

export type Cell = {
  row: number
  col: number
  value: string
  type?: CellType
  formatting?: CellFormatting
}

export type GridData = {
  cells: Map<string, Cell>
  rowCount: number
  colCount: number
}

export type SelectionRange = {
  start: { row: number; col: number }
  end: { row: number; col: number }
}

export type SelectionType = 'cell' | 'row' | 'column'

export const DEFAULT_CELL_WIDTH = 108
export const DEFAULT_CELL_HEIGHT = 28
export const DEFAULT_HEADER_WIDTH = 44
export const DEFAULT_HEADER_HEIGHT = 26
export const MIN_COL_WIDTH = 36
export const MIN_ROW_HEIGHT = 20
export const MAX_COL_WIDTH = 480
export const MAX_ROW_HEIGHT = 160
export const DEFAULT_ROWS = 16
export const DEFAULT_COLS = 8
export const MAX_ROWS = 500
export const MAX_COLS = 52

export function getCellKey(row: number, col: number): string {
  return `${row}-${col}`
}

export function getColumnLabel(col: number): string {
  let label = ''
  let num = col
  while (num >= 0) {
    label = String.fromCharCode(65 + (num % 26)) + label
    num = Math.floor(num / 26) - 1
  }
  return label
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.row === b.row &&
    a.col === b.col &&
    a.value === b.value &&
    a.type === b.type &&
    JSON.stringify(a.formatting ?? null) === JSON.stringify(b.formatting ?? null)
  )
}

export function inferCellType(raw: string): CellType {
  const t = raw.trim()
  if (t === '') return 'text'
  if (/^(true|false)$/i.test(t)) return 'boolean'
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return 'number'
  return 'text'
}

export function formatCellDisplay(cell: Cell | undefined): string {
  if (!cell) return ''
  return cell.value
}

export function cloneCell(cell: Cell, row?: number, col?: number): Cell {
  return {
    row: row ?? cell.row,
    col: col ?? cell.col,
    value: cell.value,
    type: cell.type,
    formatting: cell.formatting ? { ...cell.formatting } : undefined,
  }
}

export function mergeFormatting(base: CellFormatting | undefined, patch: Partial<CellFormatting>): CellFormatting {
  return { ...base, ...patch }
}

export function rangeCells(range: SelectionRange): { row: number; col: number }[] {
  const minRow = Math.min(range.start.row, range.end.row)
  const maxRow = Math.max(range.start.row, range.end.row)
  const minCol = Math.min(range.start.col, range.end.col)
  const maxCol = Math.max(range.start.col, range.end.col)
  const out: { row: number; col: number }[] = []
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) out.push({ row: r, col: c })
  }
  return out
}

export function normalizeRange(range: SelectionRange): { minRow: number; maxRow: number; minCol: number; maxCol: number } {
  return {
    minRow: Math.min(range.start.row, range.end.row),
    maxRow: Math.max(range.start.row, range.end.row),
    minCol: Math.min(range.start.col, range.end.col),
    maxCol: Math.max(range.start.col, range.end.col),
  }
}

export function isInRange(row: number, col: number, range: SelectionRange | null): boolean {
  if (!range) return false
  const n = normalizeRange(range)
  return row >= n.minRow && row <= n.maxRow && col >= n.minCol && col <= n.maxCol
}
