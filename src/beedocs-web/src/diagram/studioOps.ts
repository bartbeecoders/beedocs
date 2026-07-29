import type { BeeEdge, BeeNode, BeePoint } from '../types'
import { nodeCenter, rotatePoint, snapToGrid } from './beeModel'

/** Geometry helpers used by the draw.io-style studio canvas. */

export type Rect = { x: number; y: number; w: number; h: number }

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
}

export const MIN_NODE_SIZE = 20

export function nodeRect(n: BeeNode): Rect {
  return { x: n.x, y: n.y, w: n.w, h: n.h }
}

/** Axis-aligned bounds of a set of nodes (ignores rotation for simplicity). */
export function nodesBounds(nodes: BeeNode[]): Rect | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Bounds of everything in the document, including edge bend points. */
export function contentBounds(nodes: BeeNode[], edges: BeeEdge[]): Rect | null {
  const base = nodesBounds(nodes)
  if (!base) return null
  let { x, y } = base
  let maxX = base.x + base.w
  let maxY = base.y + base.h
  for (const e of edges) {
    for (const p of e.waypoints ?? []) {
      x = Math.min(x, p.x)
      y = Math.min(y, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  return { x, y, w: maxX - x, h: maxY - y }
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

/** Local (unrotated) offset of a resize handle inside the node box. */
export function handleLocalPoint(n: BeeNode, h: ResizeHandle): BeePoint {
  const map: Record<ResizeHandle, [number, number]> = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    e: [1, 0.5],
    se: [1, 1],
    s: [0.5, 1],
    sw: [0, 1],
    w: [0, 0.5],
  }
  const [u, v] = map[h]
  return { x: n.x + n.w * u, y: n.y + n.h * v }
}

/** World position of a resize handle (rotation aware). */
export function handleWorldPoint(n: BeeNode, h: ResizeHandle): BeePoint {
  const p = handleLocalPoint(n, h)
  return n.rotation ? rotatePoint(p, nodeCenter(n), n.rotation) : p
}

function oppositeHandle(h: ResizeHandle): ResizeHandle {
  const map: Record<ResizeHandle, ResizeHandle> = {
    nw: 'se',
    n: 's',
    ne: 'sw',
    e: 'w',
    se: 'nw',
    s: 'n',
    sw: 'ne',
    w: 'e',
  }
  return map[h]
}

export type ResizeOptions = {
  snap?: boolean
  grid?: number
  /** Keep the width/height ratio (Shift) */
  keepRatio?: boolean
}

/**
 * New rect for a node being resized by dragging `handle` to `world`.
 * Keeps the opposite corner/edge visually fixed, also when the node is rotated.
 */
export function resizeNodeRect(
  n: BeeNode,
  handle: ResizeHandle,
  world: BeePoint,
  opts: ResizeOptions = {},
): Rect {
  const rotation = n.rotation ?? 0
  const center = nodeCenter(n)
  const anchorWorld = handleWorldPoint(n, oppositeHandle(handle))
  // Work in the unrotated frame
  const p = rotation ? rotatePoint(world, center, -rotation) : world

  let x0 = n.x
  let y0 = n.y
  let x1 = n.x + n.w
  let y1 = n.y + n.h

  const grid = opts.grid ?? 10
  const snap = (v: number) => (opts.snap ? snapToGrid(v, grid, true) : Math.round(v))

  if (handle.includes('w')) x0 = snap(p.x)
  if (handle.includes('e')) x1 = snap(p.x)
  if (handle.includes('n')) y0 = snap(p.y)
  if (handle.includes('s')) y1 = snap(p.y)

  if (x1 - x0 < MIN_NODE_SIZE) {
    if (handle.includes('w')) x0 = x1 - MIN_NODE_SIZE
    else x1 = x0 + MIN_NODE_SIZE
  }
  if (y1 - y0 < MIN_NODE_SIZE) {
    if (handle.includes('n')) y0 = y1 - MIN_NODE_SIZE
    else y1 = y0 + MIN_NODE_SIZE
  }

  let rect: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }

  if (opts.keepRatio && n.w > 0 && n.h > 0) {
    const ratio = n.w / n.h
    if (handle === 'n' || handle === 's') {
      const w = rect.h * ratio
      rect = { ...rect, x: rect.x + (rect.w - w) / 2, w }
    } else if (handle === 'e' || handle === 'w') {
      const h = rect.w / ratio
      rect = { ...rect, y: rect.y + (rect.h - h) / 2, h }
    } else {
      const h = rect.w / ratio
      if (handle.includes('n')) rect = { ...rect, y: rect.y + rect.h - h, h }
      else rect = { ...rect, h }
    }
  }

  if (!rotation) return rect

  // Re-anchor: the opposite handle must stay where it was on screen.
  const newCenter = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  const opp = oppositeHandle(handle)
  const map: Record<ResizeHandle, [number, number]> = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    e: [1, 0.5],
    se: [1, 1],
    s: [0.5, 1],
    sw: [0, 1],
    w: [0, 0.5],
  }
  const [u, v] = map[opp]
  const newAnchorUnrotated = { x: rect.x + rect.w * u, y: rect.y + rect.h * v }
  const newAnchorWorld = rotatePoint(newAnchorUnrotated, newCenter, rotation)
  return {
    ...rect,
    x: rect.x + (anchorWorld.x - newAnchorWorld.x),
    y: rect.y + (anchorWorld.y - newAnchorWorld.y),
  }
}

// ── Alignment guides (draw.io-style snap lines) ───────────────────────────────

export type Guide = {
  orientation: 'v' | 'h'
  /** World coordinate of the guide line */
  pos: number
  /** Span of the line so it visually connects the two shapes */
  from: number
  to: number
}

export type GuideResult = {
  dx: number
  dy: number
  guides: Guide[]
}

/**
 * Snap a moving rect to other rects' edges/centres, returning the correction
 * and the guide lines to draw.
 */
export function computeGuides(moving: Rect, others: Rect[], tolerance = 5): GuideResult {
  let bestX: { delta: number; guide: Guide } | null = null
  let bestY: { delta: number; guide: Guide } | null = null

  const movingXs: { key: 'left' | 'cx' | 'right'; v: number }[] = [
    { key: 'left', v: moving.x },
    { key: 'cx', v: moving.x + moving.w / 2 },
    { key: 'right', v: moving.x + moving.w },
  ]
  const movingYs: { key: 'top' | 'cy' | 'bottom'; v: number }[] = [
    { key: 'top', v: moving.y },
    { key: 'cy', v: moving.y + moving.h / 2 },
    { key: 'bottom', v: moving.y + moving.h },
  ]

  for (const o of others) {
    const oXs = [o.x, o.x + o.w / 2, o.x + o.w]
    const oYs = [o.y, o.y + o.h / 2, o.y + o.h]

    for (const m of movingXs) {
      for (const ox of oXs) {
        const delta = ox - m.v
        if (Math.abs(delta) <= tolerance && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
          bestX = {
            delta,
            guide: {
              orientation: 'v',
              pos: ox,
              from: Math.min(moving.y, o.y) - 12,
              to: Math.max(moving.y + moving.h, o.y + o.h) + 12,
            },
          }
        }
      }
    }
    for (const m of movingYs) {
      for (const oy of oYs) {
        const delta = oy - m.v
        if (Math.abs(delta) <= tolerance && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
          bestY = {
            delta,
            guide: {
              orientation: 'h',
              pos: oy,
              from: Math.min(moving.x, o.x) - 12,
              to: Math.max(moving.x + moving.w, o.x + o.w) + 12,
            },
          }
        }
      }
    }
  }

  const guides: Guide[] = []
  if (bestX) guides.push(bestX.guide)
  if (bestY) guides.push(bestY.guide)
  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides }
}

