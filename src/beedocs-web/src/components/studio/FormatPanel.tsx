import { useState } from 'react'
import { useI18n, type MessageKey } from '../../i18n'
import type { BeeArrowHead, BeeEdgeRoute, BeeShape, BeeTextAlign, BeeTextVAlign } from '../../types'
import {
  AZURE_CATEGORY_ORDER,
  AZURE_CATEGORY_TITLES,
  AZURE_ICONS,
} from '../../diagram/azureIcons'
import {
  resolveEdgeStyle,
  resolveNodeStyle,
  resolveShape,
  shapeFillParts,
} from '../../diagram/shapes'
import type { StudioController } from './useStudioController'

type Tab = 'style' | 'text' | 'arrange'

const SWATCHES = [
  '#ffffff',
  '#f5f5f5',
  '#dae8fc',
  '#d5e8d4',
  '#ffe6cc',
  '#fff2cc',
  '#f8cecc',
  '#e1d5e7',
  '#141a21',
  '#647687',
  '#1d4ed8',
  '#0f766e',
]

const LINE_SWATCHES = [
  '#141a21',
  '#647687',
  '#6c8ebf',
  '#82b366',
  '#d79b00',
  '#b85450',
  '#9673a6',
  '#ffffff',
]

/** Labels resolve at render via `studio.shape.${id}` (same keys as the palette). */
const SHAPE_SWAP: BeeShape[] = [
  'rectangle',
  'rounded',
  'stadium',
  'ellipse',
  'circle',
  'rhombus',
  'parallelogram',
  'hexagon',
  'triangle',
  'process',
  'document',
  'cylinder',
  'cloud',
  'note',
  'card',
  'callout',
  'cube',
  'step',
  'trapezoid',
  'tape',
  'internalStorage',
  'dataStorage',
  'actor',
  'container',
  'text',
  'azure',
]

const ARROW_HEADS: { id: BeeArrowHead; key: MessageKey }[] = [
  { id: 'none', key: 'common.none' },
  { id: 'arrow', key: 'studio.arrow.arrow' },
  { id: 'open', key: 'studio.arrow.open' },
  { id: 'diamond', key: 'studio.arrow.diamond' },
  { id: 'circle', key: 'studio.arrow.circle' },
]

/**
 * `shapeFillParts` labels live in diagram/shapes.ts (not edited — the catalog
 * is serialized for MCP); known labels translate here, unknown ones pass
 * through in English.
 */
const FILL_PART_KEYS: Record<string, MessageKey> = {
  Header: 'studio.fillPart.header',
  Body: 'studio.fillPart.body',
  Front: 'studio.fillPart.front',
  'Top / side': 'studio.fillPart.topSide',
  Paper: 'studio.fillPart.paper',
  Fold: 'studio.fillPart.fold',
  Top: 'studio.fillPart.top',
  Backplate: 'studio.fillPart.backplate',
  Fill: 'studio.fillPart.fill',
}

type Props = {
  ctrl: StudioController
  zoom: number
  onZoom: (z: number) => void
  onFit: () => void
}

