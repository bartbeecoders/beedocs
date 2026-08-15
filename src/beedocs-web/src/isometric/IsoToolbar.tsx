import { selectionSize, type IsoController } from './useIsoController'

type Props = {
  ctrl: IsoController
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onActualSize: () => void
}

/** Top action bar — the studio toolbar, trimmed to what the iso editor supports. */
export function IsoToolbar({ ctrl, zoom, onZoomIn, onZoomOut, onFit, onActualSize }: Props) {
  const hasSelection = selectionSize(ctrl.selection) > 0

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
        <button
          type="button"
          className="studio-tool studio-tool--wide"
          title="Actual size (Ctrl+0)"
          onClick={onActualSize}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="studio-tool" title="Zoom in (Ctrl++)" onClick={onZoomIn}>
          +
        </button>
        <button type="button" className="studio-tool" title="Fit content (Ctrl+Shift+H)" onClick={onFit}>
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
      </div>

      <div className="studio-toolbar-group">
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.grid ? ' is-active' : ''}`}
          title="Toggle grid"
          onClick={() => ctrl.setPrefs({ grid: !ctrl.prefs.grid })}
        >
          ◈
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
