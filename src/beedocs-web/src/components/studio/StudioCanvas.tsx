import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { BeeAnchor, BeeEdge, BeeNode, BeePoint } from '../../types'
import {
  BEE_ANCHORS_PRIMARY,
  anchorPoint,
  containsPoint,
  edgePathD,
  hitTestEdge,
  hitTestNode,
  nodeCenter,
  orthogonalSegmentHandles,
  moveOrthogonalSegment,
  rotatePoint,
  snapToGrid,
  toNodeLocal,
  waypointsFromPolyline,
} from '../../diagram/beeModel'
import {
  arrowMarkerId,
  collectEdgeMarkers,
  nodeLabelBox,
  resolveEdgeStyle,
  resolveNodeStyle,
  resolveShape,
} from '../../diagram/shapes'
import {
  HANDLE_CURSOR,
  RESIZE_HANDLES,
  bendHandles,
  computeGuides,
  contentBounds,
  handleWorldPoint,
  insertWaypoint,
  nodeRect,
  nodesBounds,
  rectIntersects,
  resizeNodeRect,
  type Guide,
  type Rect,
  type ResizeHandle,
} from '../../diagram/studioOps'
import { BeeShapeNode } from '../BeeShapeNode'
import { findLibraryItem, nodeFromLibraryItem } from '../../diagram/shapeLibrary'
import type { StudioController } from './useStudioController'

export const STUDIO_GRID = 10
export const SHAPE_DRAG_MIME = 'application/x-bee-shape'
const MIN_ZOOM = 0.2
const MAX_ZOOM = 4
/** Pointer distance (screen px) that still counts as a click, not a drag */
const CLICK_SLOP = 4
/** How close to the outline the pointer starts a connection instead of a move */
const BORDER_GRAB = 8
/** Halo around a shape where its arrows/anchors stay visible */
const HOVER_HALO = 34
/** A side must be at least this long on screen to show its quarter points */
const QUARTER_ANCHOR_MIN_PX = 72

export type Viewport = { x: number; y: number; zoom: number }

export type StudioCanvasHandle = {
  zoomIn: () => void
  zoomOut: () => void
  setZoom: (z: number) => void
  zoomToFit: () => void
  actualSize: () => void
  resetView: () => void
  clientToWorld: (clientX: number, clientY: number) => BeePoint
  worldCenter: () => BeePoint
  focus: () => void
  editLabel: (kind: 'node' | 'edge', id: string) => void
}

type ContextMenuState = {
  clientX: number
  clientY: number
  world: BeePoint
  nodeId: string | null
  edgeId: string | null
}

type ShapePickerState = {
  clientX: number
  clientY: number
  world: BeePoint
  /** Connect the new shape back to this source */
  pending: { fromId: string; fromAnchor?: BeeAnchor } | null
}

type LabelEdit = { kind: 'node' | 'edge'; id: string; text: string }

type ConnectDrag = {
  fromId: string
  fromAnchor?: BeeAnchor
  /** Re-attaching an existing edge instead of creating one */
  edgeId?: string
  end?: 'from' | 'to'
  /** Fixed opposite endpoint while re-attaching */
  world: BeePoint
  hover: { id: string; anchor?: BeeAnchor } | null
  startClient: BeePoint
  fromArrow: boolean
}

type Interaction =
  | null
  | { kind: 'pan'; startClient: BeePoint; startVp: Viewport }
  | { kind: 'marquee'; start: BeePoint; current: BeePoint; additive: boolean }
  | {
      kind: 'move'
      startWorld: BeePoint
      origin: Map<string, BeePoint>
      edgeOrigin: Map<string, BeePoint[]>
      moved: boolean
      startClient: BeePoint
    }
  | { kind: 'resize'; nodeId: string; handle: ResizeHandle }
  | { kind: 'rotate'; nodeId: string; startAngle: number; startRotation: number }
  | { kind: 'connect'; drag: ConnectDrag }
  | { kind: 'bend'; edgeId: string; index: number }
  | { kind: 'ortho'; edgeId: string; segIndex: number }

type Props = {
  ctrl: StudioController
  onZoomChange?: (zoom: number) => void
  /** Ask the host to upload/pick an image and drop it at this world point */
  onRequestImage?: (world: BeePoint) => void
}

