import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { BeeAnchor, BeeDiagramDoc, BeeEdgeRoute, BeeNode, BeeNodeType, BeePoint } from '../types'
import {
  BEE_ANCHORS,
  BEE_EDGE_ROUTES,
  BEE_GRID_SIZE,
  anchorLocal,
  anchorPoint,
  bestAnchors,
  createNode,
  defaultColor,
  defaultSize,
  edgePathD,
  hitTestEdge,
  hitTestNode,
  moveOrthogonalSegment,
  nearestAnchor,
  orthogonalSegmentHandles,
  parseBeeDoc,
  serializeBeeDoc,
  snapPoint,
  snapToGrid,
  uid,
  waypointsFromPolyline,
} from '../diagram/beeModel'
import { nodeLabelBox, nodeTransform } from '../diagram/shapes'
import { useImageIntake } from '../hooks/useImageIntake'
import { loadImageSize, type UploadedImage } from '../media/imageIntake'
import { BeeDiagramView } from './BeeDiagramView'
import { ShapeLabel, ShapePrimitives } from './BeeShapeNode'
import { nodePrimitives } from '../diagram/shapes'

const SNAP_STORAGE_KEY = 'beedocs-bee-snap-grid'

type Tool = 'select' | 'pan' | 'connect' | BeeNodeType

type LinkDrag = {
  fromId: string
  fromAnchor: BeeAnchor
  x: number
  y: number
  hoverId: string | null
  hoverAnchor: BeeAnchor | null
}

type ContextMenuState = {
  /** Viewport position for the floating menu */
  clientX: number
  clientY: number
  /** Diagram world coords where the object should be placed */
  worldX: number
  worldY: number
  /** If right-click was on a node */
  nodeId: string | null
  /** If right-click was on a connection */
  edgeId: string | null
}

type LabelEditState = {
  id: string
  text: string
}

/** Dragging a segment of an orthogonal connection */
type OrthoHandleDrag = {
  edgeId: string
  segIndex: number
  axis: 'x' | 'y'
}

const ADD_OBJECTS: { type: BeeNodeType; label: string; hint: string }[] = [
  { type: 'box', label: 'Box', hint: 'Generic component' },
  { type: 'person', label: 'Person', hint: 'Actor / user' },
  { type: 'system', label: 'System', hint: 'Software system' },
  { type: 'database', label: 'Database', hint: 'Data store' },
  { type: 'note', label: 'Note', hint: 'Annotation' },
  { type: 'image', label: 'Image', hint: 'Or drag/drop / paste an image' },
]

type Props = {
  source: string
  onChange: (source: string) => void
  readOnly?: boolean
  /** Compact chrome for embedding inside page preview */
  compact?: boolean
}

function inlineLabelBox(n: BeeNode): { x: number; y: number; w: number; h: number } {
  const box = nodeLabelBox(n)
  return { x: box.x, y: box.y, w: Math.max(48, box.w), h: Math.max(28, box.h) }
}

