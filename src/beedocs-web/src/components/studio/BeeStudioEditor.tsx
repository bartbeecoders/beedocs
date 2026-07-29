import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { BeePoint } from '../../types'
import { useImageIntake } from '../../hooks/useImageIntake'
import { loadImageSize, type UploadedImage } from '../../media/imageIntake'
import { nodeFromLibraryItem, type ShapeLibraryItem } from '../../diagram/shapeLibrary'
import { createShapeNode } from '../../diagram/shapes'
import { snapToGrid } from '../../diagram/beeModel'
import { FormatPanel } from './FormatPanel'
import { ShapePalette } from './ShapePalette'
import { StudioCanvas, STUDIO_GRID, type StudioCanvasHandle } from './StudioCanvas'
import { StudioToolbar } from './StudioToolbar'
import { useStudioController } from './useStudioController'

type Props = {
  source: string
  onChange: (source: string) => void
  readOnly?: boolean
}

/**
 * Draw.io-style diagram editor: shape palette, infinite canvas with
 * hover-to-connect, and a Format panel — editing the same BeeDiagram JSON as
 * the classic editor.
 */
export function BeeStudioEditor({ source, onChange, readOnly }: Props) {
  const ctrl = useStudioController({ source, onChange, readOnly })
  const canvasRef = useRef<StudioCanvasHandle>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dropWorldRef = useRef<BeePoint | null>(null)
  const [zoom, setZoom] = useState(1)
  const [mediaError, setMediaError] = useState<string | null>(null)

  const placeImages = useCallback(
    async (images: UploadedImage[]) => {
      const at = dropWorldRef.current ?? canvasRef.current?.worldCenter() ?? { x: 120, y: 120 }
      dropWorldRef.current = null
      let offset = 0
      for (const img of images) {
        const dim = await loadImageSize(img.url)
        const node = createShapeNode('image', 0, 0, {
          label: img.fileName,
          imageUrl: img.url,
          w: dim.w,
          h: dim.h + 20,
        })
        node.x = Math.round(at.x - node.w / 2 + offset)
        node.y = Math.round(at.y - node.h / 2 + offset)
        ctrl.addNodes([node])
        offset += 24
      }
    },
    [ctrl],
  )

  const { dragging, uploading, pickFiles } = useImageIntake({
    enabled: !readOnly,
    targetRef: rootRef,
    paste: true, // image paste; shape paste is handled by the key handler below
    onUploaded: (images, ctx) => {
      if (ctx.source === 'drop') {
        dropWorldRef.current = canvasRef.current?.clientToWorld(ctx.clientX, ctx.clientY) ?? null
      }
      return placeImages(images)
    },
    onError: (msg) => setMediaError(msg),
  })

  const placeFromPalette = useCallback(
    (item: ShapeLibraryItem) => {
      if (readOnly) return
      if (item.legacyType === 'image') {
        dropWorldRef.current = canvasRef.current?.worldCenter() ?? null
        pickFiles()
        return
      }
      const center = canvasRef.current?.worldCenter() ?? { x: 200, y: 160 }
      const node = nodeFromLibraryItem(item, 0, 0)
      const grid = ctrl.prefs.snap
      node.x = grid ? snapToGrid(center.x - node.w / 2, STUDIO_GRID, true) : Math.round(center.x - node.w / 2)
      node.y = grid ? snapToGrid(center.y - node.h / 2, STUDIO_GRID, true) : Math.round(center.y - node.h / 2)
      // Cascade so repeated clicks don't pile shapes on top of each other
      const step = STUDIO_GRID * 3
      for (let i = 0; i < 24; i++) {
        const clash = ctrl.docRef.current.nodes.some(
          (n) =>
            n.x < node.x + node.w && node.x < n.x + n.w && n.y < node.y + node.h && node.y < n.y + n.h,
        )
        if (!clash) break
        node.x += step
        node.y += step
      }
      ctrl.addNodes([node])
    },
    [ctrl, pickFiles, readOnly],
  )

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const ids = ctrl.selectionRef.current.nodes
      if (ids.length === 0) return
      ctrl.updateNodes(ids, (n) => ({ x: n.x + dx, y: n.y + dy }))
    },
    [ctrl],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (readOnly) return
      const target = e.target as HTMLElement
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) ctrl.redo()
        else ctrl.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        ctrl.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        ctrl.copySelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'x') {
        e.preventDefault()
        ctrl.cutSelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        ctrl.pasteClipboard()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        ctrl.duplicateSelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        ctrl.selectAll()
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        ctrl.orderSelection('front')
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        ctrl.orderSelection('back')
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        canvasRef.current?.zoomToFit()
        return
      }
      if (mod && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        canvasRef.current?.zoomIn()
        return
      }
      if (mod && e.key === '-') {
        e.preventDefault()
        canvasRef.current?.zoomOut()
        return
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        canvasRef.current?.actualSize()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        ctrl.deleteSelection()
        return
      }
      if (e.key === 'Escape') {
        ctrl.clearSelection()
        return
      }
      if (e.key === 'F2' || (e.key === 'Enter' && !mod)) {
        const nodeId = ctrl.selectionRef.current.nodes[0]
        const edgeId = ctrl.selectionRef.current.edges[0]
        if (nodeId) {
          e.preventDefault()
          canvasRef.current?.editLabel('node', nodeId)
        } else if (edgeId) {
          e.preventDefault()
          canvasRef.current?.editLabel('edge', edgeId)
        }
        return
      }
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? STUDIO_GRID : 1
        e.preventDefault()
        if (e.key === 'ArrowLeft') nudge(-step, 0)
        else if (e.key === 'ArrowRight') nudge(step, 0)
        else if (e.key === 'ArrowUp') nudge(0, -step)
        else if (e.key === 'ArrowDown') nudge(0, step)
      }
    },
    [ctrl, nudge, readOnly],
  )

  return (
    <div
      ref={rootRef}
      className={`bee-studio${dragging ? ' is-drop-target' : ''}`}
      onKeyDown={onKeyDown}
    >
      {(dragging || uploading) && !readOnly && (
        <div className="image-drop-overlay" aria-live="polite">
          {uploading ? 'Uploading image…' : 'Drop image onto the canvas'}
        </div>
      )}
      {mediaError && (
        <div className="banner error compact">
          {mediaError}{' '}
          <button type="button" className="btn ghost sm" onClick={() => setMediaError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {!readOnly && (
        <StudioToolbar
          ctrl={ctrl}
          zoom={zoom}
          onZoomIn={() => canvasRef.current?.zoomIn()}
          onZoomOut={() => canvasRef.current?.zoomOut()}
          onFit={() => canvasRef.current?.zoomToFit()}
          onActualSize={() => canvasRef.current?.actualSize()}
          onPickImage={() => {
            dropWorldRef.current = canvasRef.current?.worldCenter() ?? null
            pickFiles()
          }}
        />
      )}

      <div className="studio-body">
        {ctrl.prefs.paletteOpen && !readOnly && (
          <ShapePalette onPlace={placeFromPalette} disabled={readOnly} />
        )}
        <StudioCanvas
          ref={canvasRef}
          ctrl={ctrl}
          onZoomChange={setZoom}
          onRequestImage={(world) => {
            dropWorldRef.current = world
            pickFiles()
          }}
        />
        {ctrl.prefs.formatOpen && !readOnly && (
          <FormatPanel
            ctrl={ctrl}
            zoom={zoom}
            onZoom={(z) => canvasRef.current?.setZoom(z)}
            onFit={() => canvasRef.current?.zoomToFit()}
          />
        )}
      </div>

      <div className="studio-status">
        <span>
          {ctrl.selection.nodes.length + ctrl.selection.edges.length > 0
            ? `${ctrl.selection.nodes.length} shape${ctrl.selection.nodes.length === 1 ? '' : 's'}, ${ctrl.selection.edges.length} connection${ctrl.selection.edges.length === 1 ? '' : 's'} selected`
            : 'Nothing selected'}
        </span>
        <span className="muted">
          Drag a shape from the left · hover a shape and drag the blue arrow to connect · double-click to
          rename
        </span>
      </div>
    </div>
  )
}
