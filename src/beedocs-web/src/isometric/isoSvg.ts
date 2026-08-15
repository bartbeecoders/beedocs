/**
 * Static SVG for an isometric document — used by the PDF/HTML export. Renders
 * the same primitives as the canvas, with concrete light-theme colours in
 * place of CSS variables so the output stands alone.
 */
import {
  DEFAULT_CONNECTOR_COLOR,
  DEFAULT_ITEM_COLOR,
  DEFAULT_ZONE_COLOR,
  isoContentBounds,
  parseIsoDoc,
  tileToWorld,
} from './isoModel'
import { connectorGeometry, sortItemsForPaint, zonePath } from './isoRender'
import { isoShape, type IsoPrimitive } from './isoShapes'

const LABEL_COLOR = '#30363d'
const HALO = '#ffffff'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function attr(name: string, value: string | number | undefined): string {
  return value === undefined ? '' : ` ${name}="${value}"`
}

function primToSvg(p: IsoPrimitive): string {
  if (p.kind === 'path') {
    return (
      `<path d="${p.d}" fill="${p.fill ?? 'none'}" stroke-linejoin="round"` +
      attr('stroke', p.stroke) +
      attr('stroke-width', p.strokeWidth) +
      attr('stroke-dasharray', p.dash) +
      attr('opacity', p.opacity) +
      (p.evenOdd ? ' fill-rule="evenodd"' : '') +
      '/>'
    )
  }
  if (p.kind === 'ellipse') {
    return (
      `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}" fill="${p.fill ?? 'none'}"` +
      attr('stroke', p.stroke) +
      attr('stroke-width', p.strokeWidth) +
      attr('opacity', p.opacity) +
      '/>'
    )
  }
  return (
    `<text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${p.fill}"` +
    (p.bold ? ' font-weight="700"' : '') +
    ' text-anchor="middle" dominant-baseline="middle">' +
    esc(p.text) +
    '</text>'
  )
}

function label(x: number, y: number, text: string, size: number, color = LABEL_COLOR, bold = false): string {
  return (
    `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="middle"` +
    (bold ? ' font-weight="600"' : '') +
    ` paint-order="stroke" stroke="${HALO}" stroke-width="3.5" stroke-linejoin="round">` +
    esc(text) +
    '</text>'
  )
}

/** Render a stored isometric document to a standalone SVG fragment. */
export function isoDiagramToSvg(source: string, title?: string): string {
  const doc = parseIsoDoc(source)
  const bounds = isoContentBounds(doc)
  if (!bounds) {
    return '<div class="export-error">Empty isometric diagram</div>'
  }
  const pad = 24
  const x = bounds.x - pad
  const y = bounds.y - pad
  const w = bounds.w + pad * 2
  const h = bounds.h + pad * 2

  const parts: string[] = []

  for (const z of doc.zones) {
    const color = z.color ?? DEFAULT_ZONE_COLOR
    parts.push(
      `<path d="${zonePath(z)}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="1.6"/>`,
    )
    if (z.label) {
      const p = tileToWorld(z.x1 - 0.5, z.y1 - 0.5)
      parts.push(label(p.x, p.y + 20, z.label, 13, color, true))
    }
  }

  const itemById = new Map(doc.items.map((i) => [i.id, i]))
  for (const c of doc.connectors) {
    const from = itemById.get(c.from)
    const to = itemById.get(c.to)
    if (!from || !to) continue
    const g = connectorGeometry(from, to)
    const color = c.color ?? DEFAULT_CONNECTOR_COLOR
    parts.push(
      `<path d="${g.d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"` +
        (c.dashed ? ' stroke-dasharray="7 5"' : '') +
        '/>',
    )
    parts.push(`<path d="${g.arrowD}" fill="${color}"/>`)
    if (c.label) parts.push(label(g.labelAt.x, g.labelAt.y - 7, c.label, 12))
  }

  for (const n of sortItemsForPaint(doc.items)) {
    const origin = tileToWorld(n.x, n.y)
    const prims = isoShape(n.shape).draw(n.color ?? DEFAULT_ITEM_COLOR)
    parts.push(
      `<g transform="translate(${origin.x},${origin.y})">${prims.map(primToSvg).join('')}</g>`,
    )
    if (n.label) parts.push(label(origin.x, origin.y + 40, n.label, 12.5, LABEL_COLOR, true))
  }

  for (const t of doc.texts) {
    if (!t.text) continue
    const p = tileToWorld(t.x, t.y)
    parts.push(label(p.x, p.y, t.text, 15, LABEL_COLOR, true))
  }

  const caption = title ? `<figcaption class="meta">${esc(title)}</figcaption>` : ''
  return (
    `<figure class="export-iso">${caption}` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}"` +
    ` width="100%" style="max-width:${Math.min(760, Math.ceil(w))}px" font-family="ui-sans-serif, system-ui, sans-serif" role="img">` +
    parts.join('') +
    '</svg></figure>'
  )
}
