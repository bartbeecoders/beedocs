import { useCallback, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '../../api'
import type { BeePoint, ShapeCollection, ShapeCollectionScope } from '../../types'
import { useImageIntake } from '../../hooks/useImageIntake'
import { loadImageSize, type UploadedImage } from '../../media/imageIntake'
import { fragmentBounds, parseFragment } from '../../diagram/collectionFragment'
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
  /** Owning book — enables book-scoped collections (app collections always work). */
  bookId?: string
}

/**
 * Draw.io-style diagram editor: shape palette, infinite canvas with
 * hover-to-connect, and a Format panel — editing the same BeeDiagram JSON as
 * the classic editor.
 */
export function BeeStudioEditor({ source, onChange, readOnly, bookId }: Props) {
  const ctrl = useStudioController({ source, onChange, readOnly })
  const canvasRef = useRef<StudioCanvasHandle>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dropWorldRef = useRef<BeePoint | null>(null)
  const [zoom, setZoom] = useState(1)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [collectionsVersion, setCollectionsVersion] = useState(0)
  const [saveDialog, setSaveDialog] = useState<{
    name: string
    description: string
    scope: ShapeCollectionScope
  } | null>(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

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

  const placeCollection = useCallback(
    (collection: ShapeCollection, at?: BeePoint) => {
      if (readOnly) return
      const fragment = parseFragment(collection.source)
      if (!fragment || fragment.nodes.length === 0) return
      const bounds = fragmentBounds(fragment)
      const center = at ?? canvasRef.current?.worldCenter() ?? { x: 200, y: 160 }
      const topLeft = {
        x: Math.round(center.x - bounds.w / 2),
        y: Math.round(center.y - bounds.h / 2),
      }
      const grid = ctrl.prefs.snap
      const origin = {
        x: grid ? snapToGrid(topLeft.x, STUDIO_GRID, true) : topLeft.x,
        y: grid ? snapToGrid(topLeft.y, STUDIO_GRID, true) : topLeft.y,
      }
      ctrl.placeFragment(fragment, origin)
    },
    [ctrl, readOnly],
  )

  const placeCollectionById = useCallback(
    async (id: string, world: BeePoint) => {
      if (readOnly) return
      try {
        const collection = await api.getShapeCollection(id)
        // Drop point is the top-left of the collection bounds.
        ctrl.placeFragment(collection.source, world)
      } catch (e) {
        setMediaError(e instanceof Error ? e.message : String(e))
      }
    },
    [ctrl, readOnly],
  )

  const openSaveCollection = useCallback(() => {
    if (readOnly) return
    if (ctrl.selection.nodes.length === 0) return
    const first = ctrl.selectedNodes[0]
    const fallback = first?.label?.trim() || 'Collection'
    setSaveError(null)
    setSaveDialog({
      name: fallback,
      description: '',
      // Prefer book scope when a book is available; otherwise app-wide only.
      scope: bookId ? 'book' : 'app',
    })
  }, [bookId, ctrl.selection.nodes.length, ctrl.selectedNodes, readOnly])

  const submitSaveCollection = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!saveDialog) return
      const name = saveDialog.name.trim()
      if (!name) {
        setSaveError('Name is required.')
        return
      }
      if (saveDialog.scope === 'book' && !bookId) {
        setSaveError('This diagram is not linked to a book.')
        return
      }
      const source = ctrl.selectionAsCollectionSource()
      if (!source) {
        setSaveError('Select at least one shape to save.')
        return
      }
      setSaveBusy(true)
      setSaveError(null)
      try {
        await api.createShapeCollection({
          name,
          description: saveDialog.description.trim() || undefined,
          source,
          bookId: saveDialog.scope === 'book' ? bookId : undefined,
        })
        setSaveDialog(null)
        setCollectionsVersion((v) => v + 1)
        if (!ctrl.prefs.paletteOpen) ctrl.setPrefs({ paletteOpen: true })
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaveBusy(false)
      }
    },
    [bookId, ctrl, saveDialog],
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
        if (saveDialog) {
          setSaveDialog(null)
          return
        }
        ctrl.clearSelection()
        return
      }
      if (e.key === 'F2' || (e.key === 'Enter' && !mod)) {
        const nodeId = ctrl.selectionRef.current.nodes[0]
        const edgeId = ctrl.selectionRef.current.edges[0]
        if (nodeId && ctrl.selectionRef.current.nodes.length === 1) {
          e.preventDefault()
          canvasRef.current?.editLabel('node', nodeId)
        } else if (edgeId && ctrl.selectionRef.current.nodes.length === 0) {
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
        return
      }

      // Type-to-edit: with a single shape (or edge) selected, start label edit
      // immediately with the first typed character (draw.io-style).
      if (
        !mod &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key !== ' ' &&
        !e.nativeEvent.isComposing
      ) {
        const nodes = ctrl.selectionRef.current.nodes
        const edges = ctrl.selectionRef.current.edges
        if (nodes.length === 1) {
          e.preventDefault()
          canvasRef.current?.editLabel('node', nodes[0], { text: e.key, selectAll: false })
          return
        }
        if (nodes.length === 0 && edges.length === 1) {
          e.preventDefault()
          canvasRef.current?.editLabel('edge', edges[0], { text: e.key, selectAll: false })
          return
        }
      }
    },
    [ctrl, nudge, readOnly, saveDialog],
  )

  const canSaveCollection = !readOnly

  return (
    <div
      ref={rootRef}
      className={`bee-studio${dragging ? ' is-drop-target' : ''}`}
      tabIndex={0}
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
          onSaveAsCollection={canSaveCollection ? openSaveCollection : undefined}
        />
      )}

      <div className="studio-body">
        {ctrl.prefs.paletteOpen && !readOnly && (
          <ShapePalette
            onPlace={placeFromPalette}
            onPlaceCollection={placeCollection}
            bookId={bookId}
            collectionsVersion={collectionsVersion}
            disabled={readOnly}
          />
        )}
        <StudioCanvas
          ref={canvasRef}
          ctrl={ctrl}
          onZoomChange={setZoom}
          onRequestImage={(world) => {
            dropWorldRef.current = world
            pickFiles()
          }}
          onPlaceCollectionId={canSaveCollection ? placeCollectionById : undefined}
          onSaveAsCollection={canSaveCollection ? openSaveCollection : undefined}
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
          Drag a shape or collection from the left · save a selection as a book or app collection
        </span>
      </div>

      {saveDialog && (
        <div className="studio-modal-backdrop" role="presentation" onClick={() => !saveBusy && setSaveDialog(null)}>
          <form
            className="studio-modal"
            role="dialog"
            aria-labelledby="save-collection-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void submitSaveCollection(e)}
          >
            <h3 id="save-collection-title">Save as collection</h3>
            <p className="muted sm">
              Stores the selected shapes so you can place them again from the shape palette.
            </p>
            <fieldset className="studio-scope-fieldset">
              <legend>Save to</legend>
              {bookId && (
                <label className="studio-scope-option">
                  <input
                    type="radio"
                    name="collection-scope"
                    checked={saveDialog.scope === 'book'}
                    onChange={() => setSaveDialog({ ...saveDialog, scope: 'book' })}
                  />
                  <span className="studio-scope-option-text">
                    <strong>This book</strong>
                    <span className="muted sm">Only diagrams in the current book</span>
                  </span>
                </label>
              )}
              <label className="studio-scope-option">
                <input
                  type="radio"
                  name="collection-scope"
                  checked={saveDialog.scope === 'app'}
                  onChange={() => setSaveDialog({ ...saveDialog, scope: 'app' })}
                />
                <span className="studio-scope-option-text">
                  <strong>App library</strong>
                  <span className="muted sm">Available in every book</span>
                </span>
              </label>
            </fieldset>
            <label className="studio-field studio-field--stack">
              <span>Name</span>
              <input
                autoFocus
                value={saveDialog.name}
                onChange={(e) => setSaveDialog({ ...saveDialog, name: e.target.value })}
                maxLength={120}
                required
              />
            </label>
            <label className="studio-field studio-field--stack">
              <span>Description</span>
              <textarea
                value={saveDialog.description}
                onChange={(e) => setSaveDialog({ ...saveDialog, description: e.target.value })}
                rows={3}
                maxLength={500}
                placeholder="Optional — shown under the name in the palette"
              />
            </label>
            {saveError && <div className="banner error compact">{saveError}</div>}
            <div className="studio-modal-actions">
              <button type="button" className="btn ghost" disabled={saveBusy} onClick={() => setSaveDialog(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={saveBusy}>
                {saveBusy ? 'Saving…' : 'Save collection'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
