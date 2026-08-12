import { useEffect, useId, useMemo, useRef } from 'react'
import { parseExcelGridDoc, toWorking } from '../excelgrid/model'
import { readGridTheme, renderGrid } from '../excelgrid/renderGrid'
import {
  DEFAULT_CELL_HEIGHT,
  DEFAULT_CELL_WIDTH,
  DEFAULT_HEADER_HEIGHT,
  DEFAULT_HEADER_WIDTH,
} from '../excelgrid/types'

type Props = {
  source: string
  className?: string
  title?: string
}

/** Read-only rendering of an excelgrid document. */
export function ExcelGridView({ source, className = '', title }: Props) {
  const clipPrefix = useId().replace(/:/g, '')
  const rootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const working = useMemo(() => toWorking(parseExcelGridDoc(source)), [source])

  const getColumnWidth = (col: number) => working.columnWidths.get(col) || DEFAULT_CELL_WIDTH
  const getRowHeight = (row: number) => working.rowHeights.get(row) || DEFAULT_CELL_HEIGHT
  const getColumnX = (col: number) => {
    let x = DEFAULT_HEADER_WIDTH
    for (let i = 0; i < col; i++) x += getColumnWidth(i)
    return x
  }
  const getRowY = (row: number) => {
    let y = DEFAULT_HEADER_HEIGHT
    for (let i = 0; i < row; i++) y += getRowHeight(i)
    return y
  }

  const totalWidth = useMemo(() => {
    let w = DEFAULT_HEADER_WIDTH
    for (let i = 0; i < working.colCount; i++) w += getColumnWidth(i)
    return w
  }, [working])

  const usedRows = useMemo(() => {
    let max = 0
    working.cells.forEach((c) => {
      if (c.value) max = Math.max(max, c.row + 1)
    })
    return Math.max(1, Math.min(working.rowCount, max + 1))
  }, [working])

  const totalHeight = useMemo(() => {
    let h = DEFAULT_HEADER_HEIGHT
    for (let i = 0; i < usedRows; i++) h += getRowHeight(i)
    return h
  }, [usedRows, working])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const noop = () => undefined
    renderGrid({
      svg,
      theme: readGridTheme(rootRef.current),
      clipPrefix,
      totalWidth,
      totalHeight,
      viewport: { startRow: 0, endRow: usedRows, startCol: 0, endCol: working.colCount },
      gridData: { ...working, rowCount: usedRows },
      headerWidth: DEFAULT_HEADER_WIDTH,
      headerHeight: DEFAULT_HEADER_HEIGHT,
      getColumnX,
      getRowY,
      getColumnWidth,
      getRowHeight,
      selectionType: 'cell',
      selectionRange: null,
      selectedCell: null,
      editingCell: null,
      onColumnHeaderDown: noop,
      onRowHeaderDown: noop,
      onColumnHeaderEnter: noop,
      onRowHeaderEnter: noop,
      onCellMouseDown: noop,
      onCellMouseEnter: noop,
      onCellDblClick: noop,
      onResizeStart: noop,
      onAutoFitColumn: noop,
    })
  }, [clipPrefix, totalHeight, totalWidth, usedRows, working])

  return (
    <div className={`excelgrid-view ${className}`.trim()} ref={rootRef}>
      {title && <div className="excelgrid-view-title muted sm">{title}</div>}
      <div className="excelgrid-surface is-readonly" style={{ maxHeight: 420, overflow: 'auto' }}>
        <svg ref={svgRef} role="img" aria-label={title || 'Spreadsheet'} />
      </div>
    </div>
  )
}
