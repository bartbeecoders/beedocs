import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  collectImageFilesFromDataTransfer,
  collectImagesFromClipboard,
  uploadImageFile,
  type UploadedImage,
} from '../media/imageIntake'

export type ImageIntakeContext = {
  clientX: number
  clientY: number
  /** Element under the pointer at drop/paste time */
  target: EventTarget | null
  source: 'drop' | 'paste' | 'pick'
}

type Options = {
  enabled?: boolean
  targetRef?: RefObject<HTMLElement | null>
  paste?: boolean
  onUploaded: (images: UploadedImage[], ctx: ImageIntakeContext) => void | Promise<void>
  onError?: (message: string) => void
}

/**
 * Drag-and-drop + clipboard paste of image files → upload → callback with drop context.
 */
export function useImageIntake({
  enabled = true,
  targetRef,
  paste = true,
  onUploaded,
  onError,
}: Options) {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const dragDepth = useRef(0)
  const onUploadedRef = useRef(onUploaded)
  const onErrorRef = useRef(onError)
  onUploadedRef.current = onUploaded
  onErrorRef.current = onError

  const processFiles = useCallback(async (files: File[], ctx: ImageIntakeContext) => {
    if (!files.length) return
    setUploading(true)
    try {
      const uploaded: UploadedImage[] = []
      for (const f of files) {
        uploaded.push(await uploadImageFile(f))
      }
      if (uploaded.length) await onUploadedRef.current(uploaded, ctx)
    } catch (e) {
      onErrorRef.current?.(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      setDragging(false)
      dragDepth.current = 0
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const el = targetRef?.current
    if (!el) return

    const hasFiles = (dt: DataTransfer | null) =>
      !!dt &&
      (Array.from(dt.types || []).includes('Files') ||
        (dt.items && Array.from(dt.items).some((i) => i.kind === 'file')))

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent) => {
      const files = collectImageFilesFromDataTransfer(e.dataTransfer)
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation()
      dragDepth.current = 0
      setDragging(false)
      void processFiles(files, {
        clientX: e.clientX,
        clientY: e.clientY,
        target: e.target,
        source: 'drop',
      })
    }

    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
    }
  }, [enabled, processFiles, targetRef])

  useEffect(() => {
    if (!enabled || !paste) return
    const onPaste = (e: ClipboardEvent) => {
      void (async () => {
        const files = await collectImagesFromClipboard(e)
        if (!files.length) return
        e.preventDefault()
        const t = e.target
        // Prefer caret in focused textarea for paste placement
        let clientX = 0
        let clientY = 0
        if (t instanceof HTMLTextAreaElement) {
          const r = t.getBoundingClientRect()
          clientX = r.left + 8
          clientY = r.top + 8
        }
        await processFiles(files, {
          clientX,
          clientY,
          target: t,
          source: 'paste',
        })
      })()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [enabled, paste, processFiles])

  const pickFiles = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = () => {
      const list = input.files ? Array.from(input.files) : []
      void processFiles(
        list.filter((f) => f.type.startsWith('image/') || isLikelyImageName(f.name)),
        { clientX: 0, clientY: 0, target: null, source: 'pick' },
      )
    }
    input.click()
  }, [processFiles])

  return { dragging, uploading, pickFiles, processFiles }
}

function isLikelyImageName(name: string) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
}
