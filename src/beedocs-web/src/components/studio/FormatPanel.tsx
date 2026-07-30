import { useState } from 'react'
import type { BeeArrowHead, BeeEdgeRoute, BeeShape, BeeTextAlign, BeeTextVAlign } from '../../types'
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

const SHAPE_SWAP: { id: BeeShape; label: string }[] = [
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'stadium', label: 'Terminator' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'circle', label: 'Circle' },
  { id: 'rhombus', label: 'Diamond' },
  { id: 'parallelogram', label: 'Parallelogram' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'process', label: 'Process' },
  { id: 'document', label: 'Document' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'note', label: 'Note' },
  { id: 'card', label: 'Card' },
  { id: 'callout', label: 'Callout' },
  { id: 'cube', label: 'Cube' },
  { id: 'step', label: 'Step' },
  { id: 'trapezoid', label: 'Trapezoid' },
  { id: 'tape', label: 'Tape' },
  { id: 'internalStorage', label: 'Internal storage' },
  { id: 'dataStorage', label: 'Data storage' },
  { id: 'actor', label: 'Actor' },
  { id: 'container', label: 'Container' },
  { id: 'text', label: 'Text' },
]

const ARROW_HEADS: { id: BeeArrowHead; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'open', label: 'Open' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'circle', label: 'Circle' },
]

type Props = {
  ctrl: StudioController
  zoom: number
  onZoom: (z: number) => void
  onFit: () => void
}

