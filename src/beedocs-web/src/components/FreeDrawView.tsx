import { useMemo } from 'react'
import {
  parseFreeDrawDoc,
  strokePathD,
  type FreeDrawDoc,
} from '../freedraw/model'

type Props = {
  source: string
  className?: string
  title?: string
  /** Cap displayed width; height scales with the document aspect ratio. */
  maxWidth?: number
}

/** Read-only free-draw sketch (SVG). */
export function FreeDrawView({ source, className = '', title, maxWidth }: Props) {
  const doc = useMemo(() => parseFreeDrawDoc(source), [source])
  return (
    <div className={`freedraw-view ${className}`.trim()}>
      {title && <div className="freedraw-view-title muted sm">{title}</div>}
      <FreeDrawSvg doc={doc} maxWidth={maxWidth} />
    </div>
  )
}

export function FreeDrawSvg({
  doc,
  maxWidth,
  className = '',
}: {
  doc: FreeDrawDoc
  maxWidth?: number
  className?: string
}) {
  const style =
    maxWidth != null
      ? { maxWidth, width: '100%', height: 'auto' as const }
      : { width: '100%', height: 'auto' as const }

  return (
    <svg
      className={`freedraw-svg ${className}`.trim()}
      viewBox={`0 0 ${doc.width} ${doc.height}`}
      width={doc.width}
      height={doc.height}
      style={style}
      role="img"
      aria-label="Sketch"
    >
      <rect width="100%" height="100%" fill={doc.background} />
      {doc.strokes
        .filter((s) => s.tool === 'pen' && s.points.length > 0)
        .map((s) => (
          <path
            key={s.id}
            d={strokePathD(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.size}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
    </svg>
  )
}
