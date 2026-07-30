import type {
  BeeArrowHead,
  BeeEdge,
  BeeNode,
  BeeNodeType,
  BeeShape,
  BeeTextAlign,
  BeeTextVAlign,
} from '../types'
import { defaultColor, uid } from './beeModel'

/**
 * Shape rendering shared by the studio editor, the read-only page view and the
 * PDF/SVG export, so a diagram looks the same everywhere.
 *
 * Geometry is emitted as primitives in *node-local* coordinates (0,0 = the
 * shape's top-left corner). Callers wrap them in a translate/rotate group.
 */

/** Legacy `BeeNode.type` renderings kept pixel-identical for old documents. */
export type LegacyShape =
  | 'beeBox'
  | 'beePerson'
  | 'beeSystem'
  | 'beeDatabase'
  | 'beeNote'
  | 'beeImage'

export type RenderShape = BeeShape | LegacyShape

export type BeePrim =
  | {
      k: 'rect'
      x: number
      y: number
      w: number
      h: number
      rx?: number
      fill?: string
      stroke?: string
      sw?: number
      dash?: string
      opacity?: number
    }
  | {
      k: 'ellipse'
      cx: number
      cy: number
      rx: number
      ry: number
      fill?: string
      stroke?: string
      sw?: number
      dash?: string
      opacity?: number
    }
  | {
      k: 'path'
      d: string
      fill?: string
      stroke?: string
      sw?: number
      dash?: string
      opacity?: number
    }
  | { k: 'image'; href: string; x: number; y: number; w: number; h: number; opacity?: number }
  /** Fixed decoration text (stereotypes, placeholders) — not the node label */
  | {
      k: 'text'
      x: number
      y: number
      text: string
      size: number
      color: string
      weight?: number
      anchor?: 'start' | 'middle' | 'end'
      opacity?: number
    }

export type ResolvedNodeStyle = {
  fill: string
  /**
   * Secondary fill for multi-part shapes. Always set after resolve:
   * either the explicit `style.fill2` or a shape-aware fallback.
   */
  fill2: string
  stroke: string
  strokeWidth: number
  dash?: string
  opacity: number
  shadow: boolean
  fontSize: number
  fontColor: string
  bold: boolean
  italic: boolean
  align: BeeTextAlign
  valign: BeeTextVAlign
}

/** A named fill slot shown in the Format panel for multi-part shapes. */
export type ShapeFillPart = {
  key: 'fill' | 'fill2'
  label: string
}

/**
 * Fill colour slots for a shape. Most shapes have a single "Fill"; multi-part
 * shapes (container, cube, note, cylinder, …) expose a second colour.
 */
export function shapeFillParts(shape: RenderShape): ShapeFillPart[] {
  switch (shape) {
    case 'container':
      return [
        { key: 'fill', label: 'Header' },
        { key: 'fill2', label: 'Body' },
      ]
    case 'cube':
      return [
        { key: 'fill', label: 'Front' },
        { key: 'fill2', label: 'Top / side' },
      ]
    case 'note':
    case 'beeNote':
      return [
        { key: 'fill', label: 'Paper' },
        { key: 'fill2', label: 'Fold' },
      ]
    case 'cylinder':
    case 'beeDatabase':
      return [
        { key: 'fill', label: 'Body' },
        { key: 'fill2', label: 'Top' },
      ]
    default:
      return [{ key: 'fill', label: 'Fill' }]
  }
}

export type LabelBox = {
  x: number
  y: number
  w: number
  h: number
  align: BeeTextAlign
  valign: BeeTextVAlign
}

export const STUDIO_DEFAULT_FILL = '#ffffff'
export const STUDIO_DEFAULT_STROKE = '#141a21'
export const STUDIO_DEFAULT_FONT_COLOR = '#111827'
export const STUDIO_DEFAULT_FONT_SIZE = 12
export const STUDIO_DEFAULT_EDGE_COLOR = '#141a21'

