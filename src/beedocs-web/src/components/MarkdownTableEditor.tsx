import { useEffect, useRef, useState } from 'react'
import {
  parseMarkdownTable,
  serializeMarkdownTable,
  type MarkdownTable,
} from '../markdownTable'

type Props = {
  /** The table's raw Markdown (exact slice of the page text). */
  raw: string
  onChange: (nextRaw: string) => void
  onRemove: () => void
}

/** A live drag of one row or one column, by source index. */
type DragState = { kind: 'row' | 'col'; from: number } | null

/**
 * Grid designer over a Markdown pipe table: edit cells in place, add, remove
 * and drag-reorder rows and columns. Cell edits live in a local model so typed
 * spaces are not trimmed out from under the cursor by a serialize/parse round
 * trip; the model re-syncs only when the incoming raw is not our own last
 * emission.
 *
 * Reordering follows the page's block-reorder conventions: drags start on a
 * grip (so dragging in a cell input still selects text), drops target the gap
 * between items — dropping beside the dragged item is a no-op, not an
 * off-by-one shuffle — and the grips accept arrow keys as the pointer-free
 * equivalent.
 */
export function MarkdownTableEditor({ raw, onChange, onRemove }: Props) {
  const [model, setModel] = useState<MarkdownTable | null>(() => parseMarkdownTable(raw))
  const [showSource, setShowSource] = useState(false)
  const [draft, setDraft] = useState(raw)
  const [drag, setDrag] = useState<DragState>(null)
  const [overGap, setOverGap] = useState<number | null>(null)
  const lastEmitted = useRef(raw)
  const rootRef = useRef<HTMLDivElement>(null)
  // Selector of the grip to focus after a keyboard move: grips are keyed by
  // position, so without this the focus would stay behind on the old index.
  const pendingFocus = useRef<string | null>(null)

  useEffect(() => {
    if (raw === lastEmitted.current) return
    setModel(parseMarkdownTable(raw))
    setDraft(raw)
    lastEmitted.current = raw
  }, [raw])

  useEffect(() => {
    if (!pendingFocus.current) return
    const el = rootRef.current?.querySelector<HTMLElement>(pendingFocus.current)
    pendingFocus.current = null
    el?.focus()
  })

  const commit = (next: MarkdownTable) => {
    setModel(next)
    const md = serializeMarkdownTable(next)
    setDraft(md)
    lastEmitted.current = md
    onChange(md)
  }

  // Source edits commit on blur, not per keystroke: a half-typed separator line
  // is no longer a table, and emitting it would unmount this block mid-edit.
  const commitSource = () => {
    if (draft === lastEmitted.current) return
    lastEmitted.current = draft
    onChange(draft)
    const parsed = parseMarkdownTable(draft)
    if (parsed) setModel(parsed)
  }

  if (!model || showSource) {
    return (
      <div className="md-table-editor" ref={rootRef}>
        <Chrome
          summary={model ? summarize(model) : 'source'}
          showSource
          canToggle={model != null}
          onToggleSource={() => setShowSource(false)}
          onRemove={onRemove}
        />
        <textarea
          className="hybrid-text-block hybrid-fence-body"
          value={draft}
          rows={Math.min(20, Math.max(4, draft.split('\n').length + 1))}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitSource}
          aria-label="Markdown table source"
        />
      </div>
    )
  }

  const cols = model.header.length

  const setHeader = (c: number, v: string) =>
    commit({ ...model, header: model.header.map((h, i) => (i === c ? v : h)) })

  const setCell = (r: number, c: number, v: string) =>
    commit({
      ...model,
      rows: model.rows.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? v : cell)) : row)),
    })

  const addRow = () => commit({ ...model, rows: [...model.rows, Array<string>(cols).fill('')] })

  const removeRow = (r: number) => commit({ ...model, rows: model.rows.filter((_, i) => i !== r) })

  const addColumn = () =>
    commit({
      header: [...model.header, `Column ${cols + 1}`],
      align: [...model.align, null],
      rows: model.rows.map((row) => [...row, '']),
    })

  const removeColumn = (c: number) => {
    if (cols <= 1) return
    commit({
      header: model.header.filter((_, i) => i !== c),
      align: model.align.filter((_, i) => i !== c),
      rows: model.rows.map((row) => row.filter((_, i) => i !== c)),
    })
  }

  /** Move a row to sit before gap `to` (0 = above the first row). */
  const moveRow = (from: number, to: number) => {
    if (to < 0 || to > model.rows.length) return
    if (to === from || to === from + 1) return
    const rows = [...model.rows]
    const [moved] = rows.splice(from, 1)
    if (!moved) return
    rows.splice(to > from ? to - 1 : to, 0, moved)
    commit({ ...model, rows })
  }

  /** Move a column (header, alignment and every row's cell) to sit before gap `to`. */
  const moveColumn = (from: number, to: number) => {
    if (to < 0 || to > cols) return
    if (to === from || to === from + 1) return
    const reorder = <T,>(arr: T[]): T[] => {
      const a = [...arr]
      const [moved] = a.splice(from, 1)
      a.splice(to > from ? to - 1 : to, 0, moved)
      return a
    }
    commit({
      header: reorder(model.header),
      align: reorder(model.align),
      rows: model.rows.map(reorder),
    })
  }

  const endDrag = () => {
    setDrag(null)
    setOverGap(null)
  }

  const startDrag = (e: React.DragEvent, kind: 'row' | 'col', from: number) => {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData('text/plain', kind)
    setDrag({ kind, from })
  }

  /**
   * Drop-target handlers for one cell. Row drags resolve the gap from the
   * pointer's vertical half of the cell, column drags from the horizontal half;
   * `row` is null for header cells, where a row drop means "above the first row".
   */
  const cellTargetProps = (row: number | null, c: number) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      if (drag.kind === 'col') {
        // The trailing control cell sits past the last column: clamp to the last gap.
        setOverGap(Math.min(e.clientX < rect.left + rect.width / 2 ? c : c + 1, cols))
      } else if (row != null) {
        setOverGap(e.clientY < rect.top + rect.height / 2 ? row : row + 1)
      } else {
        setOverGap(0)
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!drag || overGap == null) return
      e.preventDefault()
      if (drag.kind === 'col') moveColumn(drag.from, overGap)
      else moveRow(drag.from, overGap)
      endDrag()
    },
  })

  /** Drop-indicator / dim classes for a column's cells while a column drag is live. */
  const colCellClass = (c: number): string => {
    if (drag?.kind !== 'col') return ''
    const parts: string[] = []
    if (drag.from === c) parts.push('is-drag-source')
    if (overGap === c) parts.push('is-col-gap-before')
    if (overGap === cols && c === cols - 1) parts.push('is-col-gap-after')
    return parts.length ? ' ' + parts.join(' ') : ''
  }

  const rowClass = (r: number): string => {
    if (drag?.kind !== 'row') return ''
    const parts: string[] = []
    if (drag.from === r) parts.push('is-drag-source')
    if (overGap === r) parts.push('is-row-gap-before')
    if (overGap === model.rows.length && r === model.rows.length - 1) parts.push('is-row-gap-after')
    return parts.length ? ' ' + parts.join(' ') : ''
  }

  return (
    <div className="md-table-editor" ref={rootRef}>
      <Chrome
        summary={summarize(model)}
        showSource={false}
        canToggle
        onToggleSource={() => {
          setDraft(serializeMarkdownTable(model))
          setShowSource(true)
        }}
        onRemove={onRemove}
      />
      <div className="md-table-scroll">
        <table className="md-table">
          <thead>
            <tr>
              <th className="md-table-rowctl" aria-hidden />
              {model.header.map((h, c) => (
                <th key={`h-${c}`} className={`md-table-col${colCellClass(c)}`} {...cellTargetProps(null, c)}>
                  <div className="md-table-headcell">
                    <button
                      type="button"
                      className="md-table-grip"
                      draggable={cols > 1}
                      data-col-grip={c}
                      onDragStart={(e) => startDrag(e, 'col', c)}
                      onDragEnd={endDrag}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowLeft' && c > 0) {
                          e.preventDefault()
                          pendingFocus.current = `[data-col-grip="${c - 1}"]`
                          moveColumn(c, c - 1)
                        } else if (e.key === 'ArrowRight' && c < cols - 1) {
                          e.preventDefault()
                          pendingFocus.current = `[data-col-grip="${c + 1}"]`
                          moveColumn(c, c + 2)
                        }
                      }}
                      aria-label={`Move column ${c + 1}. Drag, or use arrow left and right.`}
                      title="Drag to reorder · ← / → to move"
                    >
                      <span aria-hidden="true">⠿</span>
                    </button>
                    <input
                      value={h}
                      placeholder={`Column ${c + 1}`}
                      onChange={(e) => setHeader(c, e.target.value)}
                      aria-label={`Header of column ${c + 1}`}
                    />
                    <button
                      type="button"
                      className="md-table-x"
                      disabled={cols <= 1}
                      onClick={() => removeColumn(c)}
                      title="Remove column"
                      aria-label={`Remove column ${c + 1}`}
                    >
                      ×
                    </button>
                  </div>
                </th>
              ))}
              <th className="md-table-rowctl" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row, r) => (
              <tr key={`r-${r}`} className={`md-table-row${rowClass(r)}`}>
                <td className="md-table-rowctl" {...cellTargetProps(r, 0)}>
                  <button
                    type="button"
                    className="md-table-grip"
                    draggable={model.rows.length > 1}
                    data-row-grip={r}
                    onDragStart={(e) => startDrag(e, 'row', r)}
                    onDragEnd={endDrag}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp' && r > 0) {
                        e.preventDefault()
                        pendingFocus.current = `[data-row-grip="${r - 1}"]`
                        moveRow(r, r - 1)
                      } else if (e.key === 'ArrowDown' && r < model.rows.length - 1) {
                        e.preventDefault()
                        pendingFocus.current = `[data-row-grip="${r + 1}"]`
                        moveRow(r, r + 2)
                      }
                    }}
                    aria-label={`Move row ${r + 1}. Drag, or use arrow up and down.`}
                    title="Drag to reorder · ↑ / ↓ to move"
                  >
                    <span aria-hidden="true">⠿</span>
                  </button>
                </td>
                {row.map((cell, c) => (
                  <td key={`c-${c}`} className={`md-table-col${colCellClass(c)}`} {...cellTargetProps(r, c)}>
                    <input
                      value={cell}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      aria-label={`Row ${r + 1}, column ${c + 1}`}
                    />
                  </td>
                ))}
                <td className="md-table-rowctl" {...cellTargetProps(r, cols)}>
                  <button
                    type="button"
                    className="md-table-x"
                    onClick={() => removeRow(r)}
                    title="Remove row"
                    aria-label={`Remove row ${r + 1}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="md-table-footer">
          <button type="button" className="btn ghost sm" onClick={addRow}>
            + Row
          </button>
          <button type="button" className="btn ghost sm" onClick={addColumn}>
            + Column
          </button>
        </div>
      </div>
    </div>
  )
}

function summarize(t: MarkdownTable): string {
  const cols = t.header.length
  const rows = t.rows.length
  return `${cols} column${cols === 1 ? '' : 's'} · ${rows} row${rows === 1 ? '' : 's'}`
}

function Chrome({
  summary,
  showSource,
  canToggle,
  onToggleSource,
  onRemove,
}: {
  summary: string
  showSource: boolean
  /** False while the source is not a parseable table — the grid has nothing to show. */
  canToggle: boolean
  onToggleSource: () => void
  onRemove: () => void
}) {
  return (
    <div className="hybrid-fence-chrome">
      <div className="hybrid-fence-labels">
        <span className="inline-diagram-badge">Table</span>
        <span className="muted sm">{summary}</span>
      </div>
      <div className="hybrid-fence-actions">
        <button
          type="button"
          className="btn sm"
          disabled={showSource && !canToggle}
          onClick={onToggleSource}
          title={showSource ? 'Back to the table designer' : 'Edit the Markdown source'}
        >
          {showSource ? 'Table' : 'Source'}
        </button>
        <button type="button" className="btn ghost sm danger" onClick={onRemove} title="Remove table">
          Remove
        </button>
      </div>
    </div>
  )
}
