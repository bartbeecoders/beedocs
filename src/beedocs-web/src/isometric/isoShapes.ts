/**
 * The isometric shape library: every glyph is drawn from scratch out of a few
 * primitives, in local world coordinates whose origin is the item's tile
 * centre at floor level (positive y is down, height goes up as negative y).
 *
 * Shapes take one base colour and derive their face shades from it — top face
 * lightest, left (south-west) face near-base, right (south-east) face darkest
 * — so recolouring an item keeps the lighting consistent. Both the editor and
 * the SVG export render the same primitive lists, which is what keeps the PDF
 * output identical to the canvas.
 */
import { ISO_TILE_H, ISO_TILE_W } from './isoModel'

export type IsoPrimitive =
  | {
      kind: 'path'
      d: string
      fill?: string
      stroke?: string
      strokeWidth?: number
      opacity?: number
      dash?: string
      evenOdd?: boolean
    }
  | {
      kind: 'ellipse'
      cx: number
      cy: number
      rx: number
      ry: number
      fill?: string
      stroke?: string
      strokeWidth?: number
      opacity?: number
    }
  | {
      kind: 'text'
      x: number
      y: number
      text: string
      size: number
      fill: string
      bold?: boolean
    }

export type IsoShapeDef = {
  id: string
  label: string
  keywords: string
  draw: (color: string) => IsoPrimitive[]
}

// ── Colour math ──────────────────────────────────────────────────────────────

