import { useId, useMemo } from 'react'
import type { BeeDiagramDoc } from '../types'
import { edgePathD, parseBeeDoc } from '../diagram/beeModel'
import { diagramPaintOrder } from '../diagram/containers'
import { arrowMarkerId, collectEdgeMarkers, resolveEdgeStyle } from '../diagram/shapes'
import { BeeShapeNode } from './BeeShapeNode'

type Props = {
  source?: string | null
  doc?: BeeDiagramDoc
  className?: string
}

/** Read-only BeeDiagram rendering used in pages, previews and thumbnails. */
export function BeeDiagramView({ source, doc: docProp, className }: Props) {
  const doc = useMemo(() => docProp ?? parseBeeDoc(source), [docProp, source])
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, '')

  const bounds = useMemo(() => {
    if (doc.nodes.length === 0) return { minX: 0, minY: 0, maxX: 400, maxY: 240 }
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
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
  }, [doc.nodes])

  const width = Math.max(320, bounds.maxX - bounds.minX)
  const height = Math.max(180, bounds.maxY - bounds.minY)

  // Legacy edges (no explicit style) keep following the surrounding text colour
  const markers = useMemo(
    () => collectEdgeMarkers(doc.edges.filter((e) => e.style?.stroke), prefix),
    [doc.edges, prefix],
  )

  const paintOrder = useMemo(
    () => diagramPaintOrder(doc.nodes, doc.edges),
    [doc.nodes, doc.edges],
  )

  const nodeById = useMemo(() => {
    const map = new Map(doc.nodes.map((n) => [n.id, n]))
    return map
  }, [doc.nodes])

  return (
    <div className={className ?? 'bee-diagram-view'}>
      <svg
        viewBox={`${bounds.minX} ${bounds.minY} ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="BeeDiagram"
      >
        <defs>
          <marker id={`${prefix}-arrow`} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" />
          </marker>
          {markers.map((m) => (
            <marker
              key={m.id}
              id={m.id}
              markerWidth={10}
              markerHeight={7}
              refX={m.spec.refX}
              refY={m.spec.refY}
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path
                d={m.spec.d}
                fill={m.spec.filled ? m.color : 'none'}
                stroke={m.spec.filled ? 'none' : m.color}
                strokeWidth={1.2}
              />
            </marker>
          ))}
        </defs>
        {paintOrder.map((item) => {
          if (item.kind === 'node') {
            return <BeeShapeNode key={item.node.id} node={item.node} />
          }
          const e = item.edge
          const from = nodeById.get(e.from)
          const to = nodeById.get(e.to)
          if (!from || !to) return null
          const { d, mid } = edgePathD(from, to, e)
          const styled = !!e.style?.stroke
          const st = resolveEdgeStyle(e)
          const endId = styled && st.endArrow !== 'none' ? arrowMarkerId(prefix, st.endArrow, 'end', st.stroke) : null
          const startId =
            styled && st.startArrow !== 'none' ? arrowMarkerId(prefix, st.startArrow, 'start', st.stroke) : null
          return (
            <g key={e.id} className="bee-edge">
              <path
                d={d}
                fill="none"
                stroke={styled ? st.stroke : 'currentColor'}
                strokeWidth={e.style?.strokeWidth ?? 2}
                strokeDasharray={st.dash}
                strokeLinecap="round"
                strokeLinejoin="round"
                markerStart={startId ? `url(#${startId})` : undefined}
                markerEnd={endId ? `url(#${endId})` : `url(#${prefix}-arrow)`}
                opacity={styled ? 1 : 0.75}
              />
              {e.label && (
                <text
                  x={mid.x}
                  y={mid.y - 6}
                  textAnchor="middle"
                  fontSize={st.fontSize}
                  fill={styled ? st.fontColor : 'currentColor'}
                >
                  {e.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {doc.nodes.length === 0 && <p className="muted bee-empty">Empty diagram</p>}
    </div>
  )
}
