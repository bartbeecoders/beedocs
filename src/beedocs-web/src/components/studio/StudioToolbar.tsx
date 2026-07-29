import type { BeeEdgeRoute } from '../../types'
import type { StudioController } from './useStudioController'

type Props = {
  ctrl: StudioController
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onActualSize: () => void
  onPickImage: () => void
}

/** Top action bar — the draw.io toolbar, trimmed to what BeeDocs supports. */
export function StudioToolbar({ ctrl, zoom, onZoomIn, onZoomOut, onFit, onActualSize, onPickImage }: Props) {
  const nodeIds = ctrl.selection.nodes
  const edgeIds = ctrl.selection.edges
  const hasSelection = nodeIds.length > 0 || edgeIds.length > 0

  return (
    <div className="studio-toolbar" role="toolbar" aria-label="Diagram tools">
      <div className="studio-toolbar-group">
        <button
          type="button"
          className="studio-tool"
          title="Undo (Ctrl+Z)"
          disabled={!ctrl.canUndo}
          onClick={ctrl.undo}
        >
          ↶
        </button>
        <button
          type="button"
          className="studio-tool"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!ctrl.canRedo}
          onClick={ctrl.redo}
        >
          ↷
        </button>
      </div>

      <div className="studio-toolbar-group">
        <button type="button" className="studio-tool" title="Zoom out (Ctrl+-)" onClick={onZoomOut}>
          −
        </button>
        <button type="button" className="studio-tool studio-tool--wide" title="Actual size (Ctrl+Shift+0)" onClick={onActualSize}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="studio-tool" title="Zoom in (Ctrl++)" onClick={onZoomIn}>
          +
        </button>
        <button type="button" className="studio-tool" title="Fit page (Ctrl+Shift+H)" onClick={onFit}>
          ⤢
        </button>
      </div>

      <div className="studio-toolbar-group">
        <button
          type="button"
          className="studio-tool"
          title="Delete (Del)"
          disabled={!hasSelection}
          onClick={ctrl.deleteSelection}
        >
          🗑
        </button>
        <button
          type="button"
          className="studio-tool"
          title="Duplicate (Ctrl+D)"
          disabled={!hasSelection}
          onClick={ctrl.duplicateSelection}
        >
          ⧉
        </button>
        <button
          type="button"
          className="studio-tool"
          title="Bring to front (Ctrl+Shift+F)"
          disabled={nodeIds.length === 0}
          onClick={() => ctrl.orderSelection('front')}
        >
          ⬒
        </button>
        <button
          type="button"
          className="studio-tool"
          title="Send to back (Ctrl+Shift+B)"
          disabled={nodeIds.length === 0}
          onClick={() => ctrl.orderSelection('back')}
        >
          ⬓
        </button>
      </div>

      <div className="studio-toolbar-group">
        <label className="studio-tool-color" title="Fill colour">
          <span aria-hidden>▣</span>
          <input
            type="color"
            disabled={nodeIds.length === 0}
            onChange={(e) => ctrl.updateNodeStyle(nodeIds, { fill: e.target.value })}
          />
        </label>
        <label className="studio-tool-color" title="Line colour">
          <span aria-hidden>▤</span>
          <input
            type="color"
            onChange={(e) => {
              if (nodeIds.length > 0) ctrl.updateNodeStyle(nodeIds, { stroke: e.target.value })
              if (edgeIds.length > 0) ctrl.updateEdgeStyle(edgeIds, { stroke: e.target.value })
            }}
          />
        </label>
        <select
          className="studio-tool-select"
          title="Connection style"
          value={edgeIds.length > 0 ? (ctrl.selectedEdges[0]?.route ?? 'straight') : ''}
          disabled={edgeIds.length === 0}
          onChange={(e) =>
            ctrl.updateEdges(edgeIds, { route: e.target.value as BeeEdgeRoute, waypoints: undefined })
          }
        >
          <option value="" disabled>
            Line
          </option>
          <option value="orthogonal">Orthogonal</option>
          <option value="straight">Straight</option>
          <option value="curved">Curved</option>
        </select>
      </div>

      <div className="studio-toolbar-group">
        <button type="button" className="studio-tool" title="Insert image" onClick={onPickImage}>
          🖼
        </button>
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.grid ? ' is-active' : ''}`}
          title="Toggle grid"
          onClick={() => ctrl.setPrefs({ grid: !ctrl.prefs.grid })}
        >
          ▦
        </button>
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.snap ? ' is-active' : ''}`}
          title="Snap to grid"
          onClick={() => ctrl.setPrefs({ snap: !ctrl.prefs.snap })}
        >
          🧲
        </button>
      </div>

      <div className="studio-toolbar-group studio-toolbar-group--end">
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.paletteOpen ? ' is-active' : ''}`}
          title="Toggle shape panel"
          onClick={() => ctrl.setPrefs({ paletteOpen: !ctrl.prefs.paletteOpen })}
        >
          ▤ Shapes
        </button>
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.formatOpen ? ' is-active' : ''}`}
          title="Toggle format panel"
          onClick={() => ctrl.setPrefs({ formatOpen: !ctrl.prefs.formatOpen })}
        >
          Format ▤
        </button>
      </div>
    </div>
  )
}
