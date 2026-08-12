import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  clipToTsv,
  copyRange,
  pasteAt,
  readSystemClipboard,
  tsvToClip,
  writeSystemClipboard,
  type GridClipboard,
} from '../excelgrid/clipboard'
import { parseCsv } from '../excelgrid/csv'
import {
  cloneWorking,
  fromWorking,
  parseExcelGridDoc,
  serializeExcelGridDoc,
  toWorking,
  type GridWorking,
} from '../excelgrid/model'
import { readGridTheme, renderGrid } from '../excelgrid/renderGrid'
import {
  DEFAULT_CELL_HEIGHT,
  DEFAULT_CELL_WIDTH,
  DEFAULT_HEADER_HEIGHT,
  DEFAULT_HEADER_WIDTH,
  MAX_COLS,
  MAX_COL_WIDTH,
  MAX_ROW_HEIGHT,
  MAX_ROWS,
  MIN_COL_WIDTH,
  MIN_ROW_HEIGHT,
  getCellKey,
  getColumnLabel,
  inferCellType,
  isInRange,
  mergeFormatting,
  normalizeRange,
  rangeCells,
  type Cell,
  type CellFormatting,
  type SelectionRange,
  type SelectionType,
} from '../excelgrid/types'

type Props = {
  source: string
  onChange: (next: string) => void
  readOnly?: boolean
  compact?: boolean
}

const SURFACE_H = 360
const FONT_SIZES = [10, 11, 12, 14, 16, 18, 20, 24]

/**
 * Excel-style D3 grid stored as a ```excelgrid JSON fence on the page.
 */
