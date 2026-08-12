import { cloneCell, getCellKey, type Cell } from './types'
import { gridToTsv, parseTsv } from './csv'

export type GridClipboard = {
  cells: Cell[]
  minRow: number
  minCol: number
  maxRow: number
  maxCol: number
  isCut: boolean
}

export function copyRange(
  cells: Map<string, Cell>,
  selected: { row: number; col: number }[],
  isCut = false,
): GridClipboard | null {
  if (selected.length === 0) return null
  let minRow = Infinity
  let minCol = Infinity
  let maxRow = -Infinity
  let maxCol = -Infinity
  const copied: Cell[] = []
  for (const { row, col } of selected) {
    minRow = Math.min(minRow, row)
    minCol = Math.min(minCol, col)
    maxRow = Math.max(maxRow, row)
    maxCol = Math.max(maxCol, col)
    const existing = cells.get(getCellKey(row, col))
    copied.push(existing ? cloneCell(existing) : { row, col, value: '' })
  }
  return { cells: copied, minRow, minCol, maxRow, maxCol, isCut }
}

export function pasteAt(clip: GridClipboard, targetRow: number, targetCol: number): Cell[] {
  const dR = targetRow - clip.minRow
  const dC = targetCol - clip.minCol
  return clip.cells.map((c) => cloneCell(c, c.row + dR, c.col + dC))
}

export function clipToTsv(clip: GridClipboard): string {
  const map = new Map<string, Cell>()
  for (const c of clip.cells) map.set(getCellKey(c.row, c.col), c)
  return gridToTsv(map, clip.minRow, clip.minCol, clip.maxRow, clip.maxCol)
}

export function tsvToClip(text: string, originRow: number, originCol: number): GridClipboard | null {
  const rows = parseTsv(text)
  if (rows.length === 0) return null
  const cells: Cell[] = []
  let maxCol = originCol
  rows.forEach((vals, r) => {
    vals.forEach((v, c) => {
      cells.push({ row: originRow + r, col: originCol + c, value: v })
      maxCol = Math.max(maxCol, originCol + c)
    })
  })
  return {
    cells,
    minRow: originRow,
    minCol: originCol,
    maxRow: originRow + rows.length - 1,
    maxCol,
    isCut: false,
  }
}

export async function writeSystemClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard permission is optional — in-app paste still works.
  }
}

export async function readSystemClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}
