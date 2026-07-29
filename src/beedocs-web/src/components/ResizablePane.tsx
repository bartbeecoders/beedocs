import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

type Props = {
  side: 'left' | 'right'
  width: number
  collapsed: boolean
  min?: number
  max?: number
  onResize: (width: number) => void
  onToggle: () => void
  title: string
  children: ReactNode
}

export function ResizablePane({
  side,
  width,
  collapsed,
  min = 180,
  max = 520,
  onResize,
  onToggle,
  title,
  children,
}: Props) {
  const dragging = useRef(false)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      dragging.current = true
      const startX = e.clientX
      const startW = width

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return
        const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX
        const next = Math.min(max, Math.max(min, startW + delta))
        onResize(next)
      }
      const onUp = () => {
        dragging.current = false
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [max, min, onResize, side, width],
  )

  if (collapsed) {
    return (
      <div className={`pane-rail pane-rail-${side}`}>
        <button type="button" className="pane-rail-btn" onClick={onToggle} title={`Show ${title}`}>
          <span className="pane-rail-label">{title}</span>
        </button>
      </div>
    )
  }

  return (
    <div className={`pane pane-${side}`} style={{ width }}>
      <div className="pane-header">
        <span className="pane-title">{title}</span>
        <button type="button" className="icon-btn" onClick={onToggle} title={`Collapse ${title}`} aria-label={`Collapse ${title}`}>
          {side === 'left' ? '‹' : '›'}
        </button>
      </div>
      <div className="pane-body">{children}</div>
      <div
        className={`pane-resizer pane-resizer-${side}`}
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title}`}
      />
    </div>
  )
}