export const StudioCanvas = forwardRef<StudioCanvasHandle, Props>(function StudioCanvas(
  { ctrl, onZoomChange, onRequestImage },
  ref,
) {
  const { doc, prefs, readOnly } = ctrl
  const uidPrefix = useId().replace(/[^a-zA-Z0-9]/g, '')

  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [viewport, setViewportState] = useState<Viewport>({ x: 40, y: 40, zoom: 1 })
  const viewportRef = useRef(viewport)
  const setViewport = useCallback(
    (next: Viewport | ((v: Viewport) => Viewport)) => {
      setViewportState((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next
        viewportRef.current = resolved
        return resolved
      })
    },
    [],
  )
  viewportRef.current = viewport

  const [interaction, setInteraction] = useState<Interaction>(null)
  const interactionRef = useRef<Interaction>(null)
  interactionRef.current = interaction
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [shapePicker, setShapePicker] = useState<ShapePickerState | null>(null)
  const [labelEdit, setLabelEdit] = useState<LabelEdit | null>(null)
  const labelEditRef = useRef<LabelEdit | null>(null)
  labelEditRef.current = labelEdit
  const [spaceDown, setSpaceDown] = useState(false)
  const labelInputRef = useRef<HTMLTextAreaElement>(null)

  const nodeById = useMemo(() => {
    const map = new Map<string, BeeNode>()
    for (const n of doc.nodes) map.set(n.id, n)
    return map
  }, [doc.nodes])

  const selectedNodeIds = useMemo(() => new Set(ctrl.selection.nodes), [ctrl.selection.nodes])
  const selectedEdgeIds = useMemo(() => new Set(ctrl.selection.edges), [ctrl.selection.edges])

  useEffect(() => onZoomChange?.(viewport.zoom), [viewport.zoom, onZoomChange])

  // ── Coordinate helpers ─────────────────────────────────────────────────────

  const clientToWorld = useCallback((clientX: number, clientY: number): BeePoint => {
    const rect = wrapRef.current?.getBoundingClientRect()
    const vp = viewportRef.current
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    }
  }, [])

  const snap = useCallback(
    (v: number, force?: boolean) => (force ?? prefs.snap ? snapToGrid(v, STUDIO_GRID, true) : Math.round(v)),
    [prefs.snap],
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
    const bounds = contentBounds(ctrl.docRef.current.nodes, ctrl.docRef.current.edges)
    if (!rect || !bounds) return
    const pad = 40
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min((rect.width - pad * 2) / Math.max(1, bounds.w), (rect.height - pad * 2) / Math.max(1, bounds.h)),
      ),
    )
    setViewport({
      zoom,
      x: rect.width / 2 - (bounds.x + bounds.w / 2) * zoom,
      y: rect.height / 2 - (bounds.y + bounds.h / 2) * zoom,
    })
  }, [ctrl.docRef, setViewport])

  const canvasApi = useMemo(
    (): Omit<StudioCanvasHandle, 'editLabel'> => ({
      zoomIn: () => zoomAt(1.2),
      zoomOut: () => zoomAt(1 / 1.2),
      setZoom: (z) => {
        const rect = wrapRef.current?.getBoundingClientRect()
        setViewport((vp) => {
          const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
          if (!rect) return { ...vp, zoom }
          const cx = rect.width / 2
          const cy = rect.height / 2
          const wx = (cx - vp.x) / vp.zoom
          const wy = (cy - vp.y) / vp.zoom
          return { zoom, x: cx - wx * zoom, y: cy - wy * zoom }
        })
      },
      zoomToFit,
      actualSize: () => {
        const rect = wrapRef.current?.getBoundingClientRect()
        setViewport((vp) => {
          if (!rect) return { ...vp, zoom: 1 }
          const cx = rect.width / 2
          const cy = rect.height / 2
          const wx = (cx - vp.x) / vp.zoom
          const wy = (cy - vp.y) / vp.zoom
          return { zoom: 1, x: cx - wx, y: cy - wy }
        })
      },
      resetView: () => setViewport({ x: 40, y: 40, zoom: 1 }),
      clientToWorld,
      worldCenter: () => {
        const rect = wrapRef.current?.getBoundingClientRect()
        if (!rect) return { x: 200, y: 160 }
        return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
      },
      focus: () => wrapRef.current?.focus(),
    }),
    [clientToWorld, setViewport, zoomAt, zoomToFit],
  )

  // Space bar = temporary hand tool (like draw.io)
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
        e.preventDefault()
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

  // ── Label editing ──────────────────────────────────────────────────────────

  const commitLabelEdit = useCallback(() => {
    const cur = labelEditRef.current
    if (!cur) return
    labelEditRef.current = null
    setLabelEdit(null)
    if (cur.kind === 'node') ctrl.updateNodes([cur.id], { label: cur.text })
    else ctrl.updateEdges([cur.id], { label: cur.text })
  }, [ctrl])

  const startLabelEdit = useCallback(
    (kind: 'node' | 'edge', id: string) => {
      if (readOnly) return
      const text =
        kind === 'node'
          ? (ctrl.docRef.current.nodes.find((n) => n.id === id)?.label ?? '')
          : (ctrl.docRef.current.edges.find((e) => e.id === id)?.label ?? '')
      labelEditRef.current = { kind, id, text }
      setLabelEdit({ kind, id, text })
      if (kind === 'node') ctrl.setSelection({ nodes: [id], edges: [] })
      else ctrl.setSelection({ nodes: [], edges: [id] })
    },
    [ctrl, readOnly],
  )

  useEffect(() => {
    if (!labelEdit) return
    const t = window.setTimeout(() => {
      labelInputRef.current?.focus()
      labelInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [labelEdit?.id, labelEdit?.kind])

  useImperativeHandle(
    ref,
    (): StudioCanvasHandle => ({ ...canvasApi, editLabel: startLabelEdit }),
    [canvasApi, startLabelEdit],
  )

  // ── Hit helpers ────────────────────────────────────────────────────────────

  const anchorHitAt = useCallback(
    (n: BeeNode, world: BeePoint): BeeAnchor | undefined => {
      const tol = 8 / viewportRef.current.zoom
      let best: { a: BeeAnchor; d: number } | null = null
      for (const a of visibleAnchors(n, viewportRef.current.zoom)) {
        const p = anchorPoint(n, a)
        const d = Math.hypot(p.x - world.x, p.y - world.y)
        if (d <= tol && (!best || d < best.d)) best = { a, d }
      }
      return best?.a
    },
    [],
  )

  const nearBorder = useCallback((n: BeeNode, world: BeePoint): boolean => {
    const tol = BORDER_GRAB / viewportRef.current.zoom
    const local = toNodeLocal(n, world.x, world.y)
    const insideX = local.x >= -tol && local.x <= n.w + tol
    const insideY = local.y >= -tol && local.y <= n.h + tol
    if (!insideX || !insideY) return false
    return (
      Math.abs(local.x) <= tol ||
      Math.abs(local.x - n.w) <= tol ||
      Math.abs(local.y) <= tol ||
      Math.abs(local.y - n.h) <= tol
    )
  }, [])

  const resolveConnectTarget = useCallback(
    (world: BeePoint, excludeId?: string): { id: string; anchor?: BeeAnchor } | null => {
      const nodes = ctrl.docRef.current.nodes
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (n.id === excludeId) continue
        const anchor = anchorHitAt(n, world)
        if (anchor) return { id: n.id, anchor }
        if (containsPoint(n, world.x, world.y, 4 / viewportRef.current.zoom)) return { id: n.id }
      }
      return null
    },
    [anchorHitAt, ctrl.docRef],
  )

  // ── Gesture start helpers ──────────────────────────────────────────────────

  const capture = (e: ReactPointerEvent) => {
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const startConnect = useCallback(
    (e: ReactPointerEvent, fromId: string, fromAnchor: BeeAnchor | undefined, world: BeePoint, fromArrow = false) => {
      capture(e)
      setInteraction({
        kind: 'connect',
        drag: {
          fromId,
          fromAnchor,
          world,
          hover: null,
          startClient: { x: e.clientX, y: e.clientY },
          fromArrow,
        },
      })
    },
    [],
  )

  // ── Pointer handlers ───────────────────────────────────────────────────────

  const onNodePointerDown = (e: ReactPointerEvent, node: BeeNode) => {
    if (e.button !== 0 || readOnly) return
    if (spaceDown) return
    e.stopPropagation()
    capture(e)
    if (labelEdit) commitLabelEdit()
    const world = clientToWorld(e.clientX, e.clientY)
    const additive = e.shiftKey || e.ctrlKey || e.metaKey

    // Dragging the outline of an unselected shape draws a connection
    // (draw.io behaviour). Once selected, the same spots resize and move it.
    if (!selectedNodeIds.has(node.id)) {
      const anchor = anchorHitAt(node, world)
      if (anchor || nearBorder(node, world)) {
        startConnect(e, node.id, anchor, world)
        return
      }
    }

    if (!selectedNodeIds.has(node.id)) {
      ctrl.selectNodes([node.id], additive)
    } else if (additive) {
      ctrl.selectNodes([node.id], true)
      return
    }
    // Selection state is applied asynchronously — build the move set eagerly
    const ids = selectedNodeIds.has(node.id) ? ctrl.selectionRef.current.nodes : [node.id]
    const origin = new Map<string, BeePoint>()
    for (const id of ids) {
      const n = nodeById.get(id)
      if (n) origin.set(id, { x: n.x, y: n.y })
    }
    const idSet = new Set(ids)
    const edgeOrigin = new Map<string, BeePoint[]>()
    for (const edge of ctrl.docRef.current.edges) {
      if (edge.waypoints?.length && idSet.has(edge.from) && idSet.has(edge.to)) {
        edgeOrigin.set(edge.id, edge.waypoints.map((p) => ({ ...p })))
      }
    }
    ctrl.beginGesture()
    setInteraction({
      kind: 'move',
      startWorld: world,
      origin,
      edgeOrigin,
      moved: false,
      startClient: { x: e.clientX, y: e.clientY },
    })
  }

  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    if (labelEdit) commitLabelEdit()
    setContextMenu(null)
    setShapePicker(null)
    if (e.button === 1 || spaceDown || (e.button === 0 && e.altKey && e.shiftKey)) {
      capture(e)
      setInteraction({ kind: 'pan', startClient: { x: e.clientX, y: e.clientY }, startVp: viewportRef.current })
      return
    }
    if (e.button !== 0) return
    const world = clientToWorld(e.clientX, e.clientY)
    const edgeHit = hitTestEdge(doc.nodes, doc.edges, world.x, world.y, 8 / viewport.zoom)
    if (edgeHit) {
      ctrl.selectEdges([edgeHit.id], e.shiftKey || e.ctrlKey || e.metaKey)
      return
    }
    capture(e)
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    if (!additive) ctrl.clearSelection()
    setInteraction({ kind: 'marquee', start: world, current: world, additive })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const world = clientToWorld(e.clientX, e.clientY)
    const it = interactionRef.current

    if (!it) {
      if (readOnly) return
      const hit = hitTestNode(doc.nodes, world.x, world.y)
      if (hit) {
        setHoverNodeId(hit.id)
      } else {
        // Keep the arrows/anchors alive while the pointer is in the halo
        // around the shape, so they can actually be grabbed.
        const current = hoverNodeId ? nodeById.get(hoverNodeId) : null
        const halo = HOVER_HALO / viewport.zoom
        if (!current || !containsPoint(current, world.x, world.y, halo)) setHoverNodeId(null)
      }
      setHoverEdgeId(
        hit ? null : (hitTestEdge(doc.nodes, doc.edges, world.x, world.y, 8 / viewport.zoom)?.id ?? null),
      )
      return
    }

    switch (it.kind) {
      case 'pan': {
        setViewport({
          ...it.startVp,
          x: it.startVp.x + (e.clientX - it.startClient.x),
          y: it.startVp.y + (e.clientY - it.startClient.y),
        })
        return
      }
      case 'marquee': {
        setInteraction({ ...it, current: world })
        return
      }
      case 'move': {
        const rawDx = world.x - it.startWorld.x
        const rawDy = world.y - it.startWorld.y
        const moved =
          it.moved || Math.hypot(e.clientX - it.startClient.x, e.clientY - it.startClient.y) > CLICK_SLOP
        if (!moved) return

        const ids = [...it.origin.keys()]
        const useSnap = prefs.snap && !e.altKey
        let dx = useSnap ? snapDelta(rawDx, it.origin, 'x') : Math.round(rawDx)
        let dy = useSnap ? snapDelta(rawDy, it.origin, 'y') : Math.round(rawDy)

        // Alignment guides
        let nextGuides: Guide[] = []
        if (prefs.guides && !e.altKey) {
          const movingNodes = ids
            .map((id) => nodeById.get(id))
            .filter((n): n is BeeNode => !!n)
          const bounds = nodesBounds(
            movingNodes.map((n) => ({ ...n, x: it.origin.get(n.id)!.x + dx, y: it.origin.get(n.id)!.y + dy })),
          )
          if (bounds) {
            const others = doc.nodes.filter((n) => !it.origin.has(n.id)).map(nodeRect)
            const g = computeGuides(bounds, others, 6 / viewport.zoom)
            dx += g.dx
            dy += g.dy
            nextGuides = g.guides
          }
        }
        setGuides(nextGuides)

        ctrl.apply(
          (prev) => ({
            ...prev,
            nodes: prev.nodes.map((n) => {
              const o = it.origin.get(n.id)
              return o ? { ...n, x: o.x + dx, y: o.y + dy } : n
            }),
            edges: prev.edges.map((edge) => {
              const wps = it.edgeOrigin.get(edge.id)
              return wps ? { ...edge, waypoints: wps.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : edge
            }),
          }),
          { history: false },
        )
        setInteraction({ ...it, moved: true })
        return
      }
      case 'resize': {
        const n = nodeById.get(it.nodeId)
        if (!n) return
        const rect = resizeNodeRect(n, it.handle, world, {
          snap: prefs.snap && !e.altKey,
          grid: STUDIO_GRID,
          keepRatio: e.shiftKey,
        })
        ctrl.updateNodes(
          [it.nodeId],
          { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) },
          { history: false },
        )
        return
      }
      case 'rotate': {
        const n = nodeById.get(it.nodeId)
        if (!n) return
        const c = nodeCenter(n)
        const angle = (Math.atan2(world.y - c.y, world.x - c.x) * 180) / Math.PI
        let rotation = it.startRotation + (angle - it.startAngle)
        rotation = e.shiftKey ? Math.round(rotation / 15) * 15 : Math.round(rotation)
        rotation = ((rotation % 360) + 360) % 360
        ctrl.updateNodes([it.nodeId], { rotation: rotation === 0 ? undefined : rotation }, { history: false })
        return
      }
      case 'connect': {
        const hover = resolveConnectTarget(world, it.drag.edgeId ? undefined : it.drag.fromId)
        setInteraction({ kind: 'connect', drag: { ...it.drag, world, hover } })
        return
      }
      case 'bend': {
        const edge = doc.edges.find((x) => x.id === it.edgeId)
        if (!edge) return
        const p = {
          x: prefs.snap && !e.altKey ? snapToGrid(world.x, STUDIO_GRID, true) : Math.round(world.x),
          y: prefs.snap && !e.altKey ? snapToGrid(world.y, STUDIO_GRID, true) : Math.round(world.y),
        }
        ctrl.updateEdges(
          [it.edgeId],
          (cur) => ({
            waypoints: (cur.waypoints ?? []).map((wp, i) => (i === it.index ? p : wp)),
          }),
          { history: false },
        )
        return
      }
      case 'ortho': {
        const edge = doc.edges.find((x) => x.id === it.edgeId)
        const from = edge && nodeById.get(edge.from)
        const to = edge && nodeById.get(edge.to)
        if (!edge || !from || !to) return
        const { points } = edgePathD(from, to, edge)
        const moved = moveOrthogonalSegment(points, it.segIndex, world.x, world.y, {
          snap: prefs.snap && !e.altKey,
          grid: STUDIO_GRID,
        })
        ctrl.updateEdges(
          [it.edgeId],
          { route: 'orthogonal', waypoints: waypointsFromPolyline(moved) },
          { history: false },
        )
        return
      }
    }
  }

  const finishConnect = (drag: ConnectDrag, e: ReactPointerEvent) => {
    const world = clientToWorld(e.clientX, e.clientY)
    const target = resolveConnectTarget(world, drag.edgeId ? undefined : drag.fromId)
    const clicked =
      Math.hypot(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y) <= CLICK_SLOP

    // Re-attaching an existing edge endpoint
    if (drag.edgeId && drag.end) {
      if (target && target.id) {
        ctrl.updateEdges([drag.edgeId], () =>
          drag.end === 'from'
            ? { from: target.id, fromAnchor: target.anchor, waypoints: undefined }
            : { to: target.id, toAnchor: target.anchor, waypoints: undefined },
        )
      }
      return
    }

    // Click (no drag) on a directional arrow → clone & connect
    if (clicked && drag.fromArrow && drag.fromAnchor) {
      cloneAndConnect(drag.fromId, drag.fromAnchor)
      return
    }

    if (target && target.id !== drag.fromId) {
      ctrl.addEdge(
        {
          from: drag.fromId,
          to: target.id,
          fromAnchor: drag.fromAnchor,
          toAnchor: target.anchor,
          route: 'orthogonal',
          label: '',
        },
        { select: true },
      )
      return
    }
    if (!target && !clicked) {
      // Dropped on empty canvas → offer a shape, like draw.io
      setShapePicker({
        clientX: e.clientX,
        clientY: e.clientY,
        world,
        pending: { fromId: drag.fromId, fromAnchor: drag.fromAnchor },
      })
    }
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const it = interactionRef.current
    setGuides([])
    if (!it) return
    if (it.kind === 'marquee') {
      const rect = normalizeRect(it.start, it.current)
      if (rect.w > 3 || rect.h > 3) {
        const hits = doc.nodes.filter((n) => rectIntersects(rect, nodeRect(n))).map((n) => n.id)
        const edgeHits = doc.edges
          .filter((edge) => {
            const from = nodeById.get(edge.from)
            const to = nodeById.get(edge.to)
            return from && to && rectIntersects(rect, nodeRect(from)) && rectIntersects(rect, nodeRect(to))
          })
          .map((edge) => edge.id)
        if (it.additive) {
          ctrl.setSelection({
            nodes: [...new Set([...ctrl.selectionRef.current.nodes, ...hits])],
            edges: [...new Set([...ctrl.selectionRef.current.edges, ...edgeHits])],
          })
        } else {
          ctrl.setSelection({ nodes: hits, edges: edgeHits })
        }
      }
    }
    if (it.kind === 'connect') finishConnect(it.drag, e)
    setInteraction(null)
  }

  const cloneAndConnect = (fromId: string, anchor: BeeAnchor) => {
    const source = ctrl.docRef.current.nodes.find((n) => n.id === fromId)
    if (!source) return
    const gapX = 80
    const gapY = 60
    const delta: Record<string, BeePoint> = {
      n: { x: 0, y: -(source.h + gapY) },
      s: { x: 0, y: source.h + gapY },
      e: { x: source.w + gapX, y: 0 },
      w: { x: -(source.w + gapX), y: 0 },
    }
    const d = delta[anchor] ?? delta.e
    const clone: BeeNode = {
      ...structuredClone(source),
      id: `n_${Math.random().toString(36).slice(2, 10)}`,
      x: snap(source.x + d.x),
      y: snap(source.y + d.y),
      label: source.label,
    }
    const opposite: Record<string, BeeAnchor> = { n: 's', s: 'n', e: 'w', w: 'e' }
    ctrl.apply((prev) => ({
      ...prev,
      nodes: [...prev.nodes, clone],
      edges: [
        ...prev.edges,
        {
          id: `e_${Math.random().toString(36).slice(2, 10)}`,
          from: fromId,
          to: clone.id,
          fromAnchor: anchor,
          toAnchor: opposite[anchor] ?? 'w',
          route: 'orthogonal',
          label: '',
        },
      ],
    }))
    ctrl.setSelection({ nodes: [clone.id], edges: [] })
    window.setTimeout(() => startLabelEdit('node', clone.id), 0)
  }

  // ── Context menu / double click ────────────────────────────────────────────

  const openContextMenu = (e: React.MouseEvent, opts: { nodeId?: string; edgeId?: string } = {}) => {
    if (readOnly) return
    e.preventDefault()
    e.stopPropagation()
    const world = clientToWorld(e.clientX, e.clientY)
    let nodeId = opts.nodeId ?? null
    let edgeId = opts.edgeId ?? null
    if (!nodeId && !edgeId) {
      const hit = hitTestNode(doc.nodes, world.x, world.y)
      if (hit) nodeId = hit.id
      else {
        const edgeHit = hitTestEdge(doc.nodes, doc.edges, world.x, world.y, 10 / viewport.zoom)
        if (edgeHit) edgeId = edgeHit.id
      }
    }
    if (nodeId && !selectedNodeIds.has(nodeId)) ctrl.selectNodes([nodeId])
    if (edgeId && !selectedEdgeIds.has(edgeId)) ctrl.selectEdges([edgeId])
    setInteraction(null)
    setContextMenu({ clientX: e.clientX, clientY: e.clientY, world, nodeId, edgeId })
  }

  useEffect(() => {
    if (!contextMenu && !shapePicker) return
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement
      if (target.closest('.studio-menu') || target.closest('.studio-shape-picker')) return
      setContextMenu(null)
      setShapePicker(null)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setContextMenu(null)
        setShapePicker(null)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu, shapePicker])

  const placePickedShape = (itemId: string, state: ShapePickerState) => {
    const item = findLibraryItem(itemId)
    if (!item) return
    const node = nodeFromLibraryItem(item, 0, 0)
    node.x = snap(state.world.x - node.w / 2)
    node.y = snap(state.world.y - node.h / 2)
    ctrl.apply((prev) => ({
      ...prev,
      nodes: [...prev.nodes, node],
      edges: state.pending
        ? [
            ...prev.edges,
            {
              id: `e_${Math.random().toString(36).slice(2, 10)}`,
              from: state.pending.fromId,
              to: node.id,
              fromAnchor: state.pending.fromAnchor,
              route: 'orthogonal' as const,
              label: '',
            },
          ]
        : prev.edges,
    }))
    ctrl.setSelection({ nodes: [node.id], edges: [] })
    setShapePicker(null)
    window.setTimeout(() => startLabelEdit('node', node.id), 0)
  }

  // ── Drag & drop from the palette ───────────────────────────────────────────

  const onDrop = (e: React.DragEvent) => {
    const itemId = e.dataTransfer.getData(SHAPE_DRAG_MIME)
    if (!itemId || readOnly) return
    e.preventDefault()
    const item = findLibraryItem(itemId)
    if (!item) return
    const world = clientToWorld(e.clientX, e.clientY)
    const node = nodeFromLibraryItem(item, 0, 0)
    node.x = snap(world.x - node.w / 2)
    node.y = snap(world.y - node.h / 2)
    if (item.legacyType === 'image') {
      onRequestImage?.({ x: world.x, y: world.y })
      return
    }
    ctrl.addNodes([node])
  }

  // ── Derived render data ────────────────────────────────────────────────────

  const markers = useMemo(
    () => collectEdgeMarkers(doc.edges, uidPrefix),
    [doc.edges, uidPrefix],
  )

  const selectionBounds = useMemo(() => {
    const nodes = doc.nodes.filter((n) => selectedNodeIds.has(n.id))
    return nodes.length > 1 ? nodesBounds(nodes) : null
  }, [doc.nodes, selectedNodeIds])

  const singleSelected = useMemo(
    () => (ctrl.selection.nodes.length === 1 ? (nodeById.get(ctrl.selection.nodes[0]) ?? null) : null),
    [ctrl.selection.nodes, nodeById],
  )

  const hoverNode = hoverNodeId ? nodeById.get(hoverNodeId) : null
  const showHoverAffordances =
    !readOnly &&
    !!hoverNode &&
    (!interaction || interaction.kind === 'connect') &&
    !labelEdit

  const inv = 1 / viewport.zoom
  const gridPx = STUDIO_GRID * viewport.zoom

  const cursor =
    spaceDown || interaction?.kind === 'pan'
      ? 'grabbing'
      : interaction?.kind === 'connect'
        ? 'crosshair'
        : undefined

  return (
    <div
      ref={wrapRef}
      className="studio-canvas-wrap"
      tabIndex={0}
      style={{ cursor }}
      onPointerDownCapture={() => wrapRef.current?.focus({ preventScroll: true })}
      onContextMenu={(e) => openContextMenu(e)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SHAPE_DRAG_MIME)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={onDrop}
      onWheel={onWheel}
    >
      <svg
        ref={svgRef}
        className="studio-canvas"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setInteraction(null)}
        onDoubleClick={(e) => {
          if (readOnly) return
          const world = clientToWorld(e.clientX, e.clientY)
          const node = hitTestNode(doc.nodes, world.x, world.y)
          if (node) {
            startLabelEdit('node', node.id)
            return
          }
          const edge = hitTestEdge(doc.nodes, doc.edges, world.x, world.y, 10 / viewport.zoom)
          if (edge) {
            startLabelEdit('edge', edge.id)
            return
          }
          setShapePicker({ clientX: e.clientX, clientY: e.clientY, world, pending: null })
        }}
      >
        <defs>
          <pattern
            id={`${uidPrefix}-grid`}
            width={gridPx}
            height={gridPx}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${viewport.x},${viewport.y})`}
          >
            <path d={`M ${gridPx} 0 L 0 0 0 ${gridPx}`} fill="none" stroke="#dfe3ea" strokeWidth={1} />
          </pattern>
          <pattern
            id={`${uidPrefix}-grid-major`}
            width={gridPx * 10}
            height={gridPx * 10}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${viewport.x},${viewport.y})`}
          >
            <rect width={gridPx * 10} height={gridPx * 10} fill={`url(#${uidPrefix}-grid)`} />
            <path
              d={`M ${gridPx * 10} 0 L 0 0 0 ${gridPx * 10}`}
              fill="none"
              stroke="#c8cede"
              strokeWidth={1}
            />
          </pattern>
          {markers.map((m) => (
            <marker
              key={m.id}
              id={m.id}
              markerWidth={10}
              markerHeight={7}
              refX={m.spec.refX}
              refY={m.spec.refY}
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path
                d={m.spec.d}
                fill={m.spec.filled ? m.color : 'none'}
                stroke={m.spec.filled ? 'none' : m.color}
                strokeWidth={1.2}
              />
            </marker>
          ))}
        </defs>

        {prefs.grid && (
          <rect
            width="100%"
            height="100%"
            fill={`url(#${uidPrefix}-grid-major)`}
            style={{ pointerEvents: 'none' }}
          />
        )}

        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.zoom})`}>
          {/* Connections */}
          {doc.edges.map((edge) => {
            const from = nodeById.get(edge.from)
            const to = nodeById.get(edge.to)
            if (!from || !to) return null
            const st = resolveEdgeStyle(edge)
            const { d, mid } = edgePathD(from, to, edge)
            const selected = selectedEdgeIds.has(edge.id)
            const hovered = hoverEdgeId === edge.id
            const startId =
              st.startArrow !== 'none' ? arrowMarkerId(uidPrefix, st.startArrow, 'start', st.stroke) : null
            const endId =
              st.endArrow !== 'none' ? arrowMarkerId(uidPrefix, st.endArrow, 'end', st.stroke) : null
            const editingLabel = labelEdit?.kind === 'edge' && labelEdit.id === edge.id
            return (
              <g
                key={edge.id}
                className="studio-edge"
                onPointerDown={(e) => {
                  if (e.button !== 0 || readOnly || spaceDown) return
                  e.stopPropagation()
                  ctrl.selectEdges([edge.id], e.shiftKey || e.ctrlKey || e.metaKey)
                }}
                onContextMenu={(e) => openContextMenu(e, { edgeId: edge.id })}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startLabelEdit('edge', edge.id)
                }}
              >
                <path d={d} fill="none" stroke="transparent" strokeWidth={12 * inv} style={{ cursor: 'pointer' }} />
                {(selected || hovered) && (
                  <path
                    d={d}
                    fill="none"
                    stroke="#2f7be5"
                    strokeOpacity={selected ? 0.35 : 0.18}
                    strokeWidth={(st.strokeWidth + 6) * (selected ? 1 : 0.8)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                <path
                  d={d}
                  fill="none"
                  stroke={st.stroke}
                  strokeWidth={st.strokeWidth}
                  strokeDasharray={st.dash}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerStart={startId ? `url(#${startId})` : undefined}
                  markerEnd={endId ? `url(#${endId})` : undefined}
                  style={{ pointerEvents: 'none' }}
                />
                {edge.label && !editingLabel && (
                  <g style={{ pointerEvents: 'none' }}>
                    <rect
                      x={mid.x - Math.max(12, edge.label.length * st.fontSize * 0.3)}
                      y={mid.y - st.fontSize}
                      width={Math.max(24, edge.label.length * st.fontSize * 0.6)}
                      height={st.fontSize * 1.6}
                      fill="#ffffff"
                      opacity={0.92}
                      rx={2}
                    />
                    <text
                      x={mid.x}
                      y={mid.y + st.fontSize * 0.35}
                      textAnchor="middle"
                      fontSize={st.fontSize}
                      fill={st.fontColor}
                    >
                      {edge.label}
                    </text>
                  </g>
                )}
              </g>
            )
          })}

          {/* Shapes */}
          {doc.nodes.map((node) => {
            const editing = labelEdit?.kind === 'node' && labelEdit.id === node.id
            return (
              <BeeShapeNode
                key={node.id}
                node={node}
                hideLabel={editing}
                data-node-id={node.id}
                style={{ cursor: readOnly ? 'default' : spaceDown ? 'grab' : 'move' }}
                onPointerDown={(e) => onNodePointerDown(e, node)}
                onContextMenu={(e) => openContextMenu(e, { nodeId: node.id })}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startLabelEdit('node', node.id)
                }}
              >
                {/* Whole box stays grabbable, also for outline-only shapes */}
                <rect x={0} y={0} width={node.w} height={node.h} fill="transparent" />
              </BeeShapeNode>
            )
          })}

          {/* Selection outlines */}
          {doc.nodes
            .filter((n) => selectedNodeIds.has(n.id))
            .map((n) => (
              <rect
                key={`sel-${n.id}`}
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                transform={n.rotation ? `rotate(${n.rotation} ${n.x + n.w / 2} ${n.y + n.h / 2})` : undefined}
                fill="none"
                stroke="#2f7be5"
                strokeWidth={inv}
                strokeDasharray={`${3 * inv} ${3 * inv}`}
                style={{ pointerEvents: 'none' }}
              />
            ))}

          {selectionBounds && (
            <rect
              x={selectionBounds.x - 4 * inv}
              y={selectionBounds.y - 4 * inv}
              width={selectionBounds.w + 8 * inv}
              height={selectionBounds.h + 8 * inv}
              fill="none"
              stroke="#2f7be5"
              strokeWidth={inv}
              strokeDasharray={`${5 * inv} ${4 * inv}`}
              opacity={0.7}
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Hover affordances: directional arrows + connection points */}
          {showHoverAffordances && hoverNode && (
            <HoverAffordances
              node={hoverNode}
              inv={inv}
              connecting={interaction?.kind === 'connect'}
              selected={selectedNodeIds.has(hoverNode.id)}
              onArrowDown={(e, anchor) => {
                e.stopPropagation()
                const world = clientToWorld(e.clientX, e.clientY)
                startConnect(e, hoverNode.id, anchor, world, true)
              }}
              onAnchorDown={(e, anchor) => {
                e.stopPropagation()
                const world = clientToWorld(e.clientX, e.clientY)
                startConnect(e, hoverNode.id, anchor, world)
              }}
            />
          )}

          {/* Resize + rotate handles for a single selected shape */}
          {!readOnly && singleSelected && !labelEdit && (
            <SelectionHandles
              node={singleSelected}
              inv={inv}
              onResizeStart={(e, handle) => {
                e.stopPropagation()
                capture(e)
                ctrl.beginGesture()
                setInteraction({ kind: 'resize', nodeId: singleSelected.id, handle })
              }}
              onRotateStart={(e) => {
                e.stopPropagation()
                capture(e)
                const c = nodeCenter(singleSelected)
                const world = clientToWorld(e.clientX, e.clientY)
                ctrl.beginGesture()
                setInteraction({
                  kind: 'rotate',
                  nodeId: singleSelected.id,
                  startAngle: (Math.atan2(world.y - c.y, world.x - c.x) * 180) / Math.PI,
                  startRotation: singleSelected.rotation ?? 0,
                })
              }}
            />
          )}

          {/* Connection target highlight */}
          {interaction?.kind === 'connect' && interaction.drag.hover && (
            <ConnectHighlight
              node={nodeById.get(interaction.drag.hover.id)}
              anchor={interaction.drag.hover.anchor}
              inv={inv}
            />
          )}

          {/* Live connection preview */}
          {interaction?.kind === 'connect' && (
            <ConnectPreview drag={interaction.drag} nodeById={nodeById} inv={inv} />
          )}

          {/* Edge handles for the selected connection */}
          {!readOnly &&
            ctrl.selection.edges.length === 1 &&
            (() => {
              const edge = doc.edges.find((e) => e.id === ctrl.selection.edges[0])
              const from = edge && nodeById.get(edge.from)
              const to = edge && nodeById.get(edge.to)
              if (!edge || !from || !to) return null
              const { points, a, b } = edgePathD(from, to, edge)
              const isOrtho = (edge.route ?? 'straight') === 'orthogonal'
              return (
                <g className="studio-edge-handles">
                  {isOrtho
                    ? orthogonalSegmentHandles(points).map((h) => (
                        <rect
                          key={`seg-${h.segIndex}`}
                          x={h.x - 5 * inv}
                          y={h.y - 5 * inv}
                          width={10 * inv}
                          height={10 * inv}
                          fill="#ffffff"
                          stroke="#2f7be5"
                          strokeWidth={1.5 * inv}
                          style={{ cursor: h.axis === 'x' ? 'ew-resize' : 'ns-resize' }}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return
                            e.stopPropagation()
                            capture(e)
                            ctrl.beginGesture()
                            setInteraction({ kind: 'ortho', edgeId: edge.id, segIndex: h.segIndex })
                          }}
                        />
                      ))
                    : bendHandles(points, edge.waypoints).map((h, i) => (
                        <circle
                          key={`bend-${i}-${h.index}-${h.virtual}`}
                          cx={h.x}
                          cy={h.y}
                          r={(h.virtual ? 4 : 5) * inv}
                          fill={h.virtual ? 'rgba(47,123,229,0.25)' : '#ffffff'}
                          stroke="#2f7be5"
                          strokeWidth={1.5 * inv}
                          style={{ cursor: 'move' }}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return
                            e.stopPropagation()
                            capture(e)
                            ctrl.beginGesture()
                            if (h.virtual) {
                              const wps = insertWaypoint(edge.waypoints, h.index, { x: h.x, y: h.y })
                              ctrl.updateEdges([edge.id], { waypoints: wps }, { history: false })
                              setInteraction({ kind: 'bend', edgeId: edge.id, index: h.index })
                            } else {
                              setInteraction({ kind: 'bend', edgeId: edge.id, index: h.index })
                            }
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            if (h.virtual) return
                            ctrl.updateEdges([edge.id], (cur) => ({
                              waypoints: (cur.waypoints ?? []).filter((_, i2) => i2 !== h.index),
                            }))
                          }}
                        />
                      ))}
                  {/* Endpoints — drag to re-attach */}
                  {(['from', 'to'] as const).map((end) => {
                    const p = end === 'from' ? a : b
                    const fixed = end === 'from' ? edge.fromAnchor : edge.toAnchor
                    return (
                      <circle
                        key={`end-${end}`}
                        cx={p.x}
                        cy={p.y}
                        r={5.5 * inv}
                        fill={fixed ? '#16a34a' : '#ffffff'}
                        stroke={fixed ? '#14532d' : '#2f7be5'}
                        strokeWidth={1.6 * inv}
                        style={{ cursor: 'crosshair' }}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          e.stopPropagation()
                          capture(e)
                          ctrl.beginGesture()
                          const anchorNodeId = end === 'from' ? edge.to : edge.from
                          setInteraction({
                            kind: 'connect',
                            drag: {
                              fromId: anchorNodeId,
                              edgeId: edge.id,
                              end,
                              world: clientToWorld(e.clientX, e.clientY),
                              hover: null,
                              startClient: { x: e.clientX, y: e.clientY },
                              fromArrow: false,
                            },
                          })
                        }}
                      />
                    )
                  })}
                </g>
              )
            })()}

          {/* Alignment guides */}
          {guides.map((g, i) => (
            <line
              key={`guide-${i}`}
              x1={g.orientation === 'v' ? g.pos : g.from}
              y1={g.orientation === 'v' ? g.from : g.pos}
              x2={g.orientation === 'v' ? g.pos : g.to}
              y2={g.orientation === 'v' ? g.to : g.pos}
              stroke="#f2456e"
              strokeWidth={inv}
              strokeDasharray={`${4 * inv} ${3 * inv}`}
              style={{ pointerEvents: 'none' }}
            />
          ))}

          {/* Rubber band */}
          {interaction?.kind === 'marquee' &&
            (() => {
              const r = normalizeRect(interaction.start, interaction.current)
              return (
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill="rgba(47,123,229,0.12)"
                  stroke="#2f7be5"
                  strokeWidth={inv}
                  strokeDasharray={`${4 * inv} ${3 * inv}`}
                  style={{ pointerEvents: 'none' }}
                />
              )
            })()}
        </g>
      </svg>

      {/* In-place label editor */}
      {labelEdit && (
        <LabelEditor
          labelEdit={labelEdit}
          nodeById={nodeById}
          edges={doc.edges}
          viewport={viewport}
          wrapRef={wrapRef}
          inputRef={labelInputRef}
          onChange={(text) => {
            labelEditRef.current = { ...labelEdit, text }
            setLabelEdit({ ...labelEdit, text })
          }}
          onCommit={commitLabelEdit}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <StudioContextMenu
          state={contextMenu}
          ctrl={ctrl}
          onClose={() => setContextMenu(null)}
          onEditLabel={(kind, id) => startLabelEdit(kind, id)}
          onPaste={(world) => ctrl.pasteClipboard(world)}
          onFit={zoomToFit}
          onAddShape={(world, clientX, clientY) =>
            setShapePicker({ clientX, clientY, world, pending: null })
          }
        />
      )}

      {/* Shape picker (double-click canvas / drop a connection on empty space) */}
      {shapePicker && (
        <ShapePicker
          state={shapePicker}
          onPick={(itemId) => placePickedShape(itemId, shapePicker)}
          onClose={() => setShapePicker(null)}
        />
      )}
    </div>
  )
})

