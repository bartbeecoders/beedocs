import { useEffect, useRef, useState } from 'react'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import {
  isTreeDrag,
  markdownLinkForTreePayload,
  parseTreeDrag,
} from '../markdownLinks'
import {
  cellStyleClass,
  CELL_STYLES,
  parseMarkdownTable,
  serializeMarkdownTable,
  tableThemeClass,
  TABLE_THEMES,
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

/** The cell a library-tree drag is hovering: 'h' = the header row. */
type LinkCell = { r: number | 'h'; c: number } | null

/** The open cell-style popover: which cell, and where (px, relative to the root). */
type StylePopover = { r: number | 'h'; c: number; left: number; top: number } | null

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
  const { t } = useI18n()
  const [model, setModel] = useState<MarkdownTable | null>(() => parseMarkdownTable(raw))
  const [showSource, setShowSource] = useState(false)
  const [draft, setDraft] = useState(raw)
  const [drag, setDrag] = useState<DragState>(null)
  const [overGap, setOverGap] = useState<number | null>(null)
  const [linkCell, setLinkCell] = useState<LinkCell>(null)
  const [stylePopover, setStylePopover] = useState<StylePopover>(null)
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

  // Dismiss the cell-style popover on any press outside it (its own swatches
  // close it themselves) or on Escape.
  useEffect(() => {
    if (!stylePopover) return
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.md-table-stylepop, .md-table-stylebtn')) return
      setStylePopover(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStylePopover(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [stylePopover])

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

  // The native listeners below outlive any single render; this ref always holds
  // the closure over the current model.
  const dropLinkRef = useRef<(r: number | 'h', c: number, snippet: string) => void>(() => {})
  dropLinkRef.current = (r, c, snippet) => {
    if (!model) return
    // A raw pipe would split the cell into two.
    const safe = snippet.replace(/\|/g, '\\|')
    const join = (cur: string) => (cur.trim() ? `${cur.replace(/\s+$/, '')} ${safe}` : safe)
    if (r === 'h') {
      commit({ ...model, header: model.header.map((h, i) => (i === c ? join(h) : h)) })
    } else {
      commit({
        ...model,
        rows: model.rows.map((row, ri) =>
          ri === r ? row.map((cell, ci) => (ci === c ? join(cell) : cell)) : row,
        ),
      })
    }
  }

  /**
   * Accept a page/book dragged from the library tree directly onto a cell —
   * the link lands in that cell instead of at the end of the surrounding text
   * block. Native listeners, not React handlers: HybridPageEditor's own
   * tree-drop listener sits on an ancestor DOM node, so bubbling reaches it
   * before React's delegated handlers would ever run — the cell has to claim
   * the event natively to win. A drag that is not over a cell (chrome, grips,
   * footer) is left alone and falls through to the page editor's usual
   * "insert as a paragraph" behaviour.
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const cellAt = (target: EventTarget | null): { r: number | 'h'; c: number } | null => {
      const cell = target instanceof Element ? target.closest<HTMLElement>('[data-link-cell]') : null
      if (!cell || !el.contains(cell)) return null
      const r = cell.dataset.linkRow === 'h' ? ('h' as const) : Number(cell.dataset.linkRow)
      const c = Number(cell.dataset.linkCol)
      return (r === 'h' || Number.isFinite(r)) && Number.isFinite(c) ? { r, c } : null
    }

    const onDragOver = (e: DragEvent) => {
      if (!isTreeDrag(e.dataTransfer)) return
      const cell = cellAt(e.target)
      // dragover fires continuously — only re-render when the cell changes.
      setLinkCell((prev) =>
        prev === cell || (prev && cell && prev.r === cell.r && prev.c === cell.c) ? prev : cell,
      )
      if (!cell) return
      e.preventDefault()
      e.stopPropagation()
      // Must stay within the tree drag's effectAllowed ('move') or the drop is cancelled.
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    }

    const onDrop = (e: DragEvent) => {
      if (!isTreeDrag(e.dataTransfer)) return
      const cell = cellAt(e.target)
      setLinkCell(null)
      if (!cell) return
      e.preventDefault()
      e.stopPropagation()
      const payload = parseTreeDrag(e.dataTransfer)
      const snippet = payload ? markdownLinkForTreePayload(payload) : null
      if (!snippet) return // e.g. a folder — nothing to link to
      dropLinkRef.current(cell.r, cell.c, snippet)
    }

    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
      setLinkCell(null)
    }

    // A cancelled drag never fires drop or dragleave here.
    const onDragEnd = () => setLinkCell(null)

    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    el.addEventListener('dragleave', onDragLeave)
    document.addEventListener('dragend', onDragEnd, true)
    return () => {
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('dragend', onDragEnd, true)
    }
  }, [])

  if (!model || showSource) {
    return (
      <div className="md-table-editor" ref={rootRef}>
        <Chrome
          summary={model ? summarize(model, t) : t('editor.fence.source')}
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
          aria-label={t('editor.table.sourceAria')}
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

  const addRow = () =>
    commit({
      ...model,
      rows: [...model.rows, Array<string>(cols).fill('')],
      cellStyles: [...model.cellStyles, Array<string | null>(cols).fill(null)],
    })

  const removeRow = (r: number) =>
    commit({
      ...model,
      rows: model.rows.filter((_, i) => i !== r),
      cellStyles: model.cellStyles.filter((_, i) => i !== r),
    })

  const addColumn = () =>
    commit({
      ...model,
      header: [...model.header, t('editor.table.column', { n: cols + 1 })],
      align: [...model.align, null],
      rows: model.rows.map((row) => [...row, '']),
      headerStyles: [...model.headerStyles, null],
      cellStyles: model.cellStyles.map((row) => [...row, null]),
    })

  const removeColumn = (c: number) => {
    if (cols <= 1) return
    commit({
      ...model,
      header: model.header.filter((_, i) => i !== c),
      align: model.align.filter((_, i) => i !== c),
      rows: model.rows.map((row) => row.filter((_, i) => i !== c)),
      headerStyles: model.headerStyles.filter((_, i) => i !== c),
      cellStyles: model.cellStyles.map((row) => row.filter((_, i) => i !== c)),
    })
  }

  /** Move a row to sit before gap `to` (0 = above the first row). */
  const moveRow = (from: number, to: number) => {
    if (to < 0 || to > model.rows.length) return
    if (to === from || to === from + 1) return
    const reorder = <T,>(arr: T[]): T[] => {
      const a = [...arr]
      const [moved] = a.splice(from, 1)
      a.splice(to > from ? to - 1 : to, 0, moved)
      return a
    }
    if (!model.rows[from]) return
    commit({ ...model, rows: reorder(model.rows), cellStyles: reorder(model.cellStyles) })
  }

  /** Move a column (header, alignment, styles and every row's cell) to sit before gap `to`. */
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
      ...model,
      header: reorder(model.header),
      align: reorder(model.align),
      rows: model.rows.map(reorder),
      headerStyles: reorder(model.headerStyles),
      cellStyles: model.cellStyles.map(reorder),
    })
  }

  const applyCellStyle = (cell: { r: number | 'h'; c: number }, style: string) => {
    if (cell.c >= cols) return
    const v = style || null
    if (cell.r === 'h') {
      commit({
        ...model,
        headerStyles: model.headerStyles.map((s, i) => (i === cell.c ? v : s)),
      })
    } else if (cell.r < model.rows.length) {
      commit({
        ...model,
        cellStyles: model.cellStyles.map((row, ri) =>
          ri === cell.r ? row.map((s, ci) => (ci === cell.c ? v : s)) : row,
        ),
      })
    }
  }

  /** Style of the cell the popover is open on (for marking the current swatch). */
  const popoverStyle = stylePopover
    ? (stylePopover.r === 'h'
        ? model.headerStyles[stylePopover.c]
        : model.cellStyles[stylePopover.r]?.[stylePopover.c]) ?? null
    : null

  /**
   * Anchored to the editor root rather than the cell: the grid sits in a
   * horizontal scroller, and a positioned child would be clipped by (and
   * stretch) that scroll area at the table's edges.
   */
  const openStylePopover = (e: React.MouseEvent, r: number | 'h', c: number) => {
    const cell = (e.currentTarget as HTMLElement).closest('th, td')
    const root = rootRef.current
    if (!cell || !root) return
    const cellRect = cell.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    setStylePopover((prev) =>
      prev && prev.r === r && prev.c === c
        ? null
        : {
            r,
            c,
            left: Math.max(4, Math.min(cellRect.left - rootRect.left, rootRect.width - 220)),
            top: cellRect.bottom - rootRect.top + 4,
          },
    )
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

  const linkCellClass = (r: number | 'h', c: number): string =>
    linkCell && linkCell.r === r && linkCell.c === c ? ' is-link-target' : ''

  /** Highlight class of a cell plus, on the popover's cell, a dashed outline. */
  const styledCellClass = (r: number | 'h', c: number): string => {
    const style = r === 'h' ? model.headerStyles[c] : model.cellStyles[r]?.[c]
    const cls = cellStyleClass(style)
    const active =
      stylePopover && stylePopover.r === r && stylePopover.c === c ? ' is-style-target' : ''
    return (cls ? ' ' + cls : '') + active
  }

  const styleButton = (r: number | 'h', c: number) => (
    <button
      type="button"
      className="md-table-stylebtn"
      onClick={(e) => openStylePopover(e, r, c)}
      title={t('editor.table.cellStyle')}
      aria-label={
        r === 'h'
          ? t('editor.table.styleHeaderAria', { n: c + 1 })
          : t('editor.table.styleCellAria', { r: r + 1, c: c + 1 })
      }
      aria-expanded={stylePopover != null && stylePopover.r === r && stylePopover.c === c}
    />
  )

  return (
    <div className="md-table-editor" ref={rootRef}>
      <Chrome
        summary={summarize(model, t)}
        showSource={false}
        canToggle
        theme={model.theme}
        onTheme={(th) => commit({ ...model, theme: th || null })}
        onToggleSource={() => {
          setDraft(serializeMarkdownTable(model))
          setShowSource(true)
        }}
        onRemove={onRemove}
      />
      <div className="md-table-scroll">
        <table className={`md-table ${tableThemeClass(model.theme)}`.trimEnd()}>
          <thead>
            <tr>
              <th className="md-table-rowctl" aria-hidden />
              {model.header.map((h, c) => (
                <th
                  key={`h-${c}`}
                  className={`md-table-col${colCellClass(c)}${linkCellClass('h', c)}${styledCellClass('h', c)}`}
                  data-link-cell="1"
                  data-link-row="h"
                  data-link-col={c}
                  {...cellTargetProps(null, c)}
                >
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
                      aria-label={t('editor.table.moveColAria', { n: c + 1 })}
                      title={t('editor.table.moveColTitle')}
                    >
                      <span aria-hidden="true">⠿</span>
                    </button>
                    <input
                      value={h}
                      placeholder={t('editor.table.column', { n: c + 1 })}
                      onChange={(e) => setHeader(c, e.target.value)}
                      aria-label={t('editor.table.headerAria', { n: c + 1 })}
                    />
                    {styleButton('h', c)}
                    <button
                      type="button"
                      className="md-table-x"
                      disabled={cols <= 1}
                      onClick={() => removeColumn(c)}
                      title={t('editor.table.removeCol')}
                      aria-label={t('editor.table.removeColAria', { n: c + 1 })}
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
                    aria-label={t('editor.table.moveRowAria', { n: r + 1 })}
                    title={t('editor.block.dragTitle')}
                  >
                    <span aria-hidden="true">⠿</span>
                  </button>
                </td>
                {row.map((cell, c) => (
                  <td
                    key={`c-${c}`}
                    className={`md-table-col${colCellClass(c)}${linkCellClass(r, c)}${styledCellClass(r, c)}`}
                    data-link-cell="1"
                    data-link-row={r}
                    data-link-col={c}
                    {...cellTargetProps(r, c)}
                  >
                    <textarea
                      value={cell}
                      rows={Math.max(1, cell.split('\n').length)}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      onKeyDown={(e) => {
                        // Shift+Enter is the line break (stored as <br> in the
                        // Markdown — a pipe-table cell cannot hold a newline).
                        // A textarea would also break on plain Enter, so that
                        // one is swallowed: it is how people leave a cell, and
                        // must not silently reshape it.
                        if (e.key === 'Enter' && !e.shiftKey) e.preventDefault()
                      }}
                      spellCheck={false}
                      aria-label={t('editor.table.cellAria', { r: r + 1, c: c + 1 })}
                      title={t('editor.table.lineBreakTitle')}
                    />
                    {styleButton(r, c)}
                  </td>
                ))}
                <td className="md-table-rowctl" {...cellTargetProps(r, cols)}>
                  <button
                    type="button"
                    className="md-table-x"
                    onClick={() => removeRow(r)}
                    title={t('editor.table.removeRow')}
                    aria-label={t('editor.table.removeRowAria', { n: r + 1 })}
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
            {t('editor.table.addRow')}
          </button>
          <button type="button" className="btn ghost sm" onClick={addColumn}>
            {t('editor.table.addColumn')}
          </button>
        </div>
      </div>
      {stylePopover && (
        <div
          className="md-table-stylepop"
          style={{ left: stylePopover.left, top: stylePopover.top }}
          role="menu"
          aria-label={t('editor.table.cellStyle')}
        >
          {CELL_STYLES.map((s) => {
            const styleLabel = t(`editor.table.cellStyle.${s.id || 'none'}` as MessageKey)
            return (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={popoverStyle === (s.id || null)}
                className={
                  'md-table-swatch' +
                  (s.id ? ' ' + cellStyleClass(s.id) : ' md-table-swatch--none') +
                  (popoverStyle === (s.id || null) ? ' is-current' : '')
                }
                onClick={() => {
                  applyCellStyle(stylePopover, s.id)
                  setStylePopover(null)
                }}
                title={styleLabel}
                aria-label={t('editor.table.cellStyleAria', { style: styleLabel })}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// The count phrasing sidesteps plural forms; the shape is the same in every language.
function summarize(table: MarkdownTable, t: TFunction): string {
  return t('editor.table.summary', { cols: table.header.length, rows: table.rows.length })
}

function Chrome({
  summary,
  showSource,
  canToggle,
  theme,
  onTheme,
  onToggleSource,
  onRemove,
}: {
  summary: string
  showSource: boolean
  /** False while the source is not a parseable table — the grid has nothing to show. */
  canToggle: boolean
  /** Current table theme; the picker only shows when a change handler is wired (grid mode). */
  theme?: string | null
  onTheme?: (theme: string) => void
  onToggleSource: () => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="hybrid-fence-chrome">
      <div className="hybrid-fence-labels">
        <span className="inline-diagram-badge">{t('editor.insert.table')}</span>
        <span className="muted sm">{summary}</span>
      </div>
      <div className="hybrid-fence-actions">
        {onTheme && (
          <select
            className="md-table-theme"
            value={theme ?? ''}
            onChange={(e) => onTheme(e.target.value)}
            title={t('editor.table.themeTitle')}
            aria-label={t('editor.table.themeTitle')}
          >
            {TABLE_THEMES.map((th) => (
              <option key={th.id} value={th.id}>
                {t(`editor.table.theme.${th.id || 'default'}` as MessageKey)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="btn sm"
          disabled={showSource && !canToggle}
          onClick={onToggleSource}
          title={showSource ? t('editor.table.toGridTitle') : t('editor.table.toSourceTitle')}
        >
          {showSource ? t('editor.insert.table') : t('editor.source')}
        </button>
        <button
          type="button"
          className="btn ghost sm danger"
          onClick={onRemove}
          title={t('editor.table.removeTable')}
        >
          {t('common.remove')}
        </button>
      </div>
    </div>
  )
}