const LEGACY_SHAPES: Record<BeeNodeType, LegacyShape> = {
  box: 'beeBox',
  person: 'beePerson',
  system: 'beeSystem',
  database: 'beeDatabase',
  note: 'beeNote',
  image: 'beeImage',
}

export function isLegacyShape(shape: RenderShape): shape is LegacyShape {
  return shape.startsWith('bee')
}

/** Which geometry to draw for a node — explicit shape wins over the legacy type. */
export function resolveShape(n: Pick<BeeNode, 'shape' | 'type'>): RenderShape {
  if (n.shape) return n.shape
  return LEGACY_SHAPES[n.type] ?? 'beeBox'
}

export function defaultShapeSize(shape: RenderShape): { w: number; h: number } {
  switch (shape) {
    case 'circle':
      return { w: 100, h: 100 }
    case 'ellipse':
      return { w: 140, h: 80 }
    case 'rhombus':
      return { w: 120, h: 80 }
    case 'triangle':
      return { w: 80, h: 100 }
    case 'text':
      return { w: 120, h: 40 }
    case 'actor':
      return { w: 60, h: 90 }
    case 'cylinder':
      return { w: 120, h: 100 }
    case 'cloud':
      return { w: 160, h: 100 }
    case 'note':
    case 'card':
      return { w: 140, h: 100 }
    case 'callout':
      return { w: 160, h: 90 }
    case 'container':
      return { w: 300, h: 200 }
    case 'stadium':
      return { w: 140, h: 60 }
    case 'image':
      return { w: 200, h: 150 }
    case 'cube':
      return { w: 140, h: 100 }
    case 'dataStorage':
      return { w: 140, h: 70 }
    case 'document':
    case 'tape':
      return { w: 140, h: 90 }
    default:
      return { w: 140, h: 70 }
  }
}

/** Fill/stroke/font actually used to draw a node. */
export function resolveNodeStyle(n: BeeNode): ResolvedNodeStyle {
  const shape = resolveShape(n)
  const s = n.style ?? {}
  const legacy = isLegacyShape(shape)
  const legacyFill = n.color || defaultColor(n.type)

  const fill = legacy
    ? (s.fill ?? legacyFill)
    : (s.fill ?? n.color ?? defaultShapeFill(shape))

  const base: ResolvedNodeStyle = legacy
    ? {
        fill,
        fill2: s.fill2 ?? defaultShapeFill2(shape, fill),
        stroke: s.stroke ?? 'none',
        strokeWidth: s.strokeWidth ?? 1,
        opacity: s.opacity ?? 100,
        shadow: s.shadow ?? false,
        fontSize: s.fontSize ?? (shape === 'beeBox' ? 13 : shape === 'beeImage' ? 11 : 12),
        fontColor: s.fontColor ?? '#ffffff',
        bold: s.bold ?? true,
        italic: s.italic ?? false,
        align: s.align ?? (shape === 'beeNote' ? 'left' : 'center'),
        valign: s.valign ?? legacyVAlign(shape),
      }
    : {
        fill,
        fill2: s.fill2 ?? defaultShapeFill2(shape, fill),
        stroke: s.stroke ?? defaultShapeStroke(shape),
        strokeWidth: s.strokeWidth ?? 1,
        opacity: s.opacity ?? 100,
        shadow: s.shadow ?? false,
        fontSize: s.fontSize ?? STUDIO_DEFAULT_FONT_SIZE,
        fontColor: s.fontColor ?? STUDIO_DEFAULT_FONT_COLOR,
        bold: s.bold ?? false,
        italic: s.italic ?? false,
        align: s.align ?? (shape === 'text' || shape === 'container' ? 'left' : 'center'),
        valign: s.valign ?? defaultVAlign(shape),
      }

  if (s.dashed) base.dash = '6 4'
  return base
}

/**
 * Fallback secondary fill when `style.fill2` is unset.
 * Prefers the primary fill so older single-colour documents look unchanged;
 * only a few shapes get a distinct default (note fold highlight, cube depth).
 */
