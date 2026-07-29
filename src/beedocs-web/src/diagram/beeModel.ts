import type { BeeAnchor, BeeDiagramDoc, BeeEdge, BeeEdgeRoute, BeeNode, BeeNodeType, BeePoint } from '../types'

export const BEE_ANCHORS: BeeAnchor[] = ['n', 'e', 's', 'w']

/** Visual + snap grid cell size (matches canvas pattern) */
export const BEE_GRID_SIZE = 24

export function snapToGrid(value: number, grid: number = BEE_GRID_SIZE, enabled = true): number {
  if (!enabled || grid <= 0) return value
  return Math.round(value / grid) * grid
}

export function snapPoint(
  p: { x: number; y: number },
  grid: number = BEE_GRID_SIZE,
  enabled = true,
): { x: number; y: number } {
  return {
    x: snapToGrid(p.x, grid, enabled),
    y: snapToGrid(p.y, grid, enabled),
  }
}

export const BEE_EDGE_ROUTES: { id: BeeEdgeRoute; label: string; hint: string }[] = [
  { id: 'straight', label: 'Straight line', hint: 'Direct line between anchors' },
  { id: 'curved', label: 'Curved line', hint: 'Smooth bezier curve' },
  { id: 'orthogonal', label: 'Right-angle line', hint: '90° horizontal/vertical segments' },
]

export const EMPTY_BEE_DOC: BeeDiagramDoc = {
  version: 1,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
}

export function parseBeeDoc(source: string | undefined | null): BeeDiagramDoc {
  if (!source?.trim()) return structuredClone(EMPTY_BEE_DOC)
  try {
    const raw = JSON.parse(source) as Partial<BeeDiagramDoc>
    return {
      version: 1,
      nodes: Array.isArray(raw.nodes) ? raw.nodes.map(normalizeNode) : [],
      edges: Array.isArray(raw.edges) ? raw.edges.map(normalizeEdge) : [],
      viewport: {
        x: Number(raw.viewport?.x) || 0,
        y: Number(raw.viewport?.y) || 0,
        zoom: Number(raw.viewport?.zoom) || 1,
      },
    }
  } catch {
    return structuredClone(EMPTY_BEE_DOC)
  }
}

export function serializeBeeDoc(doc: BeeDiagramDoc): string {
  return JSON.stringify(doc)
}

const NODE_TYPES: BeeNodeType[] = ['box', 'person', 'system', 'database', 'note', 'image']

function normalizeNode(n: Partial<BeeNode>): BeeNode {
  const type = (n.type as BeeNodeType) || 'box'
  const safeType = NODE_TYPES.includes(type) ? type : 'box'
  return {
    id: String(n.id || uid('n')),
    type: safeType,
    label: String(n.label ?? 'Node'),
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    w: Number(n.w) || defaultSize(safeType).w,
    h: Number(n.h) || defaultSize(safeType).h,
    color: n.color,
    imageUrl: n.imageUrl ? String(n.imageUrl) : undefined,
  }
}

function normalizeAnchor(a: unknown): BeeAnchor | undefined {
  if (a === 'n' || a === 'e' || a === 's' || a === 'w') return a
  return undefined
}

function normalizeRoute(r: unknown): BeeEdgeRoute | undefined {
  if (r === 'straight' || r === 'curved' || r === 'orthogonal') return r
  return undefined
}

