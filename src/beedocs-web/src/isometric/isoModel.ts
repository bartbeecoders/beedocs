/**
 * BeeDocs' native isometric diagram model (`kind: "isometric"`).
 *
 * Everything sits on an infinite grid of diamond tiles in 2:1 dimetric
 * projection. Items occupy one integer tile each; connectors run between item
 * tiles; zones are rectangles of floor tiles; texts are free-standing labels.
 * Tile x runs toward the lower-right of the screen, tile y toward the
 * lower-left — the same convention as every classic isometric game.
 */

export type IsoTile = { x: number; y: number }

export type IsoItem = {
  id: string
  x: number
  y: number
  /** Shape id from isoShapes.ts (unknown ids draw as a plain block). */
  shape: string
  label?: string
  /** Base colour; the three face shades are derived from it. */
  color?: string
}

export type IsoConnector = {
  id: string
  from: string
  to: string
  label?: string
  color?: string
  dashed?: boolean
}

/** A coloured floor rectangle from tile (x1,y1) to (x2,y2), both inclusive. */
export type IsoZone = {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  label?: string
  color?: string
}

export type IsoText = {
  id: string
  x: number
  y: number
  text: string
}

export type IsoViewport = { x: number; y: number; zoom: number }

export type IsoDoc = {
  version: 1
  items: IsoItem[]
  connectors: IsoConnector[]
  zones: IsoZone[]
  texts: IsoText[]
  viewport?: IsoViewport
}

export const EMPTY_ISO_DOC: IsoDoc = {
  version: 1,
  items: [],
  connectors: [],
  zones: [],
  texts: [],
}

export const DEFAULT_ITEM_COLOR = '#6c8ebf'
export const DEFAULT_ZONE_COLOR = '#82b366'
export const DEFAULT_CONNECTOR_COLOR = '#64707d'

/** Swatches offered in the format panel — draw.io-adjacent, like the studio. */
export const ISO_COLOR_SWATCHES = [
  '#6c8ebf', // blue
  '#82b366', // green
  '#b85450', // red
  '#d79b00', // orange
  '#9673a6', // purple
  '#0d9488', // teal
  '#d6b656', // yellow
  '#647687', // slate
  '#333333', // near-black
]

// ── Projection ───────────────────────────────────────────────────────────────

/** Projected tile size in world pixels (2:1 dimetric). */
export const ISO_TILE_W = 100
export const ISO_TILE_H = 50

/** Tile coordinates (fractional allowed) + height → world point. */
export function tileToWorld(tx: number, ty: number, z = 0): { x: number; y: number } {
  return { x: (tx - ty) * (ISO_TILE_W / 2), y: (tx + ty) * (ISO_TILE_H / 2) - z }
}

/** Inverse of tileToWorld at floor level. */
export function worldToTile(wx: number, wy: number): { x: number; y: number } {
  return { x: wx / ISO_TILE_W + wy / ISO_TILE_H, y: wy / ISO_TILE_H - wx / ISO_TILE_W }
}

export function roundTile(t: { x: number; y: number }): IsoTile {
  return { x: Math.round(t.x), y: Math.round(t.y) }
}

// ── Parse / serialize ────────────────────────────────────────────────────────

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function parseIsoDoc(source: string): IsoDoc {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return structuredClone(EMPTY_ISO_DOC)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return structuredClone(EMPTY_ISO_DOC)
  }
  const o = raw as Record<string, unknown>
  const items: IsoItem[] = Array.isArray(o.items)
    ? (o.items as Record<string, unknown>[])
        .filter((i) => i && typeof i === 'object' && typeof i.id === 'string')
        .map((i) => ({
          id: i.id as string,
          x: Math.round(num(i.x)),
          y: Math.round(num(i.y)),
          shape: str(i.shape) ?? 'block',
          label: str(i.label),
          color: str(i.color),
        }))
    : []
  const itemIds = new Set(items.map((i) => i.id))
  const connectors: IsoConnector[] = Array.isArray(o.connectors)
    ? (o.connectors as Record<string, unknown>[])
        .filter(
          (c) =>
            c &&
            typeof c === 'object' &&
            typeof c.id === 'string' &&
            itemIds.has(c.from as string) &&
            itemIds.has(c.to as string),
        )
        .map((c) => ({
          id: c.id as string,
          from: c.from as string,
          to: c.to as string,
          label: str(c.label),
          color: str(c.color),
          dashed: c.dashed === true ? true : undefined,
        }))
    : []
  const zones: IsoZone[] = Array.isArray(o.zones)
    ? (o.zones as Record<string, unknown>[])
        .filter((z) => z && typeof z === 'object' && typeof z.id === 'string')
        .map((z) => {
          const x1 = Math.round(num(z.x1))
          const y1 = Math.round(num(z.y1))
          const x2 = Math.round(num(z.x2))
          const y2 = Math.round(num(z.y2))
          return {
            id: z.id as string,
            x1: Math.min(x1, x2),
            y1: Math.min(y1, y2),
            x2: Math.max(x1, x2),
            y2: Math.max(y1, y2),
            label: str(z.label),
            color: str(z.color),
          }
        })
    : []
  const texts: IsoText[] = Array.isArray(o.texts)
    ? (o.texts as Record<string, unknown>[])
        .filter((t) => t && typeof t === 'object' && typeof t.id === 'string')
        .map((t) => ({
          id: t.id as string,
          x: Math.round(num(t.x)),
          y: Math.round(num(t.y)),
          text: typeof t.text === 'string' ? t.text : '',
        }))
    : []
  const vp = o.viewport as Record<string, unknown> | undefined
  const viewport: IsoViewport | undefined =
    vp && typeof vp === 'object'
      ? { x: num(vp.x), y: num(vp.y), zoom: Math.min(2.5, Math.max(0.15, num(vp.zoom, 1))) }
      : undefined
  return { version: 1, items, connectors, zones, texts, viewport }
}

export function serializeIsoDoc(doc: IsoDoc): string {
  return JSON.stringify(doc)
}

// ── Bounds ───────────────────────────────────────────────────────────────────

export type WorldRect = { x: number; y: number; w: number; h: number }

/** World-space bounds of everything drawn, for zoom-to-fit and SVG export. */
export function isoContentBounds(doc: IsoDoc): WorldRect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const it of doc.items) {
    const c = tileToWorld(it.x, it.y)
    // room for the tallest shapes above and the label below
    grow(c.x - 62, c.y - 110)
    grow(c.x + 62, c.y + 46)
  }
  for (const z of doc.zones) {
    grow(tileToWorld(z.x1 - 0.5, z.y1 - 0.5).x - 4, tileToWorld(z.x1 - 0.5, z.y1 - 0.5).y - 24)
    for (const [tx, ty] of [
      [z.x1 - 0.5, z.y1 - 0.5],
      [z.x2 + 0.5, z.y1 - 0.5],
      [z.x2 + 0.5, z.y2 + 0.5],
      [z.x1 - 0.5, z.y2 + 0.5],
    ]) {
      const p = tileToWorld(tx, ty)
      grow(p.x - 4, p.y - 4)
      grow(p.x + 4, p.y + 4)
    }
  }
  for (const t of doc.texts) {
    const p = tileToWorld(t.x, t.y)
    const w = Math.max(60, t.text.length * 9)
    grow(p.x - w / 2, p.y - 18)
    grow(p.x + w / 2, p.y + 18)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
