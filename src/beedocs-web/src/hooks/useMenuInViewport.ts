import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

const PAD = 8

/**
 * Fixed-position style that keeps a context menu opened at (x, y) fully on
 * screen. The menu is measured after it renders — its height depends on which
 * entries the target offers — so it flips left/up when it would overflow and
 * is re-clamped whenever its size or the window changes. A menu taller than
 * the viewport is capped and scrolls (see `.tree-context-menu`).
 */
export function useMenuInViewport(
  ref: RefObject<HTMLElement | null>,
  anchor: { x: number; y: number } | null,
): CSSProperties | undefined {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const x = anchor?.x
  const y = anchor?.y

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || x === undefined || y === undefined) {
      setPos(null)
      return
    }
    const place = () => {
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left = x
      let top = y
      if (left + r.width > vw - PAD) left = x - r.width
      if (top + r.height > vh - PAD) top = vh - PAD - r.height
      left = Math.max(PAD, Math.min(left, vw - PAD - r.width))
      top = Math.max(PAD, top)
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [ref, x, y])

  if (x === undefined || y === undefined) return undefined
  return {
    position: 'fixed',
    left: pos?.left ?? x,
    top: pos?.top ?? y,
    zIndex: 1200,
    // Hidden for the one pre-measure frame so it never flashes off-screen.
    visibility: pos ? undefined : 'hidden',
  }
}
