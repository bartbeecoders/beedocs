import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Custom drag type for a page block.
 *
 * Reordering shares the editor with image-file drops, so both sides have to be
 * able to tell the two apart: the image intake only reacts to drags carrying
 * `Files`, and everything here only reacts to drags carrying this type.
 */
export const BLOCK_MIME = 'application/x-beedocs-block'

/** True when this drag is a page block being reordered rather than a file. */
export function isBlockDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types || []).includes(BLOCK_MIME)
}

type Options = {
  /** Move the block at `from` to sit before gap index `to`. */
  onMove: (from: number, to: number) => void
  /**
   * Editor root. Used to find scrollable ancestors (for edge auto-scroll) and
   * block elements (for drop-target hit testing while scrolling).
   */
  containerRef?: RefObject<HTMLElement | null>
}

/** Distance from the visible top/bottom of a scroller that starts auto-scroll. */
const EDGE_PX = 72
/** Peak scroll speed (px per animation frame) at the extreme edge. */
const MAX_SCROLL_PX = 28

function findScrollParents(start: HTMLElement | null): HTMLElement[] {
  const out: HTMLElement[] = []
  let el: HTMLElement | null = start
  while (el) {
    const { overflowY } = getComputedStyle(el)
    const scrollable =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      el.scrollHeight > el.clientHeight + 1
    if (scrollable) out.push(el)
    el = el.parentElement
  }
  return out
}

/**
 * Scroll every ancestor (and the document element if needed) when the pointer
 * sits in the edge band of its *visible* region. Without this, HTML5 drag
 * cannot reach drop targets that sit above or below the current viewport.
 */
function autoScrollAt(clientY: number, parents: HTMLElement[]): boolean {
  let moved = false
  for (const scroller of parents) {
    const rect = scroller.getBoundingClientRect()
    // Only the part of the scroller that is on screen counts as the edge band.
    const top = Math.max(rect.top, 0)
    const bottom = Math.min(rect.bottom, window.innerHeight)
    if (bottom - top < EDGE_PX * 2) continue

    let delta = 0
    if (clientY < top + EDGE_PX) {
      const t = Math.min(1, Math.max(0, (top + EDGE_PX - clientY) / EDGE_PX))
      delta = -Math.ceil(MAX_SCROLL_PX * t * t)
    } else if (clientY > bottom - EDGE_PX) {
      const t = Math.min(1, Math.max(0, (clientY - (bottom - EDGE_PX)) / EDGE_PX))
      delta = Math.ceil(MAX_SCROLL_PX * t * t)
    }
    if (delta === 0) continue
    const prev = scroller.scrollTop
    scroller.scrollTop = prev + delta
    if (scroller.scrollTop !== prev) moved = true
  }
  return moved
}

/**
 * Pick a gap index from pointer Y by walking block mid-lines.
 * More reliable than only reacting to thin insert-gap hit targets, especially
 * while auto-scroll is moving content under a fixed pointer.
 */
function gapFromPointer(root: HTMLElement, clientY: number, from: number): number | null {
  const blocks = root.querySelectorAll<HTMLElement>('.hybrid-block-wrap')
  if (blocks.length === 0) return 0

  const first = blocks[0].getBoundingClientRect()
  if (clientY < first.top + 12) return skipNoop(0, from)

  const last = blocks[blocks.length - 1].getBoundingClientRect()
  if (clientY > last.bottom - 12) return skipNoop(blocks.length, from)

  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect()
    const mid = r.top + r.height / 2
    if (clientY < mid) return skipNoop(i, from)
  }
  return skipNoop(blocks.length, from)
}

/** Dropping immediately before or after the dragged block is a no-op. */
function skipNoop(gap: number, from: number): number | null {
  if (gap === from || gap === from + 1) return null
  return gap
}