function defaultShapeFill2(shape: RenderShape, fill: string): string {
  switch (shape) {
    case 'note':
    case 'beeNote':
      return 'rgba(255,255,255,0.28)'
    case 'cube':
      return shadeHex(fill, -0.12)
    case 'container':
      // Distinct body so header/body read as two parts on a new container.
      // Explicit fill2 on the node still wins via resolveNodeStyle.
      return fill === defaultShapeFill('container') ? '#ffffff' : fill
    default:
      return fill
  }
}

/** Lighten (+) / darken (−) a #rrggbb colour. Non-hex values are returned as-is. */
function shadeHex(color: string, amount: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  const t = amount >= 0 ? 255 : 0
  const p = Math.abs(amount)
  const mix = (c: number) => clamp(c + (t - c) * p)
  const hex = (c: number) => mix(c).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function legacyVAlign(shape: LegacyShape): BeeTextVAlign {
  if (shape === 'beePerson' || shape === 'beeImage') return 'bottom'
  if (shape === 'beeNote') return 'top'
  return 'middle'
}

function defaultVAlign(shape: RenderShape): BeeTextVAlign {
  if (shape === 'actor' || shape === 'image') return 'bottom'
  if (shape === 'container') return 'top'
  return 'middle'
}

function defaultShapeFill(shape: RenderShape): string {
  if (shape === 'text' || shape === 'actor') return 'none'
  if (shape === 'container') return '#f8fafc'
  return STUDIO_DEFAULT_FILL
}

function defaultShapeStroke(shape: RenderShape): string {
  if (shape === 'text') return 'none'
  return STUDIO_DEFAULT_STROKE
}

/** Region of the shape that holds the label, in node-local coordinates. */
export function nodeLabelBox(n: BeeNode): LabelBox {
  const shape = resolveShape(n)
  const st = resolveNodeStyle(n)
  const { w, h } = n
  const pad = 6

  switch (shape) {
    case 'beePerson':
      return { x: pad, y: h - 34, w: Math.max(20, w - pad * 2), h: 28, align: 'center', valign: 'middle' }
    case 'beeNote':
      return { x: 10, y: 12, w: Math.max(20, w - 28), h: Math.max(20, h - 24), align: 'left', valign: 'top' }
    case 'beeImage':
      return { x: pad, y: h - 22, w: Math.max(20, w - pad * 2), h: 18, align: 'center', valign: 'middle' }
    case 'beeSystem':
      return { x: pad, y: 16, w: Math.max(20, w - pad * 2), h: Math.max(20, h - 22), align: 'center', valign: 'middle' }
    case 'actor':
      // Sits just below the figure, like draw.io's bottom label position
      return { x: -20, y: h + 2, w: w + 40, h: 18, align: 'center', valign: 'middle' }
    case 'image':
      return { x: 0, y: h - 20, w, h: 20, align: 'center', valign: 'middle' }
    case 'container':
      return { x: 10, y: 4, w: Math.max(20, w - 20), h: 24, align: st.align, valign: 'middle' }
    case 'note':
    case 'card':
      return { x: 10, y: 10, w: Math.max(20, w - 26), h: Math.max(20, h - 20), align: st.align, valign: st.valign }
    case 'callout':
      return { x: 10, y: 6, w: Math.max(20, w - 20), h: Math.max(20, h * 0.78 - 10), align: st.align, valign: st.valign }
    case 'cylinder':
      return { x: pad, y: 16, w: Math.max(20, w - pad * 2), h: Math.max(20, h - 28), align: st.align, valign: st.valign }
    case 'rhombus':
    case 'triangle':
      return { x: w * 0.18, y: h * 0.2, w: w * 0.62, h: h * 0.6, align: st.align, valign: st.valign }
    case 'cube':
      return { x: pad, y: h * 0.18, w: Math.max(20, w - w * 0.16 - pad * 2), h: Math.max(20, h * 0.7), align: st.align, valign: st.valign }
    case 'text':
      return { x: 2, y: 2, w: Math.max(20, w - 4), h: Math.max(16, h - 4), align: st.align, valign: st.valign }
    default:
      return { x: pad, y: pad, w: Math.max(20, w - pad * 2), h: Math.max(16, h - pad * 2), align: st.align, valign: st.valign }
  }
}

/** Greedy word wrap with an average-glyph-width estimate (no DOM measuring). */
export function wrapLabelLines(text: string, maxWidth: number, fontSize: number, bold = false): string[] {
  const charW = fontSize * (bold ? 0.585 : 0.545)
  const maxChars = Math.max(4, Math.floor(maxWidth / charW))
  const out: string[] = []
  for (const rawLine of String(text ?? '').split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (candidate.length <= maxChars) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      if (word.length <= maxChars) {
        line = word
      } else {
        // Break very long words
        let rest = word
        while (rest.length > maxChars) {
          out.push(rest.slice(0, maxChars))
          rest = rest.slice(maxChars)
        }
        line = rest
      }
    }
    if (line) out.push(line)
  }
  return out.length > 0 ? out : ['']
}