// ── Align / distribute ────────────────────────────────────────────────────────

export type AlignMode = 'left' | 'centerH' | 'right' | 'top' | 'middleV' | 'bottom'

export function alignNodes(nodes: BeeNode[], mode: AlignMode): Map<string, Partial<BeeNode>> {
  const patch = new Map<string, Partial<BeeNode>>()
  const bounds = nodesBounds(nodes)
  if (!bounds || nodes.length < 2) return patch
  for (const n of nodes) {
    switch (mode) {
      case 'left':
        patch.set(n.id, { x: Math.round(bounds.x) })
        break
      case 'right':
        patch.set(n.id, { x: Math.round(bounds.x + bounds.w - n.w) })
        break
      case 'centerH':
        patch.set(n.id, { x: Math.round(bounds.x + bounds.w / 2 - n.w / 2) })
        break
      case 'top':
        patch.set(n.id, { y: Math.round(bounds.y) })
        break
      case 'bottom':
        patch.set(n.id, { y: Math.round(bounds.y + bounds.h - n.h) })
        break
      case 'middleV':
        patch.set(n.id, { y: Math.round(bounds.y + bounds.h / 2 - n.h / 2) })
        break
    }
  }
  return patch
}

export function distributeNodes(nodes: BeeNode[], axis: 'h' | 'v'): Map<string, Partial<BeeNode>> {
  const patch = new Map<string, Partial<BeeNode>>()
  if (nodes.length < 3) return patch
  const sorted = [...nodes].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const start = axis === 'h' ? first.x + first.w : first.y + first.h
  const end = axis === 'h' ? last.x : last.y
  const inner = sorted.slice(1, -1)
  const totalSize = inner.reduce((sum, n) => sum + (axis === 'h' ? n.w : n.h), 0)
  const gap = (end - start - totalSize) / (inner.length + 1)
  let cursor = start + gap
  for (const n of inner) {
    patch.set(n.id, axis === 'h' ? { x: Math.round(cursor) } : { y: Math.round(cursor) })
    cursor += (axis === 'h' ? n.w : n.h) + gap
  }
  return patch
}

