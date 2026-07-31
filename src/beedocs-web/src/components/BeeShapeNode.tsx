import type { CSSProperties } from 'react'
import type { BeeNode } from '../types'
import { withApiBase } from '../basePath'
import {
  nodeLabelLayout,
  nodePrimitives,
  nodeTransform,
  resolveNodeStyle,
  type BeePrim,
} from '../diagram/shapes'

/**
 * Renders one node (shape geometry + wrapped label) from the shared primitive
 * model, so the studio editor, the read-only view and the exporter agree.
 */

function primOpacity(p: BeePrim): number | undefined {
  return p.opacity == null ? undefined : p.opacity / 100
}

export function ShapePrimitives({ prims }: { prims: BeePrim[] }) {
  return (
    <>
      {prims.map((p, i) => {
        const common = {
          opacity: primOpacity(p),
        }
        if (p.k === 'rect') {
          return (
            <rect
              key={i}
              x={p.x}
              y={p.y}
              width={p.w}
              height={p.h}
              rx={p.rx}
              fill={p.fill ?? 'none'}
              stroke={p.stroke === 'none' ? undefined : p.stroke}
              strokeWidth={p.stroke === 'none' ? undefined : p.sw}
              strokeDasharray={p.dash}
              {...common}
            />
          )
        }
        if (p.k === 'ellipse') {
          return (
            <ellipse
              key={i}
              cx={p.cx}
              cy={p.cy}
              rx={Math.max(0, p.rx)}
              ry={Math.max(0, p.ry)}
              fill={p.fill ?? 'none'}
              stroke={p.stroke === 'none' ? undefined : p.stroke}
              strokeWidth={p.stroke === 'none' ? undefined : p.sw}
              strokeDasharray={p.dash}
              {...common}
            />
          )
        }
        if (p.k === 'text') {
          return (
            <text
              key={i}
              x={p.x}
              y={p.y}
              fontSize={p.size}
              fill={p.color}
              fontWeight={p.weight}
              textAnchor={p.anchor}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
              {...common}
            >
              {p.text}
            </text>
          )
        }
        if (p.k === 'image') {
          return (
            <image
              key={i}
              href={withApiBase(p.href)}
              x={p.x}
              y={p.y}
              width={p.w}
              height={p.h}
              preserveAspectRatio="xMidYMid meet"
              style={{ pointerEvents: 'none' }}
              {...common}
            />
          )
        }
        return (
          <path
            key={i}
            d={p.d}
            fill={p.fill ?? 'none'}
            stroke={p.stroke === 'none' ? undefined : p.stroke}
            strokeWidth={p.stroke === 'none' ? undefined : p.sw}
            strokeDasharray={p.dash}
            strokeLinejoin="round"
            {...common}
          />
        )
      })}
    </>
  )
}

export function ShapeLabel({ node }: { node: BeeNode }) {
  const layout = nodeLabelLayout(node)
  if (!layout) return null
  const { style } = layout
  return (
    <text
      x={layout.x}
      y={layout.y}
      textAnchor={layout.anchor}
      fill={style.fontColor}
      fontSize={style.fontSize}
      fontWeight={style.bold ? 700 : 400}
      fontStyle={style.italic ? 'italic' : undefined}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      {layout.lines.map((line, i) => (
        <tspan key={i} x={layout.x} dy={i === 0 ? 0 : layout.lineHeight}>
          {line || ' '}
        </tspan>
      ))}
    </text>
  )
}

type Props = {
  node: BeeNode
  hideLabel?: boolean
  /** Extra content drawn inside the node group (handles, anchors…) */
  children?: React.ReactNode
} & Omit<React.SVGProps<SVGGElement>, 'transform' | 'children'>

export function BeeShapeNode({ node, hideLabel, children, ...rest }: Props) {
  const style = resolveNodeStyle(node)
  const groupStyle: CSSProperties | undefined = style.shadow
    ? { filter: 'drop-shadow(3px 3px 2px rgba(0,0,0,0.28))' }
    : undefined
  return (
    <g transform={nodeTransform(node)} style={groupStyle} {...rest}>
      <ShapePrimitives prims={nodePrimitives(node)} />
      {!hideLabel && <ShapeLabel node={node} />}
      {children}
    </g>
  )
}