/** Lighten (f > 0, toward white) or darken (f < 0, toward black) a hex colour. */
export function shade(hex: string, f: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return hex
  const ch = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16)
    const v = f >= 0 ? c + (255 - c) * f : c * (1 + f)
    return Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${ch(0)}${ch(2)}${ch(4)}`
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

const HW = ISO_TILE_W / 2 // 50
const HH = ISO_TILE_H / 2 // 25

/** Project local tile-space offsets (+ height z) to local world pixels. */
export function pt(tx: number, ty: number, z = 0): { x: number; y: number } {
  return { x: (tx - ty) * HW, y: (tx + ty) * HH - z }
}

function poly(points: { x: number; y: number }[]): string {
  return (
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join('') + 'Z'
  )
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

const STROKE = -0.45

type BoxOpts = {
  /** Tile-space centre offset for multi-part shapes. */
  cx?: number
  cy?: number
  /** Raise the whole box off the floor (world px). */
  z0?: number
  /** Override the face shade factors [top, left, right]. */
  shades?: [number, number, number]
}

/**
 * An isometric box with half-extents `a` (along tile x) and `b` (along tile
 * y) in tile units and height `h` in world px: one top face, two visible
 * side faces.
 */
export function isoBox(a: number, b: number, h: number, color: string, o: BoxOpts = {}): IsoPrimitive[] {
  const { cx = 0, cy = 0, z0 = 0 } = o
  const [ft, fl, fr] = o.shades ?? [0.3, -0.04, -0.28]
  const P = (tx: number, ty: number, z: number) => pt(cx + tx, cy + ty, z0 + z)
  const T = P(-a, -b, h)
  const R = P(a, -b, h)
  const B = P(a, b, h)
  const L = P(-a, b, h)
  const Rf = P(a, -b, 0)
  const Bf = P(a, b, 0)
  const Lf = P(-a, b, 0)
  const stroke = shade(color, STROKE)
  return [
    { kind: 'path', d: poly([L, B, Bf, Lf]), fill: shade(color, fl), stroke, strokeWidth: 1 },
    { kind: 'path', d: poly([B, R, Rf, Bf]), fill: shade(color, fr), stroke, strokeWidth: 1 },
    { kind: 'path', d: poly([T, R, B, L]), fill: shade(color, ft), stroke, strokeWidth: 1 },
  ]
}

/** A quad on the left (south-west, constant tile-y) face — for decorations. */
function leftFaceQuad(
  b: number,
  tx1: number,
  tx2: number,
  z1: number,
  z2: number,
  fill: string,
  o: { cx?: number; cy?: number } = {},
): IsoPrimitive {
  const { cx = 0, cy = 0 } = o
  const P = (tx: number, z: number) => pt(cx + tx, cy + b, z)
  return { kind: 'path', d: poly([P(tx1, z2), P(tx2, z2), P(tx2, z1), P(tx1, z1)]), fill }
}

/** A quad on the right (south-east, constant tile-x) face — for decorations. */
function rightFaceQuad(
  a: number,
  ty1: number,
  ty2: number,
  z1: number,
  z2: number,
  fill: string,
  o: { cx?: number; cy?: number } = {},
): IsoPrimitive {
  const { cx = 0, cy = 0 } = o
  const P = (ty: number, z: number) => pt(cx + a, cy + ty, z)
  return { kind: 'path', d: poly([P(ty1, z2), P(ty2, z2), P(ty2, z1), P(ty1, z1)]), fill }
}

/** A flat diamond on top of a box (screens, insets). `inset` in tile units. */
function topInset(a: number, b: number, h: number, inset: number, fill: string, stroke?: string): IsoPrimitive {
  const ia = a - inset
  const ib = b - inset
  return {
    kind: 'path',
    d: poly([pt(-ia, -ib, h), pt(ia, -ib, h), pt(ia, ib, h), pt(-ia, ib, h)]),
    fill,
    stroke,
    strokeWidth: stroke ? 1 : undefined,
  }
}

/**
 * An isometric cylinder of radius `r` (tile units) and height `h`.
 * A circle in the tile plane projects to an ellipse with a 2:1 axis ratio.
 */
export function isoCylinder(r: number, h: number, color: string, z0 = 0): IsoPrimitive[] {
  const rx = round(r * HW * Math.SQRT2)
  const ry = rx / 2
  const stroke = shade(color, STROKE)
  const yTop = -(z0 + h)
  const yBot = -z0
  return [
    {
      kind: 'path',
      d: `M${-rx} ${yTop}L${-rx} ${yBot}A${rx} ${ry} 0 0 0 ${rx} ${yBot}L${rx} ${yTop}A${rx} ${ry} 0 0 1 ${-rx} ${yTop}Z`,
      fill: shade(color, -0.16),
      stroke,
      strokeWidth: 1,
    },
    { kind: 'ellipse', cx: 0, cy: yTop, rx, ry, fill: shade(color, 0.3), stroke, strokeWidth: 1 },
  ]
}

function shadow(rx = 40, opacity = 0.1): IsoPrimitive {
  return { kind: 'ellipse', cx: 0, cy: 0, rx, ry: rx / 2, fill: '#000000', opacity }
}

function person(color: string, cx = 0, cy = 0, scale = 1): IsoPrimitive[] {
  const c = pt(cx, cy)
  const s = scale
  const stroke = shade(color, STROKE)
  return [
    { kind: 'ellipse', cx: c.x, cy: c.y, rx: 26 * s, ry: 13 * s, fill: '#000000', opacity: 0.1 },
    {
      kind: 'path',
      d:
        `M${round(c.x - 17 * s)} ${round(c.y)}` +
        `C${round(c.x - 17 * s)} ${round(c.y - 26 * s)} ${round(c.x + 17 * s)} ${round(c.y - 26 * s)} ${round(c.x + 17 * s)} ${round(c.y)}` +
        `A${round(17 * s)} ${round(8 * s)} 0 0 1 ${round(c.x - 17 * s)} ${round(c.y)}Z`,
      fill: shade(color, -0.08),
      stroke,
      strokeWidth: 1,
    },
    {
      kind: 'ellipse',
      cx: c.x,
      cy: c.y - 34 * s,
      rx: 10.5 * s,
      ry: 10.5 * s,
      fill: shade(color, 0.28),
      stroke,
      strokeWidth: 1,
    },
  ]
}

// ── The catalogue ────────────────────────────────────────────────────────────

export const ISO_SHAPES: Record<string, IsoShapeDef> = {}

function def(id: string, label: string, keywords: string, draw: (color: string) => IsoPrimitive[]) {
  ISO_SHAPES[id] = { id, label, keywords, draw }
}

def('block', 'Block', 'cube box generic component service', (c) => isoBox(0.36, 0.36, 36, c))

def('platform', 'Platform', 'slab base floor layer tier', (c) => isoBox(0.48, 0.48, 10, c))

def('server', 'Server', 'compute host machine tower node', (c) => [
  ...isoBox(0.3, 0.3, 62, c),
  rightFaceQuad(0.3, -0.22, 0.22, 46, 52, shade(c, -0.5)),
  rightFaceQuad(0.3, -0.22, 0.22, 34, 40, shade(c, -0.5)),
  rightFaceQuad(0.3, -0.22, 0.22, 22, 28, shade(c, -0.5)),
  rightFaceQuad(0.3, 0.1, 0.2, 8, 13, '#7ee787'),
])

def('server-rack', 'Server rack', 'rack datacenter cluster blades', (c) => {
  const prims = isoBox(0.34, 0.34, 70, c)
  for (const z of [12, 26, 40, 54]) {
    prims.push(rightFaceQuad(0.34, -0.26, 0.26, z, z + 7, shade(c, -0.48)))
    prims.push(leftFaceQuad(0.34, -0.26, 0.26, z, z + 7, shade(c, -0.34)))
  }
  return prims
})

def('vm', 'Virtual machine', 'vm hypervisor guest instance', (c) => [
  ...isoBox(0.4, 0.4, 24, c),
  topInset(0.4, 0.4, 24, 0.12, shade(c, 0.62), shade(c, -0.2)),
  topInset(0.4, 0.4, 24.5, 0.26, shade(c, 0.16)),
])

def('lambda', 'Function', 'lambda serverless function faas', (c) => [
  ...isoBox(0.36, 0.36, 36, c),
  { kind: 'text', x: pt(0.36, 0, 14).x, y: pt(0.36, 0, 14).y, text: 'λ', size: 22, fill: shade(c, 0.72), bold: true },
])

def('database', 'Database', 'db sql store rdbms persistence', (c) => [
  ...isoCylinder(0.4, 44, c),
  { kind: 'ellipse', cx: 0, cy: -44, rx: 0.4 * HW * Math.SQRT2 - 8, ry: (0.4 * HW * Math.SQRT2 - 8) / 2, fill: shade(c, 0.45) },
])

def('storage', 'Storage', 'disk volume blob bucket archive stack', (c) => [
  ...isoCylinder(0.38, 12, c),
  ...isoCylinder(0.38, 12, c, 16),
  ...isoCylinder(0.38, 12, c, 32),
])

def('cache', 'Cache', 'redis memory fast bolt', (c) => [
  ...isoCylinder(0.4, 16, c),
  {
    kind: 'path',
    d: 'M4 -46L-9 -25L-1 -24L-4 -8L9 -29L1 -30Z',
    fill: '#ffd54a',
    stroke: shade('#ffd54a', -0.45),
    strokeWidth: 1,
  },
])

def('queue', 'Queue', 'message bus topic stream events', (c) => [
  ...isoBox(0.14, 0.14, 18, c, { cx: -0.3, cy: 0.3 }),
  ...isoBox(0.14, 0.14, 18, c, { cx: 0, cy: 0 }),
  ...isoBox(0.14, 0.14, 18, c, { cx: 0.3, cy: -0.3 }),
])

def('cloud', 'Cloud', 'saas internet external hosted', (c) => {
  const stroke = shade(c, STROKE)
  return [
    shadow(36, 0.08),
    { kind: 'ellipse', cx: -20, cy: -42, rx: 24, ry: 14, fill: shade(c, 0.2), stroke, strokeWidth: 1 },
    { kind: 'ellipse', cx: 16, cy: -48, rx: 27, ry: 16, fill: shade(c, 0.32), stroke, strokeWidth: 1 },
    { kind: 'ellipse', cx: 0, cy: -36, rx: 36, ry: 15, fill: shade(c, 0.42), stroke, strokeWidth: 1 },
  ]
})

def('globe', 'Globe', 'network internet world www planet', (c) => {
  const stroke = shade(c, -0.35)
  return [
    shadow(30, 0.1),
    { kind: 'ellipse', cx: 0, cy: -36, rx: 28, ry: 28, fill: shade(c, 0.3), stroke: shade(c, STROKE), strokeWidth: 1 },
    { kind: 'ellipse', cx: 0, cy: -36, rx: 11, ry: 28, fill: 'none', stroke, strokeWidth: 1 },
    { kind: 'ellipse', cx: 0, cy: -36, rx: 28, ry: 10, fill: 'none', stroke, strokeWidth: 1 },
  ]
})

def('router', 'Router', 'gateway routing network hop', (c) => {
  const a1 = pt(-0.26, 0, 18)
  const a2 = pt(0.26, 0, 18)
  const b1 = pt(0, -0.26, 18)
  const b2 = pt(0, 0.26, 18)
  const arrow = (p1: { x: number; y: number }, p2: { x: number; y: number }): IsoPrimitive => {
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const px = -uy
    const py = ux
    const tip = p2
    const base = { x: p2.x - ux * 9, y: p2.y - uy * 9 }
    return {
      kind: 'path',
      d:
        `M${round(p1.x)} ${round(p1.y)}L${round(base.x)} ${round(base.y)}` +
        `M${round(base.x + px * 4.5)} ${round(base.y + py * 4.5)}L${round(tip.x)} ${round(tip.y)}L${round(base.x - px * 4.5)} ${round(base.y - py * 4.5)}Z`,
      fill: shade(c, 0.75),
      stroke: shade(c, 0.75),
      strokeWidth: 2.4,
    }
  }
  return [...isoCylinder(0.4, 14, c), arrow(a1, a2), arrow(b2, b1)]
})

def('switch', 'Switch', 'network lan ports ethernet', (c) => [
  ...isoBox(0.44, 0.28, 13, c),
  rightFaceQuad(0.44, -0.2, -0.1, 4, 9, shade(c, -0.55)),
  rightFaceQuad(0.44, -0.04, 0.06, 4, 9, shade(c, -0.55)),
  rightFaceQuad(0.44, 0.12, 0.22, 4, 9, shade(c, -0.55)),
])

def('firewall', 'Firewall', 'security wall filter waf perimeter', (c) => {
  const prims = isoBox(0.46, 0.14, 46, c)
  const mortar = shade(c, -0.42)
  // brick courses on the left (long) face
  for (const z of [15, 30]) {
    prims.push(leftFaceQuad(0.14, -0.46, 0.46, z, z + 1.6, mortar))
  }
  for (const [tx, z] of [
    [-0.24, 0], [0.12, 0],
    [-0.06, 15], [0.3, 15],
    [-0.24, 30], [0.12, 30],
  ] as const) {
    prims.push(leftFaceQuad(0.14, tx, tx + 0.018, z + 2, z + 13, mortar))
  }
  return prims
})

def('load-balancer', 'Load balancer', 'lb traffic distribute scale', (c) => {
  const from = pt(-0.28, 0.28, 16)
  const mk = (tx: number, ty: number): IsoPrimitive => {
    const to = pt(tx, ty, 16)
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    return {
      kind: 'path',
      d:
        `M${round(from.x)} ${round(from.y)}L${round(to.x - ux * 8)} ${round(to.y - uy * 8)}` +
        `M${round(to.x - ux * 8 - uy * 4)} ${round(to.y - uy * 8 + ux * 4)}L${round(to.x)} ${round(to.y)}L${round(to.x - ux * 8 + uy * 4)} ${round(to.y - uy * 8 - ux * 4)}Z`,
      fill: shade(c, 0.75),
      stroke: shade(c, 0.75),
      strokeWidth: 2.2,
    }
  }
  return [...isoBox(0.42, 0.42, 14, c), mk(0.34, 0.02), mk(0.3, -0.3), mk(0.02, 0.34)]
})

def('user', 'User', 'person actor human client', (c) => person(c))

def('users', 'Users', 'people team group customers', (c) => [
  ...person(c, -0.14, 0.14, 0.86),
  ...person(c, 0.14, -0.14, 0.86),
])

def('building', 'Building', 'office company org enterprise onprem', (c) => {
  const prims = isoBox(0.4, 0.4, 78, c)
  const win = shade(c, 0.55)
  for (const z of [14, 34, 54]) {
    prims.push(leftFaceQuad(0.4, -0.28, -0.06, z, z + 12, win))
    prims.push(leftFaceQuad(0.4, 0.08, 0.3, z, z + 12, win))
    prims.push(rightFaceQuad(0.4, -0.28, -0.06, z, z + 12, shade(c, 0.38)))
    prims.push(rightFaceQuad(0.4, 0.08, 0.3, z, z + 12, shade(c, 0.38)))
  }
  return prims
})

def('laptop', 'Laptop', 'notebook client workstation dev', (c) => {
  const stroke = shade(c, STROKE)
  const lid = [pt(-0.3, -0.24, 6), pt(0.3, -0.24, 6), pt(0.3, -0.42, 44), pt(-0.3, -0.42, 44)]
  const screen = [pt(-0.25, -0.255, 11), pt(0.25, -0.255, 11), pt(0.25, -0.4, 40), pt(-0.25, -0.4, 40)]
  return [
    ...isoBox(0.32, 0.26, 6, c),
    { kind: 'path', d: poly(lid), fill: shade(c, -0.22), stroke, strokeWidth: 1 },
    { kind: 'path', d: poly(screen), fill: shade(c, 0.55) },
  ]
})

def('desktop', 'Desktop', 'monitor screen pc workstation', (c) => {
  const stroke = shade(c, STROKE)
  const screen = [pt(-0.24, -0.02, 16), pt(0.24, -0.02, 16), pt(0.24, -0.02, 46), pt(-0.24, -0.02, 46)]
  return [
    ...isoBox(0.14, 0.1, 6, c),
    ...isoBox(0.3, 0.045, 40, c, { z0: 10 }),
    { kind: 'path', d: poly(screen), fill: shade(c, 0.55), stroke, strokeWidth: 1 },
  ]
})

def('mobile', 'Mobile', 'phone app device handset', (c) => [
  ...isoBox(0.16, 0.05, 36, c),
  rightFaceQuad(0.16, -0.038, 0.038, 5, 31, shade(c, 0.55)),
])

def('lock', 'Lock', 'security secret auth private key', (c) => [
  {
    kind: 'ellipse',
    cx: 0,
    cy: -34,
    rx: 13,
    ry: 12,
    fill: 'none',
    stroke: shade(c, -0.25),
    strokeWidth: 5,
  },
  ...isoBox(0.26, 0.18, 26, c),
])

def('gear', 'Service', 'gear cog settings process worker', (c) => {
  const teeth = 10
  const mk = (cy: number): string => {
    let d = ''
    for (let i = 0; i < teeth * 2; i++) {
      const ang = (i / (teeth * 2)) * Math.PI * 2
      const r = i % 2 === 0 ? 36 : 27
      const x = round(Math.cos(ang) * r)
      const y = round(cy + Math.sin(ang) * r * 0.5)
      d += `${i === 0 ? 'M' : 'L'}${x} ${y}`
    }
    d += 'Z'
    d += `M14 ${cy}A14 7 0 1 0 -14 ${cy}A14 7 0 1 0 14 ${cy}Z`
    return d
  }
  return [
    { kind: 'path', d: mk(-4), fill: shade(c, -0.3), evenOdd: true },
    { kind: 'path', d: mk(-12), fill: shade(c, 0.2), stroke: shade(c, STROKE), strokeWidth: 1, evenOdd: true },
  ]
})

// ── Palette groups ───────────────────────────────────────────────────────────

export type IsoLibraryGroup = { id: string; title: string; shapes: string[] }

export const ISO_SHAPE_LIBRARY: IsoLibraryGroup[] = [
  {
    id: 'iso-compute',
    title: 'Compute',
    shapes: ['server', 'server-rack', 'vm', 'container', 'lambda', 'gear', 'block', 'platform'].filter(
      (s) => s in ISO_SHAPES || s === 'container',
    ),
  },
  { id: 'iso-data', title: 'Data', shapes: ['database', 'storage', 'cache', 'queue'] },
  {
    id: 'iso-network',
    title: 'Network',
    shapes: ['cloud', 'globe', 'router', 'switch', 'firewall', 'load-balancer', 'lock'],
  },
  {
    id: 'iso-clients',
    title: 'People & clients',
    shapes: ['user', 'users', 'building', 'laptop', 'desktop', 'mobile'],
  },
]

// `container` was aspirational; keep the library honest about what exists.
for (const g of ISO_SHAPE_LIBRARY) g.shapes = g.shapes.filter((s) => s in ISO_SHAPES)

export function isoShape(id: string): IsoShapeDef {
  return ISO_SHAPES[id] ?? ISO_SHAPES.block
}

export function searchIsoLibrary(query: string): IsoLibraryGroup[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return ISO_SHAPE_LIBRARY
  return ISO_SHAPE_LIBRARY.map((g) => ({
    ...g,
    shapes: g.shapes.filter((id) => {
      const s = ISO_SHAPES[id]
      const hay = `${s.id} ${s.label} ${s.keywords}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    }),
  })).filter((g) => g.shapes.length > 0)
}
