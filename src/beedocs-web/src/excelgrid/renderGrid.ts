import * as d3 from 'd3'
import type { CellFormatting, GridData, SelectionRange, SelectionType } from './types'
import { formatCellDisplay, getCellKey, getColumnLabel as defaultGetColumnLabel, isInRange } from './types'

export type GridTheme = {
  text: string
  muted: string
  border: string
  headerFill: string
  headerSelected: string
  cellFill: string
  cellSelected: string
  rangeFill: string
  cornerFill: string
  handle: string
  font: string
}

export type Viewport = {
  startRow: number
  endRow: number
  startCol: number
  endCol: number
}

export type RenderGridParams = {
  svg: SVGSVGElement
  theme: GridTheme
  clipPrefix: string
  totalWidth: number
  totalHeight: number
  viewport: Viewport
  gridData: GridData
  headerWidth: number
  headerHeight: number
  getColumnX: (col: number) => number
  getRowY: (row: number) => number
  getColumnWidth: (col: number) => number
  getRowHeight: (row: number) => number
  selectionType: SelectionType
  selectionRange: SelectionRange | null
  selectedCell: { row: number; col: number } | null
  editingCell: { row: number; col: number } | null
  onColumnHeaderDown: (col: number, ev: MouseEvent) => void
  onRowHeaderDown: (row: number, ev: MouseEvent) => void
  onColumnHeaderEnter: (col: number) => void
  onRowHeaderEnter: (row: number) => void
  onCellMouseDown: (row: number, col: number, ev: MouseEvent) => void
  onCellMouseEnter: (row: number, col: number) => void
  onCellDblClick: (row: number, col: number) => void
  onResizeStart: (kind: 'col' | 'row', index: number, startPos: number, startSize: number) => void
  onAutoFitColumn: (col: number) => void
}

export function readGridTheme(el: Element | null): GridTheme {
  const s = el ? getComputedStyle(el) : null
  const v = (name: string, fallback: string) => (s?.getPropertyValue(name).trim() || fallback)
  const accent = v('--accent', '#c9920a')
  const cell = v('--bg-elevated', '#fffcf6')
  return {
    text: v('--text', '#1a1814'),
    muted: v('--muted', '#5f584c'),
    border: v('--border', '#d4ccbb'),
    headerFill: v('--bg-soft', '#e9e3d6'),
    headerSelected: mix(accent, cell, 0.28),
    cellFill: cell,
    cellSelected: mix(accent, cell, 0.18),
    rangeFill: mix(accent, cell, 0.32),
    cornerFill: v('--bg-pane', '#faf7f0'),
    handle: accent,
    font: v('--font', 'IBM Plex Sans, Segoe UI, system-ui, sans-serif'),
  }
}

