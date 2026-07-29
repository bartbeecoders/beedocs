import type { BeeNode } from '../types'
import { defaultColor, edgePathD, parseBeeDoc } from '../diagram/beeModel'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function nodeSvg(n: BeeNode): string {
  const fill = esc(n.color || defaultColor(n.type))
  const label = esc(n.label)
  const t = n.type

  if (t === 'image' && n.imageUrl) {
    const href = esc(absoluteUrl(n.imageUrl))
    return `<g transform="translate(${n.x},${n.y})">
      <rect width="${n.w}" height="${n.h}" rx="8" fill="${fill}" opacity="0.35"/>
      <image href="${href}" x="4" y="4" width="${n.w - 8}" height="${n.h - 28}" preserveAspectRatio="xMidYMid meet"/>
      <text x="${n.w / 2}" y="${n.h - 8}" text-anchor="middle" fill="#111" font-size="11" font-weight="600">${label}</text>
    </g>`
  }

  if (t === 'person') {
    return `<g transform="translate(${n.x},${n.y})">
      <rect width="${n.w}" height="${n.h}" rx="10" fill="${fill}"/>
      <circle cx="${n.w / 2}" cy="28" r="12" fill="rgba(255,255,255,0.9)"/>
      <text x="${n.w / 2}" y="${n.h - 12}" text-anchor="middle" fill="#fff" font-size="12" font-weight="600">${label}</text>
    </g>`
  }

  if (t === 'database') {
    return `<g transform="translate(${n.x},${n.y})">
      <ellipse cx="${n.w / 2}" cy="14" rx="${n.w / 2 - 4}" ry="12" fill="${fill}"/>
      <rect x="4" y="14" width="${n.w - 8}" height="${n.h - 28}" fill="${fill}"/>
      <ellipse cx="${n.w / 2}" cy="${n.h - 14}" rx="${n.w / 2 - 4}" ry="12" fill="${fill}"/>
      <text x="${n.w / 2}" y="${n.h / 2 + 4}" text-anchor="middle" fill="#fff" font-size="12" font-weight="600">${label}</text>
    </g>`
  }

  if (t === 'note') {
    return `<g transform="translate(${n.x},${n.y})">
      <path d="M0 0 H${n.w - 16} L${n.w} 16 V${n.h} H0 Z" fill="${fill}"/>
      <text x="12" y="28" fill="#fff" font-size="12" font-weight="600">${label}</text>
    </g>`
  }

  const rx = t === 'system' ? 8 : 12
  const systemTag =
    t === 'system'
      ? `<text x="10" y="16" fill="rgba(255,255,255,0.65)" font-size="9">«system»</text>`
      : ''
  const ty = n.h / 2 + (t === 'system' ? 6 : 4)
  return `<g transform="translate(${n.x},${n.y})">
    <rect width="${n.w}" height="${n.h}" rx="${rx}" fill="${fill}"/>
    ${systemTag}
    <text x="${n.w / 2}" y="${ty}" text-anchor="middle" fill="#fff" font-size="13" font-weight="650">${label}</text>
  </g>`
}

function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url
  if (url.startsWith('/')) return `${window.location.origin}${url}`
  return url
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
  const mid = uidSafe()

  const edges = doc.edges
    .map((e) => {
      const from = doc.nodes.find((n) => n.id === e.from)
      const to = doc.nodes.find((n) => n.id === e.to)
      if (!from || !to) return ''
      const { d, mid: m } = edgePathD(from, to, e)
      const label = e.label
        ? `<text x="${m.x}" y="${m.y - 6}" text-anchor="middle" font-size="11" fill="#222">${esc(e.label)}</text>`
        : ''
      return `<path d="${esc(d)}" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arr-${mid})"/>${label}`
    })
    .join('\n')

  const nodes = doc.nodes.map(nodeSvg).join('\n')

  return `<figure class="export-diagram">
    ${title ? `<figcaption>${esc(title)}</figcaption>` : ''}
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="100%" style="max-height:480px">
      <defs>
        <marker id="arr-${mid}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6 Z" fill="#333"/>
        </marker>
      </defs>
      ${edges}
      ${nodes}
    </svg>
  </figure>`
}

function uidSafe(): string {
  return Math.random().toString(36).slice(2, 9)
}