/** Right-hand Format panel, modelled on the draw.io Style / Text / Arrange tabs. */
export function FormatPanel({ ctrl, zoom, onZoom, onFit }: Props) {
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
    <aside className="studio-format" aria-label="Format">
      {hasSelection ? (
        <>
          <div className="studio-format-tabs" role="tablist">
            {(['style', 'text', 'arrange'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? 'is-active' : ''}
                onClick={() => setTab(t)}
              >
                {t === 'style' ? 'Style' : t === 'text' ? 'Text' : 'Arrange'}
              </button>
            ))}
          </div>
          <div className="studio-format-body">
            {tab === 'style' && (
              <>
                {primaryNode && nodeStyle && (
                  <section className="studio-format-section">
                    <h4>Shape</h4>
                    {shapeFillParts(resolveShape(primaryNode)).map((part) => {
                      const value = part.key === 'fill' ? nodeStyle.fill : nodeStyle.fill2
                      return (
                        <div key={part.key}>
                          <label className="studio-field">
                            <span>{part.label}</span>
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
                      <span>Line</span>
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
                        <span>Width</span>
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
                        <span>Opacity</span>
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
                        Dashed
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!primaryNode.style?.shadow}
                          onChange={(e) => ctrl.updateNodeStyle(nodeIds, { shadow: e.target.checked })}
                        />
                        Shadow
                      </label>
                    </div>
                    <label className="studio-field">
                      <span>Shape</span>
                      <select
                        value={primaryNode.shape ?? ''}
                        onChange={(e) =>
                          ctrl.updateNodes(nodeIds, {
                            shape: (e.target.value || undefined) as BeeShape | undefined,
                          })
                        }
                      >
                        <option value="">Classic ({primaryNode.type})</option>
                        {SHAPE_SWAP.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(primaryNode.shape === 'image' || primaryNode.type === 'image') && (
                      <label className="studio-field studio-field--stack">
                        <span>Image URL</span>
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
                    <h4>Connection</h4>
                    <label className="studio-field">
                      <span>Line</span>
                      <input
                        type="color"
                        value={normalizeColor(edgeStyle.stroke)}
                        onChange={(e) => ctrl.updateEdgeStyle(edgeIds, { stroke: e.target.value })}
                      />
                    </label>
                    <Swatches colors={LINE_SWATCHES} onPick={(c) => ctrl.updateEdgeStyle(edgeIds, { stroke: c })} />
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>Width</span>
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
                        <span>Style</span>
                        <select
                          value={primaryEdge.route ?? 'straight'}
                          onChange={(e) =>
                            ctrl.updateEdges(edgeIds, {
                              route: e.target.value as BeeEdgeRoute,
                              waypoints: undefined,
                            })
                          }
                        >
                          <option value="orthogonal">Orthogonal</option>
                          <option value="straight">Straight</option>
                          <option value="curved">Curved</option>
                        </select>
                      </label>
                    </div>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>Start</span>
                        <select
                          value={edgeStyle.startArrow}
                          onChange={(e) =>
                            ctrl.updateEdgeStyle(edgeIds, { startArrow: e.target.value as BeeArrowHead })
                          }
                        >
                          {ARROW_HEADS.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="studio-field">
                        <span>End</span>
                        <select
                          value={edgeStyle.endArrow}
                          onChange={(e) =>
                            ctrl.updateEdgeStyle(edgeIds, { endArrow: e.target.value as BeeArrowHead })
                          }
                        >
                          {ARROW_HEADS.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
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
                        Dashed
                      </label>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => ctrl.updateEdges(edgeIds, { waypoints: undefined })}
                    >
                      Clear waypoints
                    </button>
                  </section>
                )}
              </>
            )}

            {tab === 'text' && (
              <section className="studio-format-section">
                <h4>Text</h4>
                {primaryNode && nodeStyle && (
                  <>
                    <label className="studio-field studio-field--stack">
                      <span>Label</span>
                      <textarea
                        rows={3}
                        value={primaryNode.label}
                        onChange={(e) => ctrl.updateNodes(nodeIds, { label: e.target.value })}
                      />
                    </label>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>Size</span>
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
                        <span>Colour</span>
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
                        title="Bold"
                      >
                        <b>B</b>
                      </button>
                      <button
                        type="button"
                        className={`studio-toggle${nodeStyle.italic ? ' is-active' : ''}`}
                        onClick={() => ctrl.updateNodeStyle(nodeIds, { italic: !nodeStyle.italic })}
                        title="Italic"
                      >
                        <i>I</i>
                      </button>
                      {(['left', 'center', 'right'] as BeeTextAlign[]).map((a) => (
                        <button
                          key={a}
                          type="button"
                          className={`studio-toggle${nodeStyle.align === a ? ' is-active' : ''}`}
                          onClick={() => ctrl.updateNodeStyle(nodeIds, { align: a })}
                          title={`Align ${a}`}
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
                          title={`Vertical ${v}`}
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
                      <span>Connection label</span>
                      <input
                        value={primaryEdge.label ?? ''}
                        onChange={(e) => ctrl.updateEdges(edgeIds, { label: e.target.value })}
                      />
                    </label>
                    <div className="studio-field-row">
                      <label className="studio-field">
                        <span>Size</span>
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
                        <span>Colour</span>
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
                    <h4>Size</h4>
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
                    <h4>Position</h4>
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
                      <span>Angle</span>
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

                    <h4>Order</h4>
                    <div className="studio-btn-row">
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('front')}>
                        To front
                      </button>
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('back')}>
                        To back
                      </button>
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('forward')}>
                        Forward
                      </button>
                      <button type="button" className="btn sm" onClick={() => ctrl.orderSelection('backward')}>
                        Backward
                      </button>
                    </div>

                    {nodeIds.length > 1 && (
                      <>
                        <h4>Align</h4>
                        <div className="studio-btn-row">
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('left')}>
                            Left
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('centerH')}>
                            Center
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('right')}>
                            Right
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('top')}>
                            Top
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('middleV')}>
                            Middle
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.alignSelection('bottom')}>
                            Bottom
                          </button>
                        </div>
                        <h4>Distribute</h4>
                        <div className="studio-btn-row">
                          <button type="button" className="btn sm" onClick={() => ctrl.distributeSelection('h')}>
                            Horizontal
                          </button>
                          <button type="button" className="btn sm" onClick={() => ctrl.distributeSelection('v')}>
                            Vertical
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
                {!primaryNode && primaryEdge && (
                  <>
                    <h4>Connection</h4>
                    <p className="muted sm">
                      Drag the round handles on the line to bend it, or the endpoints to re-attach.
                    </p>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => ctrl.updateEdges(edgeIds, { waypoints: undefined })}
                    >
                      Reset waypoints
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
            <h4>Diagram</h4>
            <div className="studio-check-row studio-check-row--stack">
              <label>
                <input
                  type="checkbox"
                  checked={ctrl.prefs.grid}
                  onChange={(e) => ctrl.setPrefs({ grid: e.target.checked })}
                />
                Grid
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={ctrl.prefs.snap}
                  onChange={(e) => ctrl.setPrefs({ snap: e.target.checked })}
                />
                Snap to grid
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={ctrl.prefs.guides}
                  onChange={(e) => ctrl.setPrefs({ guides: e.target.checked })}
                />
                Alignment guides
              </label>
            </div>
            <label className="studio-field">
              <span>Zoom</span>
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
              Fit page
            </button>
            <p className="muted sm">
              {ctrl.doc.nodes.length} shapes · {ctrl.doc.edges.length} connections
            </p>
          </section>
          <section className="studio-format-section">
            <h4>Tips</h4>
            <ul className="studio-tips">
              <li>Hover a shape and drag a blue arrow to connect.</li>
              <li>Click an arrow to add a connected copy.</li>
              <li>Drag from a green ✕ for a fixed connection point.</li>
              <li>Double-click empty canvas to pick a shape.</li>
              <li>Right-click for cut / copy / order actions.</li>
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
          aria-label={`Use ${c}`}
        />
      ))}
      {onNone && (
        <button
          key="none"
          type="button"
          className="studio-swatch studio-swatch--none"
          title="None"
          onClick={onNone}
          aria-label="No colour"
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