export function renderGrid(p: RenderGridParams): void {
  const svg = d3.select(p.svg)
  svg.selectAll('*').remove()
  svg.attr('width', p.totalWidth).attr('height', p.totalHeight)

  const defs = svg.append('defs')
  const g = svg.append('g').attr('class', 'excelgrid-main')

  const visibleCols = d3.range(p.viewport.startCol, Math.min(p.viewport.endCol, p.gridData.colCount))
  const visibleRows = d3.range(p.viewport.startRow, Math.min(p.viewport.endRow, p.gridData.rowCount))

  const colSelected = (col: number) =>
    p.selectionType === 'column' && p.selectionRange != null && colInRange(col, p.selectionRange)
  const rowSelected = (row: number) =>
    p.selectionType === 'row' && p.selectionRange != null && rowInRange(row, p.selectionRange)

  const colHeaders = g
    .selectAll('.col-header')
    .data(visibleCols)
    .enter()
    .append('g')
    .attr('class', 'col-header')
    .attr('transform', (d) => `translate(${p.getColumnX(d)}, 0)`)

  colHeaders
    .append('rect')
    .attr('width', (d) => p.getColumnWidth(d))
    .attr('height', p.headerHeight)
    .attr('fill', (d) => (colSelected(d) ? p.theme.headerSelected : p.theme.headerFill))
    .attr('stroke', p.theme.border)
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('mousedown', (event: MouseEvent, d) => {
      event.preventDefault()
      event.stopPropagation()
      p.onColumnHeaderDown(d, event)
    })
    .on('mouseenter', (_event, d) => p.onColumnHeaderEnter(d))

  colHeaders
    .append('text')
    .attr('x', (d) => p.getColumnWidth(d) / 2)
    .attr('y', p.headerHeight / 2)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('font-size', '11px')
    .attr('font-weight', 600)
    .attr('font-family', p.theme.font)
    .attr('fill', p.theme.muted)
    .style('pointer-events', 'none')
    .text((d) => defaultGetColumnLabel(d))

  colHeaders
    .append('rect')
    .attr('class', 'col-resize-handle')
    .attr('x', (d) => p.getColumnWidth(d) - 4)
    .attr('y', 0)
    .attr('width', 8)
    .attr('height', p.headerHeight)
    .attr('fill', 'transparent')
    .style('cursor', 'col-resize')
    .on('mouseenter', function () {
      d3.select(this).attr('fill', p.theme.handle)
      d3.select(this).attr('fill-opacity', 0.35)
    })
    .on('mouseleave', function () {
      d3.select(this).attr('fill', 'transparent').attr('fill-opacity', 1)
    })
    .on('dblclick', (event: MouseEvent, d) => {
      event.stopPropagation()
      p.onAutoFitColumn(d)
    })
    .on('mousedown', (event: MouseEvent, d) => {
      event.preventDefault()
      event.stopPropagation()
      p.onResizeStart('col', d, event.clientX, p.getColumnWidth(d))
    })

  const rowHeaders = g
    .selectAll('.row-header')
    .data(visibleRows)
    .enter()
    .append('g')
    .attr('class', 'row-header')
    .attr('transform', (d) => `translate(0, ${p.getRowY(d)})`)

  rowHeaders
    .append('rect')
    .attr('width', p.headerWidth)
    .attr('height', (d) => p.getRowHeight(d))
    .attr('fill', (d) => (rowSelected(d) ? p.theme.headerSelected : p.theme.headerFill))
    .attr('stroke', p.theme.border)
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('mousedown', (event: MouseEvent, d) => {
      event.preventDefault()
      event.stopPropagation()
      p.onRowHeaderDown(d, event)
    })
    .on('mouseenter', (_event, d) => p.onRowHeaderEnter(d))

  rowHeaders
    .append('text')
    .attr('x', p.headerWidth / 2)
    .attr('y', (d) => p.getRowHeight(d) / 2)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('font-size', '11px')
    .attr('font-weight', 600)
    .attr('font-family', p.theme.font)
    .attr('fill', p.theme.muted)
    .style('pointer-events', 'none')
    .text((d) => d + 1)

  rowHeaders
    .append('rect')
    .attr('class', 'row-resize-handle')
    .attr('x', 0)
    .attr('y', (d) => p.getRowHeight(d) - 4)
    .attr('width', p.headerWidth)
    .attr('height', 8)
    .attr('fill', 'transparent')
    .style('cursor', 'row-resize')
    .on('mouseenter', function () {
      d3.select(this).attr('fill', p.theme.handle).attr('fill-opacity', 0.35)
    })
    .on('mouseleave', function () {
      d3.select(this).attr('fill', 'transparent').attr('fill-opacity', 1)
    })
    .on('mousedown', (event: MouseEvent, d) => {
      event.preventDefault()
      event.stopPropagation()
      p.onResizeStart('row', d, event.clientY, p.getRowHeight(d))
    })

  const rows = g
    .selectAll('.row')
    .data(visibleRows)
    .enter()
    .append('g')
    .attr('class', 'row')
    .attr('transform', (d) => `translate(${p.headerWidth}, ${p.getRowY(d)})`)

  rows
    .selectAll('.cell')
    .data((row) => visibleCols.map((col) => ({ row, col, key: getCellKey(row, col) })))
    .enter()
    .append('g')
    .attr('class', 'cell')
    .attr('transform', (d) => `translate(${p.getColumnX(d.col) - p.headerWidth}, 0)`)
    .each(function (d) {
      const group = d3.select(this)
      const cell = p.gridData.cells.get(d.key)
      const isEditing = p.editingCell?.row === d.row && p.editingCell?.col === d.col
      const isActive = p.selectedCell?.row === d.row && p.selectedCell?.col === d.col
      const inRange = isInRange(d.row, d.col, p.selectionRange)
      const colW = p.getColumnWidth(d.col)
      const rowH = p.getRowHeight(d.row)
      const formatting = cell?.formatting as CellFormatting | undefined

      let fill = formatting?.fillColor || p.theme.cellFill
      if (inRange && !isActive) fill = p.theme.rangeFill
      else if (isActive) fill = formatting?.fillColor || p.theme.cellSelected

      group
        .append('rect')
        .attr('width', colW)
        .attr('height', rowH)
        .attr('fill', fill)
        .attr('stroke', isActive || inRange ? p.theme.handle : p.theme.border)
        .attr('stroke-width', isActive ? 2 : 1)
        .style('cursor', 'cell')

      drawCellBorders(group, formatting, colW, rowH)

      if (cell && !isEditing && cell.value) {
        const clipId = `${p.clipPrefix}-${d.row}-${d.col}`
        defs
          .append('clipPath')
          .attr('id', clipId)
          .append('rect')
          .attr('x', 0)
          .attr('y', 0)
          .attr('width', colW)
          .attr('height', rowH)

        const align = formatting?.textAlign || 'left'
        const pad = 6
        const textX = align === 'center' ? colW / 2 : align === 'right' ? colW - pad : pad
        const textAnchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'

        const text = group
          .append('g')
          .attr('clip-path', `url(#${clipId})`)
          .append('text')
          .attr('x', textX)
          .attr('y', rowH / 2)
          .attr('text-anchor', textAnchor)
          .attr('dominant-baseline', 'middle')
          .attr('font-size', `${formatting?.fontSize ?? 12}px`)
          .attr('font-family', formatting?.fontFamily || p.theme.font)
          .attr('font-weight', formatting?.bold ? 700 : 400)
          .attr('font-style', formatting?.italic ? 'italic' : 'normal')
          .attr('fill', formatting?.textColor || p.theme.text)
          .text(formatCellDisplay(cell))
          .style('pointer-events', 'none')

        if (formatting?.underline) text.attr('text-decoration', 'underline')
      }

      group
        .on('mousedown', (event: MouseEvent) => {
          event.preventDefault()
          p.onCellMouseDown(d.row, d.col, event)
        })
        .on('mouseenter', () => p.onCellMouseEnter(d.row, d.col))
        .on('dblclick', (event: MouseEvent) => {
          event.preventDefault()
          p.onCellDblClick(d.row, d.col)
        })
    })

  g.append('rect')
    .attr('width', p.headerWidth)
    .attr('height', p.headerHeight)
    .attr('fill', p.theme.cornerFill)
    .attr('stroke', p.theme.border)
    .attr('stroke-width', 1)
}