function normalizePoint(p: unknown): BeePoint | null {
  if (!p || typeof p !== 'object') return null
  const o = p as { x?: unknown; y?: unknown }
  const x = Number(o.x)
  const y = Number(o.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function normalizeEdge(e: Partial<BeeEdge>): BeeEdge {
  const waypoints = Array.isArray(e.waypoints)
    ? e.waypoints.map(normalizePoint).filter((p): p is BeePoint => p != null)
    : undefined
  return {
    id: String(e.id || uid('e')),
    from: String(e.from || ''),
    to: String(e.to || ''),
    fromAnchor: normalizeAnchor(e.fromAnchor),
    toAnchor: normalizeAnchor(e.toAnchor),
    route: normalizeRoute(e.route),
    waypoints: waypoints && waypoints.length > 0 ? waypoints : undefined,
    label: e.label ? String(e.label) : undefined,
  }
}

export function defaultSize(type: BeeNodeType): { w: number; h: number } {
  switch (type) {
    case 'person':
      return { w: 120, h: 100 }
    case 'database':
      return { w: 120, h: 90 }
    case 'note':
      return { w: 160, h: 100 }
    case 'system':
      return { w: 160, h: 80 }
    case 'image':
      return { w: 220, h: 160 }
    default:
      return { w: 140, h: 72 }
  }
}

export function defaultColor(type: BeeNodeType): string {
  switch (type) {
    case 'person':
      return '#1e3a5f'
    case 'system':
      return '#1d4ed8'
    case 'database':
      return '#0f766e'
    case 'note':
      return '#854d0e'
    case 'image':
      return '#2a2a2e'
    default:
      return '#3f3a32'
  }
}

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function createNode(
  type: BeeNodeType,
  x: number,
  y: number,
  label?: string,
  extras?: { imageUrl?: string; w?: number; h?: number },
): BeeNode {
  const size = defaultSize(type)
  return {
    id: uid('n'),
    type,
    label: label ?? defaultLabel(type),
    x,
    y,
    w: extras?.w ?? size.w,
    h: extras?.h ?? size.h,
    color: defaultColor(type),
    imageUrl: extras?.imageUrl,
  }
}

function defaultLabel(type: BeeNodeType): string {
  switch (type) {
    case 'person':
      return 'Person'
    case 'system':
      return 'System'
    case 'database':
      return 'Database'
    case 'note':
      return 'Note'
    case 'image':
      return 'Image'
    default:
      return 'Component'
  }
}

export function nodeCenter(n: BeeNode): { x: number; y: number } {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
}

/** World-space point for a connector anchor on the node boundary. */
export function anchorPoint(n: BeeNode, anchor: BeeAnchor): { x: number; y: number } {
  switch (anchor) {
    case 'n':
      return { x: n.x + n.w / 2, y: n.y }
    case 'e':
      return { x: n.x + n.w, y: n.y + n.h / 2 }
    case 's':
      return { x: n.x + n.w / 2, y: n.y + n.h }
    case 'w':
      return { x: n.x, y: n.y + n.h / 2 }
  }
}

/** Local (node-space) position for drawing handles inside a translated group. */
export function anchorLocal(n: BeeNode, anchor: BeeAnchor): { x: number; y: number } {
  switch (anchor) {
    case 'n':
      return { x: n.w / 2, y: 0 }
    case 'e':
      return { x: n.w, y: n.h / 2 }
    case 's':
      return { x: n.w / 2, y: n.h }
    case 'w':
      return { x: 0, y: n.h / 2 }
  }
}

export function nearestAnchor(n: BeeNode, worldX: number, worldY: number): BeeAnchor {
  let best: BeeAnchor = 'e'
  let bestDist = Infinity
  for (const a of BEE_ANCHORS) {
    const p = anchorPoint(n, a)
    const d = (p.x - worldX) ** 2 + (p.y - worldY) ** 2
    if (d < bestDist) {
      bestDist = d
      best = a
    }
  }
  return best
}

/** Pick outward-facing sides between two nodes (center-to-center). */
export function bestAnchors(from: BeeNode, to: BeeNode): { fromAnchor: BeeAnchor; toAnchor: BeeAnchor } {
  const a = nodeCenter(from)
  const b = nodeCenter(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromAnchor: 'e', toAnchor: 'w' }
      : { fromAnchor: 'w', toAnchor: 'e' }
  }
  return dy >= 0
    ? { fromAnchor: 's', toAnchor: 'n' }
    : { fromAnchor: 'n', toAnchor: 's' }
}

/** Resolved endpoints for drawing an edge (explicit anchors or inferred). */
export function edgeEndpoints(
  from: BeeNode,
  to: BeeNode,
  edge?: Pick<BeeEdge, 'fromAnchor' | 'toAnchor'>,
): { a: { x: number; y: number }; b: { x: number; y: number }; fromAnchor: BeeAnchor; toAnchor: BeeAnchor } {
  const inferred = bestAnchors(from, to)
  const fromAnchor = edge?.fromAnchor ?? inferred.fromAnchor
  const toAnchor = edge?.toAnchor ?? inferred.toAnchor
  return {
    a: anchorPoint(from, fromAnchor),
    b: anchorPoint(to, toAnchor),
    fromAnchor,
    toAnchor,
  }
}

function outwardNormal(anchor: BeeAnchor): { x: number; y: number } {
  switch (anchor) {
    case 'n':
      return { x: 0, y: -1 }
    case 'e':
      return { x: 1, y: 0 }
    case 's':
      return { x: 0, y: 1 }
    case 'w':
      return { x: -1, y: 0 }
  }
}

export type EdgePathPick = Pick<BeeEdge, 'fromAnchor' | 'toAnchor' | 'route' | 'waypoints'>

/**
 * SVG path `d` for an edge between two nodes, using route style.
 * Defaults to straight when route is omitted.
 */
export function edgePathD(
  from: BeeNode,
  to: BeeNode,
  edge?: EdgePathPick,
): {
  d: string
  mid: BeePoint
  a: BeePoint
  b: BeePoint
  points: BeePoint[]
} {
  const { a, b, fromAnchor, toAnchor } = edgeEndpoints(from, to, edge)
  const route: BeeEdgeRoute = edge?.route ?? 'straight'

  if (route === 'curved') {
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const pull = Math.min(80, Math.max(36, dist * 0.35))
    const n1 = outwardNormal(fromAnchor)
    const n2 = outwardNormal(toAnchor)
    const c1 = { x: a.x + n1.x * pull, y: a.y + n1.y * pull }
    const c2 = { x: b.x + n2.x * pull, y: b.y + n2.y * pull }
    const mid = {
      x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x,
      y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y,
    }
    return {
      d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
      mid,
      a,
      b,
      points: [a, b],
    }
  }

  if (route === 'orthogonal') {
    const pts = orthogonalPolyline(a, b, fromAnchor, toAnchor, edge?.waypoints)
    const d =
      `M ${pts[0].x} ${pts[0].y}` +
      pts
        .slice(1)
        .map((p) => ` L ${p.x} ${p.y}`)
        .join('')
    const mid = polylineMidpoint(pts)
    return { d, mid, a, b, points: pts }
  }

  // straight
  return {
    d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    a,
    b,
    points: [a, b],
  }
}

/** Default + custom-waypoint orthogonal polyline (includes endpoints). */
export function orthogonalPolyline(
  a: BeePoint,
  b: BeePoint,
  fromAnchor: BeeAnchor,
  toAnchor: BeeAnchor,
  waypoints?: BeePoint[],
): BeePoint[] {
  const stub = 18
  const n1 = outwardNormal(fromAnchor)
  const n2 = outwardNormal(toAnchor)
  const p1 = { x: a.x + n1.x * stub, y: a.y + n1.y * stub }
  const p2 = { x: b.x + n2.x * stub, y: b.y + n2.y * stub }

  if (waypoints && waypoints.length > 0) {
    const chain = [p1, ...waypoints.map((w) => ({ x: w.x, y: w.y })), p2]
    const ortho = forceOrthogonalChain(chain)
    return [a, ...ortho, b]
  }

  return defaultOrthogonalPoints(a, b, p1, p2, fromAnchor, toAnchor)
}

function defaultOrthogonalPoints(
  a: BeePoint,
  b: BeePoint,
  p1: BeePoint,
  p2: BeePoint,
  fromAnchor: BeeAnchor,
  toAnchor: BeeAnchor,
): BeePoint[] {
  const fromHoriz = fromAnchor === 'e' || fromAnchor === 'w'
  const toHoriz = toAnchor === 'e' || toAnchor === 'w'

  if (fromHoriz && toHoriz) {
    const midX = (p1.x + p2.x) / 2
    return [a, p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2, b]
  }
  if (!fromHoriz && !toHoriz) {
    const midY = (p1.y + p2.y) / 2
    return [a, p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2, b]
  }
  if (fromHoriz) {
    return [a, p1, { x: p2.x, y: p1.y }, p2, b]
  }
  return [a, p1, { x: p1.x, y: p2.y }, p2, b]
}

/** Snap a chain so consecutive segments are axis-aligned. */
function forceOrthogonalChain(points: BeePoint[]): BeePoint[] {
  if (points.length === 0) return []
  const out: BeePoint[] = [{ ...points[0] }]
  for (let i = 1; i < points.length; i++) {
    const prev = out[i - 1]
    const cur = points[i]
    const dx = Math.abs(cur.x - prev.x)
    const dy = Math.abs(cur.y - prev.y)
    if (dx >= dy) {
      out.push({ x: cur.x, y: prev.y })
    } else {
      out.push({ x: prev.x, y: cur.y })
    }
  }
  // Fix last point to match intended end if we over-snapped (last should keep both coords when possible)
  if (points.length >= 2) {
    const last = points[points.length - 1]
    const prev = out[out.length - 2]
    const dx = Math.abs(last.x - prev.x)
    const dy = Math.abs(last.y - prev.y)
    out[out.length - 1] = dx >= dy ? { x: last.x, y: prev.y } : { x: prev.x, y: last.y }
    // If end still doesn't match last target, add a corner
    const end = out[out.length - 1]
    if (Math.abs(end.x - last.x) > 0.5 || Math.abs(end.y - last.y) > 0.5) {
      out[out.length - 1] = { x: last.x, y: end.y }
      if (Math.abs(out[out.length - 1].y - last.y) > 0.5) {
        out.push({ ...last })
      } else {
        out[out.length - 1] = { ...last }
      }
    }
  }
  return dedupePoints(out)
}

function dedupePoints(pts: BeePoint[]): BeePoint[] {
  const out: BeePoint[] = []
  for (const p of pts) {
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(prev.x - p.x, prev.y - p.y) > 0.5) out.push(p)
  }
  return out
}

