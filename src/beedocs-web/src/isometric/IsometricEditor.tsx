import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IsoCanvas, type IsoCanvasHandle } from './IsoCanvas'
import { IsoFormatPanel } from './IsoFormatPanel'
import { IsoPalette } from './IsoPalette'
import { IsoToolbar } from './IsoToolbar'
import { itemAtTile } from './isoRender'
import type { IsoTile } from './isoModel'
import { selectionSize, useIsoController } from './useIsoController'

type Props = {
  source: string
  onChange: (source: string) => void
  title?: string
  readOnly?: boolean
}

/**
 * The isometric diagram workspace (`kind: "isometric"`): shape palette,
 * infinite tile canvas with hover-to-connect, and a format panel — the same
 * layout, mouse handling and keyboard map as the BeeDiagram studio, drawn in
 * 2:1 dimetric projection.
 */
export default function IsometricEditor({ source, onChange, readOnly }: Props) {
  const ctrl = useIsoController({ source, onChange, readOnly })
  const canvasRef = useRef<IsoCanvasHandle>(null)
  const [zoom, setZoom] = useState(1)

  /** Place a palette entry at a tile ('zone'/'text' are not item shapes). */
  const placeAt = useCallback(
    (shapeId: string, tile: IsoTile) => {
      if (shapeId === 'zone') {
        ctrl.addZone({ x1: tile.x, y1: tile.y, x2: tile.x + 1, y2: tile.y + 1 })
        return
      }
      if (shapeId === 'text') {
        const id = ctrl.addText({ x: tile.x, y: tile.y, text: '' })
        canvasRef.current?.editLabel('text', id)
        return
      }
      // Cascade so repeated clicks don't pile items on the same tile.
      let at = tile
      for (let i = 0; i < 24 && itemAtTile(ctrl.docRef.current, at); i++) {
        at = i % 2 === 0 ? { x: at.x + 1, y: at.y } : { x: at.x, y: at.y + 1 }
      }
      ctrl.addItem({ x: at.x, y: at.y, shape: shapeId })
    },
    [ctrl],
  )

  const placeFromPalette = useCallback(
    (shapeId: string) => {
      if (readOnly) return
      placeAt(shapeId, canvasRef.current?.centerTile() ?? { x: 0, y: 0 })
      canvasRef.current?.focus()
    },
    [placeAt, readOnly],
  )

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const sel = ctrl.selectionRef.current
      if (selectionSize(sel) === 0) return
      ctrl.apply((prev) => ({
        ...prev,
        items: prev.items.map((i) =>
          sel.items.includes(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i,
        ),
        zones: prev.zones.map((z) =>
          sel.zones.includes(z.id)
            ? { ...z, x1: z.x1 + dx, y1: z.y1 + dy, x2: z.x2 + dx, y2: z.y2 + dy }
            : z,
        ),
        texts: prev.texts.map((t) =>
          sel.texts.includes(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t,
        ),
      }))
    },
    [ctrl],
  )

  const editSelectionLabel = useCallback(
    (opts?: { text?: string; selectAll?: boolean }): boolean => {
      const sel = ctrl.selectionRef.current
      if (sel.items.length === 1 && selectionSize(sel) === 1) {
        canvasRef.current?.editLabel('item', sel.items[0], opts)
        return true
      }
      if (sel.connectors.length === 1 && selectionSize(sel) === 1) {
        canvasRef.current?.editLabel('connector', sel.connectors[0], opts)
        return true
      }
      if (sel.zones.length === 1 && selectionSize(sel) === 1) {
        canvasRef.current?.editLabel('zone', sel.zones[0], opts)
        return true
      }
      if (sel.texts.length === 1 && selectionSize(sel) === 1) {
        canvasRef.current?.editLabel('text', sel.texts[0], opts)
        return true
      }
      return false
    },
    [ctrl.selectionRef],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (readOnly) return
      const target = e.target as HTMLElement
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable)
        return
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
        if (editSelectionLabel()) e.preventDefault()
        return
      }
      if (e.key.startsWith('Arrow')) {
        e.preventDefault()
        if (e.key === 'ArrowLeft') nudge(-1, 1)
        else if (e.key === 'ArrowRight') nudge(1, -1)
        else if (e.key === 'ArrowUp') nudge(-1, -1)
        else if (e.key === 'ArrowDown') nudge(1, 1)
        return
      }

      // Type-to-edit: with one element selected, the first character starts
      // the label edit (draw.io-style, same as the studio).
      if (!mod && !e.altKey && e.key.length === 1 && e.key !== ' ' && !e.nativeEvent.isComposing) {
        if (editSelectionLabel({ text: e.key, selectAll: false })) e.preventDefault()
      }
    },
    [ctrl, editSelectionLabel, nudge, readOnly],
  )

  const sel = ctrl.selection

  return (
    <div className="bee-studio iso-studio" tabIndex={0} onKeyDown={onKeyDown}>
      {!readOnly && (
        <IsoToolbar
          ctrl={ctrl}
          zoom={zoom}
          onZoomIn={() => canvasRef.current?.zoomIn()}
          onZoomOut={() => canvasRef.current?.zoomOut()}
          onFit={() => canvasRef.current?.zoomToFit()}
          onActualSize={() => canvasRef.current?.actualSize()}
        />
      )}

      <div className="studio-body">
        {ctrl.prefs.paletteOpen && !readOnly && (
          <IsoPalette onPlace={placeFromPalette} disabled={readOnly} />
        )}
        <IsoCanvas ref={canvasRef} ctrl={ctrl} onZoomChange={setZoom} onDropShape={placeAt} />
        {ctrl.prefs.formatOpen && !readOnly && (
          <IsoFormatPanel
            ctrl={ctrl}
            zoom={zoom}
            onZoom={(z) => canvasRef.current?.setZoom(z)}
            onFit={() => canvasRef.current?.zoomToFit()}
          />
        )}
      </div>

      <div className="studio-status">
        <span>
          {selectionSize(sel) > 0
            ? [
                sel.items.length > 0 && `${sel.items.length} shape${sel.items.length === 1 ? '' : 's'}`,
                sel.connectors.length > 0 &&
                  `${sel.connectors.length} connection${sel.connectors.length === 1 ? '' : 's'}`,
                sel.zones.length > 0 && `${sel.zones.length} zone${sel.zones.length === 1 ? '' : 's'}`,
                sel.texts.length > 0 && `${sel.texts.length} text${sel.texts.length === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(', ') + ' selected'
            : 'Nothing selected'}
        </span>
        <span className="muted">
          Hover a shape to connect it · drag from the palette · double-click to rename
        </span>
      </div>
    </div>
  )
}
