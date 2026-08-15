/**
 * Pure world-space geometry shared by the interactive canvas, the read-only
 * view and the SVG/PDF exporter — one source of truth for how a document
 * looks, whoever is drawing it.
 */
import {
  tileToWorld,
  worldToTile,
  type IsoDoc,
  type IsoItem,
  type IsoTile,
  type IsoZone,
} from './isoModel'

function r2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Outline of one tile's floor diamond (optionally grown by `grow` tiles). */
export function tileDiamondPath(tile: IsoTile, grow = 0): string {
  const h = 0.5 + grow
  const pts = [
    tileToWorld(tile.x - h, tile.y - h),
    tileToWorld(tile.x + h, tile.y - h),
    tileToWorld(tile.x + h, tile.y + h),
    tileToWorld(tile.x - h, tile.y + h),
  ]
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${r2(p.x)} ${r2(p.y)}`).join('') + 'Z'
}

/** Floor outline of a zone (tile rectangle, inclusive bounds). */
export function zonePath(z: IsoZone): string {
  const pts = [
    tileToWorld(z.x1 - 0.5, z.y1 - 0.5),
    tileToWorld(z.x2 + 0.5, z.y1 - 0.5),
    tileToWorld(z.x2 + 0.5, z.y2 + 0.5),
    tileToWorld(z.x1 - 0.5, z.y2 + 0.5),
  ]
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${r2(p.x)} ${r2(p.y)}`).join('') + 'Z'
}

/** The four world-space corners of a zone, in x1y1 → x2y1 → x2y2 → x1y2 order. */
export function zoneCorners(z: IsoZone): { x: number; y: number }[] {
  return [
    tileToWorld(z.x1 - 0.5, z.y1 - 0.5),
    tileToWorld(z.x2 + 0.5, z.y1 - 0.5),
    tileToWorld(z.x2 + 0.5, z.y2 + 0.5),
    tileToWorld(z.x1 - 0.5, z.y2 + 0.5),
  ]
}

export type ConnectorGeometry = {
  /** Polyline path for the connector body. */
  d: string
  /** Filled arrow-head polygon at the target end. */
  arrowD: string
  /** Where the label sits (path midpoint). */
  labelAt: { x: number; y: number }
  /** World points of the trimmed polyline, for hit testing. */
  points: { x: number; y: number }[]
}

/**
 * Route a connector between two tiles: straight when aligned, otherwise an
 * L through the corner tile (walk x first, then y), trimmed at both ends so
 * the line meets the shapes instead of disappearing under them.
 */
export function connectorGeometry(from: IsoTile, to: IsoTile): ConnectorGeometry {
  const raw: { x: number; y: number }[] = []
  raw.push(tileToWorld(from.x, from.y))
  if (from.x !== to.x && from.y !== to.y) {
    raw.push(tileToWorld(to.x, from.y))
  }
  raw.push(tileToWorld(to.x, to.y))

  const trim = (a: { x: number; y: number }, b: { x: number; y: number }, dist: number) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    const t = Math.min(dist, len * 0.42) / (len || 1)
    return { x: a.x + dx * t, y: a.y + dy * t }
  }
  const pts = raw.map((p) => ({ ...p }))
  pts[0] = trim(raw[0], raw[1], 30)
  pts[pts.length - 1] = trim(raw[raw.length - 1], raw[raw.length - 2], 34)

  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${r2(p.x)} ${r2(p.y)}`).join('')

  // Arrow head along the final segment
  const end = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  const dx = end.x - prev.x
  const dy = end.y - prev.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const bx = end.x - ux * 11
  const by = end.y - uy * 11
  const arrowD =
    `M${r2(end.x)} ${r2(end.y)}` +
    `L${r2(bx - uy * 5)} ${r2(by + ux * 5)}` +
    `L${r2(bx + uy * 5)} ${r2(by - ux * 5)}Z`

  // Label: midpoint by arc length
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  let want = total / 2
  let labelAt = pts[0]
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (want <= seg) {
      const t = seg === 0 ? 0 : want / seg
      labelAt = {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      }
      break
    }
    want -= seg
  }

  return { d, arrowD, labelAt, points: pts }
}

/** Items back-to-front: painters' algorithm on tile depth (x + y). */
export function sortItemsForPaint(items: IsoItem[]): IsoItem[] {
  return [...items].sort((a, b) => a.x + a.y - (b.x + b.y) || a.x - b.x || a.id.localeCompare(b.id))
}

/** Distance from a point to a polyline, for connector hit testing. */
export function distanceToPolyline(points: { x: number; y: number }[], x: number, y: number): number {
  let best = Infinity
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lenSq))
    const px = a.x + dx * t
    const py = a.y + dy * t
    best = Math.min(best, Math.hypot(x - px, y - py))
  }
  return best
}

/** The item occupying a tile, if any (topmost by paint order). */
export function itemAtTile(doc: IsoDoc, tile: IsoTile): IsoItem | null {
  for (let i = doc.items.length - 1; i >= 0; i--) {
    const it = doc.items[i]
    if (it.x === tile.x && it.y === tile.y) return it
  }
  return null
}

/** True when a point lies inside a zone's floor polygon. */
export function zoneContains(z: IsoZone, wx: number, wy: number): boolean {
  // Inverse-project and compare in tile space — the zone is an axis-aligned
  // rectangle there, which beats point-in-polygon on the projected diamond.
  const t = worldToTile(wx, wy)
  return t.x >= z.x1 - 0.5 && t.x <= z.x2 + 0.5 && t.y >= z.y1 - 0.5 && t.y <= z.y2 + 0.5
}