// ── Sub components ────────────────────────────────────────────────────────────

function SelectionHandles({
  node,
  inv,
  onResizeStart,
  onRotateStart,
}: {
  node: BeeNode
  inv: number
  onResizeStart: (e: ReactPointerEvent, handle: ResizeHandle) => void
  onRotateStart: (e: ReactPointerEvent) => void
}) {
  const size = 8 * inv
  const rotateAt = (() => {
    const p = { x: node.x + node.w / 2, y: node.y - 24 * inv }
    return node.rotation ? rotatePoint(p, nodeCenter(node), node.rotation) : p
  })()
  const topCenter = (() => {
    const p = { x: node.x + node.w / 2, y: node.y }
    return node.rotation ? rotatePoint(p, nodeCenter(node), node.rotation) : p
  })()
  return (
    <g className="studio-handles">
      <line
        x1={topCenter.x}
        y1={topCenter.y}
        x2={rotateAt.x}
        y2={rotateAt.y}
        stroke="#2f7be5"
        strokeWidth={inv}
        style={{ pointerEvents: 'none' }}
      />
      <circle
        cx={rotateAt.x}
        cy={rotateAt.y}
        r={5.5 * inv}
        fill="#ffffff"
        stroke="#2f7be5"
        strokeWidth={1.6 * inv}
        style={{ cursor: 'grab' }}
        onPointerDown={onRotateStart}
      >
        <title>Rotate (Shift snaps to 15°)</title>
      </circle>
      {RESIZE_HANDLES.map((h) => {
        const p = handleWorldPoint(node, h)
        const grab = 16 * inv
        return (
          <g key={h} style={{ cursor: HANDLE_CURSOR[h] }} onPointerDown={(e) => onResizeStart(e, h)}>
            {/* Generous invisible grab area so the handle always wins */}
            <rect x={p.x - grab / 2} y={p.y - grab / 2} width={grab} height={grab} fill="transparent" />
            <rect
              x={p.x - size / 2}
              y={p.y - size / 2}
              width={size}
              height={size}
              fill="#ffffff"
              stroke="#2f7be5"
              strokeWidth={1.5 * inv}
            />
          </g>
        )
      })}
    </g>
  )
}