// D3's Selection generics do not accept a wider parent type — keep this untyped.
function drawCellBorders(
  group: { append: (name: string) => any },
  formatting: CellFormatting | undefined,
  w: number,
  h: number,
) {
  const b = formatting?.borderStyle
  if (!b) return
  const line = (x1: number, y1: number, x2: number, y2: number, side?: { width: number; color: string; style: string }) => {
    if (!side) return
    group
      .append('line')
      .attr('x1', x1)
      .attr('y1', y1)
      .attr('x2', x2)
      .attr('y2', y2)
      .attr('stroke', side.color)
      .attr('stroke-width', side.width)
      .attr('stroke-dasharray', side.style === 'dashed' ? '4 2' : side.style === 'dotted' ? '1 2' : null)
      .style('pointer-events', 'none')
  }
  line(0, 0, w, 0, b.top)
  line(w, 0, w, h, b.right)
  line(0, h, w, h, b.bottom)
  line(0, 0, 0, h, b.left)
}

function colInRange(col: number, range: SelectionRange): boolean {
  const a = Math.min(range.start.col, range.end.col)
  const b = Math.max(range.start.col, range.end.col)
  return col >= a && col <= b
}

function rowInRange(row: number, range: SelectionRange): boolean {
  const a = Math.min(range.start.row, range.end.row)
  const b = Math.max(range.start.row, range.end.row)
  return row >= a && row <= b
}

function mix(a: string, b: string, t: number): string {
  const pa = parseColor(a)
  const pb = parseColor(b)
  if (!pa || !pb) return a
  const m = (x: number, y: number) => Math.round(x * t + y * (1 - t))
  return `rgb(${m(pa[0], pb[0])}, ${m(pa[1], pb[1])}, ${m(pa[2], pb[2])})`
}

function parseColor(input: string): [number, number, number] | null {
  const hex = input.trim()
  if (hex.startsWith('#') && (hex.length === 7 || hex.length === 4)) {
    const full =
      hex.length === 4
        ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
        : hex
    const n = Number.parseInt(full.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = hex.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}
