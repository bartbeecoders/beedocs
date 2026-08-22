import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { collectDroppedFiles, dragHasFiles } from '../media/attachments'

type Options = {
  onFiles: (files: File[]) => void
  /** When false the zone ignores drags entirely — read-only accounts. */
  enabled?: boolean
}

export type FileDropZone = {
  /** True while an OS file drag is over the zone. Drives the drop overlay. */
  dragging: boolean
  /** Spread onto the element that should accept files. */
  dropProps: {
    onDragEnter: (e: ReactDragEvent) => void
    onDragOver: (e: ReactDragEvent) => void
    onDragLeave: (e: ReactDragEvent) => void
    onDrop: (e: ReactDragEvent) => void
  }
}

/**
 * A drop target for files dragged in from outside the browser.
 *
 * The depth counter is the reason this is a hook rather than four inline
 * handlers: `dragleave` fires every time the pointer crosses into a *child*
 * element, so tracking a boolean makes the highlight flicker its way across any
 * zone that contains anything. Counting enter/leave pairs and clearing at zero
 * is the fix, and it has to survive re-renders — hence the ref.
 *
 * Drags the app itself started (tree items, which carry JSON rather than files)
 * fall through untouched, so a zone can accept both without either winning by
 * accident.
 */
export function useFileDropZone({ onFiles, enabled = true }: Options): FileDropZone {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles

  const reset = useCallback(() => {
    depth.current = 0
    setDragging(false)
  }, [])

  const onDragEnter = useCallback(
    (e: ReactDragEvent) => {
      if (!enabled || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current += 1
      setDragging(true)
    },
    [enabled],
  )

  const onDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (!enabled || !dragHasFiles(e.dataTransfer)) return
      // Without preventDefault on *every* dragover the browser refuses the drop
      // and navigates to the file instead.
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    },
    [enabled],
  )

  const onDragLeave = useCallback(
    (e: ReactDragEvent) => {
      if (!enabled || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    },
    [enabled],
  )

  /**
   * Clear the highlight when a drag ends anywhere else.
   *
   * The enter/leave counter is only balanced while the pointer keeps crossing
   * this zone's own boundaries. A drag that ends elsewhere — dropped on other
   * chrome, or abandoned outside the window — can leave the last `dragleave`
   * unmatched, and the zone would then stay lit with nothing dragging. These
   * listeners are the floor under that: they never handle a file, only reset.
   */
  useEffect(() => {
    if (!enabled) return
    const clear = () => {
      if (depth.current !== 0) reset()
    }
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
    }
  }, [enabled, reset])

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      if (!enabled || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      reset()
      const files = collectDroppedFiles(e.dataTransfer)
      if (files.length) onFilesRef.current(files)
    },
    [enabled, reset],
  )

  return { dragging, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