function HoverAffordances({
  node,
  inv,
  connecting,
  selected,
  onArrowDown,
  onAnchorDown,
}: {
  node: BeeNode
  inv: number
  connecting: boolean
  /** Selected shapes show resize handles in these spots instead */
  selected: boolean
  onArrowDown: (e: ReactPointerEvent, anchor: BeeAnchor) => void
  onAnchorDown: (e: ReactPointerEvent, anchor: BeeAnchor) => void
}) {
  const dirs: { anchor: BeeAnchor; dx: number; dy: number; rotate: number }[] = [
    { anchor: 'n', dx: 0, dy: -1, rotate: -90 },
    { anchor: 'e', dx: 1, dy: 0, rotate: 0 },
    { anchor: 's', dx: 0, dy: 1, rotate: 90 },
    { anchor: 'w', dx: -1, dy: 0, rotate: 180 },
  ]
  const gap = 18 * inv
  const arrowLen = 16 * inv
  const rotation = node.rotation ?? 0
  const rad = (rotation * Math.PI) / 180
  return (
    <g className="studio-hover">
      {!connecting &&
        dirs.map((d) => {
          // Push the arrow out along the *rotated* side normal
          const nx = d.dx * Math.cos(rad) - d.dy * Math.sin(rad)
          const ny = d.dx * Math.sin(rad) + d.dy * Math.cos(rad)
          const base = anchorPoint(node, d.anchor)
          const cx = base.x + nx * (gap + arrowLen / 2)
          const cy = base.y + ny * (gap + arrowLen / 2)
          return (
            <g
              key={`arrow-${d.anchor}`}
              transform={`translate(${cx},${cy}) rotate(${d.rotate + rotation}) scale(${inv})`}
              style={{ cursor: 'crosshair' }}
              onPointerDown={(e) => onArrowDown(e, d.anchor)}
            >
              <circle r={13} fill="transparent" />
              <path
                d="M-8,-5 L2,-5 L2,-9 L9,0 L2,9 L2,5 L-8,5 Z"
                fill="rgba(47,123,229,0.85)"
                stroke="#ffffff"
                strokeWidth={1}
              />
              <title>Drag to connect · click to add a connected copy</title>
            </g>
          )
        })}
      {!selected &&
        visibleAnchors(node, 1 / inv).map((a) => {
          const p = anchorPoint(node, a)
          const quarter = !BEE_ANCHORS_PRIMARY.includes(a)
          const s = (quarter ? 3.2 : 4) * inv
          return (
            <g
              key={`anchor-${a}`}
              style={{ cursor: 'crosshair' }}
              onPointerDown={(e) => onAnchorDown(e, a)}
            >
              <circle cx={p.x} cy={p.y} r={(quarter ? 7 : 9) * inv} fill="transparent" />
              <path
                d={`M${p.x - s} ${p.y - s} L${p.x + s} ${p.y + s} M${p.x + s} ${p.y - s} L${p.x - s} ${p.y + s}`}
                stroke="#16a34a"
                strokeWidth={(quarter ? 1.5 : 1.8) * inv}
                strokeLinecap="round"
                opacity={quarter ? 0.75 : 1}
              />
            </g>
          )
        })}
    </g>
  )
}