/** Right-hand Format panel, modelled on the draw.io Style / Text / Arrange tabs. */
export function FormatPanel({ ctrl, zoom, onZoom, onFit }: Props) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('style')
  const { selectedNodes, selectedEdges } = ctrl
  const nodeIds = selectedNodes.map((n) => n.id)
  const edgeIds = selectedEdges.map((e) => e.id)
  const primaryNode = selectedNodes[0]
  const primaryEdge = selectedEdges[0]
  const nodeStyle = primaryNode ? resolveNodeStyle(primaryNode) : null
  const edgeStyle = primaryEdge ? resolveEdgeStyle(primaryEdge) : null
  const hasSelection = nodeIds.length > 0 || edgeIds.length > 0

  return (
    <aside className="studio-format" aria-label={t('studio.format')}>
      {hasSelection ? (
        <>
          <div className="studio-format-tabs" role="tablist">
            {(['style', 'text', 'arrange'] as Tab[]).map((tb) => (
              <button
                key={tb}
                type="button"
                role="tab"
                aria-selected={tab === tb}
                className={tab === tb ? 'is-active' : ''}
                onClick={() => setTab(tb)}
              >
                {tb === 'style'
                  ? t('studio.tabStyle')
                  : tb === 'text'
                    ? t('studio.tabText')
                    : t('studio.tabArrange')}
              </button>
            ))}
          </div>
          <div className="studio-format-body">
            {tab === 'style' && (
              <>
                {primaryNode && nodeStyle && (
                  <section className="studio-format-section">
                    <h4>{t('studio.shape')}</h4>
                    {shapeFillParts(resolveShape(primaryNode)).map((part) => {
                      const value = part.key === 'fill' ? nodeStyle.fill : nodeStyle.fill2
                      const partLabel = FILL_PART_KEYS[part.label]
                        ? t(FILL_PART_KEYS[part.label])
                        : part.label
                      return (
                        <div key={part.key}>
                          <label className="studio-field">
                            <span>{partLabel}</span>
                            <input
                              type="color"
                              value={normalizeColor(value)}
                              onChange={(e) =>
                                ctrl.updateNodeStyle(nodeIds, { [part.key]: e.target.value })
                              }
                            />
                          </label>
                          <Swatches
                            colors={SWATCHES}
                            onPick={(c) => ctrl.updateNodeStyle(nodeIds, { [part.key]: c })}
                            onNone={() => ctrl.updateNodeStyle(nodeIds, { [part.key]: 'none' })}
                          />
                        </div>
                      )
                    })}
                    <label className="studio-field">
                      <span>{t('studio.line')}</span>
                      <input
                        type="color"
                        value={normalizeColor(nodeStyle.stroke)}
                        onChange={(e) => ctrl.updateNodeStyle(nodeIds, { stroke: e.target.value })}
                      />
                    </label>
                    <Swatches
                      colors={LINE_SWATCHES}
                      onPick={(c) => ctrl.updateNodeStyle(nodeIds, { stroke: c })}
                      onNone={() => ctrl.updateNodeStyle(nodeIds, { stroke: 'none' })}
                    />
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>{t('studio.width')}</span>
                        <input
                          type="number"
                          min={0}
                          max={12}
                          step={0.5}
                          value={nodeStyle.strokeWidth}
                          onChange={(e) =>
                            ctrl.updateNodeStyle(nodeIds, { strokeWidth: Number(e.target.value) || 0 })
                          }
                        />
                      </label>
                      <label className="studio-field">
                        <span>{t('studio.opacity')}</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={5}
                          value={nodeStyle.opacity}
                          onChange={(e) =>
                            ctrl.updateNodeStyle(nodeIds, { opacity: clamp(Number(e.target.value), 0, 100) })
                          }
                        />
                      </label>
                    </div>
                    <div className="studio-check-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={!!primaryNode.style?.dashed}
                          onChange={(e) => ctrl.updateNodeStyle(nodeIds, { dashed: e.target.checked })}
                        />
                        {t('studio.dashed')}
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!primaryNode.style?.shadow}
                          onChange={(e) => ctrl.updateNodeStyle(nodeIds, { shadow: e.target.checked })}
                        />
                        {t('studio.shadow')}
                      </label>
                    </div>
                    <label className="studio-field">
                      <span>{t('studio.shape')}</span>
                      <select
                        value={primaryNode.shape ?? ''}
                        onChange={(e) =>
                          ctrl.updateNodes(nodeIds, {
                            shape: (e.target.value || undefined) as BeeShape | undefined,
                          })
                        }
                      >
                        <option value="">{t('studio.classicOption', { type: primaryNode.type })}</option>
                        {SHAPE_SWAP.map((s) => (
                          <option key={s} value={s}>
                            {t(`studio.shape.${s}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {primaryNode.shape === 'azure' && (
                      <label className="studio-field">
                        <span>{t('studio.service')}</span>
                        <select
                          value={primaryNode.icon ?? 'azure'}
                          onChange={(e) => ctrl.updateNodes(nodeIds, { icon: e.target.value })}
                        >
                          {AZURE_CATEGORY_ORDER.map((category) => (
                            <optgroup key={category} label={AZURE_CATEGORY_TITLES[category]}>
                              {AZURE_ICONS.filter((i) => i.category === category).map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </label>
                    )}
                    {(primaryNode.shape === 'image' || primaryNode.type === 'image') && (
                      <label className="studio-field studio-field--stack">
                        <span>{t('studio.imageUrl')}</span>
                        <input
                          value={primaryNode.imageUrl ?? ''}
                          placeholder="/uploads/…"
                          onChange={(e) => ctrl.updateNodes(nodeIds, { imageUrl: e.target.value })}
                        />
                      </label>
                    )}
                  </section>
                )}

                {primaryEdge && edgeStyle && (
                  <section className="studio-format-section">
                    <h4>{t('studio.connection')}</h4>
                    <label className="studio-field">
                      <span>{t('studio.line')}</span>
                      <input
                        type="color"
                        value={normalizeColor(edgeStyle.stroke)}
                        onChange={(e) => ctrl.updateEdgeStyle(edgeIds, { stroke: e.target.value })}
                      />
                    </label>
                    <Swatches colors={LINE_SWATCHES} onPick={(c) => ctrl.updateEdgeStyle(edgeIds, { stroke: c })} />
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>{t('studio.width')}</span>
                        <input
                          type="number"
                          min={0.5}
                          max={12}
                          step={0.5}
                          value={edgeStyle.strokeWidth}
                          onChange={(e) =>
                            ctrl.updateEdgeStyle(edgeIds, { strokeWidth: Number(e.target.value) || 1 })
                          }
                        />
                      </label>
                      <label className="studio-field">
                        <span>{t('studio.tabStyle')}</span>
                        <select
                          value={primaryEdge.route ?? 'straight'}
                          onChange={(e) =>
                            ctrl.updateEdges(edgeIds, {
                              route: e.target.value as BeeEdgeRoute,
                              waypoints: undefined,
                            })
                          }
                        >
                          <option value="orthogonal">{t('studio.route.orthogonal')}</option>
                          <option value="straight">{t('studio.route.straight')}</option>
                          <option value="curved">{t('studio.route.curved')}</option>
                        </select>
                      </label>
                    </div>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>{t('studio.start')}</span>
                        <select
                          value={edgeStyle.startArrow}
                          onChange={(e) =>
                            ctrl.updateEdgeStyle(edgeIds, { startArrow: e.target.value as BeeArrowHead })
                          }
                        >
                          {ARROW_HEADS.map((a) => (
                            <option key={a.id} value={a.id}>
                              {t(a.key)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="studio-field">
                        <span>{t('studio.end')}</span>
                        <select
                          value={edgeStyle.endArrow}
                          onChange={(e) =>
                            ctrl.updateEdgeStyle(edgeIds, { endArrow: e.target.value as BeeArrowHead })
                          }
                        >
                          {ARROW_HEADS.map((a) => (
                            <option key={a.id} value={a.id}>
                              {t(a.key)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="studio-check-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={!!primaryEdge.style?.dashed}
                          onChange={(e) => ctrl.updateEdgeStyle(edgeIds, { dashed: e.target.checked })}
                        />
                        {t('studio.dashed')}
                      </label>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => ctrl.updateEdges(edgeIds, { waypoints: undefined })}
                    >
                      {t('studio.clearWaypoints')}
                    </button>
                  </section>
                )}
              </>
            )}

            {tab === 'text' && (
              <section className="studio-format-section">
                <h4>{t('studio.tabText')}</h4>
                {primaryNode && nodeStyle && (
                  <>
                    <label className="studio-field studio-field--stack">
                      <span>{t('studio.label')}</span>
                      <textarea
                        rows={3}
                        value={primaryNode.label}
                        onChange={(e) => ctrl.updateNodes(nodeIds, { label: e.target.value })}
                      />
                    </label>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>{t('studio.size')}</span>
                        <input
                          type="number"
                          min={6}
                          max={72}
                          value={nodeStyle.fontSize}
                          onChange={(e) =>
                            ctrl.updateNodeStyle(nodeIds, { fontSize: clamp(Number(e.target.value), 6, 72) })
                          }
                        />
                      </label>
                      <label className="studio-field">
                        <span>{t('studio.colour')}</span>
                        <input
                          type="color"
                          value={normalizeColor(nodeStyle.fontColor)}
                          onChange={(e) => ctrl.updateNodeStyle(nodeIds, { fontColor: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="studio-btn-row">
                      <button
                        type="button"
                        className={`studio-toggle${nodeStyle.bold ? ' is-active' : ''}`}
                        onClick={() => ctrl.updateNodeStyle(nodeIds, { bold: !nodeStyle.bold })}
                        title={t('studio.bold')}
                      >
                        <b>B</b>
                      </button>
                      <button
                        type="button"
                        className={`studio-toggle${nodeStyle.italic ? ' is-active' : ''}`}
                        onClick={() => ctrl.updateNodeStyle(nodeIds, { italic: !nodeStyle.italic })}
                        title={t('studio.italic')}
                      >
                        <i>I</i>
                      </button>
                      {(['left', 'center', 'right'] as BeeTextAlign[]).map((a) => (
                        <button
                          key={a}
                          type="button"
                          className={`studio-toggle${nodeStyle.align === a ? ' is-active' : ''}`}
                          onClick={() => ctrl.updateNodeStyle(nodeIds, { align: a })}
                          title={t(`studio.align.${a}` as MessageKey)}
                        >
                          {a === 'left' ? '⯇' : a === 'center' ? '≡' : '⯈'}
                        </button>
                      ))}
                      {(['top', 'middle', 'bottom'] as BeeTextVAlign[]).map((v) => (
                        <button
                          key={v}
                          type="button"
                          className={`studio-toggle${nodeStyle.valign === v ? ' is-active' : ''}`}
                          onClick={() => ctrl.updateNodeStyle(nodeIds, { valign: v })}
                          title={t(`studio.valign.${v}` as MessageKey)}
                        >
                          {v === 'top' ? '⤒' : v === 'middle' ? '↕' : '⤓'}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {primaryEdge && edgeStyle && (
                  <>
                    <label className="studio-field studio-field--stack">
                      <span>{t('studio.connectionLabel')}</span>
                      <input
                        value={primaryEdge.label ?? ''}
                        onChange={(e) => ctrl.updateEdges(edgeIds, { label: e.target.value })}
                      />
                    </label>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>{t('studio.size')}</span>
                        <input
                          type="number"
                          min={6}
                          max={48}
                          value={edgeStyle.fontSize}
                          onChange={(e) =>
                            ctrl.updateEdgeStyle(edgeIds, { fontSize: clamp(Number(e.target.value), 6, 48) })
                          }
                        />
                      </label>
                      <label className="studio-field">
                        <span>{t('studio.colour')}</span>
                        <input
                          type="color"
                          value={normalizeColor(edgeStyle.fontColor)}
                          onChange={(e) => ctrl.updateEdgeStyle(edgeIds, { fontColor: e.target.value })}
                        />
                      </label>
                    </div>
                  </>
                )}
              </section>
            )}

            {tab === 'arrange' && (
              <section className="studio-format-section">
                {primaryNode && (
                  <>
                    <h4>{t('studio.size')}</h4>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>W</span>
                        <input
                          type="number"
                          value={Math.round(primaryNode.w)}
                          min={10}
                          onChange={(e) => ctrl.updateNodes(nodeIds, { w: Math.max(10, Number(e.target.value)) })}
                        />
                      </label>
                      <label className="studio-field">
                        <span>H</span>
                        <input
                          type="number"
                          value={Math.round(primaryNode.h)}
                          min={10}
                          onChange={(e) => ctrl.updateNodes(nodeIds, { h: Math.max(10, Number(e.target.value)) })}
                        />
                      </label>
                    </div>
                    <h4>{t('studio.position')}</h4>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>X</span>
                        <input
                          type="number"
                          value={Math.round(primaryNode.x)}
                          onChange={(e) => ctrl.updateNodes([primaryNode.id], { x: Number(e.target.value) })}
                        />
                      </label>
                      <label className="studio-field">
                        <span>Y</span>
                        <input
                          type="number"
                          value={Math.round(primaryNode.y)}
                          onChange={(e) => ctrl.updateNodes([primaryNode.id], { y: Number(e.target.value) })}
                        />
                      </label>
                    </div>
                    <label className="studio-field">
                      <span>{t('studio.angle')}</span>
                      <input
                        type="number"
                        min={0}
                        max={359}
                        value={Math.round(primaryNode.rotation ?? 0)}
                        onChange={(e) => {
                          const v = ((Number(e.target.value) % 360) + 360) % 360
                          ctrl.updateNodes(nodeIds, { rotation: v === 0 ? undefined : v })
                        }}
                      />
                    </label>

                    <h4>{t('studio.order')}</h4>
                    <div className="studio-btn-row">
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('front')}>
                        {t('studio.toFront')}
                      </button>
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('back')}>
                        {t('studio.toBack')}
                      </button>
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('forward')}>
                        {t('studio.forward')}
                      </button>
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('backward')}>
                        {t('studio.backward')}
                      </button>
                    </div>

                    {nodeIds.length > 1 && (
                      <>
                        <h4>{t('studio.alignHeading')}</h4>
                        <div className="studio-btn-row">
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('left')}>
                            {t('studio.left')}
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('centerH')}>
                            {t('studio.center')}
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('right')}>
                            {t('studio.right')}
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('top')}>
                            {t('studio.top')}
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('middleV')}>
                            {t('studio.middle')}
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('bottom')}>
                            {t('studio.bottom')}
                          </button>
                        </div>
                        <h4>{t('studio.distribute')}</h4>
                        <div className="studio-btn-row">
                          <button type="button" className="btn sm" onClick={() => ctrl.distributeSelection('h')}>
                            {t('studio.horizontal')}
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.distributeSelection('v')}>
                            {t('studio.vertical')}
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
                {!primaryNode && primaryEdge && (
                  <>
                    <h4>{t('studio.connection')}</h4>
                    <p className="muted sm">{t('studio.edgeArrangeHint')}</p>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => ctrl.updateEdges(edgeIds, { waypoints: undefined })}
                    >
                      {t('studio.resetWaypoints')}
                    </button>
                  </>
                )}
              </section>
            )}
          </div>
        </>
      ) : (
        <div className="studio-format-body">
          <section className="studio-format-section">
            <h4>{t('common.diagram')}</h4>
            <div className="studio-check-row studio-check-row--stack">
              <label>
                <input
                  type="checkbox"
                  checked={ctrl.prefs.grid}
                  onChange={(e) => ctrl.setPrefs({ grid: e.target.checked })}
                />
                {t('studio.grid')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={ctrl.prefs.snap}
                  onChange={(e) => ctrl.setPrefs({ snap: e.target.checked })}
                />
                {t('studio.snapToGrid')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={ctrl.prefs.guides}
                  onChange={(e) => ctrl.setPrefs({ guides: e.target.checked })}
                />
                {t('studio.alignmentGuides')}
              </label>
            </div>
            <label className="studio-field">
              <span>{t('studio.zoom')}</span>
              <input
                type="number"
                min={20}
                max={400}
                step={10}
                value={Math.round(zoom * 100)}
                onChange={(e) => onZoom(clamp(Number(e.target.value), 20, 400) / 100)}
              />
            </label>
            <button type="button" className="btn sm" onClick={onFit}>
              {t('studio.fitPage')}
            </button>
            <p className="muted sm">
              {t('studio.docStats', {
                shapes: t(
                  ctrl.doc.nodes.length === 1 ? 'studio.nShapes.one' : 'studio.nShapes.other',
                  { count: ctrl.doc.nodes.length },
                ),
                connections: t(
                  ctrl.doc.edges.length === 1
                    ? 'studio.nConnections.one'
                    : 'studio.nConnections.other',
                  { count: ctrl.doc.edges.length },
                ),
              })}
            </p>
          </section>
          <section className="studio-format-section">
            <h4>{t('studio.tips')}</h4>
            <ul className="studio-tips">
              <li>{t('studio.tip1')}</li>
              <li>{t('studio.tip2')}</li>
              <li>{t('studio.tip3')}</li>
              <li>{t('studio.tip4')}</li>
              <li>{t('studio.tip5')}</li>
            </ul>
          </section>
        </div>
      )}
    </aside>
  )
}

function Swatches({
  colors,
  onPick,
  onNone,
}: {
  colors: string[]
  onPick: (color: string) => void
  onNone?: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="studio-swatches">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className="studio-swatch"
          style={{ background: c }}
          title={c}
          onClick={() => onPick(c)}
          aria-label={t('studio.useColor', { color: c })}
        />
      ))}
      {onNone && (
        <button
          key="none"
          type="button"
          className="studio-swatch studio-swatch--none"
          title={t('common.none')}
          onClick={onNone}
          aria-label={t('studio.noColour')}
        />
      )}
    </div>
  )
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

/** `<input type="color">` needs a #rrggbb value. */
function normalizeColor(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
  }
  return '#ffffff'
}