export type OrthoSegmentHandle = {
  /** Index of segment start in the polyline (segment is points[i] → points[i+1]) */
  segIndex: number
  x: number
  y: number
  /** Drag axis: vertical segment moves in X; horizontal in Y */
  axis: 'x' | 'y'
}

/** Midpoint handles for each non-trivial orthogonal segment (excluding pure endpoint stubs optional). */
export function orthogonalSegmentHandles(points: BeePoint[]): OrthoSegmentHandle[] {
  const handles: OrthoSegmentHandle[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]
    const q = points[i + 1]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len < 8) continue
    // Skip the very first stub to node and last stub from node only if short; keep mid segments
    // Include all long enough segments so user can reshape the whole path
    const vertical = Math.abs(q.x - p.x) < 0.75
    handles.push({
      segIndex: i,
      x: (p.x + q.x) / 2,
      y: (p.y + q.y) / 2,
      axis: vertical ? 'x' : 'y',
    })
  }
  return handles
}

/**
 * Drag an orthogonal segment: move its free axis, persist new intermediate waypoints
 * (everything between endpoints a/b).
 */
export function moveOrthogonalSegment(
  points: BeePoint[],
  segIndex: number,
  worldX: number,
  worldY: number,
  opts?: { snap?: boolean; grid?: number },
): BeePoint[] {
  if (segIndex < 0 || segIndex >= points.length - 1) return points
  const next = points.map((p) => ({ ...p }))
  const p = next[segIndex]
  const q = next[segIndex + 1]
  const vertical = Math.abs(q.x - p.x) < 0.75
  const snap = opts?.snap ?? false
  const grid = opts?.grid ?? BEE_GRID_SIZE

  if (vertical) {
    const x = snapToGrid(worldX, grid, snap)
    p.x = x
    q.x = x
  } else {
    const y = snapToGrid(worldY, grid, snap)
    p.y = y
    q.y = y
  }

  // Keep neighbors orthogonal: pull adjacent points onto the new axis if needed
  if (segIndex > 0) {
    const prev = next[segIndex - 1]
    if (vertical) {
      // prev→p should stay H or V
      if (Math.abs(prev.y - p.y) < Math.abs(prev.x - p.x)) prev.y = p.y
      else prev.x = p.x
    } else {
      if (Math.abs(prev.x - p.x) < Math.abs(prev.y - p.y)) prev.x = p.x
      else prev.y = p.y
    }
  }
  if (segIndex + 2 < next.length) {
    const n2 = next[segIndex + 2]
    if (vertical) {
      if (Math.abs(n2.y - q.y) < Math.abs(n2.x - q.x)) n2.y = q.y
      else n2.x = q.x
    } else {
      if (Math.abs(n2.x - q.x) < Math.abs(n2.y - q.y)) n2.x = q.x
      else n2.y = q.y
    }
  }

  // Endpoints (node anchors) stay fixed
  next[0] = { ...points[0] }
  next[next.length - 1] = { ...points[points.length - 1] }

  // Re-snap chain between fixed ends
  const mid = forceOrthogonalChain(next.slice(1, -1))
  // Ensure mid starts/ends align with stubs from fixed anchors
  if (mid.length > 0) {
    const a = next[0]
    const b = next[next.length - 1]
    // first mid should be reachable orthogonally from a
    const f = mid[0]
    if (Math.abs(f.x - a.x) > 0.5 && Math.abs(f.y - a.y) > 0.5) {
      mid[0] = Math.abs(f.x - a.x) >= Math.abs(f.y - a.y) ? { x: f.x, y: a.y } : { x: a.x, y: f.y }
    }
    const l = mid[mid.length - 1]
    if (Math.abs(l.x - b.x) > 0.5 && Math.abs(l.y - b.y) > 0.5) {
      mid[mid.length - 1] =
        Math.abs(l.x - b.x) >= Math.abs(l.y - b.y) ? { x: l.x, y: b.y } : { x: b.x, y: l.y }
    }
  }

  return dedupePoints([points[0], ...mid, points[points.length - 1]])
}