function ConnectHighlight({
  node,
  anchor,
  inv,
}: {
  node: BeeNode | undefined
  anchor: BeeAnchor | undefined
  inv: number
}) {
  if (!node) return null
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={node.x - 2 * inv}
        y={node.y - 2 * inv}
        width={node.w + 4 * inv}
        height={node.h + 4 * inv}
        transform={node.rotation ? `rotate(${node.rotation} ${node.x + node.w / 2} ${node.y + node.h / 2})` : undefined}
        fill="rgba(22,163,74,0.10)"
        stroke="#16a34a"
        strokeWidth={2 * inv}
      />
      {anchor && (
        <circle
          cx={anchorPoint(node, anchor).x}
          cy={anchorPoint(node, anchor).y}
          r={5 * inv}
          fill="#16a34a"
        />
      )}
    </g>
  )
}

function ConnectPreview({
  drag,
  nodeById,
  inv,
}: {
  drag: ConnectDrag
  nodeById: Map<string, BeeNode>
  inv: number
}) {
  const from = nodeById.get(drag.fromId)
  if (!from) return null
  const start = drag.fromAnchor
    ? anchorPoint(from, drag.fromAnchor)
    : nearestPointOnNode(from, drag.world)
  const end = drag.hover
    ? drag.hover.anchor
      ? anchorPoint(nodeById.get(drag.hover.id)!, drag.hover.anchor)
      : nodeCenter(nodeById.get(drag.hover.id)!)
    : drag.world
  return (
    <g style={{ pointerEvents: 'none' }}>
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke="#2f7be5"
        strokeWidth={2 * inv}
        strokeDasharray={`${6 * inv} ${4 * inv}`}
      />
      <circle cx={end.x} cy={end.y} r={4 * inv} fill="#2f7be5" />
    </g>
  )
}