export function ExcelGridCanvas({ source, onChange, readOnly, compact }: Props) {
  const clipPrefix = useId().replace(/:/g, '')
  const rootRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const editorRef = useRef<HTMLInputElement>(null)
  const formulaRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const lastClickRef = useRef<{ row: number; col: number; t: number } | null>(null)
  const armedRef = useRef(false)
  const typeSeedRef = useRef(false)
  const ignoreEditorInputUntilRef = useRef(0)
  const emitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renderRaf = useRef<number | null>(null)

  const [working, setWorking] = useState<GridWorking>(() => toWorking(parseExcelGridDoc(source)))
  const workingRef = useRef(working)
  workingRef.current = working

  const [selected, setSelected] = useState<{ row: number; col: number } | null>({ row: 0, col: 0 })
  const [range, setRange] = useState<SelectionRange | null>(null)
  const [selectionType, setSelectionType] = useState<SelectionType>('cell')
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null)
  const [editValue, setEditValue] = useState('')
  const editingRef = useRef(editing)
  const editValueRef = useRef(editValue)
  editingRef.current = editing
  editValueRef.current = editValue
  const [viewport, setViewport] = useState({ startRow: 0, endRow: 24, startCol: 0, endCol: 12 })
  const [resizing, setResizing] = useState<{
    type: 'col' | 'row'
    index: number
    startPos: number
    startSize: number
  } | null>(null)
  const [clipboard, setClipboard] = useState<GridClipboard | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const undoStack = useRef<GridWorking[]>([])
  const redoStack = useRef<GridWorking[]>([])
  const [, bumpHistory] = useState(0)

  useEffect(() => {
    const next = toWorking(parseExcelGridDoc(source))
    const cur = serializeExcelGridDoc(fromWorking(workingRef.current))
    if (serializeExcelGridDoc(fromWorking(next)) !== cur) {
      setWorking(next)
      workingRef.current = next
      undoStack.current = []
      redoStack.current = []
      bumpHistory((n) => n + 1)
    }
  }, [source])

  const emit = useCallback(
    (next: GridWorking) => {
      workingRef.current = next
      setWorking(next)
      if (emitTimer.current) clearTimeout(emitTimer.current)
      emitTimer.current = setTimeout(() => onChange(serializeExcelGridDoc(fromWorking(next))), 200)
    },
    [onChange],
  )

  useEffect(
    () => () => {
      if (emitTimer.current) clearTimeout(emitTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  const pushHistory = useCallback(() => {
    undoStack.current.push(cloneWorking(workingRef.current))
    if (undoStack.current.length > 80) undoStack.current.shift()
    redoStack.current = []
    bumpHistory((n) => n + 1)
  }, [])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(cloneWorking(workingRef.current))
    emit(prev)
    bumpHistory((n) => n + 1)
  }, [emit])

  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(cloneWorking(workingRef.current))
    emit(next)
    bumpHistory((n) => n + 1)
  }, [emit])

  const getColumnWidth = useCallback(
    (col: number) => working.columnWidths.get(col) || DEFAULT_CELL_WIDTH,
    [working.columnWidths],
  )
  const getRowHeight = useCallback(
    (row: number) => working.rowHeights.get(row) || DEFAULT_CELL_HEIGHT,
    [working.rowHeights],
  )
  const getColumnX = useCallback(
    (col: number) => {
      let x = DEFAULT_HEADER_WIDTH
      for (let i = 0; i < col; i++) x += getColumnWidth(i)
      return x
    },
    [getColumnWidth],
  )
  const getRowY = useCallback(
    (row: number) => {
      let y = DEFAULT_HEADER_HEIGHT
      for (let i = 0; i < row; i++) y += getRowHeight(i)
      return y
    },
    [getRowHeight],
  )

  const totalWidth = useMemo(() => {
    let w = DEFAULT_HEADER_WIDTH
    for (let i = 0; i < working.colCount; i++) w += getColumnWidth(i)
    return w
  }, [working.colCount, getColumnWidth])

  const totalHeight = useMemo(() => {
    let h = DEFAULT_HEADER_HEIGHT
    for (let i = 0; i < working.rowCount; i++) h += getRowHeight(i)
    return h
  }, [working.rowCount, getRowHeight])

  const activeRange: SelectionRange | null = range ?? (selected ? { start: selected, end: selected } : null)

  const selectedCells = useMemo(
    () => (activeRange ? rangeCells(activeRange) : []),
    [activeRange],
  )

  const selectedFormatting = useMemo(() => {
    if (!selected) return undefined
    return working.cells.get(getCellKey(selected.row, selected.col))?.formatting
  }, [selected, working.cells])

  const commitEdit = useCallback(
    (move?: { dRow: number; dCol: number }) => {
      const cell = editingRef.current
      if (!cell) return
      const value = editValueRef.current
      editingRef.current = null
      editValueRef.current = ''
      pushHistory()
      const next = cloneWorking(workingRef.current)
      const key = getCellKey(cell.row, cell.col)
      if (value === '') {
        next.cells.delete(key)
      } else {
        const prev = next.cells.get(key)
        next.cells.set(key, {
          row: cell.row,
          col: cell.col,
          value,
          type: inferCellType(value),
          formatting: prev?.formatting,
        })
      }
      emit(next)
      setEditing(null)
      setEditValue('')
      if (move) {
        const row = clamp(cell.row + move.dRow, 0, next.rowCount - 1)
        const col = clamp(cell.col + move.dCol, 0, next.colCount - 1)
        setSelected({ row, col })
        setRange(null)
        setSelectionType('cell')
      }
    },
    [emit, pushHistory],
  )

  const cancelEdit = useCallback(() => {
    editingRef.current = null
    editValueRef.current = ''
    typeSeedRef.current = false
    setEditing(null)
    setEditValue('')
  }, [])

  const beginEdit = useCallback(
    (row: number, col: number, seed?: string) => {
      if (readOnly) return
      const existing = workingRef.current.cells.get(getCellKey(row, col))
      const nextValue = seed !== undefined ? seed : (existing?.value ?? '')
      typeSeedRef.current = seed !== undefined
      if (seed !== undefined) ignoreEditorInputUntilRef.current = performance.now() + 75
      editingRef.current = { row, col }
      editValueRef.current = nextValue
      setEditing({ row, col })
      setEditValue(nextValue)
      setSelected({ row, col })
      setRange(null)
      setSelectionType('cell')
      armedRef.current = true
    },
    [readOnly],
  )

  useLayoutEffect(() => {
    if (!editing) return
    const el = editorRef.current
    if (!el) return
    el.focus()
    if (typeSeedRef.current) {
      const n = el.value.length
      el.setSelectionRange(n, n)
      typeSeedRef.current = false
    } else {
      el.select()
    }
  }, [editing])

  const applyToSelection = useCallback(
    (mutate: (w: GridWorking, row: number, col: number) => void) => {
      const cells = selectedCells
      if (cells.length === 0) return
      pushHistory()
      const next = cloneWorking(workingRef.current)
      for (const { row, col } of cells) mutate(next, row, col)
      emit(next)
    },
    [emit, pushHistory, selectedCells],
  )

  const formatSelection = useCallback(
    (patch: Partial<CellFormatting>) => {
      applyToSelection((w, row, col) => {
        const key = getCellKey(row, col)
        const prev = w.cells.get(key) ?? { row, col, value: '' }
        w.cells.set(key, { ...prev, formatting: mergeFormatting(prev.formatting, patch) })
      })
    },
    [applyToSelection],
  )

  const clearSelection = useCallback(() => {
    applyToSelection((w, row, col) => {
      w.cells.delete(getCellKey(row, col))
    })
  }, [applyToSelection])

  const copy = useCallback(
    async (cut = false) => {
      const clip = copyRange(workingRef.current.cells, selectedCells, cut)
      if (!clip) return
      setClipboard(clip)
      void writeSystemClipboard(clipToTsv(clip))
      if (cut) {
        pushHistory()
        const next = cloneWorking(workingRef.current)
        for (const { row, col } of selectedCells) next.cells.delete(getCellKey(row, col))
        emit(next)
      }
    },
    [emit, pushHistory, selectedCells],
  )

  const paste = useCallback(async () => {
    if (readOnly || !selected) return
    const text = await readSystemClipboard()
    const fromSystem = text ? tsvToClip(text, selected.row, selected.col) : null
    const clip = fromSystem ?? (clipboard ? { ...clipboard, cells: pasteAt(clipboard, selected.row, selected.col) } : null)
    if (!clip) return
    pushHistory()
    const next = cloneWorking(workingRef.current)
    let maxRow = next.rowCount
    let maxCol = next.colCount
    for (const cell of clip.cells) {
      maxRow = Math.max(maxRow, cell.row + 1)
      maxCol = Math.max(maxCol, cell.col + 1)
      const key = getCellKey(cell.row, cell.col)
      if (cell.value === '' && !cell.formatting) next.cells.delete(key)
      else next.cells.set(key, cell)
    }
    next.rowCount = Math.min(MAX_ROWS, maxRow)
    next.colCount = Math.min(MAX_COLS, maxCol)
    emit(next)
    setRange({
      start: { row: selected.row, col: selected.col },
      end: { row: clip.maxRow - clip.minRow + selected.row, col: clip.maxCol - clip.minCol + selected.col },
    })
  }, [clipboard, emit, pushHistory, readOnly, selected])

  const fillDirection = useCallback(
    (dir: 'down' | 'right') => {
      if (!activeRange) return
      const n = normalizeRange(activeRange)
      pushHistory()
      const next = cloneWorking(workingRef.current)
      if (dir === 'down') {
        for (let c = n.minCol; c <= n.maxCol; c++) {
          const src = next.cells.get(getCellKey(n.minRow, c))
          for (let r = n.minRow + 1; r <= n.maxRow; r++) {
            if (src) next.cells.set(getCellKey(r, c), { ...src, row: r, col: c, formatting: src.formatting ? { ...src.formatting } : undefined })
            else next.cells.delete(getCellKey(r, c))
          }
        }
      } else {
        for (let r = n.minRow; r <= n.maxRow; r++) {
          const src = next.cells.get(getCellKey(r, n.minCol))
          for (let c = n.minCol + 1; c <= n.maxCol; c++) {
            if (src) next.cells.set(getCellKey(r, c), { ...src, row: r, col: c, formatting: src.formatting ? { ...src.formatting } : undefined })
            else next.cells.delete(getCellKey(r, c))
          }
        }
      }
      emit(next)
    },
    [activeRange, emit, pushHistory],
  )

  const addRows = useCallback(
    (count = 5) => {
      pushHistory()
      const next = cloneWorking(workingRef.current)
      next.rowCount = Math.min(MAX_ROWS, next.rowCount + count)
      emit(next)
    },
    [emit, pushHistory],
  )

  const addColumns = useCallback(
    (count = 2) => {
      pushHistory()
      const next = cloneWorking(workingRef.current)
      next.colCount = Math.min(MAX_COLS, next.colCount + count)
      emit(next)
    },
    [emit, pushHistory],
  )

  const insertRow = useCallback(
    (at: number) => {
      pushHistory()
      const next = cloneWorking(workingRef.current)
      next.rowCount = Math.min(MAX_ROWS, next.rowCount + 1)
      const shifted = new Map<string, Cell>()
      next.cells.forEach((cell) => {
        const row = cell.row >= at ? cell.row + 1 : cell.row
        shifted.set(getCellKey(row, cell.col), { ...cell, row })
      })
      next.cells = shifted
      const heights = new Map<number, number>()
      next.rowHeights.forEach((h, r) => heights.set(r >= at ? r + 1 : r, h))
      next.rowHeights = heights
      emit(next)
    },
    [emit, pushHistory],
  )

  const insertColumn = useCallback(
    (at: number) => {
      pushHistory()
      const next = cloneWorking(workingRef.current)
      next.colCount = Math.min(MAX_COLS, next.colCount + 1)
      const shifted = new Map<string, Cell>()
      next.cells.forEach((cell) => {
        const col = cell.col >= at ? cell.col + 1 : cell.col
        shifted.set(getCellKey(cell.row, col), { ...cell, col })
      })
      next.cells = shifted
      const widths = new Map<number, number>()
      next.columnWidths.forEach((w, c) => widths.set(c >= at ? c + 1 : c, w))
      next.columnWidths = widths
      emit(next)
    },
    [emit, pushHistory],
  )

  const deleteRows = useCallback(() => {
    if (!activeRange) return
    const n = normalizeRange(activeRange)
    const count = n.maxRow - n.minRow + 1
    if (workingRef.current.rowCount - count < 1) return
    pushHistory()
    const next = cloneWorking(workingRef.current)
    const shifted = new Map<string, Cell>()
    next.cells.forEach((cell) => {
      if (cell.row >= n.minRow && cell.row <= n.maxRow) return
      const row = cell.row > n.maxRow ? cell.row - count : cell.row
      shifted.set(getCellKey(row, cell.col), { ...cell, row })
    })
    next.cells = shifted
    next.rowCount -= count
    emit(next)
    setSelected({ row: Math.min(n.minRow, next.rowCount - 1), col: selected?.col ?? 0 })
    setRange(null)
  }, [activeRange, emit, pushHistory, selected])

  const deleteColumns = useCallback(() => {
    if (!activeRange) return
    const n = normalizeRange(activeRange)
    const count = n.maxCol - n.minCol + 1
    if (workingRef.current.colCount - count < 1) return
    pushHistory()
    const next = cloneWorking(workingRef.current)
    const shifted = new Map<string, Cell>()
    next.cells.forEach((cell) => {
      if (cell.col >= n.minCol && cell.col <= n.maxCol) return
      const col = cell.col > n.maxCol ? cell.col - count : cell.col
      shifted.set(getCellKey(cell.row, col), { ...cell, col })
    })
    next.cells = shifted
    next.colCount -= count
    emit(next)
    setSelected({ row: selected?.row ?? 0, col: Math.min(n.minCol, next.colCount - 1) })
    setRange(null)
  }, [activeRange, emit, pushHistory, selected])

  const importCsvText = useCallback(
    (text: string) => {
      const result = parseCsv(text)
      if (result.cells.size === 0) return
      pushHistory()
      const next = cloneWorking(workingRef.current)
      result.cells.forEach((cell, key) => next.cells.set(key, cell))
      next.rowCount = Math.min(MAX_ROWS, Math.max(next.rowCount, result.rowCount + 2))
      next.colCount = Math.min(MAX_COLS, Math.max(next.colCount, result.colCount + 1))
      emit(next)
    },
    [emit, pushHistory],
  )

  const autoFitColumn = useCallback(
    (col: number) => {
      const w = workingRef.current
      let max = 56
      const header = getColumnLabel(col)
      max = Math.max(max, header.length * 8 + 16)
      for (let r = 0; r < w.rowCount; r++) {
        const cell = w.cells.get(getCellKey(r, col))
        if (!cell?.value) continue
        const size = cell.formatting?.fontSize || 12
        const bold = cell.formatting?.bold ? 1.1 : 1
        max = Math.max(max, cell.value.length * size * 0.62 * bold + 14)
      }
      pushHistory()
      const next = cloneWorking(w)
      next.columnWidths.set(col, Math.min(MAX_COL_WIDTH, Math.round(max)))
      emit(next)
    },
    [emit, pushHistory],
  )

  const selectCell = useCallback((row: number, col: number, ev?: MouseEvent) => {
    setMenu(null)
    armedRef.current = true
    if (ev?.shiftKey && selected) {
      setRange({ start: selected, end: { row, col } })
      setSelectionType('cell')
      return
    }
    setSelected({ row, col })
    setRange({ start: { row, col }, end: { row, col } })
    setSelectionType('cell')
    surfaceRef.current?.focus({ preventScroll: true })
  }, [selected])

  const onColumnHeaderDown = useCallback(
    (col: number, ev: MouseEvent) => {
      if (ev.shiftKey && range) {
        setRange({ start: { row: 0, col: range.start.col }, end: { row: workingRef.current.rowCount - 1, col } })
      } else {
        setSelected({ row: 0, col })
        setRange({ start: { row: 0, col }, end: { row: workingRef.current.rowCount - 1, col } })
      }
      setSelectionType('column')
      if (editingRef.current) commitEdit()
      draggingRef.current = true
      setDragging(true)
    },
    [commitEdit, range],
  )

  const onRowHeaderDown = useCallback(
    (row: number, ev: MouseEvent) => {
      if (ev.shiftKey && range) {
        setRange({ start: { row: range.start.row, col: 0 }, end: { row, col: workingRef.current.colCount - 1 } })
      } else {
        setSelected({ row, col: 0 })
        setRange({ start: { row, col: 0 }, end: { row, col: workingRef.current.colCount - 1 } })
      }
      setSelectionType('row')
      if (editingRef.current) commitEdit()
      draggingRef.current = true
      setDragging(true)
    },
    [commitEdit, range],
  )

  const onCellMouseDown = useCallback(
    (row: number, col: number, ev: MouseEvent) => {
      if (ev.button === 2) {
        if (!isInRange(row, col, activeRange)) {
          setSelected({ row, col })
          setRange({ start: { row, col }, end: { row, col } })
          setSelectionType('cell')
        }
        return
      }

      const now = performance.now()
      const last = lastClickRef.current
      // Selection redraws replace the SVG node, so the browser never fires
      // `dblclick`. Treat two mousedowns on the same cell as one.
      if (last && last.row === row && last.col === col && now - last.t < 450) {
        lastClickRef.current = null
        if (editingRef.current && (editingRef.current.row !== row || editingRef.current.col !== col)) {
          commitEdit()
        }
        beginEdit(row, col)
        return
      }
      lastClickRef.current = { row, col, t: now }

      if (editingRef.current && (editingRef.current.row !== row || editingRef.current.col !== col)) {
        commitEdit()
      }
      selectCell(row, col, ev)
      draggingRef.current = true
      setDragging(true)
    },
    [activeRange, beginEdit, commitEdit, selectCell],
  )

  const onCellMouseEnter = useCallback(
    (row: number, col: number) => {
      if (!draggingRef.current || !selected) return
      if (selectionType === 'column') {
        setRange({ start: { row: 0, col: selected.col }, end: { row: workingRef.current.rowCount - 1, col } })
        return
      }
      if (selectionType === 'row') {
        setRange({ start: { row: selected.row, col: 0 }, end: { row, col: workingRef.current.colCount - 1 } })
        return
      }
      setRange({ start: selected, end: { row, col } })
    },
    [selected, selectionType],
  )

  useEffect(() => {
    if (!dragging) return
    const up = () => {
      draggingRef.current = false
      setDragging(false)
    }
    document.addEventListener('mouseup', up)
    return () => document.removeEventListener('mouseup', up)
  }, [dragging])

  useEffect(() => {
    if (!resizing) return
    const move = (e: MouseEvent) => {
      if (resizing.type === 'col') {
        const width = clamp(resizing.startSize + (e.clientX - resizing.startPos), MIN_COL_WIDTH, MAX_COL_WIDTH)
        setWorking((prev) => {
          const next = { ...prev, columnWidths: new Map(prev.columnWidths) }
          next.columnWidths.set(resizing.index, width)
          workingRef.current = next
          return next
        })
      } else {
        const height = clamp(resizing.startSize + (e.clientY - resizing.startPos), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT)
        setWorking((prev) => {
          const next = { ...prev, rowHeights: new Map(prev.rowHeights) }
          next.rowHeights.set(resizing.index, height)
          workingRef.current = next
          return next
        })
      }
    }
    const up = () => {
      setResizing(null)
      emit(cloneWorking(workingRef.current))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
  }, [emit, resizing])

  const updateViewport = useCallback(() => {
    const el = surfaceRef.current
    if (!el) return
    const w = workingRef.current
    const scrollLeft = el.scrollLeft
    const scrollTop = el.scrollTop
    const viewW = el.clientWidth
    const viewH = el.clientHeight

    let x = 0
    let startCol = 0
    for (let c = 0; c < w.colCount; c++) {
      const cw = w.columnWidths.get(c) || DEFAULT_CELL_WIDTH
      if (x + cw >= scrollLeft) {
        startCol = Math.max(0, c - 1)
        break
      }
      x += cw
      startCol = c
    }
    let endCol = startCol
    let acc = 0
    for (let c = startCol; c < w.colCount && acc < viewW + 200; c++) {
      acc += w.columnWidths.get(c) || DEFAULT_CELL_WIDTH
      endCol = c + 2
    }

    let y = 0
    let startRow = 0
    for (let r = 0; r < w.rowCount; r++) {
      const rh = w.rowHeights.get(r) || DEFAULT_CELL_HEIGHT
      if (y + rh >= scrollTop) {
        startRow = Math.max(0, r - 1)
        break
      }
      y += rh
      startRow = r
    }
    let endRow = startRow
    acc = 0
    for (let r = startRow; r < w.rowCount && acc < viewH + 160; r++) {
      acc += w.rowHeights.get(r) || DEFAULT_CELL_HEIGHT
      endRow = r + 3
    }

    setViewport({
      startRow,
      endRow: Math.min(w.rowCount, endRow),
      startCol,
      endCol: Math.min(w.colCount, endCol),
    })
  }, [])

  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const onScroll = () => {
      if (renderRaf.current != null) cancelAnimationFrame(renderRaf.current)
      renderRaf.current = requestAnimationFrame(updateViewport)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    updateViewport()
    const ro = new ResizeObserver(updateViewport)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (renderRaf.current != null) cancelAnimationFrame(renderRaf.current)
    }
  }, [updateViewport, working.rowCount, working.colCount])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    renderGrid({
      svg,
      theme: readGridTheme(rootRef.current),
      clipPrefix,
      totalWidth,
      totalHeight,
      viewport,
      gridData: working,
      headerWidth: DEFAULT_HEADER_WIDTH,
      headerHeight: DEFAULT_HEADER_HEIGHT,
      getColumnX,
      getRowY,
      getColumnWidth,
      getRowHeight,
      selectionType,
      selectionRange: activeRange,
      selectedCell: selected,
      editingCell: editing,
      onColumnHeaderDown,
      onRowHeaderDown,
      onColumnHeaderEnter: (col) => onCellMouseEnter(0, col),
      onRowHeaderEnter: (row) => onCellMouseEnter(row, 0),
      onCellMouseDown,
      onCellMouseEnter,
      onCellDblClick: (row, col) => beginEdit(row, col),
      onResizeStart: (type, index, startPos, startSize) => {
        pushHistory()
        setResizing({ type, index, startPos, startSize })
      },
      onAutoFitColumn: autoFitColumn,
    })
  }, [
    activeRange,
    autoFitColumn,
    beginEdit,
    clipPrefix,
    editing,
    getColumnWidth,
    getColumnX,
    getRowHeight,
    getRowY,
    onCellMouseDown,
    onCellMouseEnter,
    onColumnHeaderDown,
    onRowHeaderDown,
    pushHistory,
    selected,
    selectionType,
    totalHeight,
    totalWidth,
    viewport,
    working,
  ])

  const moveSelection = useCallback(
    (dRow: number, dCol: number, extend: boolean) => {
      if (!selected) {
        setSelected({ row: 0, col: 0 })
        return
      }
      const row = clamp(selected.row + dRow, 0, working.rowCount - 1)
      const col = clamp(selected.col + dCol, 0, working.colCount - 1)
      if (extend) {
        setRange({ start: range?.start ?? selected, end: { row, col } })
        setSelected({ row, col })
      } else {
        setSelected({ row, col })
        setRange({ start: { row, col }, end: { row, col } })
        setSelectionType('cell')
      }
    },
    [range, selected, working.colCount, working.rowCount],
  )

  const handleGridKey = useCallback((e: {
    key: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    shiftKey: boolean
    preventDefault: () => void
  }) => {
    if (editingRef.current) return
    const meta = e.ctrlKey || e.metaKey
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (meta && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (meta && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      void copy(false)
      return
    }
    if (meta && e.key.toLowerCase() === 'x') {
      e.preventDefault()
      void copy(true)
      return
    }
    if (meta && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      void paste()
      return
    }
    if (meta && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      formatSelection({ bold: !selectedFormatting?.bold })
      return
    }
    if (meta && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      formatSelection({ italic: !selectedFormatting?.italic })
      return
    }
    if (meta && e.key.toLowerCase() === 'u') {
      e.preventDefault()
      formatSelection({ underline: !selectedFormatting?.underline })
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      clearSelection()
      return
    }
    if (e.key === 'F2' && selected) {
      e.preventDefault()
      beginEdit(selected.row, selected.col)
      return
    }
    if (e.key === 'Enter' && selected) {
      e.preventDefault()
      if (e.shiftKey) moveSelection(-1, 0, false)
      else beginEdit(selected.row, selected.col)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      moveSelection(0, e.shiftKey ? -1 : 1, false)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(-1, 0, e.shiftKey)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSelection(1, 0, e.shiftKey)
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      moveSelection(0, -1, e.shiftKey)
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      moveSelection(0, 1, e.shiftKey)
      return
    }
    if (e.key.length === 1 && !meta && !e.altKey && selected && !readOnly) {
      e.preventDefault()
      beginEdit(selected.row, selected.col, e.key)
    }
  }, [
    beginEdit,
    clearSelection,
    copy,
    formatSelection,
    moveSelection,
    paste,
    readOnly,
    redo,
    selected,
    selectedFormatting?.bold,
    selectedFormatting?.italic,
    selectedFormatting?.underline,
    undo,
  ])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current
      const inside = !!(root && root.contains(e.target as Node))
      armedRef.current = inside
      if (!inside && editingRef.current) commitEdit()
    }
    const onDocKey = (e: KeyboardEvent) => {
      if (!armedRef.current) return
      if (editingRef.current) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          if (target === editorRef.current || target === formulaRef.current) return
          return
        }
      }
      handleGridKey(e)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onDocKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onDocKey)
    }
  }, [commitEdit, handleGridKey])

  const onEditorKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit({ dRow: e.shiftKey ? -1 : 1, dCol: 0 })
      surfaceRef.current?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit({ dRow: 0, dCol: e.shiftKey ? -1 : 1 })
      surfaceRef.current?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
      surfaceRef.current?.focus()
    }
  }

  const onContextMenu = (e: ReactMouseEvent) => {
    if (readOnly) return
    e.preventDefault()
    const rect = rootRef.current?.getBoundingClientRect()
    setMenu({
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    })
  }

  const addr = selected ? `${getColumnLabel(selected.col)}${selected.row + 1}` : '—'
  const formula = selected ? (working.cells.get(getCellKey(selected.row, selected.col))?.value ?? '') : ''

  if (readOnly) {
    return (
      <div className="excelgrid is-readonly" ref={rootRef}>
        <div className="excelgrid-surface" style={{ height: Math.min(SURFACE_H, totalHeight + 2) }}>
          <div className="excelgrid-sheet" style={{ width: totalWidth, height: totalHeight }}>
            <svg ref={svgRef} role="img" aria-label="Spreadsheet" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`excelgrid${compact ? ' is-compact' : ''}`}
      ref={rootRef}
      onContextMenu={onContextMenu}
    >
      <div className="excelgrid-toolbar" role="toolbar" aria-label="Spreadsheet tools">
        <div className="excelgrid-toolbar-group">
          <button type="button" className="excelgrid-tool" disabled={!undoStack.current.length} onClick={undo} title="Undo">
            Undo
          </button>
          <button type="button" className="excelgrid-tool" disabled={!redoStack.current.length} onClick={redo} title="Redo">
            Redo
          </button>
        </div>
        <div className="excelgrid-toolbar-group">
          <button type="button" className="excelgrid-tool" onClick={() => void copy(true)} title="Cut">
            Cut
          </button>
          <button type="button" className="excelgrid-tool" onClick={() => void copy(false)} title="Copy">
            Copy
          </button>
          <button type="button" className="excelgrid-tool" onClick={() => void paste()} title="Paste">
            Paste
          </button>
          <button type="button" className="excelgrid-tool" onClick={() => fillDirection('down')} title="Fill down">
            ↓
          </button>
          <button type="button" className="excelgrid-tool" onClick={() => fillDirection('right')} title="Fill right">
            →
          </button>
        </div>
        <div className="excelgrid-toolbar-group">
          <button
            type="button"
            className={`excelgrid-tool${selectedFormatting?.bold ? ' is-active' : ''}`}
            onClick={() => formatSelection({ bold: !selectedFormatting?.bold })}
            title="Bold"
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className={`excelgrid-tool${selectedFormatting?.italic ? ' is-active' : ''}`}
            onClick={() => formatSelection({ italic: !selectedFormatting?.italic })}
            title="Italic"
          >
            <em>I</em>
          </button>
          <button
            type="button"
            className={`excelgrid-tool${selectedFormatting?.underline ? ' is-active' : ''}`}
            onClick={() => formatSelection({ underline: !selectedFormatting?.underline })}
            title="Underline"
          >
            <span style={{ textDecoration: 'underline' }}>U</span>
          </button>
          <button
            type="button"
            className={`excelgrid-tool${selectedFormatting?.textAlign === 'left' ? ' is-active' : ''}`}
            onClick={() => formatSelection({ textAlign: 'left' })}
            title="Align left"
          >
            ⇤
          </button>
          <button
            type="button"
            className={`excelgrid-tool${selectedFormatting?.textAlign === 'center' ? ' is-active' : ''}`}
            onClick={() => formatSelection({ textAlign: 'center' })}
            title="Align center"
          >
            ≡
          </button>
          <button
            type="button"
            className={`excelgrid-tool${selectedFormatting?.textAlign === 'right' ? ' is-active' : ''}`}
            onClick={() => formatSelection({ textAlign: 'right' })}
            title="Align right"
          >
            ⇥
          </button>
          <label className="excelgrid-color" title="Text colour">
            A
            <input
              type="color"
              value={selectedFormatting?.textColor || '#1a1814'}
              onChange={(e) => formatSelection({ textColor: e.target.value })}
            />
          </label>
          <label className="excelgrid-color" title="Fill colour">
            ▣
            <input
              type="color"
              value={selectedFormatting?.fillColor || '#ffffff'}
              onChange={(e) => formatSelection({ fillColor: e.target.value })}
            />
          </label>
          <select
            className="excelgrid-select"
            aria-label="Font size"
            value={selectedFormatting?.fontSize ?? 12}
            onChange={(e) => formatSelection({ fontSize: Number(e.target.value) })}
          >
            {FONT_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="excelgrid-toolbar-group excelgrid-toolbar-group--end">
          <button type="button" className="excelgrid-tool" onClick={() => addRows(5)} title="Add 5 rows">
            + Rows
          </button>
          <button type="button" className="excelgrid-tool" onClick={() => addColumns(2)} title="Add 2 columns">
            + Cols
          </button>
          <button type="button" className="excelgrid-tool" onClick={() => fileRef.current?.click()} title="Import CSV">
            CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              void file.text().then(importCsvText)
            }}
          />
        </div>
      </div>

      <div className="excelgrid-formula">
        <span className="excelgrid-addr" title="Active cell">
          {addr}
        </span>
        <input
          ref={formulaRef}
          className="excelgrid-formula-input"
          value={editing ? editValue : formula}
          readOnly={!selected}
          aria-label="Cell value"
          onFocus={() => {
            armedRef.current = true
            if (selected && !editingRef.current) {
              const existing = workingRef.current.cells.get(getCellKey(selected.row, selected.col))
              const next = existing?.value ?? ''
              editingRef.current = selected
              editValueRef.current = next
              setEditing(selected)
              setEditValue(next)
            }
          }}
          onChange={(e) => {
            editValueRef.current = e.target.value
            setEditValue(e.target.value)
          }}
          onKeyDown={onEditorKeyDown}
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null
            if (next === editorRef.current || next === formulaRef.current) return
            window.setTimeout(() => {
              if (!editingRef.current) return
              if (document.activeElement === editorRef.current || document.activeElement === formulaRef.current) return
              commitEdit()
            }, 0)
          }}
        />
      </div>

      <div
        className="excelgrid-surface"
        ref={surfaceRef}
        tabIndex={0}
        role="grid"
        aria-label="Spreadsheet"
        onFocus={() => {
          armedRef.current = true
        }}
        onKeyDown={handleGridKey}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          const file = [...e.dataTransfer.files].find((f) => /\.(csv|tsv)$/i.test(f.name) || /csv|tab-separated/.test(f.type))
          if (!file) return
          e.preventDefault()
          e.stopPropagation()
          void file.text().then(importCsvText)
        }}
        style={{ height: compact ? 320 : SURFACE_H }}
      >
        <div className="excelgrid-sheet" style={{ width: totalWidth, height: totalHeight }}>
          <svg ref={svgRef} role="presentation" />
          <input
            ref={editorRef}
            className={`excelgrid-editor${editing ? '' : ' is-idle'}`}
            value={editing ? editValue : ''}
            tabIndex={editing ? 0 : -1}
            aria-hidden={!editing}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (performance.now() < ignoreEditorInputUntilRef.current) return
              editValueRef.current = e.target.value
              setEditValue(e.target.value)
            }}
            onKeyDown={onEditorKeyDown}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null
              if (next === editorRef.current || next === formulaRef.current) return
              window.setTimeout(() => {
                if (!editingRef.current) return
                if (document.activeElement === editorRef.current || document.activeElement === formulaRef.current) {
                  return
                }
                commitEdit()
              }, 0)
            }}
            style={
              editing
                ? {
                    left: getColumnX(editing.col),
                    top: getRowY(editing.row),
                    width: getColumnWidth(editing.col),
                    height: getRowHeight(editing.row),
                  }
                : undefined
            }
          />
        </div>
      </div>

      <p className="excelgrid-hint muted sm">
        Double-click or type to edit · drag to select · drop a CSV to import · {working.rowCount}×{working.colCount}
      </p>

      {menu && (
        <div
          className="excelgrid-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => { void copy(true); setMenu(null) }}>Cut</button>
          <button type="button" onClick={() => { void copy(false); setMenu(null) }}>Copy</button>
          <button type="button" onClick={() => { void paste(); setMenu(null) }}>Paste</button>
          <button type="button" onClick={() => { clearSelection(); setMenu(null) }}>Clear</button>
          <hr />
          <button
            type="button"
            onClick={() => {
              insertRow(selected?.row ?? 0)
              setMenu(null)
            }}
          >
            Insert row
          </button>
          <button
            type="button"
            onClick={() => {
              insertColumn(selected?.col ?? 0)
              setMenu(null)
            }}
          >
            Insert column
          </button>
          <button
            type="button"
            onClick={() => {
              deleteRows()
              setMenu(null)
            }}
          >
            Delete row(s)
          </button>
          <button
            type="button"
            onClick={() => {
              deleteColumns()
              setMenu(null)
            }}
          >
            Delete column(s)
          </button>
        </div>
      )}
    </div>
  )
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
