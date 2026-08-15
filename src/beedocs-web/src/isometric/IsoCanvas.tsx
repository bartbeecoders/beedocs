import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  DEFAULT_CONNECTOR_COLOR,
  DEFAULT_ITEM_COLOR,
  DEFAULT_ZONE_COLOR,
  isoContentBounds,
  roundTile,
  tileToWorld,
  worldToTile,
  type IsoItem,
  type IsoTile,
  type IsoViewport,
} from './isoModel'
import {
  connectorGeometry,
  itemAtTile,
  sortItemsForPaint,
  tileDiamondPath,
  zoneCorners,
  zonePath,
} from './isoRender'
import { isoShape, type IsoPrimitive } from './isoShapes'
import { selectionSize, type IsoController, type IsoSelection } from './useIsoController'

export const ISO_SHAPE_MIME = 'application/x-beedocs-iso-shape'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 2.5

type WorldPt = { x: number; y: number }

export type IsoElementKind = 'item' | 'connector' | 'zone' | 'text'

export type EditLabelOptions = { text?: string; selectAll?: boolean }

export type IsoCanvasHandle = {
  zoomIn: () => void
  zoomOut: () => void
  setZoom: (zoom: number) => void
  zoomToFit: () => void
  actualSize: () => void
  clientToWorld: (clientX: number, clientY: number) => WorldPt
  centerTile: () => IsoTile
  editLabel: (kind: IsoElementKind, id: string, opts?: EditLabelOptions) => void
  focus: () => void
}

type LabelEdit = {
  kind: IsoElementKind
  id: string
  text: string
  selectAll: boolean
  session: number
}

type Interaction =
  | null
  | { kind: 'pan'; startClient: WorldPt; startVp: IsoViewport }
  | { kind: 'marquee'; start: WorldPt; current: WorldPt; additive: boolean }
  | {
      kind: 'move'
      startTile: { x: number; y: number }
      itemOrigin: Map<string, IsoTile>
      zoneOrigin: Map<string, { x1: number; y1: number; x2: number; y2: number }>
      textOrigin: Map<string, IsoTile>
      last: IsoTile
      moved: boolean
    }
  | {
      kind: 'connect'
      fromId: string
      dir: IsoTile
      world: WorldPt
      targetId: string | null
      targetTile: IsoTile | null
      startClient: WorldPt
      moved: boolean
    }
  | { kind: 'zone-resize'; zoneId: string; corner: 0 | 1 | 2 | 3; moved: boolean }

type ContextMenuState = {
  x: number
  y: number
  target: { kind: IsoElementKind; id: string } | null
}

type Props = {
  ctrl: IsoController
  onZoomChange?: (zoom: number) => void
  /** Place a palette entry dropped at a tile ('zone' and 'text' are special). */
  onDropShape?: (shapeId: string, tile: IsoTile) => void
}

const CONNECT_DIRS: IsoTile[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
]

/** Angle (deg) of a tile-space direction on screen, for the hover arrows. */
function dirAngle(dir: IsoTile): number {
  const p = tileToWorld(dir.x, dir.y)
  return (Math.atan2(p.y, p.x) * 180) / Math.PI
}

function renderPrimitive(p: IsoPrimitive, key: number): ReactNode {
  if (p.kind === 'path') {
    return (
      <path
        key={key}
        d={p.d}
        fill={p.fill ?? 'none'}
        stroke={p.stroke}
        strokeWidth={p.strokeWidth}
        strokeLinejoin="round"
        strokeDasharray={p.dash}
        opacity={p.opacity}
        fillRule={p.evenOdd ? 'evenodd' : undefined}
      />
    )
  }
  if (p.kind === 'ellipse') {
    return (
      <ellipse
        key={key}
        cx={p.cx}
        cy={p.cy}
        rx={p.rx}
        ry={p.ry}
        fill={p.fill ?? 'none'}
        stroke={p.stroke}
        strokeWidth={p.strokeWidth}
        opacity={p.opacity}
      />
    )
  }
  return (
    <text
      key={key}
      x={p.x}
      y={p.y}
      fontSize={p.size}
      fill={p.fill}
      fontWeight={p.bold ? 700 : undefined}
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {p.text}
    </text>
  )
}