function LabelEditor({
  labelEdit,
  nodeById,
  edges,
  viewport,
  wrapRef,
  inputRef,
  onChange,
  onCommit,
}: {
  labelEdit: LabelEdit
  nodeById: Map<string, BeeNode>
  edges: BeeEdge[]
  viewport: Viewport
  wrapRef: React.RefObject<HTMLDivElement | null>
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onChange: (text: string) => void
  onCommit: () => void
}) {
  const rect = (() => {
    if (labelEdit.kind === 'node') {
      const n = nodeById.get(labelEdit.id)
      if (!n) return null
      const box = nodeLabelBox(n)
      const st = resolveNodeStyle(n)
      return {
        left: (n.x + box.x) * viewport.zoom + viewport.x,
        top: (n.y + box.y) * viewport.zoom + viewport.y,
        width: Math.max(40, box.w * viewport.zoom),
        height: Math.max(20, box.h * viewport.zoom),
        fontSize: st.fontSize * viewport.zoom,
        color: st.fontColor,
        bold: st.bold,
        italic: st.italic,
        align: box.align,
      }
    }
    const edge = edges.find((e) => e.id === labelEdit.id)
    const from = edge && nodeById.get(edge.from)
    const to = edge && nodeById.get(edge.to)
    if (!edge || !from || !to) return null
    const { mid } = edgePathD(from, to, edge)
    const st = resolveEdgeStyle(edge)
    const w = 120
    const h = 24
    return {
      left: mid.x * viewport.zoom + viewport.x - (w * viewport.zoom) / 2,
      top: mid.y * viewport.zoom + viewport.y - (h * viewport.zoom) / 2,
      width: w * viewport.zoom,
      height: h * viewport.zoom,
      fontSize: st.fontSize * viewport.zoom,
      color: st.fontColor,
      bold: false,
      italic: false,
      align: 'center' as const,
    }
  })()

  if (!rect || !wrapRef.current) return null

  return (
    <textarea
      ref={inputRef}
      className="studio-label-input"
      value={labelEdit.text}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        fontSize: rect.fontSize,
        color: rect.color,
        fontWeight: rect.bold ? 700 : 400,
        fontStyle: rect.italic ? 'italic' : undefined,
        textAlign: rect.align,
      }}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Tab') {
          e.preventDefault()
          onCommit()
        }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label="Shape label"
    />
  )
}