export type LabelLayout = {
  lines: string[]
  /** x for the text element (depends on anchor) */
  x: number
  /** baseline y of the first line */
  y: number
  anchor: 'start' | 'middle' | 'end'
  lineHeight: number
  style: ResolvedNodeStyle
}

export function nodeLabelLayout(n: BeeNode): LabelLayout | null {
  const label = n.label?.trim()
  if (!label) return null
  const style = resolveNodeStyle(n)
  const box = nodeLabelBox(n)
  const lines = wrapLabelLines(n.label, box.w, style.fontSize, style.bold)
  const lineHeight = style.fontSize * 1.28
  const blockH = lines.length * lineHeight

  let top: number
  if (box.valign === 'top') top = box.y
  else if (box.valign === 'bottom') top = box.y + box.h - blockH
  else top = box.y + (box.h - blockH) / 2

  const anchor = box.align === 'left' ? 'start' : box.align === 'right' ? 'end' : 'middle'
  const x = box.align === 'left' ? box.x : box.align === 'right' ? box.x + box.w : box.x + box.w / 2

  return {
    lines,
    x,
    // baseline of first line: top + ascent
    y: top + style.fontSize * 0.92,
    anchor,
    lineHeight,
    style,
  }
}

/** Shape outline + decorations (no label) in node-local coordinates. */
export function nodePrimitives(n: BeeNode): BeePrim[] {
  const shape = resolveShape(n)
  const st = resolveNodeStyle(n)
  const w = Math.max(1, n.w)
  const h = Math.max(1, n.h)
  const fill = st.fill
  const fill2 = st.fill2
  const stroke = st.stroke
  const sw = st.strokeWidth
  const dash = st.dash
  const body = { fill, stroke, sw, dash }

  switch (shape) {
    // ── Legacy BeeDocs shapes (unchanged look) ───────────────────────────────
    case 'beePerson':
      return [
        { k: 'rect', x: 0, y: 0, w, h, rx: 10, fill, stroke, sw: stroke === 'none' ? 0 : sw, dash },
        { k: 'ellipse', cx: w / 2, cy: 28, rx: 12, ry: 12, fill: 'rgba(255,255,255,0.9)' },
        {
          k: 'path',
          d: `M ${w / 2 - 16} ${h - 30} Q ${w / 2} ${h - 52} ${w / 2 + 16} ${h - 30}`,
          fill: 'none',
          stroke: 'rgba(255,255,255,0.9)',
          sw: 4,
        },
      ]
    case 'beeDatabase':
      return [
        { k: 'ellipse', cx: w / 2, cy: 14, rx: Math.max(2, w / 2 - 4), ry: 12, fill: fill2 },
        { k: 'rect', x: 4, y: 14, w: Math.max(1, w - 8), h: Math.max(1, h - 28), fill },
        { k: 'ellipse', cx: w / 2, cy: h - 14, rx: Math.max(2, w / 2 - 4), ry: 12, fill },
        {
          k: 'ellipse',
          cx: w / 2,
          cy: 14,
          rx: Math.max(2, w / 2 - 4),
          ry: 12,
          fill: 'none',
          stroke: stroke === 'none' ? undefined : stroke,
          sw: stroke === 'none' ? undefined : sw,
          dash,
        },
      ]
    case 'beeNote':
      return [
        { k: 'path', d: `M0 0 H${w - 16} L${w} 16 V${h} H0 Z`, fill },
        { k: 'path', d: `M${w - 16} 0 V16 H${w} Z`, fill: fill2 },
      ]
    case 'beeImage':
      return [
        { k: 'rect', x: 0, y: 0, w, h, rx: 8, fill, opacity: 35 },
        ...(n.imageUrl
          ? [{ k: 'image' as const, href: n.imageUrl, x: 4, y: 4, w: Math.max(1, w - 8), h: Math.max(1, h - 28) }]
          : [
              {
                k: 'text' as const,
                x: w / 2,
                y: h / 2,
                text: 'No image',
                size: 12,
                color: '#ffffff',
                anchor: 'middle' as const,
                opacity: 80,
              },
            ]),
      ]
    case 'beeSystem':
      return [
        { k: 'rect', x: 0, y: 0, w, h, rx: 8, fill },
        {
          k: 'text',
          x: 10,
          y: 16,
          text: '«system»',
          size: 9,
          color: 'rgba(255,255,255,0.65)',
        },
      ]
    case 'beeBox':
      return [{ k: 'rect', x: 0, y: 0, w, h, rx: 12, fill }]

    // ── Draw.io-style shapes ────────────────────────────────────────────────
    case 'rectangle':
      return [{ k: 'rect', x: 0, y: 0, w, h, ...body }]
    case 'rounded':
      return [{ k: 'rect', x: 0, y: 0, w, h, rx: Math.min(20, Math.min(w, h) * 0.18), ...body }]
    case 'stadium':
      return [{ k: 'rect', x: 0, y: 0, w, h, rx: h / 2, ...body }]
    case 'text':
      return []
    case 'ellipse':
    case 'circle':
      return [{ k: 'ellipse', cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...body }]
    case 'triangle':
      return [{ k: 'path', d: `M0 0 L${w} ${h / 2} L0 ${h} Z`, ...body }]
    case 'rhombus':
      return [{ k: 'path', d: `M${w / 2} 0 L${w} ${h / 2} L${w / 2} ${h} L0 ${h / 2} Z`, ...body }]
    case 'parallelogram': {
      const s = Math.min(w * 0.22, 40)
      return [{ k: 'path', d: `M${s} 0 H${w} L${w - s} ${h} H0 Z`, ...body }]
    }
    case 'trapezoid': {
      const s = Math.min(w * 0.22, 40)
      return [{ k: 'path', d: `M${s} 0 H${w - s} L${w} ${h} H0 Z`, ...body }]
    }
    case 'hexagon': {
      const s = Math.min(w * 0.22, h / 2)
      return [
        { k: 'path', d: `M${s} 0 H${w - s} L${w} ${h / 2} L${w - s} ${h} H${s} L0 ${h / 2} Z`, ...body },
      ]
    }
    case 'step': {
      const s = Math.min(w * 0.22, 40)
      return [
        {
          k: 'path',
          d: `M0 0 H${w - s} L${w} ${h / 2} L${w - s} ${h} H0 L${s} ${h / 2} Z`,
          ...body,
        },
      ]
    }
    case 'process': {
      const inset = Math.min(w * 0.12, 20)
      return [
        { k: 'rect', x: 0, y: 0, w, h, ...body },
        { k: 'path', d: `M${inset} 0 V${h}`, fill: 'none', stroke, sw, dash },
        { k: 'path', d: `M${w - inset} 0 V${h}`, fill: 'none', stroke, sw, dash },
      ]
    }
    case 'document': {
      const wave = h * 0.18
      return [
        {
          k: 'path',
          d:
            `M0 0 H${w} V${h - wave} ` +
            `C${w * 0.75} ${h - wave * 2.1} ${w * 0.25} ${h + wave * 0.6} 0 ${h - wave} Z`,
          ...body,
        },
      ]
    }
    case 'tape': {
      const wave = h * 0.14
      return [
        {
          k: 'path',
          d:
            `M0 ${wave} C${w * 0.25} ${-wave * 0.6} ${w * 0.75} ${wave * 2.1} ${w} ${wave} ` +
            `V${h - wave} C${w * 0.75} ${h + wave * 0.6} ${w * 0.25} ${h - wave * 2.1} 0 ${h - wave} Z`,
          ...body,
        },
      ]
    }
    case 'card': {
      const c = Math.min(w, h) * 0.22
      return [{ k: 'path', d: `M${c} 0 H${w} V${h} H0 V${c} Z`, ...body }]
    }
    case 'callout': {
      const bodyH = h * 0.78
      const tailX = w * 0.22
      return [
        {
          k: 'path',
          d:
            `M6 0 H${w - 6} Q${w} 0 ${w} 6 V${bodyH - 6} Q${w} ${bodyH} ${w - 6} ${bodyH} ` +
            `H${tailX + 26} L${tailX} ${h} L${tailX + 8} ${bodyH} H6 Q0 ${bodyH} 0 ${bodyH - 6} V6 Q0 0 6 0 Z`,
          ...body,
        },
      ]
    }
    case 'note': {
      const f = Math.min(24, Math.min(w, h) * 0.28)
      return [
        { k: 'path', d: `M0 0 H${w - f} L${w} ${f} V${h} H0 Z`, fill, stroke, sw, dash },
        { k: 'path', d: `M${w - f} 0 V${f} H${w} Z`, fill: fill2, stroke, sw, dash },
      ]
    }
    case 'cube': {
      const d = Math.min(w, h) * 0.18
      // Front uses primary fill; top + right side share the secondary fill.
      return [
        { k: 'path', d: `M0 ${d} H${w - d} V${h} H0 Z`, fill, stroke, sw, dash },
        { k: 'path', d: `M0 ${d} L${d} 0 H${w} L${w - d} ${d} Z`, fill: fill2, stroke, sw, dash },
        {
          k: 'path',
          d: `M${w - d} ${d} L${w} 0 V${h - d} L${w - d} ${h} Z`,
          fill: fill2,
          stroke,
          sw,
          dash,
        },
      ]
    }
    case 'cylinder': {
      const ry = Math.min(h * 0.18, 22)
      return [
        {
          k: 'path',
          d:
            `M0 ${ry} A${w / 2} ${ry} 0 0 1 ${w} ${ry} V${h - ry} ` +
            `A${w / 2} ${ry} 0 0 1 0 ${h - ry} Z`,
          fill,
          stroke,
          sw,
          dash,
        },
        {
          k: 'ellipse',
          cx: w / 2,
          cy: ry,
          rx: w / 2,
          ry,
          fill: fill2,
          stroke,
          sw,
          dash,
        },
      ]
    }
    case 'internalStorage': {
      const inset = Math.min(18, w * 0.16)
      const insetY = Math.min(18, h * 0.22)
      return [
        { k: 'rect', x: 0, y: 0, w, h, ...body },
        { k: 'path', d: `M${inset} 0 V${h}`, fill: 'none', stroke, sw, dash },
        { k: 'path', d: `M0 ${insetY} H${w}`, fill: 'none', stroke, sw, dash },
      ]
    }
    case 'dataStorage': {
      const c = Math.min(w * 0.16, 26)
      return [
        {
          k: 'path',
          d: `M${c} 0 H${w} A${c} ${h / 2} 0 0 0 ${w} ${h} H${c} A${c} ${h / 2} 0 0 1 ${c} 0 Z`,
          ...body,
        },
      ]
    }
    case 'cloud':
      return [
        {
          k: 'path',
          d:
            `M${w * 0.25} ${h} ` +
            `A${w * 0.19} ${h * 0.26} 0 0 1 ${w * 0.15} ${h * 0.52} ` +
            `A${w * 0.2} ${h * 0.28} 0 0 1 ${w * 0.36} ${h * 0.22} ` +
            `A${w * 0.22} ${h * 0.3} 0 0 1 ${w * 0.72} ${h * 0.2} ` +
            `A${w * 0.2} ${h * 0.26} 0 0 1 ${w * 0.9} ${h * 0.55} ` +
            `A${w * 0.17} ${h * 0.24} 0 0 1 ${w * 0.78} ${h} Z`,
          ...body,
        },
      ]
    case 'actor': {
      const headR = Math.min(w * 0.28, h * 0.18)
      const cx = w / 2
      const headY = headR + 2
      const bodyTop = headY + headR
      const bodyBottom = h * 0.62
      return [
        { k: 'ellipse', cx, cy: headY, rx: headR, ry: headR, fill: fill === 'none' ? 'none' : fill, stroke: stroke === 'none' ? STUDIO_DEFAULT_STROKE : stroke, sw: Math.max(1.4, sw), dash },
        {
          k: 'path',
          d:
            `M${cx} ${bodyTop} V${bodyBottom} ` +
            `M${cx - w * 0.4} ${bodyTop + (bodyBottom - bodyTop) * 0.3} H${cx + w * 0.4} ` +
            `M${cx} ${bodyBottom} L${cx - w * 0.36} ${h - 2} ` +
            `M${cx} ${bodyBottom} L${cx + w * 0.36} ${h - 2}`,
          fill: 'none',
          stroke: stroke === 'none' ? STUDIO_DEFAULT_STROKE : stroke,
          sw: Math.max(1.4, sw),
          dash,
        },
      ]
    }
    case 'container': {
      const header = 28
      const r = 4
      // Body (fill2) + header band (fill), then stroke on top so corners stay clean.
      return [
        { k: 'rect', x: 0, y: 0, w, h, rx: r, fill: fill2, stroke: 'none' },
        {
          k: 'path',
          d:
            `M0 ${header} V${r} Q0 0 ${r} 0 H${w - r} Q${w} 0 ${w} ${r} V${header} Z`,
          fill,
          stroke: 'none',
        },
        { k: 'rect', x: 0, y: 0, w, h, rx: r, fill: 'none', stroke, sw, dash },
        { k: 'path', d: `M0 ${header} H${w}`, fill: 'none', stroke, sw, dash },
      ]
    }
    case 'image':
      return [
        { k: 'rect', x: 0, y: 0, w, h, rx: 4, fill: fill === STUDIO_DEFAULT_FILL ? 'none' : fill, stroke, sw, dash },
        ...(n.imageUrl
          ? [
              {
                k: 'image' as const,
                href: n.imageUrl,
                x: 2,
                y: 2,
                w: Math.max(1, w - 4),
                h: Math.max(1, h - 22),
              },
            ]
          : []),
      ]
    default:
      return [{ k: 'rect', x: 0, y: 0, w, h, ...body }]
  }
}

