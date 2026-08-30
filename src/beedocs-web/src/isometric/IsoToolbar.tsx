import { useI18n } from '../i18n'
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
  const { t } = useI18n()
  const hasSelection = selectionSize(ctrl.selection) > 0

  return (
    <div className="studio-toolbar" role="toolbar" aria-label={t('isometric.toolbar.tools')}>
      <div className="studio-toolbar-group">
        <button
          type="button"
          className="studio-tool"
          title={t('isometric.toolbar.undo')}
          disabled={!ctrl.canUndo}
          onClick={ctrl.undo}
        >
          ↶
        </button>
        <button
          type="button"
          className="studio-tool"
          title={t('isometric.toolbar.redo')}
          disabled={!ctrl.canRedo}
          onClick={ctrl.redo}
        >
          ↷
        </button>
      </div>

      <div className="studio-toolbar-group">
        <button
          type="button"
          className="studio-tool"
          title={t('isometric.toolbar.zoomOut')}
          onClick={onZoomOut}
        >
          −
        </button>
        <button
          type="button"
          className="studio-tool studio-tool--wide"
          title={t('isometric.toolbar.actualSize')}
          onClick={onActualSize}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="studio-tool"
          title={t('isometric.toolbar.zoomIn')}
          onClick={onZoomIn}
        >
          +
        </button>
        <button
          type="button"
          className="studio-tool"
          title={t('isometric.toolbar.fit')}
          onClick={onFit}
        >
          ⤢
        </button>
      </div>

      <div className="studio-toolbar-group">
        <button
          type="button"
          className="studio-tool"
          title={t('isometric.toolbar.delete')}
          disabled={!hasSelection}
          onClick={ctrl.deleteSelection}
        >
          🗑
        </button>
        <button
          type="button"
          className="studio-tool"
          title={t('isometric.toolbar.duplicate')}
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
          title={t('isometric.toolbar.toggleGrid')}
          onClick={() => ctrl.setPrefs({ grid: !ctrl.prefs.grid })}
        >
          ◈
        </button>
      </div>

      <div className="studio-toolbar-group studio-toolbar-group--end">
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.paletteOpen ? ' is-active' : ''}`}
          title={t('isometric.toolbar.togglePalette')}
          onClick={() => ctrl.setPrefs({ paletteOpen: !ctrl.prefs.paletteOpen })}
        >
          ▤ {t('isometric.toolbar.shapes')}
        </button>
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.formatOpen ? ' is-active' : ''}`}
          title={t('isometric.toolbar.toggleFormat')}
          onClick={() => ctrl.setPrefs({ formatOpen: !ctrl.prefs.formatOpen })}
        >
          {t('isometric.toolbar.format')} ▤
        </button>
      </div>
    </div>
  )
}