function StudioContextMenu({
  state,
  ctrl,
  onClose,
  onEditLabel,
  onPaste,
  onFit,
  onAddShape,
}: {
  state: ContextMenuState
  ctrl: StudioController
  onClose: () => void
  onEditLabel: (kind: 'node' | 'edge', id: string) => void
  onPaste: (world: BeePoint) => void
  onFit: () => void
  onAddShape: (world: BeePoint, clientX: number, clientY: number) => void
}) {
  const hasSelection = ctrl.selection.nodes.length > 0 || ctrl.selection.edges.length > 0
  const item = (label: string, action: () => void, opts?: { hint?: string; danger?: boolean }) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      className={`studio-menu-item${opts?.danger ? ' danger' : ''}`}
      onClick={() => {
        action()
        onClose()
      }}
    >
      <span>{label}</span>
      {opts?.hint && <kbd>{opts.hint}</kbd>}
    </button>
  )

  return (
    <div
      className="studio-menu"
      role="menu"
      style={{ left: state.clientX, top: state.clientY }}
    >
      {hasSelection ? (
        <>
          {item('Cut', () => ctrl.cutSelection(), { hint: 'Ctrl+X' })}
          {item('Copy', () => ctrl.copySelection(), { hint: 'Ctrl+C' })}
          {item('Duplicate', () => ctrl.duplicateSelection(), { hint: 'Ctrl+D' })}
          <div className="studio-menu-sep" />
          {state.nodeId && item('Edit label', () => onEditLabel('node', state.nodeId!), { hint: 'F2' })}
          {state.edgeId && item('Edit label', () => onEditLabel('edge', state.edgeId!), { hint: 'F2' })}
          {ctrl.selection.nodes.length > 0 && (
            <>
              {item('Bring to front', () => ctrl.orderSelection('front'), { hint: 'Ctrl+Shift+F' })}
              {item('Send to back', () => ctrl.orderSelection('back'), { hint: 'Ctrl+Shift+B' })}
            </>
          )}
          {state.edgeId && (
            <>
              <div className="studio-menu-sep" />
              {item('Straight', () => ctrl.updateEdges([state.edgeId!], { route: 'straight', waypoints: undefined }))}
              {item('Orthogonal', () => ctrl.updateEdges([state.edgeId!], { route: 'orthogonal', waypoints: undefined }))}
              {item('Curved', () => ctrl.updateEdges([state.edgeId!], { route: 'curved', waypoints: undefined }))}
              {item('Clear waypoints', () => ctrl.updateEdges([state.edgeId!], { waypoints: undefined }))}
            </>
          )}
          <div className="studio-menu-sep" />
          {item('Delete', () => ctrl.deleteSelection(), { hint: 'Del', danger: true })}
        </>
      ) : (
        <>
          {item('Paste here', () => onPaste(state.world), { hint: 'Ctrl+V' })}
          {item('Add shape…', () => onAddShape(state.world, state.clientX, state.clientY))}
          <div className="studio-menu-sep" />
          {item('Select all', () => ctrl.selectAll(), { hint: 'Ctrl+A' })}
          {item('Fit page', onFit, { hint: 'Ctrl+Shift+H' })}
        </>
      )}
    </div>
  )
}