/** `transform` attribute placing a node (translate + rotate around centre). */
export function nodeTransform(n: BeeNode): string {
  const rot = n.rotation
    ? ` rotate(${n.rotation} ${n.w / 2} ${n.h / 2})`
    : ''
  return `translate(${n.x},${n.y})${rot}`
}

/** Whether the shape keeps the image content (studio image / legacy image). */
export function shapeSupportsImage(shape: RenderShape): boolean {
  return shape === 'image' || shape === 'beeImage'
}

// ── Edge styling ──────────────────────────────────────────────────────────────

export type ResolvedEdgeStyle = {
  stroke: string
  strokeWidth: number
  dash?: string
  startArrow: BeeArrowHead
  endArrow: BeeArrowHead
  fontSize: number
  fontColor: string
}

export function resolveEdgeStyle(e: BeeEdge, fallbackStroke = STUDIO_DEFAULT_EDGE_COLOR): ResolvedEdgeStyle {
  const s = e.style ?? {}
  return {
    stroke: s.stroke ?? fallbackStroke,
    strokeWidth: s.strokeWidth ?? 2,
    dash: s.dashed ? '6 4' : undefined,
    startArrow: s.startArrow ?? 'none',
    endArrow: s.endArrow ?? 'arrow',
    fontSize: s.fontSize ?? 11,
    fontColor: s.fontColor ?? STUDIO_DEFAULT_FONT_COLOR,
  }
}

