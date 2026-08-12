import { inferCellType, type Cell, getCellKey } from './types'

export type CsvImportResult = {
  cells: Map<string, Cell>
  rowCount: number
  colCount: number
}

const HEADER_FORMATTING = {
  bold: true,
  textAlign: 'center' as const,
}

/**
 * Parse CSV / TSV into grid cells. Quoted fields and escaped quotes are honoured.
 */
export function parseCsv(
  text: string,
  opts: { delimiter?: string; hasHeader?: boolean; startRow?: number; startCol?: number } = {},
): CsvImportResult {
  const delimiter = opts.delimiter ?? detectDelimiter(text)
  const hasHeader = opts.hasHeader ?? true
  const startRow = opts.startRow ?? 0
  const startCol = opts.startCol ?? 0
  const rows = parseCsvRows(text, delimiter)
  const cells = new Map<string, Cell>()
  let maxCols = 0

  rows.forEach((values, r) => {
    if (values.length > maxCols) maxCols = values.length
    values.forEach((raw, c) => {
      const value = raw.trim()
      if (value === '') return
      const row = startRow + r
      const col = startCol + c
      cells.set(getCellKey(row, col), {
        row,
        col,
        value,
        type: inferCellType(value),
        formatting: hasHeader && r === 0 ? { ...HEADER_FORMATTING } : undefined,
      })
    })
  })

  return {
    cells,
    rowCount: startRow + rows.length,
    colCount: startCol + maxCols,
  }
}

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    const count = splitUnquoted(first, d).length
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

export function gridToTsv(
  cells: Map<string, Cell>,
  minRow: number,
  minCol: number,
  maxRow: number,
  maxCol: number,
): string {
  const lines: string[] = []
  for (let r = minRow; r <= maxRow; r++) {
    const cols: string[] = []
    for (let c = minCol; c <= maxCol; c++) {
      cols.push(escapeTsv(cells.get(getCellKey(r, c))?.value ?? ''))
    }
    lines.push(cols.join('\t'))
  }
  return lines.join('\n')
}

export function parseTsv(text: string): string[][] {
  return parseCsvRows(text, '\t')
}

function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field: string[] = []
  let inQuotes = false
  const src = text.replace(/^\uFEFF/, '')

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '"') {
      if (inQuotes && next === '"') {
        field.push('"')
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === delimiter) {
      row.push(field.join(''))
      field = []
      continue
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && next === '\n') i++
      row.push(field.join(''))
      field = []
      if (row.some((v) => v.trim() !== '')) rows.push(row)
      row = []
      continue
    }
    field.push(ch)
  }
  row.push(field.join(''))
  if (row.some((v) => v.trim() !== '')) rows.push(row)
  return rows
}

function splitUnquoted(line: string, delimiter: string): string[] {
  return parseCsvRows(line, delimiter)[0] ?? []
}

function escapeTsv(value: string): string {
  if (/[\t\n\r"]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}
