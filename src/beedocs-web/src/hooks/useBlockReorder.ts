import { useCallback, useRef, useState } from 'react'

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
}

export function useBlockReorder({ onMove }: Options) {
  /** Index of the block being dragged, or null when no reorder is in flight. */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** Gap the pointer is currently over. */
  const [overGap, setOverGap] = useState<number | null>(null)
  // dragIndex is also read from handlers created in earlier renders.
  const dragIndexRef = useRef<number | null>(null)

  const end = useCallback(() => {
    dragIndexRef.current = null
    setDragIndex(null)
    setOverGap(null)
  }, [])

  const start = useCallback((index: number, e: React.DragEvent) => {
    dragIndexRef.current = index
    setDragIndex(index)
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
  }, [])

  /** Wire onto a gap to make it a drop target. Returns null for gaps that would not move anything. */
  const gapProps = useCallback(
    (gap: number) => {
      const from = dragIndexRef.current
      if (from === null) return null
      // Dropping either side of where the block already sits changes nothing.
      if (gap === from || gap === from + 1) return null

      return {
        onDragOver: (e: React.DragEvent) => {
          if (!isBlockDrag(e.dataTransfer)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setOverGap(gap)
        },
        onDragLeave: () => setOverGap((g) => (g === gap ? null : g)),
        onDrop: (e: React.DragEvent) => {
          if (!isBlockDrag(e.dataTransfer)) return
          e.preventDefault()
          e.stopPropagation()
          const source = dragIndexRef.current
          end()
          if (source !== null) onMove(source, gap)
        },
      }
    },
    [end, onMove],
  )

  return { dragIndex, overGap, start, end, gapProps }
}