export type ArrowMarkerSpec = {
  d: string
  filled: boolean
  refX: number
  refY: number
}

/**
 * Arrow-head geometry for an SVG `<marker>` (8×6 box, `orient="auto"`).
 * Start heads point backwards so they sit correctly on the first segment.
 */
export function arrowMarkerSpec(head: BeeArrowHead, position: 'start' | 'end'): ArrowMarkerSpec | null {
  const atEnd = position === 'end'
  switch (head) {
    case 'none':
      return null
    case 'arrow':
      return atEnd
        ? { d: 'M0,0 L8,3 L0,6 Z', filled: true, refX: 8, refY: 3 }
        : { d: 'M8,0 L0,3 L8,6 Z', filled: true, refX: 0, refY: 3 }
    case 'open':
      return atEnd
        ? { d: 'M1,0 L8,3 L1,6', filled: false, refX: 8, refY: 3 }
        : { d: 'M7,0 L0,3 L7,6', filled: false, refX: 0, refY: 3 }
    case 'diamond':
      return atEnd
        ? { d: 'M0,3 L4,0 L8,3 L4,6 Z', filled: true, refX: 8, refY: 3 }
        : { d: 'M0,3 L4,0 L8,3 L4,6 Z', filled: true, refX: 0, refY: 3 }
    case 'circle':
      return atEnd
        ? { d: 'M2,3 a2.6,2.6 0 1,0 5.2,0 a2.6,2.6 0 1,0 -5.2,0', filled: true, refX: 7.2, refY: 3 }
        : { d: 'M0.8,3 a2.6,2.6 0 1,0 5.2,0 a2.6,2.6 0 1,0 -5.2,0', filled: true, refX: 0.8, refY: 3 }
  }
}