const QUICK_SHAPES = [
  'rectangle',
  'rounded',
  'ellipse',
  'rhombus',
  'stadium',
  'hexagon',
  'cylinder',
  'note',
  'actor',
  'text',
  'cloud',
  'process',
]

function ShapePicker({
  state,
  onPick,
  onClose,
}: {
  state: ShapePickerState
  onPick: (itemId: string) => void
  onClose: () => void
}) {
  return (
    <div className="studio-shape-picker" style={{ left: state.clientX, top: state.clientY }}>
      <div className="studio-shape-picker-head">
        <span>{state.pending ? 'Connect to a new shape' : 'Pick a shape'}</span>
        <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="studio-shape-picker-grid">
        {QUICK_SHAPES.map((id) => {
          const item = findLibraryItem(id)
          if (!item) return null
          return (
            <button
              key={id}
              type="button"
              className="studio-shape-picker-item"
              title={item.label}
              onClick={() => onPick(id)}
            >
              <ShapeThumb itemId={id} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Small preview used in the picker (and re-used by the palette). */
export function ShapeThumb({ itemId, size = 34 }: { itemId: string; size?: number }) {
  const item = findLibraryItem(itemId)
  if (!item) return null
  const node = nodeFromLibraryItem(item, 0, 0)
  const w = size * 1.35
  const h = size
  const preview: BeeNode = { ...node, label: '', x: 0, y: 0, w, h }
  const shape = resolveShape(preview)
  return (
    <svg width={w} height={h} viewBox={`-1 -1 ${w + 2} ${h + 2}`} aria-hidden focusable="false">
      <BeeShapeNode node={preview} hideLabel />
      {shape === 'text' && (
        <text x={w / 2} y={h / 2 + 4} textAnchor="middle" fontSize={12} fill="#111827">
          Abc
        </text>
      )}
    </svg>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/**
 * Fixed connection points worth showing: always the sides and corners, plus the
 * quarter points once a side is long enough on screen to keep them apart.
 */
function visibleAnchors(n: BeeNode, zoom: number): BeeAnchor[] {
  const room = (lengthPx: number) => lengthPx * zoom >= QUARTER_ANCHOR_MIN_PX
  const out = [...BEE_ANCHORS_PRIMARY]
  if (room(n.w)) out.push('n1', 'n2', 's1', 's2')
  if (room(n.h)) out.push('e1', 'e2', 'w1', 'w2')
  return out
}

function normalizeRect(a: BeePoint, b: BeePoint): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  }
}

/** Snap the drag delta so the first shape lands on the grid. */
function snapDelta(raw: number, origin: Map<string, BeePoint>, axis: 'x' | 'y'): number {
  const first = origin.values().next().value as BeePoint | undefined
  if (!first) return Math.round(raw)
  const base = axis === 'x' ? first.x : first.y
  return snapToGrid(base + raw, STUDIO_GRID, true) - base
}

function nearestPointOnNode(n: BeeNode, world: BeePoint): BeePoint {
  const c = nodeCenter(n)
  const local = toNodeLocal(n, world.x, world.y)
  const clamped = {
    x: Math.max(0, Math.min(n.w, local.x)),
    y: Math.max(0, Math.min(n.h, local.y)),
  }
  const p = { x: n.x + clamped.x, y: n.y + clamped.y }
  return n.rotation ? rotatePoint(p, c, n.rotation) : p
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}
