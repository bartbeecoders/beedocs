import { useI18n } from '../i18n'
import { isoShapeName } from './IsoPalette'
import { ISO_COLOR_SWATCHES } from './isoModel'
import { ISO_SHAPES } from './isoShapes'
import { selectionSize, type IsoController } from './useIsoController'

type Props = {
  ctrl: IsoController
  zoom: number
  onZoom: (zoom: number) => void
  onFit: () => void
}

function Swatches({
  value,
  onPick,
}: {
  value: string | undefined
  onPick: (color: string | undefined) => void
}) {
  const { t } = useI18n()
  return (
    <div className="studio-swatches">
      <button
        type="button"
        className={`studio-swatch studio-swatch--none${value === undefined ? ' is-active' : ''}`}
        title={t('isometric.format.defaultColour')}
        onClick={() => onPick(undefined)}
      />
      {ISO_COLOR_SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className={`studio-swatch${value === c ? ' is-active' : ''}`}
          style={{ background: c }}
          title={c}
          onClick={() => onPick(c)}
        />
      ))}
      <label className="studio-swatch studio-swatch--custom" title={t('isometric.format.customColour')}>
        <input
          type="color"
          value={value ?? '#6c8ebf'}
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
    </div>
  )
}

/** Right-hand format panel — label, colour and per-kind options for the selection. */
export function IsoFormatPanel({ ctrl, zoom, onZoom, onFit }: Props) {
  const { t } = useI18n()
  const sel = ctrl.selection
  const items = ctrl.selectedItems
  const connectors = ctrl.selectedConnectors
  const zones = ctrl.selectedZones
  const texts = ctrl.selectedTexts
  const total = selectionSize(sel)

  return (
    <aside className="studio-format" aria-label={t('isometric.toolbar.format')}>
      <div className="studio-format-body">
        {total === 0 && (
          <section className="studio-format-section">
            <h4>{t('common.diagram')}</h4>
            <label className="studio-field">
              <span>{t('isometric.format.zoom')}</span>
              <input
                type="range"
                min={15}
                max={250}
                value={Math.round(zoom * 100)}
                onChange={(e) => onZoom(Number(e.target.value) / 100)}
              />
            </label>
            <div className="studio-btn-row">
              <button type="button" className="btn sm" onClick={onFit}>
                {t('isometric.format.fitContent')}
              </button>
              <button type="button" className="btn sm" onClick={() => onZoom(1)}>
                100%
              </button>
            </div>
            <label className="studio-check-row">
              <input
                type="checkbox"
                checked={ctrl.prefs.grid}
                onChange={(e) => ctrl.setPrefs({ grid: e.target.checked })}
              />
              {t('isometric.format.showGrid')}
            </label>
            <p className="muted sm studio-tips">{t('isometric.format.tips')}</p>
          </section>
        )}

        {items.length > 0 && (
          <section className="studio-format-section">
            <h4>
              {items.length === 1
                ? isoShapeName(t, items[0].shape)
                : t('isometric.count.shapes.other', { count: items.length })}
            </h4>
            {items.length === 1 && (
              <label className="studio-field studio-field--stack">
                <span>{t('isometric.format.label')}</span>
                <input
                  value={items[0].label ?? ''}
                  placeholder={t('isometric.format.labelUnderShape')}
                  onChange={(e) =>
                    ctrl.updateItems([items[0].id], { label: e.target.value || undefined })
                  }
                />
              </label>
            )}
            {items.length === 1 && (
              <label className="studio-field studio-field--stack">
                <span>{t('isometric.format.shape')}</span>
                <select
                  value={items[0].shape in ISO_SHAPES ? items[0].shape : 'block'}
                  onChange={(e) => ctrl.updateItems([items[0].id], { shape: e.target.value })}
                >
                  {Object.values(ISO_SHAPES).map((s) => (
                    <option key={s.id} value={s.id}>
                      {isoShapeName(t, s.id)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="studio-field studio-field--stack">
              <span>{t('isometric.format.colour')}</span>
              <Swatches
                value={items[0].color}
                onPick={(color) =>
                  ctrl.updateItems(
                    items.map((i) => i.id),
                    { color },
                  )
                }
              />
            </div>
          </section>
        )}

        {connectors.length > 0 && (
          <section className="studio-format-section">
            <h4>
              {connectors.length === 1
                ? t('isometric.connection')
                : t('isometric.count.connections.other', { count: connectors.length })}
            </h4>
            {connectors.length === 1 && (
              <label className="studio-field studio-field--stack">
                <span>{t('isometric.format.label')}</span>
                <input
                  value={connectors[0].label ?? ''}
                  placeholder={t('isometric.format.labelOnLine')}
                  onChange={(e) =>
                    ctrl.updateConnectors([connectors[0].id], {
                      label: e.target.value || undefined,
                    })
                  }
                />
              </label>
            )}
            <label className="studio-check-row">
              <input
                type="checkbox"
                checked={connectors.every((c) => c.dashed)}
                onChange={(e) =>
                  ctrl.updateConnectors(
                    connectors.map((c) => c.id),
                    { dashed: e.target.checked || undefined },
                  )
                }
              />
              {t('isometric.format.dashed')}
            </label>
            <div className="studio-field studio-field--stack">
              <span>{t('isometric.format.colour')}</span>
              <Swatches
                value={connectors[0].color}
                onPick={(color) =>
                  ctrl.updateConnectors(
                    connectors.map((c) => c.id),
                    { color },
                  )
                }
              />
            </div>
          </section>
        )}

        {zones.length > 0 && (
          <section className="studio-format-section">
            <h4>
              {zones.length === 1
                ? t('isometric.shape.zone')
                : t('isometric.count.zones.other', { count: zones.length })}
            </h4>
            {zones.length === 1 && (
              <label className="studio-field studio-field--stack">
                <span>{t('isometric.format.label')}</span>
                <input
                  value={zones[0].label ?? ''}
                  placeholder={t('isometric.format.zoneName')}
                  onChange={(e) =>
                    ctrl.updateZones([zones[0].id], { label: e.target.value || undefined })
                  }
                />
              </label>
            )}
            <div className="studio-field studio-field--stack">
              <span>{t('isometric.format.colour')}</span>
              <Swatches
                value={zones[0].color}
                onPick={(color) =>
                  ctrl.updateZones(
                    zones.map((z) => z.id),
                    { color },
                  )
                }
              />
            </div>
            <p className="muted sm">{t('isometric.format.resizeHint')}</p>
          </section>
        )}

        {texts.length > 0 && (
          <section className="studio-format-section">
            <h4>
              {texts.length === 1
                ? t('isometric.shape.text')
                : t('isometric.count.texts.other', { count: texts.length })}
            </h4>
            {texts.length === 1 && (
              <label className="studio-field studio-field--stack">
                <span>{t('isometric.shape.text')}</span>
                <input
                  value={texts[0].text}
                  onChange={(e) => ctrl.updateTexts([texts[0].id], { text: e.target.value })}
                />
              </label>
            )}
          </section>
        )}

        {total > 0 && (
          <section className="studio-format-section">
            <div className="studio-btn-row">
              <button type="button" className="btn sm" onClick={ctrl.duplicateSelection}>
                {t('isometric.duplicate')}
              </button>
              <button type="button" className="btn danger ghost sm" onClick={ctrl.deleteSelection}>
                {t('common.delete')}
              </button>
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}