// ── Z-order ───────────────────────────────────────────────────────────────────

export function bringToFront(nodes: BeeNode[], ids: Set<string>): BeeNode[] {
  const keep = nodes.filter((n) => !ids.has(n.id))
  const moved = nodes.filter((n) => ids.has(n.id))
  return [...keep, ...moved]
}

export function sendToBack(nodes: BeeNode[], ids: Set<string>): BeeNode[] {
  const keep = nodes.filter((n) => !ids.has(n.id))
  const moved = nodes.filter((n) => ids.has(n.id))
  return [...moved, ...keep]
}

export function bringForward(nodes: BeeNode[], ids: Set<string>): BeeNode[] {
  const out = [...nodes]
  for (let i = out.length - 2; i >= 0; i--) {
    if (ids.has(out[i].id) && !ids.has(out[i + 1].id)) {
      ;[out[i], out[i + 1]] = [out[i + 1], out[i]]
    }
  }
  return out
}

export function sendBackward(nodes: BeeNode[], ids: Set<string>): BeeNode[] {
  const out = [...nodes]
  for (let i = 1; i < out.length; i++) {
    if (ids.has(out[i].id) && !ids.has(out[i - 1].id)) {
      ;[out[i], out[i - 1]] = [out[i - 1], out[i]]
    }
  }
  return out
}

// ── Edge bend points ──────────────────────────────────────────────────────────

/** Handles for adding/moving bends on straight & curved connections. */
export type BendHandle = {
  /** Index into `waypoints`; -1 means "virtual" (creates a new bend) */
  index: number
  x: number
  y: number
  virtual: boolean
}

export function bendHandles(points: BeePoint[], waypoints: BeePoint[] | undefined): BendHandle[] {
  const out: BendHandle[] = []
  const wps = waypoints ?? []
  wps.forEach((p, i) => out.push({ index: i, x: p.x, y: p.y, virtual: false }))
  // Virtual handles at the midpoint of every segment
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (Math.hypot(b.x - a.x, b.y - a.y) < 30) continue
    out.push({
      index: i,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      virtual: true,
    })
  }
  return out
}

/** Insert a new bend at segment `segIndex` of the rendered polyline. */
export function insertWaypoint(
  waypoints: BeePoint[] | undefined,
  segIndex: number,
  p: BeePoint,
): BeePoint[] {
  const wps = [...(waypoints ?? [])]
  const at = Math.max(0, Math.min(segIndex, wps.length))
  wps.splice(at, 0, { x: Math.round(p.x), y: Math.round(p.y) })
  return wps
}
