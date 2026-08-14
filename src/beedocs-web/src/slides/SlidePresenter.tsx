import { useCallback, useEffect, useRef, useState } from 'react'
import type { SlideDeckDoc } from './slideModel'
import { SlideSurface } from './SlideView'

type Props = {
  deck: SlideDeckDoc
  /** Slide to open on — presenting from the editor starts at the selected slide. */
  initialIndex?: number
  onClose: () => void
}

/**
 * Full-screen presentation mode. The overlay covers the app whatever the
 * browser answers to the fullscreen request (an iframe or a denied permission
 * still gets a working presentation, just with chrome around it).
 */
export function SlidePresenter({ deck, initialIndex = 0, onClose }: Props) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(initialIndex, 0), deck.slides.length - 1),
  )
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const rootRef = useRef<HTMLDivElement>(null)
  const count = deck.slides.length

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => Math.min(Math.max(i + delta, 0), count - 1))
    },
    [count],
  )

  // Best-effort fullscreen; exiting fullscreen (Esc included) ends the show, so
  // the two ways out cannot leave the overlay and the browser disagreeing.
  useEffect(() => {
    const root = rootRef.current
    if (root?.requestFullscreen) {
      root.requestFullscreen().catch(() => {})
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) onClose()
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [onClose])

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
          e.preventDefault()
          step(1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault()
          step(-1)
          break
        case 'Home':
          e.preventDefault()
          setIndex(0)
          break
        case 'End':
          e.preventDefault()
          setIndex(count - 1)
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, count, onClose])

  const slide = deck.slides[index]
  const scale = Math.min(viewport.w / deck.size.w, viewport.h / deck.size.h)

  return (
    <div
      ref={rootRef}
      className="slide-presenter"
      role="dialog"
      aria-label="Presentation"
      // Click to advance, PowerPoint style; the controls stop propagation.
      onClick={() => step(1)}
      onContextMenu={(e) => {
        e.preventDefault()
        step(-1)
      }}
    >
      <div
        className="slide-presenter-stage"
        style={{
          width: deck.size.w * scale,
          height: deck.size.h * scale,
        }}
      >
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          {slide && <SlideSurface deck={deck} slide={slide} />}
        </div>
      </div>

      <div className="slide-presenter-hud" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="slide-hud-btn" onClick={() => step(-1)} disabled={index === 0}>
          ‹
        </button>
        <span className="slide-hud-counter">
          {index + 1} / {count}
        </span>
        <button
          type="button"
          className="slide-hud-btn"
          onClick={() => step(1)}
          disabled={index === count - 1}
        >
          ›
        </button>
        <button type="button" className="slide-hud-btn slide-hud-exit" onClick={onClose} title="End presentation (Esc)">
          ✕
        </button>
      </div>
    </div>
  )
}
