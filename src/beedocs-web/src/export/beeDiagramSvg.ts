import type { BeeNode } from '../types'
import { edgePathD, parseBeeDoc } from '../diagram/beeModel'
import {
  arrowMarkerId,
  collectEdgeMarkers,
  nodeLabelLayout,
  nodePrimitives,
  nodeTransform,
  resolveEdgeStyle,
  resolveShape,
  type BeePrim,
} from '../diagram/shapes'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function attr(name: string, value: string | number | undefined): string {
  if (value == null || value === '') return ''
  return ` ${name}="${typeof value === 'string' ? esc(value) : value}"`
}

function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url
  if (url.startsWith('/')) {
    const raw = (import.meta.env.VITE_BEEDOCS_API_PATH_BASE as string | undefined)
      || (import.meta.env.BASE_URL || '/')
    const prefix = raw.replace(/\/+$/, '')
    const base = !prefix || prefix === '/' ? '' : prefix
    const path = base && (url === base || url.startsWith(`${base}/`)) ? url : `${base}${url}`
    return `${window.location.origin}${path}`
  }
  return url
}

function primToSvg(p: BeePrim): string {
  const opacity = p.k === 'image' ? p.opacity : p.opacity
  const common = `${attr('opacity', opacity == null ? undefined : opacity / 100)}`
  if (p.k === 'rect') {
    return (
      `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"` +
      attr('rx', p.rx) +
      attr('fill', p.fill ?? 'none') +
      (p.stroke && p.stroke !== 'none' ? attr('stroke', p.stroke) + attr('stroke-width', p.sw) : '') +
      attr('stroke-dasharray', p.dash) +
      common +
      '/>'
    )
  }
  if (p.k === 'ellipse') {
    return (
      `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${Math.max(0, p.rx)}" ry="${Math.max(0, p.ry)}"` +
      attr('fill', p.fill ?? 'none') +
      (p.stroke && p.stroke !== 'none' ? attr('stroke', p.stroke) + attr('stroke-width', p.sw) : '') +
      attr('stroke-dasharray', p.dash) +
      common +
      '/>'
    )
  }
  if (p.k === 'text') {
    return (
      `<text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${esc(p.color)}"` +
      attr('font-weight', p.weight) +
      attr('text-anchor', p.anchor) +
      common +
      `>${esc(p.text)}</text>`
    )
  }
  if (p.k === 'image') {
    return (
      `<image href="${esc(absoluteUrl(p.href))}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"` +
      ` preserveAspectRatio="xMidYMid meet"${common}/>`
    )
  }
  return (
    `<path d="${esc(p.d)}"` +
    attr('fill', p.fill ?? 'none') +
    (p.stroke && p.stroke !== 'none' ? attr('stroke', p.stroke) + attr('stroke-width', p.sw) : '') +
    attr('stroke-dasharray', p.dash) +
    ' stroke-linejoin="round"' +
    common +
    '/>'
  )
}

function labelToSvg(n: BeeNode): string {
  const layout = nodeLabelLayout(n)
  if (!layout) return ''
  const st = layout.style
  // Legacy image captions sit on a pale plate — keep them dark for print
  const fill = resolveShape(n) === 'beeImage' && !n.style?.fontColor ? '#111827' : st.fontColor
  const tspans = layout.lines
    .map(
      (line, i) =>
        `<tspan x="${layout.x}"${i === 0 ? '' : ` dy="${layout.lineHeight}"`}>${esc(line || ' ')}</tspan>`,
    )
    .join('')
  return (
    `<text x="${layout.x}" y="${layout.y}" text-anchor="${layout.anchor}" fill="${esc(fill)}"` +
    ` font-size="${st.fontSize}" font-weight="${st.bold ? 700 : 400}"` +
    (st.italic ? ' font-style="italic"' : '') +
    `>${tspans}</text>`
  )
}

function nodeSvg(n: BeeNode): string {
  const prims = nodePrimitives(n).map(primToSvg).join('')
  return `<g transform="${esc(nodeTransform(n))}">${prims}${labelToSvg(n)}</g>`
}

/** Standalone SVG markup for a BeeDiagram JSON source (print/export). */
export function beeDiagramToSvg(source: string, title?: string): string {
  const doc = parseBeeDoc(source)
  if (doc.nodes.length === 0) {
    return `<div class="export-empty-diagram">${esc(title || 'Empty diagram')}</div>`
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of doc.nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  const pad = 32
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  const width = Math.max(320, maxX - minX)
  const height = Math.max(180, maxY - minY)
  const prefix = `bd${uidSafe()}`

  const markers = collectEdgeMarkers(doc.edges, prefix, '#333333')
    .map(
      (m) =>
        `<marker id="${m.id}" markerWidth="10" markerHeight="7" refX="${m.spec.refX}" refY="${m.spec.refY}"` +
        ` orient="auto" markerUnits="strokeWidth">` +
        `<path d="${m.spec.d}" fill="${m.spec.filled ? esc(m.color) : 'none'}"` +
        `${m.spec.filled ? '' : ` stroke="${esc(m.color)}" stroke-width="1.2"`}/></marker>`,
    )
    .join('\n')

  const edges = doc.edges
    .map((e) => {
      const from = doc.nodes.find((n) => n.id === e.from)
      const to = doc.nodes.find((n) => n.id === e.to)
      if (!from || !to) return ''
      const st = resolveEdgeStyle(e, '#333333')
      const { d, mid } = edgePathD(from, to, e)
      const startId =
        st.startArrow !== 'none' ? arrowMarkerId(prefix, st.startArrow, 'start', st.stroke) : null
      const endId = st.endArrow !== 'none' ? arrowMarkerId(prefix, st.endArrow, 'end', st.stroke) : null
      const label = e.label
        ? `<text x="${mid.x}" y="${mid.y - 6}" text-anchor="middle" font-size="${st.fontSize}" fill="${esc(st.fontColor)}">${esc(e.label)}</text>`
        : ''
      return (
        `<path d="${esc(d)}" fill="none" stroke="${esc(st.stroke)}" stroke-width="${st.strokeWidth}"` +
        attr('stroke-dasharray', st.dash) +
        ` stroke-linecap="round" stroke-linejoin="round"` +
        (startId ? ` marker-start="url(#${startId})"` : '') +
        (endId ? ` marker-end="url(#${endId})"` : '') +
        `/>${label}`
      )
    })
    .join('\n')

  const nodes = doc.nodes.map(nodeSvg).join('\n')

  return `<figure class="export-diagram">
    ${title ? `<figcaption>${esc(title)}</figcaption>` : ''}
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="100%" style="max-height:480px">
      <defs>
        ${markers}
      </defs>
      ${edges}
      ${nodes}
    </svg>
  </figure>`
}

function uidSafe(): string {
  return Math.random().toString(36).slice(2, 9)
}