/** Intermediate waypoints to store on the edge (exclude endpoints). */
export function waypointsFromPolyline(points: BeePoint[]): BeePoint[] {
  if (points.length <= 2) return []
  return points.slice(1, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
}

function polylineMidpoint(pts: { x: number; y: number }[]): { x: number; y: number } {
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 }
  let total = 0
  const segs: number[] = []
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    segs.push(len)
    total += len
  }
  let remain = total / 2
  for (let i = 1; i < pts.length; i++) {
    const len = segs[i - 1]
    if (remain <= len) {
      const t = len === 0 ? 0 : remain / len
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      }
    }
    remain -= len
  }
  return pts[pts.length - 1]
}

/** Approximate distance from point to polyline (sampled). */
export function distanceToEdgePath(
  from: BeeNode,
  to: BeeNode,
  edge: EdgePathPick,
  x: number,
  y: number,
): number {
  const samples = sampleEdgePath(from, to, edge, 24)
  let best = Infinity
  for (let i = 1; i < samples.length; i++) {
    const dist = distToSegment(x, y, samples[i - 1], samples[i])
    if (dist < best) best = dist
  }
  return best
}

function sampleEdgePath(
  from: BeeNode,
  to: BeeNode,
  edge: EdgePathPick,
  steps: number,
): { x: number; y: number }[] {
  const route = edge.route ?? 'straight'
  const { a, b, fromAnchor, toAnchor } = edgeEndpoints(from, to, edge)
  if (route === 'orthogonal') {
    return orthogonalPolyline(a, b, fromAnchor, toAnchor, edge.waypoints)
  }
  if (route === 'curved') {
    const pull = Math.min(80, Math.max(36, Math.hypot(b.x - a.x, b.y - a.y) * 0.35))
    const n1 = outwardNormal(fromAnchor)
    const n2 = outwardNormal(toAnchor)
    const c1 = { x: a.x + n1.x * pull, y: a.y + n1.y * pull }
    const c2 = { x: b.x + n2.x * pull, y: b.y + n2.y * pull }
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const u = 1 - t
      pts.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      })
    }
    return pts
  }
  return [a, b]
}

function distToSegment(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y)
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

export function hitTestNode(nodes: BeeNode[], worldX: number, worldY: number): BeeNode | null {
  // Top-most last
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (worldX >= n.x && worldX <= n.x + n.w && worldY >= n.y && worldY <= n.y + n.h) {
      return n
    }
  }
  return null
}

export function hitTestEdge(
  nodes: BeeNode[],
  edges: BeeEdge[],
  worldX: number,
  worldY: number,
  threshold = 10,
): BeeEdge | null {
  let best: BeeEdge | null = null
  let bestD = threshold
  for (const e of edges) {
    const from = nodes.find((n) => n.id === e.from)
    const to = nodes.find((n) => n.id === e.to)
    if (!from || !to) continue
    const d = distanceToEdgePath(from, to, e, worldX, worldY)
    if (d <= bestD) {
      bestD = d
      best = e
    }
  }
  return best
}
