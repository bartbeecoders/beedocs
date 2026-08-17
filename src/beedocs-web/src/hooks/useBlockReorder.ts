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

/** A block's position: which grid cell it lives in, and where inside it. */
export type BlockAddr = { cell: number; index: number }

/** A drop target: gap `gap` (0 = before first block) inside cell `cell`. */
export type GapAddr = { cell: number; gap: number }

export function sameGap(a: GapAddr | null, b: GapAddr | null): boolean {
  return !!a && !!b && a.cell === b.cell && a.gap === b.gap
}

type Options = {
  /** Move the block at `from` to sit before gap `to` (possibly in another cell). */
  onMove: (from: BlockAddr, to: GapAddr) => void
  /**
   * Editor root. Used to find scrollable ancestors (for edge auto-scroll),
   * cell containers (`[data-cell-root]`) and block elements for hit testing.
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
 * Pick the cell container the pointer is over — or, when it sits in the gutter
 * between cells, the nearest one — so a drag can cross grid columns.
 */
function cellFromPointer(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): { cell: number; el: HTMLElement } | null {
  const cells = root.querySelectorAll<HTMLElement>('[data-cell-root]')
  if (cells.length === 0) return null

  let best: { cell: number; el: HTMLElement } | null = null
  let bestDist = Infinity
  cells.forEach((el) => {
    const idx = Number(el.getAttribute('data-cell-root'))
    if (!Number.isFinite(idx)) return
    const r = el.getBoundingClientRect()
    const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
    const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      bestDist = dist
      best = { cell: idx, el }
    }
  })
  return best
}

/**
 * Pick a gap from pointer position: choose the cell under (or nearest to) the
 * pointer, then walk that cell's block mid-lines. More reliable than only
 * reacting to thin insert-gap hit targets, especially while auto-scroll is
 * moving content under a fixed pointer.
 */
function gapFromPointer(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  from: BlockAddr,
): GapAddr | null {
  const hit = cellFromPointer(root, clientX, clientY)
  if (!hit) return null

  const blocks = hit.el.querySelectorAll<HTMLElement>('.hybrid-block-wrap')
  if (blocks.length === 0) return skipNoop({ cell: hit.cell, gap: 0 }, from)

  const first = blocks[0].getBoundingClientRect()
  if (clientY < first.top + 12) return skipNoop({ cell: hit.cell, gap: 0 }, from)

  const last = blocks[blocks.length - 1].getBoundingClientRect()
  if (clientY > last.bottom - 12) return skipNoop({ cell: hit.cell, gap: blocks.length }, from)

  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect()
    const mid = r.top + r.height / 2
    if (clientY < mid) return skipNoop({ cell: hit.cell, gap: i }, from)
  }
  return skipNoop({ cell: hit.cell, gap: blocks.length }, from)
}

/** Dropping immediately before or after the dragged block is a no-op. */
function skipNoop(gap: GapAddr, from: BlockAddr): GapAddr | null {
  if (gap.cell === from.cell && (gap.gap === from.index || gap.gap === from.index + 1)) return null
  return gap
}

export function useBlockReorder({ onMove, containerRef }: Options) {
  /** Address of the block being dragged, or null when no reorder is in flight. */
  const [dragAddr, setDragAddr] = useState<BlockAddr | null>(null)
  /** Gap the pointer is currently targeting. */
  const [overGap, setOverGap] = useState<GapAddr | null>(null)

  const dragAddrRef = useRef<BlockAddr | null>(null)
  const overGapRef = useRef<GapAddr | null>(null)
  const scrollParentsRef = useRef<HTMLElement[]>([])
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  const setOver = useCallback((gap: GapAddr | null) => {
    overGapRef.current = gap
    setOverGap((prev) => (sameGap(prev, gap) ? prev : gap))
  }, [])

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastPointer.current = null
    scrollParentsRef.current = []
  }, [])

  const end = useCallback(() => {
    dragAddrRef.current = null
    setDragAddr(null)
    setOver(null)
    stopAutoScroll()
  }, [setOver, stopAutoScroll])

  const updateTargetFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const from = dragAddrRef.current
      if (from === null) return
      const root = containerRef?.current
      if (!root) return
      setOver(gapFromPointer(root, clientX, clientY, from))
    },
    [containerRef, setOver],
  )

  const tickScroll = useCallback(() => {
    rafRef.current = null
    if (dragAddrRef.current === null) return
    const p = lastPointer.current
    if (p == null) return

    const scrolled = autoScrollAt(p.y, scrollParentsRef.current)
    // After scrolling, content moves under a fixed pointer — re-hit-test gaps.
    if (scrolled) updateTargetFromPointer(p.x, p.y)

    rafRef.current = requestAnimationFrame(tickScroll)
  }, [updateTargetFromPointer])

  const ensureAutoScroll = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(tickScroll)
  }, [tickScroll])

  const start = useCallback(
    (addr: BlockAddr, e: React.DragEvent) => {
      dragAddrRef.current = addr
      setDragAddr(addr)
      setOver(null)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(BLOCK_MIME, `${addr.cell}:${addr.index}`)
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
      lastPointer.current = { x: e.clientX, y: e.clientY }
      ensureAutoScroll()
    },
    [containerRef, ensureAutoScroll, setOver],
  )

  // While a block drag is active: track the pointer, auto-scroll, accept drops
  // even when the pointer is not sitting on a thin gap element.
  useEffect(() => {
    if (dragAddr === null) return

    const onDragOver = (e: DragEvent) => {
      if (!isBlockDrag(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

      // Some browsers report (0,0) when the pointer leaves the window.
      if (e.clientX === 0 && e.clientY === 0) return
      lastPointer.current = { x: e.clientX, y: e.clientY }
      updateTargetFromPointer(e.clientX, e.clientY)
      ensureAutoScroll()
    }

    const onDrop = (e: DragEvent) => {
      if (dragAddrRef.current === null) return
      if (!isBlockDrag(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      const from = dragAddrRef.current
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
  }, [dragAddr, end, ensureAutoScroll, updateTargetFromPointer])

  /** Wire onto a gap for visual drop feedback. Drop itself is handled globally. */
  const gapProps = useCallback(
    (gap: GapAddr) => {
      const from = dragAddrRef.current
      if (from === null) return null
      if (skipNoop(gap, from) === null) return null

      return {
        onDragOver: (e: React.DragEvent) => {
          if (!isBlockDrag(e.dataTransfer)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          if (e.clientX === 0 && e.clientY === 0) return
          lastPointer.current = { x: e.clientX, y: e.clientY }
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
          const source = dragAddrRef.current
          end()
          if (source !== null) onMoveRef.current(source, gap)
        },
      }
    },
    [end, ensureAutoScroll, setOver],
  )

  return { dragAddr, overGap, start, end, gapProps }
}