export function BeeDiagramEditor({ source, onChange, readOnly, compact }: Props) {
  const [doc, setDoc] = useState<BeeDiagramDoc>(() => parseBeeDoc(source))
  const [tool, setTool] = useState<Tool>('select')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ id: string; ox: number; oy: number } | null>(null)
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [labelEdit, setLabelEdit] = useState<LabelEditState | null>(null)
  const [orthoDrag, setOrthoDrag] = useState<OrthoHandleDrag | null>(null)
  const [snapToGridEnabled, setSnapToGridEnabled] = useState(() => {
    try {
      return localStorage.getItem(SNAP_STORAGE_KEY) !== 'false'
    } catch {
      return true
    }
  })
  const [mediaError, setMediaError] = useState<string | null>(null)
  const snapRef = useRef(snapToGridEnabled)
  snapRef.current = snapToGridEnabled
  const svgRef = useRef<SVGSVGElement>(null)
  const editorRootRef = useRef<HTMLDivElement>(null)
  const dropWorldRef = useRef<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const labelInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const hydrating = useRef(false)
  const onChangeRef = useRef(onChange)
  const lastEmittedRef = useRef(source)
  const docRef = useRef(doc)
  docRef.current = doc
  onChangeRef.current = onChange

  useEffect(() => {
    if (source === lastEmittedRef.current) return
    hydrating.current = true
    setDoc(parseBeeDoc(source))
    lastEmittedRef.current = source
    hydrating.current = false
  }, [source])

  const commit = useCallback((next: BeeDiagramDoc | ((prev: BeeDiagramDoc) => BeeDiagramDoc)) => {
    setDoc((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      if (!hydrating.current) {
        const serialized = serializeBeeDoc(resolved)
        lastEmittedRef.current = serialized
        onChangeRef.current(serialized)
      }
      hydrating.current = false
      return resolved
    })
  }, [])

  const selected = useMemo(
    () => doc.nodes.find((n) => n.id === selectedId) ?? null,
    [doc.nodes, selectedId],
  )

  const selectedEdge = useMemo(
    () => doc.edges.find((e) => e.id === selectedEdgeId) ?? null,
    [doc.edges, selectedEdgeId],
  )

  const clientToWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = pt.matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }

  const updateNode = (id: string, patch: Partial<BeeNode>) => {
    commit((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }))
  }

  const snapCoord = useCallback(
    (value: number) => snapToGrid(value, BEE_GRID_SIZE, snapToGridEnabled),
    [snapToGridEnabled],
  )

  const snapPos = useCallback(
    (x: number, y: number) => snapPoint({ x, y }, BEE_GRID_SIZE, snapToGridEnabled),
    [snapToGridEnabled],
  )

  useEffect(() => {
    try {
      localStorage.setItem(SNAP_STORAGE_KEY, String(snapToGridEnabled))
    } catch {
      /* ignore */
    }
  }, [snapToGridEnabled])

  const finishLink = useCallback(
    (fromId: string, fromAnchor: BeeAnchor, toId: string, toAnchor: BeeAnchor) => {
      if (fromId === toId) return
      commit((prev) => {
        // Avoid exact duplicate
        const dup = prev.edges.some(
          (e) =>
            e.from === fromId &&
            e.to === toId &&
            (e.fromAnchor ?? '') === fromAnchor &&
            (e.toAnchor ?? '') === toAnchor,
        )
        if (dup) return prev
        return {
          ...prev,
          edges: [
            ...prev.edges,
            {
              id: uid('e'),
              from: fromId,
              to: toId,
              fromAnchor,
              toAnchor,
              route: 'straight',
              label: '',
            },
          ],
        }
      })
      setSelectedId(toId)
      setSelectedEdgeId(null)
      setTool('select')
    },
    [commit],
  )

  const updateEdge = useCallback(
    (
      edgeId: string,
      patch: Partial<{ route: BeeEdgeRoute; label: string; waypoints: BeePoint[] | undefined }>,
    ) => {
      commit((prev) => ({
        ...prev,
        edges: prev.edges.map((e) => {
          if (e.id !== edgeId) return e
          const next = { ...e, ...patch }
          // Changing route style clears custom bends unless explicitly set
          if (patch.route != null && patch.waypoints === undefined && patch.route !== 'orthogonal') {
            next.waypoints = undefined
          }
          if (patch.route != null && patch.route === 'orthogonal' && patch.waypoints === undefined && e.route !== 'orthogonal') {
            next.waypoints = undefined
          }
          return next
        }),
      }))
    },
    [commit],
  )

  const deleteEdgeById = useCallback(
    (edgeId: string) => {
      commit((prev) => ({
        ...prev,
        edges: prev.edges.filter((e) => e.id !== edgeId),
      }))
      if (selectedEdgeId === edgeId) setSelectedEdgeId(null)
    },
    [commit, selectedEdgeId],
  )

  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    if (readOnly) return
    if (e.button !== 0) return
    const target = e.target as Element
    if (target.closest('[data-node-id]') || target.closest('[data-anchor]') || target.closest('[data-inline-label]'))
      return

    if (labelEdit) {
      commitLabelEdit()
    }

    const world = clientToWorld(e.clientX, e.clientY)

    if (tool === 'select' || tool === 'connect') {
      // Prefer selecting edges when clicking near a connection
      const edgeHit = hitTestEdge(docRef.current.nodes, docRef.current.edges, world.x, world.y, 12)
      if (edgeHit && tool === 'select') {
        setSelectedEdgeId(edgeHit.id)
        setSelectedId(null)
        setLinkDrag(null)
        return
      }
      setSelectedId(null)
      setSelectedEdgeId(null)
      setLinkDrag(null)
      return
    }

    if (tool === 'pan') return

    const size = defaultSize(tool as BeeNodeType)
    const pos = snapPos(world.x - size.w / 2, world.y - size.h / 2)
    const node = createNode(tool, pos.x, pos.y)
    commit((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    setSelectedId(node.id)
    setTool('select')
  }

  const beginLabelEdit = useCallback(
    (id: string) => {
      if (readOnly) return
      const n = docRef.current.nodes.find((x) => x.id === id)
      if (!n) return
      setDrag(null)
      setLinkDrag(null)
      setContextMenu(null)
      setSelectedId(id)
      setTool('select')
      setLabelEdit({ id, text: n.label })
    },
    [readOnly],
  )

  const commitLabelEdit = useCallback(() => {
    setLabelEdit((cur) => {
      if (!cur) return null
      const next = cur.text.trim() || 'Untitled'
      commit((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === cur.id ? { ...n, label: next } : n)),
      }))
      return null
    })
  }, [commit])

  const cancelLabelEdit = useCallback(() => {
    setLabelEdit(null)
  }, [])

  useEffect(() => {
    if (!labelEdit) return
    const t = window.setTimeout(() => {
      labelInputRef.current?.focus()
      labelInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [labelEdit?.id])

  // F2 renames selected node
  useEffect(() => {
    if (readOnly) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'F2' && selectedId && !labelEdit) {
        ev.preventDefault()
        beginLabelEdit(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [beginLabelEdit, labelEdit, readOnly, selectedId])

  const onNodePointerDown = (e: ReactPointerEvent, id: string) => {
    if (readOnly) return
    if ((e.target as Element).closest('[data-anchor]')) return
    if ((e.target as Element).closest('[data-inline-label]')) return
    // Don't start a drag while editing this (or another) label
    if (labelEdit) {
      if (labelEdit.id !== id) commitLabelEdit()
      return
    }
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)

    // Connect tool: click body still works (auto anchors), but prefer dragging anchors
    if (tool === 'connect' && !linkDrag) {
      const n = docRef.current.nodes.find((x) => x.id === id)
      if (!n) return
      const world = clientToWorld(e.clientX, e.clientY)
      const fromAnchor = nearestAnchor(n, world.x, world.y)
      setSelectedId(id)
      setLinkDrag({
        fromId: id,
        fromAnchor,
        x: world.x,
        y: world.y,
        hoverId: null,
        hoverAnchor: null,
      })
      return
    }

    setSelectedId(id)
    setSelectedEdgeId(null)
    if (tool === 'select') {
      const n = doc.nodes.find((x) => x.id === id)
      if (!n) return
      const world = clientToWorld(e.clientX, e.clientY)
      setDrag({ id, ox: world.x - n.x, oy: world.y - n.y })
    }
  }

  const onAnchorPointerDown = (e: ReactPointerEvent, nodeId: string, anchor: BeeAnchor) => {
    if (readOnly) return
    e.stopPropagation()
    e.preventDefault()
    const svg = svgRef.current
    if (svg) svg.setPointerCapture(e.pointerId)

    const p = anchorPoint(docRef.current.nodes.find((n) => n.id === nodeId)!, anchor)
    setSelectedId(nodeId)
    setLinkDrag({
      fromId: nodeId,
      fromAnchor: anchor,
      x: p.x,
      y: p.y,
      hoverId: null,
      hoverAnchor: null,
    })
    if (tool !== 'connect') {
      // Stay on select; anchor drag still works
    }
  }

  const resolveHover = (worldX: number, worldY: number, fromId: string) => {
    const hit = hitTestNode(docRef.current.nodes, worldX, worldY)
    if (!hit || hit.id === fromId) {
      // Also snap to nearby anchors of other nodes (even slightly outside box)
      let best: { id: string; anchor: BeeAnchor; d: number } | null = null
      for (const n of docRef.current.nodes) {
        if (n.id === fromId) continue
        for (const a of BEE_ANCHORS) {
          const p = anchorPoint(n, a)
          const d = (p.x - worldX) ** 2 + (p.y - worldY) ** 2
          if (d < 22 * 22 && (!best || d < best.d)) {
            best = { id: n.id, anchor: a, d }
          }
        }
      }
      if (best) return { hoverId: best.id, hoverAnchor: best.anchor }
      return { hoverId: null, hoverAnchor: null }
    }
    return { hoverId: hit.id, hoverAnchor: nearestAnchor(hit, worldX, worldY) }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (readOnly) return
    const world = clientToWorld(e.clientX, e.clientY)

    if (orthoDrag) {
      const edge = docRef.current.edges.find((x) => x.id === orthoDrag.edgeId)
      const from = edge && docRef.current.nodes.find((n) => n.id === edge.from)
      const to = edge && docRef.current.nodes.find((n) => n.id === edge.to)
      if (edge && from && to) {
        const { points } = edgePathD(from, to, edge)
        const moved = moveOrthogonalSegment(points, orthoDrag.segIndex, world.x, world.y, {
          snap: snapRef.current,
          grid: BEE_GRID_SIZE,
        })
        const wps = waypointsFromPolyline(moved)
        commit((prev) => ({
          ...prev,
          edges: prev.edges.map((el) =>
            el.id === orthoDrag.edgeId ? { ...el, route: 'orthogonal', waypoints: wps } : el,
          ),
        }))
      }
      return
    }

    if (linkDrag) {
      const hover = resolveHover(world.x, world.y, linkDrag.fromId)
      setLinkDrag({
        ...linkDrag,
        x: world.x,
        y: world.y,
        ...hover,
      })
      setHoverId(hover.hoverId)
      return
    }

    if (drag) {
      const pos = snapPos(world.x - drag.ox, world.y - drag.oy)
      updateNode(drag.id, { x: pos.x, y: pos.y })
      return
    }

    if (tool === 'select' || tool === 'connect') {
      const hit = hitTestNode(doc.nodes, world.x, world.y)
      setHoverId(hit?.id ?? null)
      if (!hit) {
        const edgeHit = hitTestEdge(doc.nodes, doc.edges, world.x, world.y, 10)
        setHoverEdgeId(edgeHit?.id ?? null)
      } else {
        setHoverEdgeId(null)
      }
    }
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    if (orthoDrag) {
      setOrthoDrag(null)
      return
    }
    if (linkDrag) {
      const world = clientToWorld(e.clientX, e.clientY)
      const hover = resolveHover(world.x, world.y, linkDrag.fromId)
      if (hover.hoverId && hover.hoverAnchor) {
        finishLink(linkDrag.fromId, linkDrag.fromAnchor, hover.hoverId, hover.hoverAnchor)
      } else if (hover.hoverId) {
        const to = docRef.current.nodes.find((n) => n.id === hover.hoverId)
        const from = docRef.current.nodes.find((n) => n.id === linkDrag.fromId)
        if (to && from) {
          const auto = bestAnchors(from, to)
          finishLink(linkDrag.fromId, linkDrag.fromAnchor || auto.fromAnchor, to.id, auto.toAnchor)
        }
      }
      setLinkDrag(null)
      return
    }
    setDrag(null)
  }

  const deleteNodeById = useCallback(
    (id: string) => {
      commit((prev) => ({
        ...prev,
        nodes: prev.nodes.filter((n) => n.id !== id),
        edges: prev.edges.filter((e) => e.from !== id && e.to !== id),
      }))
      if (selectedId === id) setSelectedId(null)
    },
    [commit, selectedId],
  )

  const deleteSelected = () => {
    if (!selectedId || readOnly) return
    deleteNodeById(selectedId)
  }

  const placeObjectAt = useCallback(
    (type: BeeNodeType, worldX: number, worldY: number, extras?: { imageUrl?: string; w?: number; h?: number; label?: string }) => {
      const size = defaultSize(type)
      const w = extras?.w ?? size.w
      const h = extras?.h ?? size.h
      const pos = snapPos(worldX - w / 2, worldY - h / 2)
      const node = createNode(type, pos.x, pos.y, extras?.label, {
        imageUrl: extras?.imageUrl,
        w,
        h,
      })
      commit((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
      setSelectedId(node.id)
      setSelectedEdgeId(null)
      setTool('select')
      setContextMenu(null)
    },
    [commit, snapPos],
  )

  const placeImagesAt = useCallback(
    async (images: { url: string; fileName: string }[], worldX: number, worldY: number) => {
      let offset = 0
      for (const img of images) {
        const dim = await loadImageSize(img.url)
        placeObjectAt('image', worldX + offset, worldY + offset, {
          imageUrl: img.url,
          w: dim.w,
          h: dim.h,
          label: img.fileName,
        })
        offset += 24
      }
    },
    [placeObjectAt],
  )

  const { dragging: imageDragging, uploading: imageUploading, pickFiles: pickImageFiles } = useImageIntake({
    enabled: !readOnly,
    targetRef: editorRootRef,
    paste: !readOnly,
    onUploaded: async (images: UploadedImage[]) => {
      const at = dropWorldRef.current ?? { x: 200, y: 160 }
      dropWorldRef.current = null
      await placeImagesAt(images, at.x, at.y)
    },
    onError: (msg: string) => setMediaError(msg),
  })

  const snapSelectedToGrid = useCallback(() => {
    if (!selectedId) return
    const n = docRef.current.nodes.find((x) => x.id === selectedId)
    if (!n) return
    const pos = snapPoint({ x: n.x, y: n.y }, BEE_GRID_SIZE, true)
    const w = snapToGrid(n.w, BEE_GRID_SIZE, true)
    const h = snapToGrid(n.h, BEE_GRID_SIZE, true)
    updateNode(selectedId, { x: pos.x, y: pos.y, w: Math.max(BEE_GRID_SIZE * 2, w), h: Math.max(BEE_GRID_SIZE * 2, h) })
  }, [selectedId])

  const openContextMenu = (
    e: ReactMouseEvent,
    opts: { nodeId?: string | null; edgeId?: string | null } = {},
  ) => {
    if (readOnly) return
    e.preventDefault()
    e.stopPropagation()
    const world = clientToWorld(e.clientX, e.clientY)
    setLinkDrag(null)
    setDrag(null)

    let nodeId = opts.nodeId ?? null
    let edgeId = opts.edgeId ?? null

    // Right-click empty canvas: hit-test edge under cursor first
    if (!nodeId && !edgeId) {
      const edgeHit = hitTestEdge(docRef.current.nodes, docRef.current.edges, world.x, world.y, 12)
      if (edgeHit) edgeId = edgeHit.id
    }

    if (edgeId) {
      setSelectedEdgeId(edgeId)
      setSelectedId(null)
    } else if (nodeId) {
      setSelectedId(nodeId)
      setSelectedEdgeId(null)
    }

    setContextMenu({
      clientX: e.clientX,
      clientY: e.clientY,
      worldX: world.x,
      worldY: world.y,
      nodeId,
      edgeId,
    })
  }

  // Close context menu on outside click / Escape / scroll
  useEffect(() => {
    if (!contextMenu) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setContextMenu(null)
    }
    const onDown = (ev: MouseEvent) => {
      if (menuRef.current?.contains(ev.target as Node)) return
      setContextMenu(null)
    }
    const onScroll = () => setContextMenu(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [contextMenu])

  const tools: { id: Tool; label: string }[] = [
    { id: 'select', label: 'Select' },
    { id: 'connect', label: 'Connect' },
    { id: 'box', label: 'Box' },
    { id: 'person', label: 'Person' },
    { id: 'system', label: 'System' },
    { id: 'database', label: 'DB' },
    { id: 'note', label: 'Note' },
    { id: 'image', label: 'Image' },
  ]

  const showAnchorsFor = (id: string) =>
    !readOnly &&
    (selectedId === id ||
      hoverId === id ||
      linkDrag?.fromId === id ||
      linkDrag?.hoverId === id ||
      tool === 'connect')

  const linkPreviewEnd = useMemo(() => {
    if (!linkDrag) return null
    if (linkDrag.hoverId && linkDrag.hoverAnchor) {
      const n = doc.nodes.find((x) => x.id === linkDrag.hoverId)
      if (n) return anchorPoint(n, linkDrag.hoverAnchor)
    }
    return { x: linkDrag.x, y: linkDrag.y }
  }, [linkDrag, doc.nodes])

  // Keep menu on-screen
  const menuStyle = useMemo(() => {
    if (!contextMenu) return undefined
    const pad = 8
    const w = 220
    const h = contextMenu.edgeId ? 300 : contextMenu.nodeId ? 300 : 240
    const left = Math.min(contextMenu.clientX, window.innerWidth - w - pad)
    const top = Math.min(contextMenu.clientY, window.innerHeight - h - pad)
    return {
      position: 'fixed' as const,
      left: Math.max(pad, left),
      top: Math.max(pad, top),
      zIndex: 1000,
    }
  }, [contextMenu])

  return (
    <div
      ref={editorRootRef}
      className={`bee-editor${compact ? ' bee-editor--compact' : ''}${imageDragging ? ' is-drop-target' : ''}`}
      onDragOver={(e) => {
        if (!readOnly && e.dataTransfer?.types?.includes('Files')) {
          // Remember drop position in diagram coords for placement
          dropWorldRef.current = clientToWorld(e.clientX, e.clientY)
        }
      }}
    >
      {(imageDragging || imageUploading) && !readOnly && (
        <div className="image-drop-overlay" aria-live="polite">
          {imageUploading ? 'Uploading image…' : 'Drop image onto the diagram'}
        </div>
      )}
      {mediaError && !readOnly && (
        <div className="banner error compact">
          {mediaError}{' '}
          <button type="button" className="btn ghost sm" onClick={() => setMediaError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!readOnly && (
        <div className="bee-toolbar">
          <div className="segmented">
            {tools.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tool === t.id ? 'active' : ''}
                onClick={() => {
                  if (t.id === 'image') {
                    setTool('select')
                    setContextMenu(null)
                    dropWorldRef.current = { x: 240, y: 180 }
                    pickImageFiles()
                    return
                  }
                  setTool(t.id)
                  if (t.id !== 'connect') setLinkDrag(null)
                  setContextMenu(null)
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn danger ghost sm" disabled={!selectedId} onClick={deleteSelected}>
            Delete
          </button>
          <label className="bee-snap-toggle" title={`Snap position to ${BEE_GRID_SIZE}px grid`}>
            <input
              type="checkbox"
              checked={snapToGridEnabled}
              onChange={(e) => setSnapToGridEnabled(e.target.checked)}
            />
            <span>Snap to grid</span>
          </label>
          {selectedId && (
            <button
              type="button"
              className="btn sm"
              title="Align selected node position and size to the grid"
              onClick={snapSelectedToGrid}
            >
              Snap selected
            </button>
          )}
          <span className="meta">
            {orthoDrag
              ? 'Drag to reshape right-angle path…'
              : labelEdit
                ? 'Edit label · Enter to save · Esc to cancel'
                : linkDrag
                  ? 'Drop on a target anchor…'
                  : tool === 'connect'
                    ? 'Drag from an anchor (•) to another node'
                    : selectedEdge?.route === 'orthogonal'
                      ? 'Drag square handles on the connection to move segments'
                      : 'Double-click label · right-click connection for line style'}
          </span>
          {['box', 'person', 'system', 'database', 'note'].includes(tool) && (
            <span className="meta">Click canvas to place</span>
          )}
          <span className="meta">Drop or paste images onto the canvas</span>
        </div>
      )}

      <div className={`bee-workspace${compact ? ' bee-workspace--compact' : ''}`}>
        <svg
          ref={svgRef}
          className={`bee-canvas${linkDrag ? ' is-linking' : ''}`}
          viewBox="0 0 960 560"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onContextMenu={(e) => openContextMenu(e)}
          onPointerLeave={() => {
            if (!linkDrag) setHoverId(null)
          }}
        >
          <defs>
            <pattern
              id="bee-grid"
              width={BEE_GRID_SIZE}
              height={BEE_GRID_SIZE}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${BEE_GRID_SIZE} 0 L 0 0 0 ${BEE_GRID_SIZE}`}
                fill="none"
                stroke="currentColor"
                strokeOpacity={snapToGridEnabled ? 0.14 : 0.08}
              />
            </pattern>
            <marker id="bee-arrow-edit" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" />
            </marker>
          </defs>
          <rect width="960" height="560" fill="url(#bee-grid)" />

          {doc.edges.map((e) => {
            const from = doc.nodes.find((n) => n.id === e.from)
            const to = doc.nodes.find((n) => n.id === e.to)
            if (!from || !to) return null
            const { d, mid, points } = edgePathD(from, to, e)
            const active = e.id === selectedEdgeId
            const hovered = e.id === hoverEdgeId
            const isOrtho = (e.route ?? 'straight') === 'orthogonal'
            const handles =
              active && isOrtho && !readOnly ? orthogonalSegmentHandles(points) : []
            return (
              <g
                key={e.id}
                className={`bee-edge${active ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`}
                data-edge-id={e.id}
                onPointerDown={(ev) => {
                  if (readOnly || tool !== 'select') return
                  if ((ev.target as Element).closest('[data-ortho-handle]')) return
                  ev.stopPropagation()
                  setSelectedEdgeId(e.id)
                  setSelectedId(null)
                  setDrag(null)
                }}
                onContextMenu={(ev) => openContextMenu(ev, { edgeId: e.id })}
              >
                {/* Wide hit target */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ cursor: 'pointer' }}
                />
                <path
                  d={d}
                  fill="none"
                  stroke={active ? 'var(--accent, #e6a817)' : 'currentColor'}
                  strokeWidth={active || hovered ? 2.75 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd="url(#bee-arrow-edit)"
                  opacity={active ? 1 : 0.78}
                  style={{ pointerEvents: 'none' }}
                />
                {e.label && (
                  <text x={mid.x} y={mid.y - 6} textAnchor="middle" fontSize={11} style={{ pointerEvents: 'none' }}>
                    {e.label}
                  </text>
                )}
                {handles.map((h) => (
                  <g
                    key={`h-${e.id}-${h.segIndex}`}
                    data-ortho-handle={h.segIndex}
                    className="bee-ortho-handle"
                    transform={`translate(${h.x},${h.y})`}
                    style={{ cursor: h.axis === 'x' ? 'ew-resize' : 'ns-resize' }}
                    onPointerDown={(ev) => {
                      if (readOnly) return
                      ev.stopPropagation()
                      ev.preventDefault()
                      svgRef.current?.setPointerCapture(ev.pointerId)
                      setSelectedEdgeId(e.id)
                      setSelectedId(null)
                      setOrthoDrag({ edgeId: e.id, segIndex: h.segIndex, axis: h.axis })
                    }}
                  >
                    <circle r={11} fill="transparent" />
                    <rect
                      x={-6}
                      y={-6}
                      width={12}
                      height={12}
                      rx={2}
                      className="bee-ortho-handle-box"
                      fill="var(--bg-elevated, #fff)"
                      stroke="var(--accent, #e6a817)"
                      strokeWidth={2}
                    />
                  </g>
                ))}
              </g>
            )
          })}

          {linkDrag && linkPreviewEnd && (
            <g className="bee-link-preview" pointerEvents="none">
              {(() => {
                const from = doc.nodes.find((n) => n.id === linkDrag.fromId)
                if (!from) return null
                const start = anchorPoint(from, linkDrag.fromAnchor)
                return (
                  <>
                    <line
                      x1={start.x}
                      y1={start.y}
                      x2={linkPreviewEnd.x}
                      y2={linkPreviewEnd.y}
                      stroke="var(--accent, #e6a817)"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      markerEnd="url(#bee-arrow-edit)"
                      opacity={0.9}
                    />
                    <circle cx={start.x} cy={start.y} r={5} fill="var(--accent, #e6a817)" />
                    <circle
                      cx={linkPreviewEnd.x}
                      cy={linkPreviewEnd.y}
                      r={5}
                      fill="none"
                      stroke="var(--accent, #e6a817)"
                      strokeWidth={2}
                    />
                  </>
                )
              })()}
            </g>
          )}

          {doc.nodes.map((n) => {
            const active = n.id === selectedId
            const hovered = n.id === hoverId || n.id === linkDrag?.hoverId
            const showAnchors = showAnchorsFor(n.id) && labelEdit?.id !== n.id
            const isEditingLabel = labelEdit?.id === n.id
            const labelBox = inlineLabelBox(n)
            return (
              <g
                key={n.id}
                data-node-id={n.id}
                transform={nodeTransform(n)}
                style={{
                  cursor: isEditingLabel
                    ? 'text'
                    : tool === 'connect' || linkDrag
                      ? 'crosshair'
                      : 'grab',
                }}
                onPointerDown={(ev) => onNodePointerDown(ev, n.id)}
                onDoubleClick={(ev) => {
                  if (readOnly) return
                  ev.stopPropagation()
                  ev.preventDefault()
                  beginLabelEdit(n.id)
                }}
                onContextMenu={(ev) => openContextMenu(ev, { nodeId: n.id })}
                onPointerEnter={() => !linkDrag && setHoverId(n.id)}
              >
                {(active || hovered) && !isEditingLabel && (
                  <rect
                    x={-4}
                    y={-4}
                    width={n.w + 8}
                    height={n.h + 8}
                    rx={14}
                    fill="none"
                    stroke="var(--accent, #e6a817)"
                    strokeWidth={active ? 2 : 1.5}
                    strokeDasharray={active ? '4 3' : undefined}
                    opacity={active ? 1 : 0.55}
                  />
                )}
                <rect width={n.w} height={n.h} fill="transparent" />
                <ShapePrimitives prims={nodePrimitives(n)} />
                {!isEditingLabel && <ShapeLabel node={n} />}

                {isEditingLabel && labelEdit && (
                  <foreignObject
                    x={labelBox.x}
                    y={labelBox.y}
                    width={labelBox.w}
                    height={labelBox.h}
                    data-inline-label=""
                  >
                    <div className="bee-inline-label-wrap" data-inline-label="">
                      {n.type === 'note' ? (
                        <textarea
                          ref={(el) => {
                            labelInputRef.current = el
                          }}
                          className="bee-inline-label-input bee-inline-label-textarea"
                          value={labelEdit.text}
                          rows={3}
                          onChange={(ev) => setLabelEdit({ id: n.id, text: ev.target.value })}
                          onBlur={() => commitLabelEdit()}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Escape') {
                              ev.preventDefault()
                              cancelLabelEdit()
                            }
                            // Ctrl/Cmd+Enter saves multiline note
                            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                              ev.preventDefault()
                              commitLabelEdit()
                            }
                            ev.stopPropagation()
                          }}
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => ev.stopPropagation()}
                        />
                      ) : (
                        <input
                          ref={(el) => {
                            labelInputRef.current = el
                          }}
                          className="bee-inline-label-input"
                          value={labelEdit.text}
                          onChange={(ev) => setLabelEdit({ id: n.id, text: ev.target.value })}
                          onBlur={() => commitLabelEdit()}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') {
                              ev.preventDefault()
                              commitLabelEdit()
                            } else if (ev.key === 'Escape') {
                              ev.preventDefault()
                              cancelLabelEdit()
                            }
                            ev.stopPropagation()
                          }}
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => ev.stopPropagation()}
                        />
                      )}
                    </div>
                  </foreignObject>
                )}

                {showAnchors &&
                  BEE_ANCHORS.map((a) => {
                    const p = anchorLocal(n, a)
                    const isSource = linkDrag?.fromId === n.id && linkDrag.fromAnchor === a
                    const isTarget = linkDrag?.hoverId === n.id && linkDrag.hoverAnchor === a
                    return (
                      <g
                        key={a}
                        data-anchor={a}
                        className={`bee-anchor${isSource ? ' is-source' : ''}${isTarget ? ' is-target' : ''}`}
                        transform={`translate(${p.x},${p.y})`}
                        onPointerDown={(ev) => onAnchorPointerDown(ev, n.id, a)}
                        style={{ cursor: 'crosshair' }}
                      >
                        {/* Larger hit area */}
                        <circle r={12} fill="transparent" />
                        <circle
                          r={isSource || isTarget ? 6 : 5}
                          className="bee-anchor-dot"
                          fill={isSource || isTarget ? 'var(--accent, #e6a817)' : 'var(--bg-elevated, #fff)'}
                          stroke="var(--accent, #e6a817)"
                          strokeWidth={2}
                        />
                      </g>
                    )
                  })}
              </g>
            )
          })}
        </svg>

        {contextMenu && !readOnly && (
          <div
            ref={menuRef}
            className="bee-context-menu"
            style={menuStyle}
            role="menu"
            aria-label={contextMenu.edgeId ? 'Connection options' : 'Diagram context menu'}
          >
            {contextMenu.edgeId ? (
              <>
                <div className="bee-context-menu-heading">Connection</div>
                {BEE_EDGE_ROUTES.map((r) => {
                  const edge = doc.edges.find((x) => x.id === contextMenu.edgeId)
                  const current = edge?.route ?? 'straight'
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="menuitem"
                      className={`bee-context-item${current === r.id ? ' is-active' : ''}`}
                      onClick={() => {
                        if (contextMenu.edgeId) updateEdge(contextMenu.edgeId, { route: r.id })
                        setContextMenu(null)
                      }}
                    >
                      <span className="bee-context-item-label">
                        {current === r.id ? '✓ ' : ''}
                        {r.label}
                      </span>
                      <span className="bee-context-item-hint">{r.hint}</span>
                    </button>
                  )
                })}
                <div className="bee-context-sep" role="separator" />
                {(doc.edges.find((x) => x.id === contextMenu.edgeId)?.route ?? 'straight') ===
                  'orthogonal' && (
                  <button
                    type="button"
                    role="menuitem"
                    className="bee-context-item"
                    onClick={() => {
                      if (contextMenu.edgeId) {
                        updateEdge(contextMenu.edgeId, { route: 'orthogonal', waypoints: undefined })
                      }
                      setContextMenu(null)
                    }}
                  >
                    <span className="bee-context-item-label">Reset path</span>
                    <span className="bee-context-item-hint">Clear custom bend points</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="bee-context-item danger"
                  onClick={() => {
                    if (contextMenu.edgeId) deleteEdgeById(contextMenu.edgeId)
                    setContextMenu(null)
                  }}
                >
                  <span className="bee-context-item-label">Delete connection</span>
                  <span className="bee-context-item-hint">Remove this link</span>
                </button>
              </>
            ) : (
              <>
                <div className="bee-context-menu-heading">Add object</div>
                {ADD_OBJECTS.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    role="menuitem"
                    className="bee-context-item"
                    onClick={() => {
                      if (item.type === 'image') {
                        dropWorldRef.current = {
                          x: contextMenu.worldX,
                          y: contextMenu.worldY,
                        }
                        setContextMenu(null)
                        pickImageFiles()
                        return
                      }
                      placeObjectAt(item.type, contextMenu.worldX, contextMenu.worldY)
                    }}
                  >
                    <span className="bee-context-item-label">{item.label}</span>
                    <span className="bee-context-item-hint">{item.hint}</span>
                  </button>
                ))}
                {contextMenu.nodeId && (
                  <>
                    <div className="bee-context-sep" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="bee-context-item"
                      onClick={() => {
                        const id = contextMenu.nodeId
                        setContextMenu(null)
                        if (id) beginLabelEdit(id)
                      }}
                    >
                      <span className="bee-context-item-label">Edit label</span>
                      <span className="bee-context-item-hint">Rename this object</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="bee-context-item danger"
                      onClick={() => {
                        if (contextMenu.nodeId) deleteNodeById(contextMenu.nodeId)
                        setContextMenu(null)
                      }}
                    >
                      <span className="bee-context-item-label">Delete object</span>
                      <span className="bee-context-item-hint">Remove node &amp; links</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {!readOnly && (
          <aside className="bee-props card">
            <h3>Properties</h3>
            {!selected && !selectedEdge && (
              <p className="muted sm">
                Double-click a node to edit its label. Right-click a connection to change line style
                (straight / curved / right-angle).
              </p>
            )}
            {selectedEdge && !selected && (
              <div className="stack">
                <h4 className="bee-props-sub">Connection</h4>
                <label>
                  Line style
                  <select
                    value={selectedEdge.route ?? 'straight'}
                    onChange={(e) =>
                      updateEdge(selectedEdge.id, { route: e.target.value as BeeEdgeRoute })
                    }
                  >
                    {BEE_EDGE_ROUTES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Label
                  <input
                    value={selectedEdge.label ?? ''}
                    placeholder="Edge label"
                    onChange={(e) => updateEdge(selectedEdge.id, { label: e.target.value })}
                  />
                </label>
                <p className="muted sm">
                  {(selectedEdge.route ?? 'straight') === 'straight' && 'Direct line between anchors.'}
                  {selectedEdge.route === 'curved' && 'Smooth curve leaving each anchor.'}
                  {selectedEdge.route === 'orthogonal' &&
                    '90° segments — drag the square handles on the line to reshape.'}
                </p>
                {selectedEdge.route === 'orthogonal' && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      updateEdge(selectedEdge.id, { route: 'orthogonal', waypoints: undefined })
                    }
                  >
                    Reset path bends
                  </button>
                )}
                <button
                  type="button"
                  className="btn danger ghost sm"
                  onClick={() => deleteEdgeById(selectedEdge.id)}
                >
                  Delete connection
                </button>
              </div>
            )}
            {selected && (
              <div className="stack">
                <label>
                  Label
                  <div className="bee-label-row">
                    <input
                      value={labelEdit?.id === selected.id ? labelEdit.text : selected.label}
                      onChange={(e) => {
                        if (labelEdit?.id === selected.id) {
                          setLabelEdit({ id: selected.id, text: e.target.value })
                        } else {
                          updateNode(selected.id, { label: e.target.value })
                        }
                      }}
                      onFocus={() => {
                        if (labelEdit?.id !== selected.id) beginLabelEdit(selected.id)
                      }}
                      onBlur={() => {
                        if (labelEdit?.id === selected.id) commitLabelEdit()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitLabelEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelLabelEdit()
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn sm"
                      title="Edit label on the shape (F2)"
                      onClick={() => beginLabelEdit(selected.id)}
                    >
                      Inline
                    </button>
                  </div>
                </label>
                <label>
                  Type
                  <select
                    value={selected.type}
                    onChange={(e) =>
                      updateNode(selected.id, { type: e.target.value as BeeNodeType })
                    }
                  >
                    <option value="box">Box</option>
                    <option value="person">Person</option>
                    <option value="system">System</option>
                    <option value="database">Database</option>
                    <option value="note">Note</option>
                    <option value="image">Image</option>
                  </select>
                </label>
                {selected.type === 'image' && (
                  <label>
                    Image URL
                    <input
                      value={selected.imageUrl ?? ''}
                      placeholder="/uploads/…"
                      onChange={(e) => updateNode(selected.id, { imageUrl: e.target.value })}
                    />
                  </label>
                )}
                {selected.type === 'image' && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      dropWorldRef.current = {
                        x: selected.x + selected.w / 2,
                        y: selected.y + selected.h / 2,
                      }
                      // Replace: upload then update node instead of placing new
                      const input = document.createElement('input')
                      input.type = 'file'
                      input.accept = 'image/*'
                      input.onchange = () => {
                        const f = input.files?.[0]
                        if (!f) return
                        void (async () => {
                          try {
                            const { uploadImageFile } = await import('../media/imageIntake')
                            const up = await uploadImageFile(f)
                            const dim = await loadImageSize(up.url)
                            updateNode(selected.id, {
                              imageUrl: up.url,
                              label: up.fileName,
                              w: dim.w,
                              h: dim.h,
                            })
                          } catch (err) {
                            setMediaError(err instanceof Error ? err.message : String(err))
                          }
                        })()
                      }
                      input.click()
                    }}
                  >
                    Replace image…
                  </button>
                )}
                <label>
                  Color
                  <input
                    type="color"
                    value={selected.color || defaultColor(selected.type)}
                    onChange={(e) => updateNode(selected.id, { color: e.target.value })}
                  />
                </label>
                <div className="row">
                  <label>
                    W
                    <input
                      type="number"
                      value={selected.w}
                      min={60}
                      step={snapToGridEnabled ? BEE_GRID_SIZE : 1}
                      onChange={(e) => {
                        let w = Number(e.target.value) || 60
                        if (snapToGridEnabled) w = Math.max(BEE_GRID_SIZE * 2, snapCoord(w))
                        updateNode(selected.id, { w })
                      }}
                    />
                  </label>
                  <label>
                    H
                    <input
                      type="number"
                      value={selected.h}
                      min={40}
                      step={snapToGridEnabled ? BEE_GRID_SIZE : 1}
                      onChange={(e) => {
                        let h = Number(e.target.value) || 40
                        if (snapToGridEnabled) h = Math.max(BEE_GRID_SIZE * 2, snapCoord(h))
                        updateNode(selected.id, { h })
                      }}
                    />
                  </label>
                </div>
                <p className="muted sm">
                  Grid {BEE_GRID_SIZE}px · snap {snapToGridEnabled ? 'on' : 'off'}
                  {snapToGridEnabled ? ' (drag & place lock to cells)' : ''}.
                </p>
                <h4 className="bee-props-sub">Connections</h4>
                {doc.edges.filter((e) => e.from === selected.id || e.to === selected.id).length === 0 && (
                  <p className="muted sm">No edges yet — drag an anchor to another node.</p>
                )}
                {doc.edges
                  .filter((e) => e.from === selected.id || e.to === selected.id)
                  .map((edge) => {
                    const otherId = edge.from === selected.id ? edge.to : edge.from
                    const other = doc.nodes.find((n) => n.id === otherId)
                    const dir = edge.from === selected.id ? 'out' : 'in'
                    return (
                      <div key={edge.id} className="bee-edge-row">
                        <label>
                          {dir === 'out' ? '→' : '←'} {other?.label ?? otherId.slice(0, 6)}
                          <span className="muted sm">
                            {' '}
                            ({edge.fromAnchor ?? 'auto'}→{edge.toAnchor ?? 'auto'})
                          </span>
                          <input
                            value={edge.label ?? ''}
                            placeholder="Edge label"
                            onChange={(ev) =>
                              commit((prev) => ({
                                ...prev,
                                edges: prev.edges.map((x) =>
                                  x.id === edge.id ? { ...x, label: ev.target.value } : x,
                                ),
                              }))
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="btn ghost sm danger"
                          onClick={() =>
                            commit((prev) => ({
                              ...prev,
                              edges: prev.edges.filter((x) => x.id !== edge.id),
                            }))
                          }
                        >
                          Unlink
                        </button>
                      </div>
                    )
                  })}
              </div>
            )}
            {!compact && (
              <>
                <details className="bee-json">
                  <summary>JSON source</summary>
                  <pre>{serializeBeeDoc(doc)}</pre>
                </details>
                <div className="bee-mini-preview">
                  <span className="meta">Thumbnail</span>
                  <BeeDiagramView doc={doc} />
                </div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