/** Stable, DOM-safe marker id for a (head, position, colour) combination. */
export function arrowMarkerId(prefix: string, head: BeeArrowHead, position: 'start' | 'end', color: string): string {
  const safeColor = color.replace(/[^a-zA-Z0-9]/g, '')
  return `${prefix}-${position}-${head}-${safeColor}`
}

/** Every distinct arrow marker used by a set of edges. */
export function collectEdgeMarkers(
  edges: BeeEdge[],
  prefix: string,
  fallbackStroke = STUDIO_DEFAULT_EDGE_COLOR,
): { id: string; spec: ArrowMarkerSpec; color: string }[] {
  const seen = new Map<string, { id: string; spec: ArrowMarkerSpec; color: string }>()
  for (const e of edges) {
    const st = resolveEdgeStyle(e, fallbackStroke)
    for (const position of ['start', 'end'] as const) {
      const head = position === 'start' ? st.startArrow : st.endArrow
      const spec = arrowMarkerSpec(head, position)
      if (!spec) continue
      const id = arrowMarkerId(prefix, head, position, st.stroke)
      if (!seen.has(id)) seen.set(id, { id, spec, color: st.stroke })
    }
  }
  return [...seen.values()]
}

// ── Node creation for studio mode ─────────────────────────────────────────────

export type StudioNodeInit = {
  label?: string
  w?: number
  h?: number
  imageUrl?: string
  style?: BeeNode['style']
}

/** Create a node for a catalog shape (no legacy colour defaults applied). */
export function createShapeNode(
  shape: BeeShape,
  x: number,
  y: number,
  init: StudioNodeInit = {},
): BeeNode {
  const size = defaultShapeSize(shape)
  return {
    id: uid('n'),
    type: shape === 'image' ? 'image' : 'box',
    shape,
    label: init.label ?? '',
    x,
    y,
    w: init.w ?? size.w,
    h: init.h ?? size.h,
    imageUrl: init.imageUrl,
    style: init.style,
  }
}
