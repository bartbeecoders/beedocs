import { useMemo } from 'react'
import type { BeeDiagramDoc, BeeNode } from '../types'
import { defaultColor, edgePathD, parseBeeDoc } from '../diagram/beeModel'

type Props = {
  source?: string | null
  doc?: BeeDiagramDoc
  className?: string
}

function NodeShape({ node }: { node: BeeNode }) {
  const fill = node.color || defaultColor(node.type)
  const text = node.label

  if (node.type === 'person') {
    return (
      <g transform={`translate(${node.x},${node.y})`}>
        <rect width={node.w} height={node.h} rx={10} fill={fill} opacity={0.95} />
        <circle cx={node.w / 2} cy={28} r={12} fill="rgba(255,255,255,0.9)" />
        <path
          d={`M ${node.w / 2 - 16} 70 Q ${node.w / 2} 48 ${node.w / 2 + 16} 70`}
          fill="none"
          stroke="rgba(255,255,255,0.9)"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <text x={node.w / 2} y={node.h - 12} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={600}>
          {text}
        </text>
      </g>
    )
  }

  if (node.type === 'database') {
    return (
      <g transform={`translate(${node.x},${node.y})`}>
        <ellipse cx={node.w / 2} cy={14} rx={node.w / 2 - 4} ry={12} fill={fill} />
        <rect x={4} y={14} width={node.w - 8} height={node.h - 28} fill={fill} />
        <ellipse cx={node.w / 2} cy={node.h - 14} rx={node.w / 2 - 4} ry={12} fill={fill} />
        <text x={node.w / 2} y={node.h / 2 + 4} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={600}>
          {text}
        </text>
      </g>
    )
  }

  if (node.type === 'note') {
    return (
      <g transform={`translate(${node.x},${node.y})`}>
        <path
          d={`M0 0 H${node.w - 16} L${node.w} 16 V${node.h} H0 Z`}
          fill={fill}
          opacity={0.92}
        />
        <path d={`M${node.w - 16} 0 V16 H${node.w}`} fill="rgba(255,255,255,0.25)" />
        <text x={12} y={28} fill="#fff" fontSize={12} fontWeight={600}>
          {text}
        </text>
      </g>
    )
  }

  if (node.type === 'image') {
    return (
      <g transform={`translate(${node.x},${node.y})`}>
        <rect width={node.w} height={node.h} rx={8} fill={fill} opacity={0.35} />
        {node.imageUrl ? (
          <image
            href={node.imageUrl}
            x={4}
            y={4}
            width={node.w - 8}
            height={node.h - 28}
            preserveAspectRatio="xMidYMid meet"
          />
        ) : null}
        <text x={node.w / 2} y={node.h - 8} textAnchor="middle" fill="#fff" fontSize={11} fontWeight={600}>
          {text}
        </text>
      </g>
    )
  }

  // box / system
  return (
    <g transform={`translate(${node.x},${node.y})`}>
      <rect width={node.w} height={node.h} rx={node.type === 'system' ? 8 : 12} fill={fill} />
      {node.type === 'system' && (
        <text x={10} y={16} fill="rgba(255,255,255,0.65)" fontSize={9} fontFamily="ui-monospace, monospace">
          «system»
        </text>
      )}
      <text
        x={node.w / 2}
        y={node.h / 2 + (node.type === 'system' ? 6 : 4)}
        textAnchor="middle"
        fill="#fff"
        fontSize={13}
        fontWeight={650}
      >
        {text}
      </text>
    </g>
  )
}

export function BeeDiagramView({ source, doc: docProp, className }: Props) {
  const doc = useMemo(() => docProp ?? parseBeeDoc(source), [docProp, source])

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

  return (
    <div className={className ?? 'bee-diagram-view'}>
      <svg
        viewBox={`${bounds.minX} ${bounds.minY} ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="BeeDiagram"
      >
        <defs>
          <marker id="bee-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" />
          </marker>
        </defs>
        {doc.edges.map((e) => {
          const from = doc.nodes.find((n) => n.id === e.from)
          const to = doc.nodes.find((n) => n.id === e.to)
          if (!from || !to) return null
          const { d, mid } = edgePathD(from, to, e)
          return (
            <g key={e.id} className="bee-edge">
              <path
                d={d}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd="url(#bee-arrow)"
                opacity={0.75}
              />
              {e.label && (
                <text x={mid.x} y={mid.y - 6} textAnchor="middle" fontSize={11} fill="currentColor">
                  {e.label}
                </text>
              )}
            </g>
          )
        })}
        {doc.nodes.map((n) => (
          <NodeShape key={n.id} node={n} />
        ))}
      </svg>
      {doc.nodes.length === 0 && <p className="muted bee-empty">Empty diagram</p>}
    </div>
  )
}
