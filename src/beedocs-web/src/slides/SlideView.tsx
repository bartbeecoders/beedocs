import type { CSSProperties, ReactNode } from 'react'
import type { Slide, SlideDeckDoc, SlideElement, SlideTheme } from './slideModel'

/**
 * The one renderer every slide surface goes through — editor canvas, filmstrip
 * thumbnails, read-only view and the presenter all draw a slide with these
 * components, so a deck looks identical everywhere it appears.
 */

/** SVG geometry for a shape element, drawn in the element's local w×h space. */
function ShapeGeometry({ element }: { element: SlideElement }) {
  const w = element.w
  const h = element.h
  const fill = element.fill ?? '#f59e0b'
  const stroke = element.stroke && element.stroke !== 'none' ? element.stroke : undefined
  const strokeWidth = stroke ? (element.strokeWidth ?? 2) : 0
  const common = { fill, stroke, strokeWidth }

  switch (element.shape) {
    case 'rounded': {
      const r = Math.min(24, w / 2, h / 2)
      return <rect x={0} y={0} width={w} height={h} rx={r} {...common} />
    }
    case 'ellipse':
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...common} />
    case 'triangle':
      return <polygon points={`${w / 2},0 ${w},${h} 0,${h}`} {...common} />
    case 'diamond':
      return <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} {...common} />
    case 'star': {
      const cx = w / 2
      const cy = h / 2
      const points: string[] = []
      for (let i = 0; i < 10; i++) {
        const angle = (Math.PI / 5) * i - Math.PI / 2
        const rx = (i % 2 === 0 ? 0.5 : 0.2) * w
        const ry = (i % 2 === 0 ? 0.5 : 0.2) * h
        points.push(`${cx + rx * Math.cos(angle)},${cy + ry * Math.sin(angle)}`)
      }
      return <polygon points={points.join(' ')} {...common} />
    }
    case 'arrow': {
      // Right-pointing block arrow: shaft two thirds of the width, head the rest.
      const head = Math.min(w * 0.35, h)
      const shaftTop = h * 0.28
      const shaftBottom = h * 0.72
      return (
        <polygon
          points={`0,${shaftTop} ${w - head},${shaftTop} ${w - head},0 ${w},${h / 2} ${w - head},${h} ${w - head},${shaftBottom} 0,${shaftBottom}`}
          {...common}
        />
      )
    }
    case 'line':
      return (
        <line
          x1={0}
          y1={h / 2}
          x2={w}
          y2={h / 2}
          stroke={element.stroke ?? '#1f2430'}
          strokeWidth={element.strokeWidth ?? 3}
        />
      )
    case 'rect':
    default:
      return <rect x={0} y={0} width={w} height={h} {...common} />
  }
}

function textStyle(element: SlideElement, theme: SlideTheme): CSSProperties {
  return {
    fontSize: element.fontSize ?? 28,
    fontFamily: element.fontFamily ?? theme.fontFamily,
    fontWeight: element.bold ? 700 : 400,
    fontStyle: element.italic ? 'italic' : 'normal',
    textDecoration: element.underline ? 'underline' : 'none',
    color: element.color ?? theme.color,
    textAlign: element.align ?? 'left',
    justifyContent:
      element.align === 'center' ? 'center' : element.align === 'right' ? 'flex-end' : 'flex-start',
    alignItems:
      element.valign === 'middle' ? 'center' : element.valign === 'bottom' ? 'flex-end' : 'flex-start',
  }
}

/** One element's visual content, filling its box. Interaction wrappers go outside. */
export function SlideElementVisual({
  element,
  theme,
}: {
  element: SlideElement
  theme: SlideTheme
}) {
  const opacity = element.opacity != null ? element.opacity / 100 : 1

  if (element.kind === 'image') {
    return element.imageUrl ? (
      <img
        src={element.imageUrl}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'fill', opacity, display: 'block' }}
      />
    ) : (
      <div className="slide-image-placeholder">Image</div>
    )
  }

  const text = element.text ? (
    <div className="slide-element-text" style={{ ...textStyle(element, theme), opacity }}>
      {element.text}
    </div>
  ) : null

  if (element.kind === 'shape') {
    return (
      <>
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${element.w} ${element.h}`}
          preserveAspectRatio="none"
          style={{ display: 'block', opacity, overflow: 'visible' }}
          aria-hidden
        >
          <ShapeGeometry element={element} />
        </svg>
        {text}
      </>
    )
  }

  return text ?? <div className="slide-element-text" style={{ opacity }} />
}

function elementBoxStyle(element: SlideElement): CSSProperties {
  return {
    position: 'absolute',
    left: element.x,
    top: element.y,
    width: element.w,
    height: element.h,
    transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
  }
}

/**
 * A slide at its native size (deck.size), for wrapping in a scale transform.
 * `renderElement` lets the editor wrap each element with selection/drag handles
 * while everything else gets the plain visual.
 */
export function SlideSurface({
  deck,
  slide,
  renderElement,
}: {
  deck: SlideDeckDoc
  slide: Slide
  renderElement?: (element: SlideElement, box: CSSProperties) => ReactNode
}) {
  return (
    <div
      className="slide-surface"
      style={{
        width: deck.size.w,
        height: deck.size.h,
        background: slide.background ?? deck.theme.background,
      }}
    >
      {slide.elements.map((element) =>
        renderElement ? (
          renderElement(element, elementBoxStyle(element))
        ) : (
          <div key={element.id} style={elementBoxStyle(element)}>
            <SlideElementVisual element={element} theme={deck.theme} />
          </div>
        ),
      )}
    </div>
  )
}

/** A slide scaled to a given pixel width — thumbnails, previews, the presenter. */
export function SlideScaled({
  deck,
  slide,
  width,
  className,
}: {
  deck: SlideDeckDoc
  slide: Slide
  width: number
  className?: string
}) {
  const scale = width / deck.size.w
  return (
    <div
      className={className}
      style={{
        width,
        height: deck.size.h * scale,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <SlideSurface deck={deck} slide={slide} />
      </div>
    </div>
  )
}
