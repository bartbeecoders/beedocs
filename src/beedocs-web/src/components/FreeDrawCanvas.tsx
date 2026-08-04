import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  eraseStrokes,
  freeDrawUid,
  parseFreeDrawDoc,
  serializeFreeDrawDoc,
  simplifyPoints,
  strokePathD,
  type FreeDrawDoc,
  type FreeDrawPoint,
  type FreeDrawStroke,
  type FreeDrawTool,
} from '../freedraw/model'
import { FreeDrawSvg } from './FreeDrawView'

const PEN_COLORS = [
  '#141a21',
  '#b42318',
  '#b54708',
  '#027a48',
  '#175cd3',
  '#6941c6',
  '#c11574',
  '#ffffff',
]

const SIZES = [2, 4, 8, 14, 22]

type Props = {
  source: string
  onChange: (source: string) => void
  readOnly?: boolean
  /** Compact chrome for dense page layouts */
  compact?: boolean
}

/**
 * Fully interactive free-draw sketch pad.
 * Document is JSON stored in a ```freedraw fence on the page.
 */
export function FreeDrawCanvas({ source, onChange, readOnly, compact }: Props) {
  const [doc, setDoc] = useState<FreeDrawDoc>(() => parseFreeDrawDoc(source))
  const docRef = useRef(doc)
  docRef.current = doc

  const [tool, setTool] = useState<FreeDrawTool>('pen')
  const [color, setColor] = useState('#141a21')
  const [size, setSize] = useState(4)
  const [draft, setDraft] = useState<FreeDrawStroke | null>(null)
  const drawingRef = useRef(false)
  const pointsRef = useRef<FreeDrawPoint[]>([])

  const undoStack = useRef<FreeDrawDoc[]>([])
  const redoStack = useRef<FreeDrawDoc[]>([])
  const [, bumpHistory] = useState(0)

  const svgRef = useRef<SVGSVGElement>(null)
  const emitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // External source wins when it changes from outside (e.g. undo of page, reload).
  useEffect(() => {
    const next = parseFreeDrawDoc(source)
    const cur = serializeFreeDrawDoc(docRef.current)
    if (serializeFreeDrawDoc(next) !== cur) {
      setDoc(next)
      docRef.current = next
      undoStack.current = []
      redoStack.current = []
      bumpHistory((n) => n + 1)
    }
  }, [source])

  const emit = useCallback(
    (next: FreeDrawDoc) => {
      docRef.current = next
      setDoc(next)
      if (emitTimer.current) clearTimeout(emitTimer.current)
      emitTimer.current = setTimeout(() => {
        onChange(serializeFreeDrawDoc(next))
      }, 200)
    },
    [onChange],
  )

  useEffect(
    () => () => {
      if (emitTimer.current) clearTimeout(emitTimer.current)
    },
    [],
  )

  const pushHistory = useCallback(() => {
    undoStack.current.push(structuredClone(docRef.current))
    if (undoStack.current.length > 80) undoStack.current.shift()
    redoStack.current = []
    bumpHistory((n) => n + 1)
  }, [])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(structuredClone(docRef.current))
    emit(prev)
    bumpHistory((n) => n + 1)
  }, [emit])

  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(structuredClone(docRef.current))
    emit(next)
    bumpHistory((n) => n + 1)
  }, [emit])

  const clearAll = useCallback(() => {
    if (docRef.current.strokes.length === 0) return
    if (!window.confirm('Clear this sketch?')) return
    pushHistory()
    emit({ ...docRef.current, strokes: [] })
  }, [emit, pushHistory])

  const clientToLocal = useCallback((clientX: number, clientY: number): FreeDrawPoint | null => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const local = pt.matrixTransform(ctm.inverse())
    const d = docRef.current
    return {
      x: Math.max(0, Math.min(d.width, local.x)),
      y: Math.max(0, Math.min(d.height, local.y)),
    }
  }, [])

  const onPointerDown = (e: ReactPointerEvent) => {
    if (readOnly || e.button !== 0) return
    const p = clientToLocal(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drawingRef.current = true
    pointsRef.current = [p]
    pushHistory()
    const stroke: FreeDrawStroke = {
      id: freeDrawUid(),
      tool,
      color: tool === 'eraser' ? docRef.current.background : color,
      size: tool === 'eraser' ? Math.max(size * 2.2, 12) : size,
      points: [p],
    }
    setDraft(stroke)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drawingRef.current) return
    const p = clientToLocal(e.clientX, e.clientY)
    if (!p) return
    const pts = pointsRef.current
    const last = pts[pts.length - 1]
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.8) return
    pts.push(p)
    setDraft((d) => (d ? { ...d, points: [...pts] } : d))
  }

  const finishStroke = useCallback(() => {
    if (!drawingRef.current) return
    drawingRef.current = false
    const pts = simplifyPoints(pointsRef.current, 1.2)
    pointsRef.current = []
    setDraft(null)
    if (pts.length === 0) {
      // Empty gesture — drop the history snapshot we pushed
      undoStack.current.pop()
      return
    }

    if (tool === 'eraser') {
      const eraserSize = Math.max(size * 2.2, 12)
      const nextStrokes = eraseStrokes(docRef.current.strokes, pts, eraserSize)
      emit({ ...docRef.current, strokes: nextStrokes })
      return
    }

    const stroke: FreeDrawStroke = {
      id: freeDrawUid(),
      tool: 'pen',
      color,
      size,
      points: pts,
    }
    emit({ ...docRef.current, strokes: [...docRef.current.strokes, stroke] })
  }, [color, emit, size, tool])

  const onPointerUp = () => finishStroke()
  const onPointerCancel = () => finishStroke()

  const canUndo = undoStack.current.length > 0
  const canRedo = redoStack.current.length > 0

  const displayDoc = useMemo(() => {
    if (!draft || draft.tool !== 'pen') return doc
    return { ...doc, strokes: [...doc.strokes, draft] }
  }, [doc, draft])

  const eraserPreview =
    draft && draft.tool === 'eraser' && draft.points.length > 0 ? draft : null

  if (readOnly) {
    return (
      <div className="freedraw-canvas is-readonly">
        <FreeDrawSvg doc={doc} />
      </div>
    )
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (readOnly) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
    }
  }

  return (
    <div
      className={`freedraw-canvas${compact ? ' is-compact' : ''}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="freedraw-toolbar" role="toolbar" aria-label="Sketch tools">
        <div className="freedraw-toolbar-group">
          <button
            type="button"
            className={`freedraw-tool${tool === 'pen' ? ' is-active' : ''}`}
            aria-pressed={tool === 'pen'}
            title="Pen"
            onClick={() => setTool('pen')}
          >
            Pen
          </button>
          <button
            type="button"
            className={`freedraw-tool${tool === 'eraser' ? ' is-active' : ''}`}
            aria-pressed={tool === 'eraser'}
            title="Eraser — removes strokes you paint over"
            onClick={() => setTool('eraser')}
          >
            Eraser
          </button>
        </div>

        <div className="freedraw-toolbar-group" aria-label="Stroke size">
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              className={`freedraw-size${size === s ? ' is-active' : ''}`}
              title={`Size ${s}`}
              aria-pressed={size === s}
              onClick={() => setSize(s)}
            >
              <span className="freedraw-size-dot" style={{ width: Math.min(16, s + 2), height: Math.min(16, s + 2) }} />
            </button>
          ))}
        </div>

        <div className="freedraw-toolbar-group freedraw-colors" aria-label="Colour">
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`freedraw-swatch${color === c && tool === 'pen' ? ' is-active' : ''}`}
              style={{ background: c }}
              title={c}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              disabled={tool === 'eraser'}
              onClick={() => {
                setColor(c)
                setTool('pen')
              }}
            />
          ))}
          <label className="freedraw-color-custom" title="Custom colour">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#141a21'}
              disabled={tool === 'eraser'}
              onChange={(e) => {
                setColor(e.target.value)
                setTool('pen')
              }}
            />
          </label>
        </div>

        <div className="freedraw-toolbar-group">
          <button type="button" className="freedraw-tool" disabled={!canUndo} title="Undo" onClick={undo}>
            Undo
          </button>
          <button type="button" className="freedraw-tool" disabled={!canRedo} title="Redo" onClick={redo}>
            Redo
          </button>
          <button
            type="button"
            className="freedraw-tool"
            disabled={doc.strokes.length === 0}
            title="Clear sketch"
            onClick={clearAll}
          >
            Clear
          </button>
        </div>

        <div className="freedraw-toolbar-group freedraw-toolbar-group--end">
          <label className="freedraw-dim" title="Canvas height">
            H
            <input
              type="number"
              min={160}
              max={1200}
              step={20}
              value={doc.height}
              onChange={(e) => {
                const h = Math.max(160, Math.min(1200, Number(e.target.value) || doc.height))
                pushHistory()
                emit({ ...docRef.current, height: h })
              }}
            />
          </label>
        </div>
      </div>

      <div
        className={`freedraw-surface${tool === 'eraser' ? ' is-eraser' : ''}`}
        style={{ aspectRatio: `${doc.width} / ${doc.height}` }}
      >
        <svg
          ref={svgRef}
          className="freedraw-svg freedraw-svg--edit"
          viewBox={`0 0 ${doc.width} ${doc.height}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={(e) => {
            if (drawingRef.current && e.buttons === 0) finishStroke()
          }}
        >
          <rect width="100%" height="100%" fill={displayDoc.background} />
          {displayDoc.strokes
            .filter((s) => s.tool === 'pen' && s.points.length > 0)
            .map((s) => (
              <path
                key={s.id}
                d={strokePathD(s.points)}
                fill="none"
                stroke={s.color}
                strokeWidth={s.size}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: 'none' }}
              />
            ))}
          {eraserPreview && (
            <path
              d={strokePathD(eraserPreview.points)}
              fill="none"
              stroke="rgba(180,35,24,0.35)"
              strokeWidth={eraserPreview.size}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ pointerEvents: 'none' }}
            />
          )}
        </svg>
      </div>

      <p className="freedraw-hint muted sm">
        Draw with the pen · eraser removes whole strokes · undo/redo supported · stored on this page
      </p>
    </div>
  )
}