/** One item's shape, memo-drawn at its projected tile centre. */
export function IsoItemShape({ item }: { item: IsoItem }) {
  const origin = tileToWorld(item.x, item.y)
  const prims = useMemo(
    () => isoShape(item.shape).draw(item.color ?? DEFAULT_ITEM_COLOR),
    [item.shape, item.color],
  )
  return (
    <g transform={`translate(${origin.x},${origin.y})`}>{prims.map((p, i) => renderPrimitive(p, i))}</g>
  )
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export const IsoCanvas = forwardRef<IsoCanvasHandle, Props>(function IsoCanvas(
  { ctrl, onZoomChange, onDropShape },
  ref,
) {
  const { doc, prefs, readOnly } = ctrl

  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 500 })
  const [viewport, setViewportState] = useState<IsoViewport>(() => ({
    x: doc.viewport?.x ?? 0,
    y: doc.viewport?.y ?? 0,
    zoom: doc.viewport?.zoom ?? 1,
  }))
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const setViewport = useCallback((next: IsoViewport | ((v: IsoViewport) => IsoViewport)) => {
    setViewportState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      viewportRef.current = resolved
      return resolved
    })
  }, [])

  const [interaction, setInteraction] = useState<Interaction>(null)
  const interactionRef = useRef<Interaction>(null)
  interactionRef.current = interaction
  const movedRef = useRef(false)
  const [hoverItemId, setHoverItemId] = useState<string | null>(null)
  // Leaving a shape schedules the clear instead of clearing at once, so the
  // pointer can travel from the shape to its connect arrows without them
  // unmounting mid-flight.
  const hoverClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setHover = useCallback((id: string | null) => {
    if (hoverClearTimer.current) {
      clearTimeout(hoverClearTimer.current)
      hoverClearTimer.current = null
    }
    if (id !== null) {
      setHoverItemId(id)
      return
    }
    hoverClearTimer.current = setTimeout(() => setHoverItemId(null), 280)
  }, [])
  useEffect(
    () => () => {
      if (hoverClearTimer.current) clearTimeout(hoverClearTimer.current)
    },
    [],
  )
  const [spaceDown, setSpaceDown] = useState(false)
  const [labelEdit, setLabelEdit] = useState<LabelEdit | null>(null)
  const labelEditRef = useRef<LabelEdit | null>(null)
  labelEditRef.current = labelEdit
  const labelSession = useRef(0)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const selected: IsoSelection = ctrl.selection
  const selectedItemIds = useMemo(() => new Set(selected.items), [selected.items])
  const selectedConnectorIds = useMemo(() => new Set(selected.connectors), [selected.connectors])
  const selectedZoneIds = useMemo(() => new Set(selected.zones), [selected.zones])
  const selectedTextIds = useMemo(() => new Set(selected.texts), [selected.texts])

  const itemById = useMemo(() => {
    const map = new Map<string, IsoItem>()
    for (const it of doc.items) map.set(it.id, it)
    return map
  }, [doc.items])

  useEffect(() => onZoomChange?.(viewport.zoom), [viewport.zoom, onZoomChange])

  // Track the wrapper size for the grid and centring math.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // First open of an empty-viewport document: put the origin tile mid-view.
  const centeredOnce = useRef(false)
  useEffect(() => {
    if (centeredOnce.current || doc.viewport) return
    const el = wrapRef.current
    if (!el || el.clientWidth === 0) return
    centeredOnce.current = true
    setViewport({ x: el.clientWidth / 2, y: el.clientHeight / 2.6, zoom: 1 })
  }, [doc.viewport, setViewport, size])

  // ── Coordinate helpers ─────────────────────────────────────────────────────

  const clientToWorld = useCallback((clientX: number, clientY: number): WorldPt => {
    const rect = wrapRef.current?.getBoundingClientRect()
    const vp = viewportRef.current
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left - vp.x) / vp.zoom, y: (clientY - rect.top - vp.y) / vp.zoom }
  }, [])

  const clientToTile = useCallback(
    (clientX: number, clientY: number): IsoTile => {
      const w = clientToWorld(clientX, clientY)
      return roundTile(worldToTile(w.x, w.y))
    },
    [clientToWorld],
  )

  // ── Zoom / pan API ─────────────────────────────────────────────────────────

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const rect = wrapRef.current?.getBoundingClientRect()
      setViewport((vp) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor))
        if (!rect) return { ...vp, zoom }
        const cx = (clientX ?? rect.left + rect.width / 2) - rect.left
        const cy = (clientY ?? rect.top + rect.height / 2) - rect.top
        const wx = (cx - vp.x) / vp.zoom
        const wy = (cy - vp.y) / vp.zoom
        return { zoom, x: cx - wx * zoom, y: cy - wy * zoom }
      })
    },
    [setViewport],
  )

  const zoomToFit = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect()
    const bounds = isoContentBounds(ctrl.docRef.current)
    if (!rect) return
    if (!bounds) {
      setViewport({ x: rect.width / 2, y: rect.height / 2.6, zoom: 1 })
      return
    }
    const pad = 48
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min(
          (rect.width - pad * 2) / Math.max(1, bounds.w),
          (rect.height - pad * 2) / Math.max(1, bounds.h),
          1.4,
        ),
      ),
    )
    setViewport({
      zoom,
      x: rect.width / 2 - (bounds.x + bounds.w / 2) * zoom,
      y: rect.height / 2 - (bounds.y + bounds.h / 2) * zoom,
    })
  }, [ctrl.docRef, setViewport])

  // ── Label editing ──────────────────────────────────────────────────────────

  const commitLabelEdit = useCallback(() => {
    const cur = labelEditRef.current
    if (!cur) return
    labelEditRef.current = null
    setLabelEdit(null)
    const text = cur.text.trim()
    if (cur.kind === 'item') ctrl.updateItems([cur.id], { label: text || undefined })
    else if (cur.kind === 'connector') ctrl.updateConnectors([cur.id], { label: text || undefined })
    else if (cur.kind === 'zone') ctrl.updateZones([cur.id], { label: text || undefined })
    else ctrl.updateTexts([cur.id], { text })
  }, [ctrl])

  const startLabelEdit = useCallback(
    (kind: IsoElementKind, id: string, opts?: EditLabelOptions) => {
      if (readOnly) return
      const d = ctrl.docRef.current
      const existing =
        kind === 'item'
          ? (d.items.find((x) => x.id === id)?.label ?? '')
          : kind === 'connector'
            ? (d.connectors.find((x) => x.id === id)?.label ?? '')
            : kind === 'zone'
              ? (d.zones.find((x) => x.id === id)?.label ?? '')
              : (d.texts.find((x) => x.id === id)?.text ?? '')
      const text = opts?.text !== undefined ? opts.text : existing
      labelSession.current += 1
      setLabelEdit({
        kind,
        id,
        text,
        selectAll: opts?.selectAll ?? opts?.text === undefined,
        session: labelSession.current,
      })
    },
    [ctrl.docRef, readOnly],
  )

  useEffect(() => {
    if (!labelEdit) return
    const input = labelInputRef.current
    if (!input) return
    input.focus()
    if (labelEdit.selectAll) input.select()
    else input.setSelectionRange(input.value.length, input.value.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refocus per session only
  }, [labelEdit?.session])

  useImperativeHandle(
    ref,
    (): IsoCanvasHandle => ({
      zoomIn: () => zoomAt(1.2),
      zoomOut: () => zoomAt(1 / 1.2),
      setZoom: (z) => zoomAt(z / viewportRef.current.zoom),
      zoomToFit,
      actualSize: () => zoomAt(1 / viewportRef.current.zoom),
      clientToWorld,
      centerTile: () => {
        const rect = wrapRef.current?.getBoundingClientRect()
        if (!rect) return { x: 0, y: 0 }
        const w = clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return roundTile(worldToTile(w.x, w.y))
      },
      editLabel: startLabelEdit,
      focus: () => wrapRef.current?.focus(),
    }),
    [clientToWorld, startLabelEdit, zoomAt, zoomToFit],
  )

  // Space bar = temporary hand tool (like the studio / draw.io)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) setSpaceDown(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY)
        return
      }
      setViewport((vp) => ({
        ...vp,
        x: vp.x - (e.shiftKey ? e.deltaY : e.deltaX),
        y: vp.y - (e.shiftKey ? 0 : e.deltaY),
      }))
    },
    [setViewport, zoomAt],
  )

  // Native listener so preventDefault works (React wheel is passive)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // Close the context menu on outside pointerdown / Escape.
  useEffect(() => {
    if (!contextMenu) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.studio-menu')) return
      setContextMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  // ── Gesture starts ─────────────────────────────────────────────────────────

  const capture = (e: ReactPointerEvent) => {
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const beginMove = useCallback(
    (e: ReactPointerEvent) => {
      const sel = ctrl.selectionRef.current
      const d = ctrl.docRef.current
      const itemOrigin = new Map<string, IsoTile>()
      const zoneOrigin = new Map<string, { x1: number; y1: number; x2: number; y2: number }>()
      const textOrigin = new Map<string, IsoTile>()
      for (const it of d.items) if (sel.items.includes(it.id)) itemOrigin.set(it.id, { x: it.x, y: it.y })
      for (const z of d.zones)
        if (sel.zones.includes(z.id)) zoneOrigin.set(z.id, { x1: z.x1, y1: z.y1, x2: z.x2, y2: z.y2 })
      for (const t of d.texts) if (sel.texts.includes(t.id)) textOrigin.set(t.id, { x: t.x, y: t.y })
      const w = clientToWorld(e.clientX, e.clientY)
      movedRef.current = false
      setInteraction({
        kind: 'move',
        startTile: worldToTile(w.x, w.y),
        itemOrigin,
        zoneOrigin,
        textOrigin,
        last: { x: 0, y: 0 },
        moved: false,
      })
    },
    [clientToWorld, ctrl.docRef, ctrl.selectionRef],
  )

  const onElementPointerDown = useCallback(
    (e: ReactPointerEvent, kind: IsoElementKind, id: string) => {
      if (e.button === 1 || spaceDown) return // fall through to canvas pan
      e.stopPropagation()
      if (e.button === 2) return // context menu handled separately
      wrapRef.current?.focus({ preventScroll: true })
      commitLabelEdit()
      setContextMenu(null)
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      const key = (
        { item: 'items', connector: 'connectors', zone: 'zones', text: 'texts' } as const
      )[kind]
      const already = ctrl.selectionRef.current[key].includes(id)
      if (additive) {
        ctrl.select(key, [id], true)
        return
      }
      if (!already) ctrl.select(key, [id])
      if (readOnly || kind === 'connector') return
      capture(e)
      beginMove(e)
    },
    [beginMove, commitLabelEdit, ctrl, readOnly, spaceDown],
  )

  const onCanvasPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      wrapRef.current?.focus({ preventScroll: true })
      commitLabelEdit()
      setContextMenu(null)
      if (e.button === 1 || spaceDown || (e.button === 0 && e.altKey && e.shiftKey)) {
        capture(e)
        setInteraction({
          kind: 'pan',
          startClient: { x: e.clientX, y: e.clientY },
          startVp: viewportRef.current,
        })
        return
      }
      if (e.button !== 0) return
      capture(e)
      const world = clientToWorld(e.clientX, e.clientY)
      movedRef.current = false
      setInteraction({
        kind: 'marquee',
        start: world,
        current: world,
        additive: e.shiftKey || e.ctrlKey || e.metaKey,
      })
    },
    [clientToWorld, commitLabelEdit, spaceDown],
  )

  const onArrowPointerDown = useCallback(
    (e: ReactPointerEvent, fromId: string, dir: IsoTile) => {
      e.stopPropagation()
      if (e.button !== 0 || readOnly) return
      capture(e)
      movedRef.current = false
      setInteraction({
        kind: 'connect',
        fromId,
        dir,
        world: clientToWorld(e.clientX, e.clientY),
        targetId: null,
        targetTile: null,
        startClient: { x: e.clientX, y: e.clientY },
        moved: false,
      })
    },
    [clientToWorld, readOnly],
  )

  const onZoneHandlePointerDown = useCallback(
    (e: ReactPointerEvent, zoneId: string, corner: 0 | 1 | 2 | 3) => {
      e.stopPropagation()
      if (e.button !== 0 || readOnly) return
      capture(e)
      movedRef.current = false
      setInteraction({ kind: 'zone-resize', zoneId, corner, moved: false })
    },
    [readOnly],
  )

  // ── Gesture updates ────────────────────────────────────────────────────────

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const it = interactionRef.current
      if (!it) return
      if (it.kind === 'pan') {
        setViewport({
          ...it.startVp,
          x: it.startVp.x + (e.clientX - it.startClient.x),
          y: it.startVp.y + (e.clientY - it.startClient.y),
        })
        return
      }
      if (it.kind === 'marquee') {
        const world = clientToWorld(e.clientX, e.clientY)
        if (Math.hypot(world.x - it.start.x, world.y - it.start.y) > 3) movedRef.current = true
        setInteraction({ ...it, current: world })
        return
      }
      if (it.kind === 'move') {
        const w = clientToWorld(e.clientX, e.clientY)
        const cur = worldToTile(w.x, w.y)
        const d = {
          x: Math.round(cur.x - it.startTile.x),
          y: Math.round(cur.y - it.startTile.y),
        }
        if (d.x === it.last.x && d.y === it.last.y) return
        if (!it.moved) {
          if (d.x === 0 && d.y === 0) return
          ctrl.beginGesture()
        }
        movedRef.current = true
        setInteraction({ ...it, last: d, moved: true })
        ctrl.apply(
          (prev) => ({
            ...prev,
            items: prev.items.map((n) => {
              const o = it.itemOrigin.get(n.id)
              return o ? { ...n, x: o.x + d.x, y: o.y + d.y } : n
            }),
            zones: prev.zones.map((z) => {
              const o = it.zoneOrigin.get(z.id)
              return o
                ? { ...z, x1: o.x1 + d.x, y1: o.y1 + d.y, x2: o.x2 + d.x, y2: o.y2 + d.y }
                : z
            }),
            texts: prev.texts.map((t) => {
              const o = it.textOrigin.get(t.id)
              return o ? { ...t, x: o.x + d.x, y: o.y + d.y } : t
            }),
          }),
          { history: false },
        )
        return
      }
      if (it.kind === 'connect') {
        const world = clientToWorld(e.clientX, e.clientY)
        const tile = roundTile(worldToTile(world.x, world.y))
        const target = itemAtTile(ctrl.docRef.current, tile)
        const moved =
          it.moved || Math.hypot(e.clientX - it.startClient.x, e.clientY - it.startClient.y) > 5
        setInteraction({
          ...it,
          world,
          moved,
          targetId: target && target.id !== it.fromId ? target.id : null,
          targetTile: tile,
        })
        return
      }
      if (it.kind === 'zone-resize') {
        const w = clientToWorld(e.clientX, e.clientY)
        const t = roundTile(worldToTile(w.x, w.y))
        if (!it.moved) ctrl.beginGesture()
        movedRef.current = true
        setInteraction({ ...it, moved: true })
        ctrl.updateZones(
          [it.zoneId],
          (z) => {
            // Corners in x1y1 → x2y1 → x2y2 → x1y2 order; the dragged corner
            // moves, the opposite one anchors, bounds re-normalise.
            const anchor = {
              0: { x: z.x2, y: z.y2 },
              1: { x: z.x1, y: z.y2 },
              2: { x: z.x1, y: z.y1 },
              3: { x: z.x2, y: z.y1 },
            }[it.corner]
            return {
              x1: Math.min(t.x, anchor.x),
              y1: Math.min(t.y, anchor.y),
              x2: Math.max(t.x, anchor.x),
              y2: Math.max(t.y, anchor.y),
            }
          },
          { history: false },
        )
      }
    },
    [clientToWorld, ctrl, setViewport],
  )

  const onPointerUp = useCallback(() => {
    const it = interactionRef.current
    setInteraction(null)
    if (!it) return
    if (it.kind === 'marquee') {
      if (!movedRef.current) {
        if (!it.additive) ctrl.clearSelection()
        return
      }
      const x1 = Math.min(it.start.x, it.current.x)
      const y1 = Math.min(it.start.y, it.current.y)
      const x2 = Math.max(it.start.x, it.current.x)
      const y2 = Math.max(it.start.y, it.current.y)
      const inside = (p: WorldPt) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2
      const d = ctrl.docRef.current
      const hit: IsoSelection = {
        items: d.items.filter((n) => inside(tileToWorld(n.x, n.y))).map((n) => n.id),
        connectors: [],
        zones: d.zones
          .filter((z) => inside(tileToWorld((z.x1 + z.x2) / 2, (z.y1 + z.y2) / 2)))
          .map((z) => z.id),
        texts: d.texts.filter((t) => inside(tileToWorld(t.x, t.y))).map((t) => t.id),
      }
      if (it.additive) {
        const cur = ctrl.selectionRef.current
        ctrl.setSelection({
          items: [...new Set([...cur.items, ...hit.items])],
          connectors: cur.connectors,
          zones: [...new Set([...cur.zones, ...hit.zones])],
          texts: [...new Set([...cur.texts, ...hit.texts])],
        })
      } else {
        ctrl.setSelection(hit)
      }
      return
    }
    if (it.kind === 'connect') {
      const d = ctrl.docRef.current
      const from = d.items.find((n) => n.id === it.fromId)
      if (!from) return
      const connectTo = (toId: string) => {
        const dup = d.connectors.some(
          (c) =>
            (c.from === it.fromId && c.to === toId) || (c.from === toId && c.to === it.fromId),
        )
        if (!dup) ctrl.addConnector({ from: it.fromId, to: toId }, { select: true })
      }
      const copyAndConnect = (tile: IsoTile) => {
        const id = ctrl.addItem({ x: tile.x, y: tile.y, shape: from.shape, color: from.color })
        ctrl.addConnector({ from: it.fromId, to: id })
        ctrl.select('items', [id])
        startLabelEdit('item', id)
      }
      if (!it.moved) {
        // Click on an arrow: connected copy two tiles out (first free tile).
        let tile = { x: from.x + it.dir.x * 2, y: from.y + it.dir.y * 2 }
        for (let i = 0; i < 8 && itemAtTile(d, tile); i++) {
          tile = { x: tile.x + it.dir.x, y: tile.y + it.dir.y }
        }
        copyAndConnect(tile)
        return
      }
      if (it.targetId) {
        connectTo(it.targetId)
        return
      }
      if (it.targetTile && !itemAtTile(d, it.targetTile)) {
        copyAndConnect(it.targetTile)
      }
    }
  }, [ctrl, startLabelEdit])

  // ── Drag-and-drop from the palette ─────────────────────────────────────────

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const shapeId = e.dataTransfer.getData(ISO_SHAPE_MIME)
      if (!shapeId || readOnly) return
      e.preventDefault()
      onDropShape?.(shapeId, clientToTile(e.clientX, e.clientY))
    },
    [clientToTile, onDropShape, readOnly],
  )

  // ── Context menu ───────────────────────────────────────────────────────────

  const openContextMenu = useCallback(
    (e: React.MouseEvent, target: ContextMenuState['target']) => {
      e.preventDefault()
      e.stopPropagation()
      if (readOnly) return
      if (target) {
        const key = (
          { item: 'items', connector: 'connectors', zone: 'zones', text: 'texts' } as const
        )[target.kind]
        if (!ctrl.selectionRef.current[key].includes(target.id)) ctrl.select(key, [target.id])
      }
      setContextMenu({ x: e.clientX, y: e.clientY, target })
    },
    [ctrl, readOnly],
  )

  // ── Rendering ──────────────────────────────────────────────────────────────

  const vp = viewport
  const paintedItems = useMemo(() => sortItemsForPaint(doc.items), [doc.items])

  const gridLines = useMemo(() => {
    if (!prefs.grid) return null
    const c = worldToTile((size.w / 2 - vp.x) / vp.zoom, (size.h / 2 - vp.y) / vp.zoom)
    const R = Math.min(90, Math.ceil(34 / Math.max(0.2, vp.zoom)) + Math.ceil((size.w + size.h) / 260))
    const cx = Math.round(c.x)
    const cy = Math.round(c.y)
    const lines: ReactNode[] = []
    for (let k = -R; k <= R; k++) {
      const a = tileToWorld(cx + k - 0.5, cy - R - 0.5)
      const b = tileToWorld(cx + k - 0.5, cy + R + 0.5)
      lines.push(<line key={`x${k}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />)
      const p = tileToWorld(cx - R - 0.5, cy + k - 0.5)
      const q = tileToWorld(cx + R + 0.5, cy + k - 0.5)
      lines.push(<line key={`y${k}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />)
    }
    return lines
  }, [prefs.grid, size.h, size.w, vp.x, vp.y, vp.zoom])

  const connectorGeoms = useMemo(() => {
    const map = new Map<string, ReturnType<typeof connectorGeometry>>()
    for (const c of doc.connectors) {
      const from = itemById.get(c.from)
      const to = itemById.get(c.to)
      if (from && to) map.set(c.id, connectorGeometry(from, to))
    }
    return map
  }, [doc.connectors, itemById])

  const hoverItem = hoverItemId ? (itemById.get(hoverItemId) ?? null) : null
  const showArrows =
    !readOnly &&
    hoverItem &&
    (!interaction || interaction.kind === 'connect') &&
    !labelEdit &&
    !spaceDown

  const labelEditPos = useMemo((): WorldPt | null => {
    if (!labelEdit) return null
    const d = doc
    if (labelEdit.kind === 'item') {
      const n = d.items.find((x) => x.id === labelEdit.id)
      return n ? { ...tileToWorld(n.x, n.y), y: tileToWorld(n.x, n.y).y + 26 } : null
    }
    if (labelEdit.kind === 'connector') {
      const g = connectorGeoms.get(labelEdit.id)
      return g ? g.labelAt : null
    }
    if (labelEdit.kind === 'zone') {
      const z = d.zones.find((x) => x.id === labelEdit.id)
      if (!z) return null
      const p = tileToWorld(z.x1 - 0.5, z.y1 - 0.5)
      return { x: p.x, y: p.y + 12 }
    }
    const t = d.texts.find((x) => x.id === labelEdit.id)
    return t ? tileToWorld(t.x, t.y) : null
  }, [connectorGeoms, doc, labelEdit])

  const cursor =
    spaceDown || interaction?.kind === 'pan'
      ? 'grabbing'
      : interaction?.kind === 'connect'
        ? 'crosshair'
        : undefined

  const connectPreview =
    interaction?.kind === 'connect' && interaction.moved
      ? (() => {
          const from = itemById.get(interaction.fromId)
          if (!from) return null
          const a = tileToWorld(from.x, from.y)
          return { a, b: interaction.world, targetTile: interaction.targetTile }
        })()
      : null

  return (
    <div
      ref={wrapRef}
      className="studio-canvas-wrap iso-canvas-wrap"
      tabIndex={0}
      style={{ cursor }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ISO_SHAPE_MIME)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={onDrop}
      onWheel={onWheel}
    >
      <svg
        className="studio-canvas iso-canvas"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setInteraction(null)}
        onContextMenu={(e) => openContextMenu(e, null)}
      >
        <g transform={`translate(${vp.x},${vp.y}) scale(${vp.zoom})`}>
          <g className="iso-grid" aria-hidden>
            {gridLines}
          </g>

          {doc.zones.map((z) => {
            const color = z.color ?? DEFAULT_ZONE_COLOR
            const top = tileToWorld(z.x1 - 0.5, z.y1 - 0.5)
            const isSel = selectedZoneIds.has(z.id)
            return (
              <g key={z.id}>
                <path
                  d={zonePath(z)}
                  fill={color}
                  fillOpacity={0.14}
                  stroke={color}
                  strokeWidth={1.6}
                  onPointerDown={(e) => onElementPointerDown(e, 'zone', z.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startLabelEdit('zone', z.id)
                  }}
                  onContextMenu={(e) => openContextMenu(e, { kind: 'zone', id: z.id })}
                  style={{ cursor: readOnly ? undefined : 'move' }}
                />
                {z.label && !(labelEdit?.kind === 'zone' && labelEdit.id === z.id) && (
                  <text className="iso-zone-label" x={top.x} y={top.y + 20} fill={color}>
                    {z.label}
                  </text>
                )}
                {isSel && !readOnly && (
                  <>
                    <path d={zonePath(z)} className="iso-selection-outline" />
                    {zoneCorners(z).map((p, i) => (
                      <circle
                        key={i}
                        cx={p.x}
                        cy={p.y}
                        r={6 / vp.zoom}
                        className="iso-zone-handle"
                        onPointerDown={(e) => onZoneHandlePointerDown(e, z.id, i as 0 | 1 | 2 | 3)}
                      />
                    ))}
                  </>
                )}
              </g>
            )
          })}

          {doc.connectors.map((c) => {
            const g = connectorGeoms.get(c.id)
            if (!g) return null
            const color = c.color ?? DEFAULT_CONNECTOR_COLOR
            const isSel = selectedConnectorIds.has(c.id)
            return (
              <g
                key={c.id}
                onPointerDown={(e) => onElementPointerDown(e, 'connector', c.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startLabelEdit('connector', c.id)
                }}
                onContextMenu={(e) => openContextMenu(e, { kind: 'connector', id: c.id })}
                style={{ cursor: 'pointer' }}
              >
                {isSel && <path d={g.d} className="iso-connector-selected" />}
                <path d={g.d} fill="none" stroke="transparent" strokeWidth={14} />
                <path
                  d={g.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={2.4}
                  strokeLinejoin="round"
                  strokeDasharray={c.dashed ? '7 5' : undefined}
                />
                <path d={g.arrowD} fill={color} />
                {c.label && !(labelEdit?.kind === 'connector' && labelEdit.id === c.id) && (
                  <text className="iso-connector-label" x={g.labelAt.x} y={g.labelAt.y - 7}>
                    {c.label}
                  </text>
                )}
              </g>
            )
          })}

          {connectPreview && (
            <g className="iso-connect-preview" aria-hidden>
              {connectPreview.targetTile && (
                <path
                  d={tileDiamondPath(connectPreview.targetTile)}
                  className={
                    interaction?.kind === 'connect' && interaction.targetId
                      ? 'iso-connect-target is-item'
                      : 'iso-connect-target'
                  }
                />
              )}
              <line
                x1={connectPreview.a.x}
                y1={connectPreview.a.y}
                x2={connectPreview.b.x}
                y2={connectPreview.b.y}
              />
            </g>
          )}

          {paintedItems.map((n) => {
            const isSel = selectedItemIds.has(n.id)
            const c = tileToWorld(n.x, n.y)
            return (
              <g
                key={n.id}
                onPointerDown={(e) => onElementPointerDown(e, 'item', n.id)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startLabelEdit('item', n.id)
                }}
                onContextMenu={(e) => openContextMenu(e, { kind: 'item', id: n.id })}
                style={{ cursor: readOnly ? undefined : spaceDown ? 'grab' : 'move' }}
              >
                {isSel && <path d={tileDiamondPath(n, 0.06)} className="iso-selection-tile" />}
                <path d={tileDiamondPath(n)} fill="transparent" />
                <IsoItemShape item={n} />
                {n.label && !(labelEdit?.kind === 'item' && labelEdit.id === n.id) && (
                  <text className="iso-item-label" x={c.x} y={c.y + 40}>
                    {n.label}
                  </text>
                )}
              </g>
            )
          })}

          {doc.texts.map((t) => {
            const p = tileToWorld(t.x, t.y)
            const isSel = selectedTextIds.has(t.id)
            const w = Math.max(56, t.text.length * 9.5)
            return (
              <g
                key={t.id}
                onPointerDown={(e) => onElementPointerDown(e, 'text', t.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startLabelEdit('text', t.id)
                }}
                onContextMenu={(e) => openContextMenu(e, { kind: 'text', id: t.id })}
                style={{ cursor: readOnly ? undefined : 'move' }}
              >
                <rect
                  x={p.x - w / 2}
                  y={p.y - 14}
                  width={w}
                  height={28}
                  fill="transparent"
                  className={isSel ? 'iso-text-selected' : undefined}
                />
                {!(labelEdit?.kind === 'text' && labelEdit.id === t.id) && (
                  <text className="iso-text" x={p.x} y={p.y}>
                    {t.text || '…'}
                  </text>
                )}
              </g>
            )
          })}

          {showArrows &&
            hoverItem &&
            CONNECT_DIRS.map((dir) => {
              const tip = tileToWorld(hoverItem.x + dir.x * 0.92, hoverItem.y + dir.y * 0.92)
              return (
                <g
                  key={`${dir.x},${dir.y}`}
                  className="iso-connect-arrow"
                  transform={`translate(${tip.x},${tip.y}) rotate(${dirAngle(dir)})`}
                  onPointerEnter={() => setHover(hoverItem.id)}
                  onPointerLeave={() => setHover(null)}
                  onPointerDown={(e) => onArrowPointerDown(e, hoverItem.id, dir)}
                >
                  <circle r={13} fill="transparent" />
                  <path d="M-6 -7L8 0L-6 7L-2.5 0Z" />
                </g>
              )
            })}

          {interaction?.kind === 'marquee' && movedRef.current && (
            <rect
              className="iso-marquee"
              x={Math.min(interaction.start.x, interaction.current.x)}
              y={Math.min(interaction.start.y, interaction.current.y)}
              width={Math.abs(interaction.current.x - interaction.start.x)}
              height={Math.abs(interaction.current.y - interaction.start.y)}
            />
          )}
        </g>
      </svg>

      {labelEdit && labelEditPos && (
        <input
          ref={labelInputRef}
          className="studio-label-input iso-label-input"
          value={labelEdit.text}
          style={{
            left: vp.x + labelEditPos.x * vp.zoom - 80,
            top: vp.y + labelEditPos.y * vp.zoom - 13,
            width: 160,
          }}
          onChange={(e) => setLabelEdit((cur) => (cur ? { ...cur, text: e.target.value } : cur))}
          onBlur={commitLabelEdit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault()
              commitLabelEdit()
              wrapRef.current?.focus()
            }
          }}
        />
      )}

      {contextMenu && (
        <div
          className="studio-menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 1300 }}
          role="menu"
        >
          {contextMenu.target ? (
            <>
              <button
                type="button"
                className="studio-menu-item"
                onClick={() => {
                  const t = contextMenu.target!
                  setContextMenu(null)
                  startLabelEdit(t.kind, t.id)
                }}
              >
                {contextMenu.target.kind === 'text' ? 'Edit text' : 'Edit label'} <kbd>F2</kbd>
              </button>
              <button
                type="button"
                className="studio-menu-item"
                onClick={() => {
                  setContextMenu(null)
                  ctrl.duplicateSelection()
                }}
              >
                Duplicate <kbd>Ctrl+D</kbd>
              </button>
              <div className="studio-menu-sep" />
              <button
                type="button"
                className="studio-menu-item danger"
                onClick={() => {
                  setContextMenu(null)
                  ctrl.deleteSelection()
                }}
              >
                Delete <kbd>Del</kbd>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="studio-menu-item"
                onClick={() => {
                  setContextMenu(null)
                  ctrl.pasteClipboard()
                }}
              >
                Paste <kbd>Ctrl+V</kbd>
              </button>
              <button
                type="button"
                className="studio-menu-item"
                onClick={() => {
                  setContextMenu(null)
                  ctrl.selectAll()
                }}
              >
                Select all <kbd>Ctrl+A</kbd>
              </button>
            </>
          )}
        </div>
      )}

      {!readOnly && selectionSize(selected) === 0 && doc.items.length === 0 && (
        <div className="iso-empty-hint">
          Drag a shape from the palette, or click one to drop it here.
        </div>
      )}
    </div>
  )
})
