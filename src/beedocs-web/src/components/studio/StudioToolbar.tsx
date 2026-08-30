import { useI18n } from '../../i18n'
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
  /** Save the selected shapes as a book collection (requires book context). */
  onSaveAsCollection?: () => void
}

/** Top action bar — the draw.io toolbar, trimmed to what BeeDocs supports. */
export function StudioToolbar({
  ctrl,
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onActualSize,
  onPickImage,
  onSaveAsCollection,
}: Props) {
  const { t } = useI18n()
  const nodeIds = ctrl.selection.nodes
  const edgeIds = ctrl.selection.edges
  const hasSelection = nodeIds.length > 0 || edgeIds.length > 0

  return (
    <div className="studio-toolbar" role="toolbar" aria-label={t('studio.diagramTools')}>
      <div className="studio-toolbar-group">
        <button
          type="button"
          className="studio-tool"
          title={t('studio.tipUndo')}
          disabled={!ctrl.canUndo}
          onClick={ctrl.undo}
        >
          ↶
        </button>
        <button
          type="button"
          className="studio-tool"
          title={t('studio.tipRedo')}
          disabled={!ctrl.canRedo}
          onClick={ctrl.redo}
        >
          ↷
        </button>
      </div>

      <div className="studio-toolbar-group">
        <button type="button" className="studio-tool" title={t('studio.tipZoomOut')} onClick={onZoomOut}>
          −
        </button>
        <button type="button" className="studio-tool studio-tool--wide" title={t('studio.tipActualSize')} onClick={onActualSize}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="studio-tool" title={t('studio.tipZoomIn')} onClick={onZoomIn}>
          +
        </button>
        <button type="button" className="studio-tool" title={t('studio.tipFitPage')} onClick={onFit}>
          ⤢
        </button>
      </div>

      <div className="studio-toolbar-group">
        <button
          type="button"
          className="studio-tool"
          title={t('studio.tipDelete')}
          disabled={!hasSelection}
          onClick={ctrl.deleteSelection}
        >
          🗑
        </button>
        <button
          type="button"
          className="studio-tool"
          title={t('studio.tipDuplicate')}
          disabled={!hasSelection}
          onClick={ctrl.duplicateSelection}
        >
          ⧉
        </button>
        {onSaveAsCollection && (
          <button
            type="button"
            className="studio-tool studio-tool--wide"
            title={t('studio.tipSaveCollection')}
            disabled={nodeIds.length === 0}
            onClick={onSaveAsCollection}
          >
            {t('studio.saveCollection')}
          </button>
        )}
        <button
          type="button"
          className="studio-tool"
          title={t('studio.tipBringFront')}
          disabled={nodeIds.length === 0}
          onClick={() => ctrl.orderSelection('front')}
        >
          ⬒
        </button>
        <button
          type="button"
          className="studio-tool"
          title={t('studio.tipSendBack')}
          disabled={nodeIds.length === 0}
          onClick={() => ctrl.orderSelection('back')}
        >
          ⬓
        </button>
      </div>

      <div className="studio-toolbar-group">
        <label className="studio-tool-color" title={t('studio.tipFillColor')}>
          <span aria-hidden>▣</span>
          <input
            type="color"
            disabled={nodeIds.length === 0}
            onChange={(e) => ctrl.updateNodeStyle(nodeIds, { fill: e.target.value })}
          />
        </label>
        <label className="studio-tool-color" title={t('studio.tipLineColor')}>
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
          title={t('studio.tipConnectionStyle')}
          value={edgeIds.length > 0 ? (ctrl.selectedEdges[0]?.route ?? 'straight') : ''}
          disabled={edgeIds.length === 0}
          onChange={(e) =>
            ctrl.updateEdges(edgeIds, { route: e.target.value as BeeEdgeRoute, waypoints: undefined })
          }
        >
          <option value="" disabled>
            {t('studio.line')}
          </option>
          <option value="orthogonal">{t('studio.route.orthogonal')}</option>
          <option value="straight">{t('studio.route.straight')}</option>
          <option value="curved">{t('studio.route.curved')}</option>
        </select>
      </div>

      <div className="studio-toolbar-group">
        <button type="button" className="studio-tool" title={t('studio.tipInsertImage')} onClick={onPickImage}>
          🖼
        </button>
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.grid ? ' is-active' : ''}`}
          title={t('studio.tipToggleGrid')}
          onClick={() => ctrl.setPrefs({ grid: !ctrl.prefs.grid })}
        >
          ▦
        </button>
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.snap ? ' is-active' : ''}`}
          title={t('studio.snapToGrid')}
          onClick={() => ctrl.setPrefs({ snap: !ctrl.prefs.snap })}
        >
          🧲
        </button>
      </div>

      <div className="studio-toolbar-group studio-toolbar-group--end">
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.paletteOpen ? ' is-active' : ''}`}
          title={t('studio.tipTogglePalette')}
          onClick={() => ctrl.setPrefs({ paletteOpen: !ctrl.prefs.paletteOpen })}
        >
          ▤ {t('studio.shapes')}
        </button>
        <button
          type="button"
          className={`studio-tool${ctrl.prefs.formatOpen ? ' is-active' : ''}`}
          title={t('studio.tipToggleFormat')}
          onClick={() => ctrl.setPrefs({ formatOpen: !ctrl.prefs.formatOpen })}
        >
          {t('studio.format')} ▤
        </button>
      </div>
    </div>
  )
}