export function useBlockReorder({ onMove, containerRef }: Options) {
  /** Index of the block being dragged, or null when no reorder is in flight. */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** Gap the pointer is currently targeting. */
  const [overGap, setOverGap] = useState<number | null>(null)

  const dragIndexRef = useRef<number | null>(null)
  const overGapRef = useRef<number | null>(null)
  const scrollParentsRef = useRef<HTMLElement[]>([])
  const lastPointerY = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  const setOver = useCallback((gap: number | null) => {
    overGapRef.current = gap
    setOverGap(gap)
  }, [])

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastPointerY.current = null
    scrollParentsRef.current = []
  }, [])

  const end = useCallback(() => {
    dragIndexRef.current = null
    setDragIndex(null)
    setOver(null)
    stopAutoScroll()
  }, [setOver, stopAutoScroll])

  const updateTargetFromY = useCallback(
    (clientY: number) => {
      const from = dragIndexRef.current
      if (from === null) return
      const root = containerRef?.current
      if (!root) return
      setOver(gapFromPointer(root, clientY, from))
    },
    [containerRef, setOver],
  )

  const tickScroll = useCallback(() => {
    rafRef.current = null
    if (dragIndexRef.current === null) return
    const y = lastPointerY.current
    if (y == null) return

    const scrolled = autoScrollAt(y, scrollParentsRef.current)
    // After scrolling, content moves under a fixed pointer — re-hit-test gaps.
    if (scrolled) updateTargetFromY(y)

    rafRef.current = requestAnimationFrame(tickScroll)
  }, [updateTargetFromY])

  const ensureAutoScroll = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(tickScroll)
  }, [tickScroll])

  const start = useCallback(
    (index: number, e: React.DragEvent) => {
      dragIndexRef.current = index
      setDragIndex(index)
      setOver(null)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(BLOCK_MIME, String(index))
      // Some browsers refuse a drag with no text payload.
      e.dataTransfer.setData('text/plain', '')

      // Drag the whole block, not the little handle the gesture started on.
      const block = (e.currentTarget as HTMLElement).closest('.hybrid-block-wrap')
      if (block instanceof HTMLElement) {
        const rect = block.getBoundingClientRect()
        e.dataTransfer.setDragImage(block, Math.min(e.clientX - rect.left, rect.width), 16)
      }

      const root = containerRef?.current ?? (e.currentTarget as HTMLElement)
      scrollParentsRef.current = findScrollParents(root)
      lastPointerY.current = e.clientY
      ensureAutoScroll()
    },
    [containerRef, ensureAutoScroll, setOver],
  )

  // While a block drag is active: track the pointer, auto-scroll, accept drops
  // even when the pointer is not sitting on a thin gap element.
  useEffect(() => {
    if (dragIndex === null) return

    const onDragOver = (e: DragEvent) => {
      if (!isBlockDrag(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

      // Some browsers report (0,0) when the pointer leaves the window.
      if (e.clientX === 0 && e.clientY === 0) return
      lastPointerY.current = e.clientY
      updateTargetFromY(e.clientY)
      ensureAutoScroll()
    }

    const onDrop = (e: DragEvent) => {
      if (dragIndexRef.current === null) return
      if (!isBlockDrag(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      const from = dragIndexRef.current
      const to = overGapRef.current
      end()
      if (from !== null && to !== null) onMoveRef.current(from, to)
    }

    const onDragEnd = () => {
      // dragend fires even when drop already handled the move — end is idempotent.
      end()
    }

    // Capture phase so we still see events when nested targets stopPropagation.
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('dragend', onDragEnd, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('dragend', onDragEnd, true)
    }
  }, [dragIndex, end, ensureAutoScroll, updateTargetFromY])

  /** Wire onto a gap for visual drop feedback. Drop itself is handled globally. */
  const gapProps = useCallback(
    (gap: number) => {
      const from = dragIndexRef.current
      if (from === null) return null
      if (gap === from || gap === from + 1) return null

      return {
        onDragOver: (e: React.DragEvent) => {
          if (!isBlockDrag(e.dataTransfer)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          if (e.clientX === 0 && e.clientY === 0) return
          lastPointerY.current = e.clientY
          setOver(gap)
          ensureAutoScroll()
        },
        onDragLeave: () => {
          // Don't clear overGap here — global tracking owns the active target.
        },
        onDrop: (e: React.DragEvent) => {
          if (!isBlockDrag(e.dataTransfer)) return
          e.preventDefault()
          e.stopPropagation()
          const source = dragIndexRef.current
          end()
          if (source !== null) onMoveRef.current(source, gap)
        },
      }
    },
    [end, ensureAutoScroll, setOver],
  )

  return { dragIndex, overGap, start, end, gapProps }
}
