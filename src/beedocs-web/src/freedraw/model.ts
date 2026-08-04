/**
 * Free-draw (sketch) documents stored in ```freedraw fenced blocks on a page.
 *
 * Strokes are polylines in canvas coordinates. The eraser tool either paints
 * with the background (when used as a thick soft stroke) or removes whole
 * strokes that the eraser path intersects — we use stroke-removal for clean
 * vector documents.
 */

export type FreeDrawTool = 'pen' | 'eraser'

export type FreeDrawPoint = { x: number; y: number }

export type FreeDrawStroke = {
  id: string
  tool: FreeDrawTool
  color: string
  size: number
  points: FreeDrawPoint[]
}

export type FreeDrawDoc = {
  version: 1
  width: number
  height: number
  background: string
  strokes: FreeDrawStroke[]
}

export const DEFAULT_FREE_DRAW_WIDTH = 720
export const DEFAULT_FREE_DRAW_HEIGHT = 360
export const DEFAULT_FREE_DRAW_BG = '#ffffff'

export const EMPTY_FREE_DRAW_DOC: FreeDrawDoc = {
  version: 1,
  width: DEFAULT_FREE_DRAW_WIDTH,
  height: DEFAULT_FREE_DRAW_HEIGHT,
  background: DEFAULT_FREE_DRAW_BG,
  strokes: [],
}

export function freeDrawUid(prefix = 's'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function parseFreeDrawDoc(source: string | null | undefined): FreeDrawDoc {
  if (!source?.trim()) return structuredClone(EMPTY_FREE_DRAW_DOC)
  try {
    const raw = JSON.parse(source) as Partial<FreeDrawDoc>
    const width = clampSize(Number(raw.width) || DEFAULT_FREE_DRAW_WIDTH)
    const height = clampSize(Number(raw.height) || DEFAULT_FREE_DRAW_HEIGHT)
    const background =
      typeof raw.background === 'string' && raw.background.trim()
        ? raw.background.trim()
        : DEFAULT_FREE_DRAW_BG
    const strokes = Array.isArray(raw.strokes)
      ? raw.strokes
          .map(normalizeStroke)
          .filter((s): s is FreeDrawStroke => s != null && s.points.length >= 1)
      : []
    return { version: 1, width, height, background, strokes }
  } catch {
    return structuredClone(EMPTY_FREE_DRAW_DOC)
  }
}

export function serializeFreeDrawDoc(doc: FreeDrawDoc): string {
  const clean: FreeDrawDoc = {
    version: 1,
    width: clampSize(doc.width),
    height: clampSize(doc.height),
    background: doc.background || DEFAULT_FREE_DRAW_BG,
    strokes: doc.strokes
      .map(normalizeStroke)
      .filter((s): s is FreeDrawStroke => s != null && s.points.length >= 1)
      .map((s) => ({
        id: s.id,
        tool: s.tool,
        color: s.color,
        size: Math.max(1, Math.round(s.size * 10) / 10),
        points: s.points.map((p) => ({
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
        })),
      })),
  }
  return JSON.stringify(clean)
}

function clampSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FREE_DRAW_WIDTH
  return Math.max(120, Math.min(2400, Math.round(n)))
}

function normalizeStroke(raw: unknown): FreeDrawStroke | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<FreeDrawStroke>
  const points = Array.isArray(s.points)
    ? s.points
        .map((p) => {
          if (!p || typeof p !== 'object') return null
          const x = Number((p as FreeDrawPoint).x)
          const y = Number((p as FreeDrawPoint).y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null
          return { x, y }
        })
        .filter((p): p is FreeDrawPoint => p != null)
    : []
  if (points.length === 0) return null
  const tool: FreeDrawTool = s.tool === 'eraser' ? 'eraser' : 'pen'
  return {
    id: typeof s.id === 'string' && s.id ? s.id : freeDrawUid(),
    tool,
    color: typeof s.color === 'string' && s.color ? s.color : '#141a21',
    size: Math.max(1, Number(s.size) || 3),
    points,
  }
}

/** Build an SVG path `d` from points (M/L). Single point → tiny dot. */
export function strokePathD(points: FreeDrawPoint[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    const p = points[0]
    return `M ${p.x} ${p.y} l 0.01 0`
  }
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`
  }
  return d
}

/**
 * Distance from point to segment AB (for eraser hit tests).
 */
function distToSegment(p: FreeDrawPoint, a: FreeDrawPoint, b: FreeDrawPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const px = a.x + t * dx
  const py = a.y + t * dy
  return Math.hypot(p.x - px, p.y - py)
}

/** True if eraser path comes within `radius` of any segment of the stroke. */
export function strokeHitsEraser(
  stroke: FreeDrawStroke,
  eraserPoints: FreeDrawPoint[],
  eraserSize: number,
): boolean {
  if (eraserPoints.length === 0 || stroke.points.length === 0) return false
  const radius = eraserSize / 2 + stroke.size / 2 + 1
  for (const ep of eraserPoints) {
    if (stroke.points.length === 1) {
      if (Math.hypot(ep.x - stroke.points[0].x, ep.y - stroke.points[0].y) <= radius) return true
      continue
    }
    for (let i = 0; i < stroke.points.length - 1; i++) {
      if (distToSegment(ep, stroke.points[i], stroke.points[i + 1]) <= radius) return true
    }
  }
  // Also test eraser segments against stroke points (dense pen, sparse eraser)
  for (const sp of stroke.points) {
    if (eraserPoints.length === 1) {
      if (Math.hypot(sp.x - eraserPoints[0].x, sp.y - eraserPoints[0].y) <= radius) return true
      continue
    }
    for (let i = 0; i < eraserPoints.length - 1; i++) {
      if (distToSegment(sp, eraserPoints[i], eraserPoints[i + 1]) <= radius) return true
    }
  }
  return false
}

/** Apply eraser path: remove any pen strokes that the path hits. */
export function eraseStrokes(
  strokes: FreeDrawStroke[],
  eraserPoints: FreeDrawPoint[],
  eraserSize: number,
): FreeDrawStroke[] {
  return strokes.filter(
    (s) => s.tool === 'eraser' || !strokeHitsEraser(s, eraserPoints, eraserSize),
  )
}

/**
 * Simplify a polyline by dropping points closer than `minDist` to the previous kept point.
 * Keeps endpoints.
 */
export function simplifyPoints(points: FreeDrawPoint[], minDist = 1.5): FreeDrawPoint[] {
  if (points.length <= 2) return points
  const out: FreeDrawPoint[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]
    const p = points[i]
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= minDist) out.push(p)
  }
  out.push(points[points.length - 1])
  return out
}

/** Render a free-draw document to an SVG string (for preview / PDF export). */
export function freeDrawToSvg(source: string, title?: string): string {
  const doc = parseFreeDrawDoc(source)
  const paths = doc.strokes
    .filter((s) => s.tool === 'pen' && s.points.length > 0)
    .map((s) => {
      const d = strokePathD(s.points)
      return (
        `<path d="${escAttr(d)}" fill="none" stroke="${escAttr(s.color)}" ` +
        `stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"/>`
      )
    })
    .join('')
  const caption = title
    ? `<figcaption style="font-size:0.9rem;color:#555;margin-bottom:0.35em">${escText(title)}</figcaption>`
    : ''
  return (
    `<figure class="export-diagram export-freedraw">` +
    caption +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" ` +
    `viewBox="0 0 ${doc.width} ${doc.height}" role="img">` +
    `<rect width="100%" height="100%" fill="${escAttr(doc.background)}"/>` +
    paths +
    `</svg></figure>`
  )
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
