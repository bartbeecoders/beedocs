import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import { withApiBase } from '../basePath'
import { useI18n } from '../i18n'
import {
  NOTE_BACKGROUNDS,
  NOTE_HIGHLIGHT_COLORS,
  NOTE_MAX_IMAGE_W,
  NOTE_MIN_TEXT_W,
  NOTE_PAPERS,
  NOTE_PEN_COLORS,
  NOTE_TAGS,
  NOTE_TAG_GLYPH,
  addStroke,
  bringToFront,
  findBlock,
  moveBlock,
  newChecklistBlock,
  newId,
  newImageBlock,
  newTextBlock,
  nextFreeSpot,
  noteExtent,
  parseNote,
  removeBlock,
  removeStroke,
  sendToBack,
  serializeNote,
  strokeAt,
  strokePath,
  updateBlock,
  addBlock,
  type NoteBlock,
  type NoteChecklistBlock,
  type NoteDoc,
  type NoteImageBlock,
  type NoteInkBlock,
  type NoteStroke,
  type NoteTag,
  type NoteTextBlock,
} from './noteModel'
import '../styles/notes.css'

type Tool = 'select' | 'pen' | 'highlighter' | 'eraser'
type PenWidth = 'thin' | 'medium' | 'thick'

const PEN_WIDTH_PX: Record<PenWidth, number> = { thin: 2, medium: 3.5, thick: 6 }
const HIGHLIGHT_WIDTH_PX: Record<PenWidth, number> = { thin: 10, medium: 16, thick: 24 }
const HISTORY_LIMIT = 100
/** Consecutive edits to the same field inside this window collapse into one undo step. */
const COALESCE_MS = 900

type Props = {
  source: string
  onChange?: (next: string) => void
  /** Page embed: bounded height, smaller chrome. */
  compact?: boolean
  readOnly?: boolean
}

type Drag =
  | { kind: 'move'; id: string; startX: number; startY: number; dx: number; dy: number }
  | { kind: 'resize'; id: string; startX: number; startY: number; w0: number; h0: number | null; w: number; h: number | null }

/**
 * OneNote-style free-form editor: absolutely positioned blocks on a page,
 * ink drawn over them. Click empty page to start typing; drag a block by its
 * top bar; pen/highlighter/eraser draw and erase strokes.
 */
export function NoteEditor({ source, onChange, compact = false, readOnly = false }: Props) {
  const { t } = useI18n()
  const editable = !readOnly && Boolean(onChange)
  const doc = useMemo(() => parseNote(source), [source])

  const [tool, setTool] = useState<Tool>('select')
  const [penColor, setPenColor] = useState<string>(NOTE_PEN_COLORS[0])
  const [highlightColor, setHighlightColor] = useState<string>(NOTE_HIGHLIGHT_COLORS[0])
  const [penWidth, setPenWidth] = useState<PenWidth>('medium')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [liveStroke, setLiveStroke] = useState<NoteStroke | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const pageRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inkSession = useRef<string | null>(null)
  const liveStrokeRef = useRef<NoteStroke | null>(null)
  const lastClick = useRef<{ x: number; y: number } | null>(null)

  // Undo history over serialized sources. The parent owns `source`; we only
  // remember what it was before each of our commits.
  const past = useRef<string[]>([])
  const future = useRef<string[]>([])
  const lastCommit = useRef<{ key: string; at: number } | null>(null)
  const sourceRef = useRef(source)
  sourceRef.current = source

  const commit = useCallback(
    (next: NoteDoc, coalesceKey?: string) => {
      if (!editable || !onChange) return
      const serialized = serializeNote(next)
      if (serialized === sourceRef.current) return
      const now = Date.now()
      const same = coalesceKey && lastCommit.current?.key === coalesceKey && now - lastCommit.current.at < COALESCE_MS
      if (!same) {
        past.current.push(sourceRef.current)
        if (past.current.length > HISTORY_LIMIT) past.current.shift()
        future.current = []
      }
      lastCommit.current = coalesceKey ? { key: coalesceKey, at: now } : null
      sourceRef.current = serialized
      onChange(serialized)
    },
    [editable, onChange],
  )

  const undo = useCallback(() => {
    if (!editable || !onChange) return
    const prev = past.current.pop()
    if (prev == null) return
    future.current.push(sourceRef.current)
    lastCommit.current = null
    sourceRef.current = prev
    onChange(prev)
  }, [editable, onChange])

  const redo = useCallback(() => {
    if (!editable || !onChange) return
    const next = future.current.pop()
    if (next == null) return
    past.current.push(sourceRef.current)
    lastCommit.current = null
    sourceRef.current = next
    onChange(next)
  }, [editable, onChange])

  const selected = selectedId ? findBlock(doc, selectedId) : undefined
  useEffect(() => {
    if (selectedId && !findBlock(doc, selectedId)) setSelectedId(null)
    if (editingId && !findBlock(doc, editingId)) setEditingId(null)
  }, [doc, selectedId, editingId])

  // Switching tools ends the current ink session so the next stroke starts a
  // fresh ink block (OneNote keeps each drawing "sitting" together).
  useEffect(() => {
    inkSession.current = null
    if (tool !== 'select') {
      setEditingId(null)
      setSelectedId(null)
    }
  }, [tool])

  const pagePoint = (e: { clientX: number; clientY: number }) => {
    const rect = pageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // ---- empty-page click → new text block (the OneNote gesture) ----
  const onPagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (tool !== 'select') return
    if (e.button !== 0) return
    const p = pagePoint(e)
    lastClick.current = p
    if (!editable) {
      setSelectedId(null)
      return
    }
    // Cancel the default focus change: the new block's textarea takes focus in
    // an effect, and the page's mousedown would otherwise blur it right away.
    e.preventDefault()
    const block = newTextBlock(p.x - 8, p.y - 8)
    commit(addBlock(doc, block))
    setSelectedId(block.id)
    setEditingId(block.id)
  }

  // ---- block move / resize ----
  const beginMove = (e: ReactPointerEvent<Element>, id: string) => {
    if (!editable || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedId(id)
    setEditingId(null)
    setDrag({ kind: 'move', id, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 })
  }

  const beginResize = (e: ReactPointerEvent<Element>, b: NoteBlock) => {
    if (!editable || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedId(b.id)
    setDrag({ kind: 'resize', id: b.id, startX: e.clientX, startY: e.clientY, w0: b.w, h0: b.h, w: b.w, h: b.h })
  }

  const onDragMove = (e: ReactPointerEvent<Element>) => {
    if (!drag) return
    if (drag.kind === 'move') {
      setDrag({ ...drag, dx: e.clientX - drag.startX, dy: e.clientY - drag.startY })
    } else {
      const b = findBlock(doc, drag.id)
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      const w = Math.max(b?.kind === 'image' ? 40 : NOTE_MIN_TEXT_W, drag.w0 + dx)
      let h: number | null = drag.h0
      if (b?.kind === 'image' && drag.h0 != null) {
        // Corner handle keeps the picture's aspect ratio.
        h = Math.max(24, Math.round((drag.h0 * w) / drag.w0))
      } else if (drag.h0 != null) {
        h = Math.max(24, drag.h0 + dy)
      }
      setDrag({ ...drag, w, h })
    }
  }

  const endDrag = () => {
    if (!drag) return
    if (drag.kind === 'move') {
      if (drag.dx !== 0 || drag.dy !== 0) commit(moveBlock(doc, drag.id, drag.dx, drag.dy))
    } else {
      const b = findBlock(doc, drag.id)
      if (b) commit(updateBlock(doc, drag.id, { w: drag.w, h: b.kind === 'image' ? (drag.h ?? b.h) : b.h }))
    }
    setDrag(null)
  }

  // ---- ink ----
  const currentStrokeStyle = () =>
    tool === 'highlighter'
      ? { color: highlightColor, width: HIGHLIGHT_WIDTH_PX[penWidth], opacity: 0.4 }
      : { color: penColor, width: PEN_WIDTH_PX[penWidth], opacity: 1 }

  const eraseAt = (x: number, y: number) => {
    const hit = strokeAt(doc, x, y, 6)
    if (hit) commit(removeStroke(doc, hit.inkId, hit.strokeId))
  }

  const onDrawPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = pagePoint(e)
    if (tool === 'eraser') {
      eraseAt(p.x, p.y)
      return
    }
    const style = currentStrokeStyle()
    const stroke: NoteStroke = { id: newId('stk'), ...style, points: [p.x, p.y] }
    liveStrokeRef.current = stroke
    setLiveStroke(stroke)
  }

  const onDrawPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) return
    const p = pagePoint(e)
    if (tool === 'eraser') {
      if (e.buttons & 1) eraseAt(p.x, p.y)
      return
    }
    const s = liveStrokeRef.current
    if (!s) return
    const n = s.points.length
    const lx = s.points[n - 2]!
    const ly = s.points[n - 1]!
    if (Math.hypot(p.x - lx, p.y - ly) < 1.5) return
    const next = { ...s, points: [...s.points, p.x, p.y] }
    liveStrokeRef.current = next
    setLiveStroke(next)
  }

  const onDrawPointerUp = () => {
    const s = liveStrokeRef.current
    liveStrokeRef.current = null
    setLiveStroke(null)
    if (!s || tool === 'eraser') return
    const { doc: next, inkId } = addStroke(doc, inkSession.current, s)
    inkSession.current = inkId
    commit(next)
  }

  // ---- inserting blocks from the toolbar / clipboard / drop ----
  const insertAt = (): { x: number; y: number } => {
    if (lastClick.current) return { x: lastClick.current.x, y: lastClick.current.y }
    return nextFreeSpot(doc)
  }

  const addText = () => {
    const p = insertAt()
    const block = newTextBlock(p.x, p.y)
    commit(addBlock(doc, block))
    setSelectedId(block.id)
    setEditingId(block.id)
  }

  const addChecklist = () => {
    const p = insertAt()
    const block = newChecklistBlock(p.x, p.y)
    commit(addBlock(doc, block))
    setSelectedId(block.id)
  }

  const addImageFile = async (file: File, at?: { x: number; y: number }) => {
    if (!editable) return
    setUploadError(null)
    setUploading(true)
    try {
      const up = await api.uploadFile(file)
      const size = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 200 })
        img.onerror = () => resolve({ w: 320, h: 200 })
        img.src = withApiBase(up.url)
      })
      const w = Math.min(NOTE_MAX_IMAGE_W, size.w)
      const h = Math.max(24, Math.round((size.h * w) / size.w))
      const p = at ?? insertAt()
      const block = newImageBlock(p.x, p.y, up.url, file.name.replace(/\.[^.]+$/, ''), w, h)
      commit(addBlock(doc, block))
      setSelectedId(block.id)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!editable || editingId) return
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    void addImageFile(file)
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!editable) return
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    e.stopPropagation()
    void addImageFile(file, pagePoint(e))
  }

  // ---- keyboard ----
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editable) return
    const tag = (e.target as HTMLElement | null)?.tagName
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    if ((e.ctrlKey || e.metaKey) && !inField && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && !inField && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (e.key === 'Escape') {
      if (editingId) setEditingId(null)
      else if (tool !== 'select') setTool('select')
      else setSelectedId(null)
      return
    }
    if (!inField && (e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault()
      commit(removeBlock(doc, selectedId))
      setSelectedId(null)
    }
  }

  const extent = noteExtent(doc)
  const drawing = editable && tool !== 'select'
  const liveStyle = currentStrokeStyle()

  return (
    <div
      className={`note${compact ? ' is-compact' : ''}${editable ? '' : ' is-readonly'}${drawing ? ` is-drawing tool-${tool}` : ''}`}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    >
      {editable && (
        <div className="note-toolbar">
          <div className="note-tool-group" role="group">
            <ToolButton active={tool === 'select'} label={t('notes.tool.select')} title={t('notes.tool.selectTitle')} onClick={() => setTool('select')} glyph="⌖" />
            <ToolButton active={tool === 'pen'} label={t('notes.tool.pen')} title={t('notes.tool.pen')} onClick={() => setTool('pen')} glyph="✎" />
            <ToolButton active={tool === 'highlighter'} label={t('notes.tool.highlighter')} title={t('notes.tool.highlighter')} onClick={() => setTool('highlighter')} glyph="▮" />
            <ToolButton active={tool === 'eraser'} label={t('notes.tool.eraser')} title={t('notes.tool.eraserTitle')} onClick={() => setTool('eraser')} glyph="⌫" />
          </div>
          {(tool === 'pen' || tool === 'highlighter') && (
            <div className="note-tool-group note-pen-options">
              <span className="note-tool-label">{t('notes.penColor')}</span>
              {(tool === 'pen' ? NOTE_PEN_COLORS : NOTE_HIGHLIGHT_COLORS).map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`note-swatch${(tool === 'pen' ? penColor : highlightColor) === c ? ' is-active' : ''}`}
                  style={{ background: c }}
                  aria-label={c}
                  onClick={() => (tool === 'pen' ? setPenColor(c) : setHighlightColor(c))}
                />
              ))}
              <select
                className="note-select"
                value={penWidth}
                aria-label={t('notes.penWidth')}
                onChange={(e) => setPenWidth(e.target.value as PenWidth)}
              >
                <option value="thin">{t('notes.width.thin')}</option>
                <option value="medium">{t('notes.width.medium')}</option>
                <option value="thick">{t('notes.width.thick')}</option>
              </select>
            </div>
          )}
          <div className="note-tool-group">
            <button type="button" className="btn sm" onClick={addText}>
              {t('notes.addText')}
            </button>
            <button type="button" className="btn sm" onClick={addChecklist}>
              {t('notes.addChecklist')}
            </button>
            <button type="button" className="btn sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading ? t('notes.uploading') : t('notes.addImage')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void addImageFile(f)
              }}
            />
          </div>
          <div className="note-tool-group">
            <select
              className="note-select"
              value={doc.background}
              aria-label={t('notes.background')}
              title={t('notes.background')}
              onChange={(e) => commit({ ...doc, background: e.target.value as NoteDoc['background'] })}
            >
              {NOTE_BACKGROUNDS.map((bg) => (
                <option key={bg} value={bg}>
                  {t(`notes.bg.${bg}`)}
                </option>
              ))}
            </select>
            <select
              className="note-select"
              value={doc.paper}
              aria-label={t('notes.paper')}
              title={t('notes.paper')}
              onChange={(e) => commit({ ...doc, paper: e.target.value as NoteDoc['paper'] })}
            >
              {NOTE_PAPERS.map((p) => (
                <option key={p} value={p}>
                  {t(`notes.paper.${p}`)}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <div className="note-tool-group note-selection-options">
              {selected.kind === 'text' && (
                <select
                  className="note-select"
                  value={selected.tag ?? ''}
                  aria-label={t('notes.tag')}
                  title={t('notes.tag')}
                  onChange={(e) =>
                    commit(updateBlock<NoteTextBlock>(doc, selected.id, { tag: (e.target.value || null) as NoteTag | null }))
                  }
                >
                  <option value="">{t('notes.tag.none')}</option>
                  {NOTE_TAGS.map((tag) => (
                    <option key={tag} value={tag}>
                      {NOTE_TAG_GLYPH[tag]} {t(`notes.tag.${tag}`)}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="btn sm ghost" title={t('notes.bringFront')} onClick={() => commit(bringToFront(doc, selected.id))}>
                ▲
              </button>
              <button type="button" className="btn sm ghost" title={t('notes.sendBack')} onClick={() => commit(sendToBack(doc, selected.id))}>
                ▼
              </button>
              <button
                type="button"
                className="btn sm ghost danger"
                title={t('notes.deleteBlock')}
                onClick={() => {
                  commit(removeBlock(doc, selected.id))
                  setSelectedId(null)
                }}
              >
                ✕
              </button>
            </div>
          )}
          <span className="note-toolbar-spacer" />
          <div className="note-tool-group">
            <button type="button" className="btn sm ghost" title={t('notes.undo')} onClick={undo}>
              ↶
            </button>
            <button type="button" className="btn sm ghost" title={t('notes.redo')} onClick={redo}>
              ↷
            </button>
          </div>
        </div>
      )}
      {uploadError && <div className="banner error compact">{t('notes.uploadFailed', { error: uploadError })}</div>}
      <div className="note-scroll" ref={scrollRef} onDragOver={(e) => editable && e.preventDefault()} onDrop={onDrop}>
        <div
          ref={pageRef}
          className="note-page"
          data-bg={doc.background}
          data-paper={doc.paper}
          style={{ width: extent.width, height: extent.height }}
          onPointerDown={onPagePointerDown}
        >
          {doc.blocks.length === 0 && editable && <div className="note-hint muted">{t('notes.emptyHint')}</div>}
          {doc.blocks.map((b) =>
            b.kind === 'ink' ? null : (
              <BlockShell
                key={b.id}
                block={b}
                editable={editable}
                selected={selectedId === b.id}
                drag={drag?.id === b.id ? drag : null}
                onSelect={() => {
                  if (tool !== 'select') return
                  setSelectedId(b.id)
                }}
                onBeginMove={(e) => beginMove(e, b.id)}
                onBeginResize={(e) => beginResize(e, b)}
                onDragMove={onDragMove}
                onDragEnd={endDrag}
              >
                {b.kind === 'text' ? (
                  <TextBlockBody
                    block={b}
                    editable={editable}
                    editing={editingId === b.id}
                    onEdit={() => {
                      if (!editable || tool !== 'select') return
                      setSelectedId(b.id)
                      setEditingId(b.id)
                    }}
                    onChange={(text) => commit(updateBlock<NoteTextBlock>(doc, b.id, { text }), `text:${b.id}`)}
                    onBlur={(text) => {
                      setEditingId((cur) => (cur === b.id ? null : cur))
                      if (!text.trim()) commit(removeBlock(doc, b.id))
                    }}
                  />
                ) : b.kind === 'checklist' ? (
                  <ChecklistBody
                    block={b}
                    editable={editable}
                    onChange={(next, key) => commit(updateBlock<NoteChecklistBlock>(doc, b.id, next), key)}
                    onFocusBlock={() => setSelectedId(b.id)}
                  />
                ) : (
                  <ImageBody block={b} />
                )}
              </BlockShell>
            ),
          )}
          <svg className="note-ink-layer" width={extent.width} height={extent.height} aria-hidden="true">
            {doc.blocks.map((b) =>
              b.kind === 'ink' ? (
                <InkGroup
                  key={b.id}
                  block={b}
                  selected={selectedId === b.id}
                  editable={editable && tool === 'select'}
                  offset={drag?.kind === 'move' && drag.id === b.id ? { dx: drag.dx, dy: drag.dy } : null}
                  onBeginMove={(e) => beginMove(e, b.id)}
                  onDragMove={onDragMove}
                  onDragEnd={endDrag}
                />
              ) : null,
            )}
            {liveStroke && (
              <path
                d={strokePath(liveStroke)}
                fill="none"
                stroke={liveStyle.color}
                strokeWidth={liveStyle.width}
                strokeOpacity={liveStyle.opacity}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
          {drawing && (
            <div
              className="note-draw-layer"
              onPointerDown={onDrawPointerDown}
              onPointerMove={onDrawPointerMove}
              onPointerUp={onDrawPointerUp}
              onPointerCancel={onDrawPointerUp}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ToolButton({
  active,
  label,
  title,
  glyph,
  onClick,
}: {
  active: boolean
  label: string
  title: string
  glyph: string
  onClick: () => void
}) {
  return (
    <button type="button" className={`btn sm${active ? ' primary' : ' ghost'}`} title={title} aria-pressed={active} onClick={onClick}>
      <span className="note-tool-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="note-tool-text">{label}</span>
    </button>
  )
}

function BlockShell({
  block,
  editable,
  selected,
  drag,
  onSelect,
  onBeginMove,
  onBeginResize,
  onDragMove,
  onDragEnd,
  children,
}: {
  block: Exclude<NoteBlock, NoteInkBlock>
  editable: boolean
  selected: boolean
  drag: Drag | null
  onSelect: () => void
  onBeginMove: (e: ReactPointerEvent<Element>) => void
  onBeginResize: (e: ReactPointerEvent<Element>) => void
  onDragMove: (e: ReactPointerEvent<Element>) => void
  onDragEnd: () => void
  children: React.ReactNode
}) {
  const { t } = useI18n()
  const w = drag?.kind === 'resize' ? drag.w : block.w
  const h = drag?.kind === 'resize' ? drag.h : block.h
  const transform = drag?.kind === 'move' ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined
  return (
    <div
      className={`note-block kind-${block.kind}${selected ? ' is-selected' : ''}${drag ? ' is-dragging' : ''}`}
      style={{ left: block.x, top: block.y, width: w, height: h ?? undefined, transform }}
      tabIndex={editable ? 0 : undefined}
      onPointerDown={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      {block.kind === 'text' && block.tag && (
        <span className="note-block-tag" title={t(`notes.tag.${block.tag}`)}>
          {NOTE_TAG_GLYPH[block.tag]}
        </span>
      )}
      {editable && (
        <div
          className="note-block-grip"
          onPointerDown={onBeginMove}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        />
      )}
      <div className="note-block-body">{children}</div>
      {editable && (
        <div
          className={`note-block-resize${block.kind === 'image' ? ' is-corner' : ''}`}
          onPointerDown={onBeginResize}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        />
      )}
    </div>
  )
}

function TextBlockBody({
  block,
  editable,
  editing,
  onEdit,
  onChange,
  onBlur,
}: {
  block: NoteTextBlock
  editable: boolean
  editing: boolean
  onEdit: () => void
  onChange: (text: string) => void
  onBlur: (text: string) => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [block.text, editing])

  useEffect(() => {
    if (editing) {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [editing])

  if (editing) {
    return (
      <textarea
        ref={ref}
        className="note-text-input"
        value={block.text}
        placeholder={t('notes.textPlaceholder')}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlur(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
    )
  }

  return (
    <div
      className={`note-text-view markdown-body${block.text.trim() ? '' : ' is-empty'}`}
      onClick={editable ? onEdit : undefined}
      role={editable ? 'button' : undefined}
    >
      {block.text.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
      ) : (
        <span className="muted">{t('notes.textPlaceholder')}</span>
      )}
    </div>
  )
}

function ChecklistBody({
  block,
  editable,
  onChange,
  onFocusBlock,
}: {
  block: NoteChecklistBlock
  editable: boolean
  onChange: (patch: Partial<NoteChecklistBlock>, coalesceKey?: string) => void
  onFocusBlock: () => void
}) {
  const { t } = useI18n()
  const [focusItem, setFocusItem] = useState<string | null>(null)
  const itemRefs = useRef(new Map<string, HTMLInputElement>())

  useEffect(() => {
    if (!focusItem) return
    itemRefs.current.get(focusItem)?.focus()
    setFocusItem(null)
  }, [focusItem, block.items])

  const setItems = (items: NoteChecklistBlock['items'], key?: string) => onChange({ items }, key)

  const addAfter = (index: number) => {
    const item = { id: newId('chk'), text: '', done: false }
    const items = [...block.items]
    items.splice(index + 1, 0, item)
    setItems(items)
    setFocusItem(item.id)
  }

  return (
    <div className="note-checklist" onPointerDown={editable ? (e) => e.stopPropagation() : undefined}>
      {editable ? (
        <input
          className="note-checklist-title"
          value={block.title}
          placeholder={t('notes.checklistTitlePlaceholder')}
          onFocus={onFocusBlock}
          onChange={(e) => onChange({ title: e.target.value }, `title:${block.id}`)}
        />
      ) : (
        block.title.trim() && <div className="note-checklist-title">{block.title}</div>
      )}
      <ul>
        {block.items.map((it, i) => (
          <li key={it.id} className={it.done ? 'is-done' : ''}>
            <input
              type="checkbox"
              checked={it.done}
              disabled={!editable}
              aria-label={it.text || t('notes.itemPlaceholder')}
              onChange={(e) => setItems(block.items.map((x) => (x.id === it.id ? { ...x, done: e.target.checked } : x)))}
            />
            {editable ? (
              <input
                ref={(el) => {
                  if (el) itemRefs.current.set(it.id, el)
                  else itemRefs.current.delete(it.id)
                }}
                className="note-checklist-item"
                value={it.text}
                placeholder={t('notes.itemPlaceholder')}
                onFocus={onFocusBlock}
                onChange={(e) =>
                  setItems(
                    block.items.map((x) => (x.id === it.id ? { ...x, text: e.target.value } : x)),
                    `item:${it.id}`,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addAfter(i)
                  } else if (e.key === 'Backspace' && !it.text && block.items.length > 1) {
                    e.preventDefault()
                    const prev = block.items[i - 1] ?? block.items[i + 1]
                    setItems(block.items.filter((x) => x.id !== it.id))
                    if (prev) setFocusItem(prev.id)
                  }
                }}
              />
            ) : (
              <span className="note-checklist-item">{it.text}</span>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <button type="button" className="btn ghost sm note-checklist-add" onClick={() => addAfter(block.items.length - 1)}>
          + {t('notes.addItem')}
        </button>
      )}
    </div>
  )
}

function ImageBody({ block }: { block: NoteImageBlock }) {
  return <img className="note-image" src={withApiBase(block.src)} alt={block.alt} draggable={false} />
}

function InkGroup({
  block,
  selected,
  editable,
  offset,
  onBeginMove,
  onDragMove,
  onDragEnd,
}: {
  block: NoteInkBlock
  selected: boolean
  editable: boolean
  offset: { dx: number; dy: number } | null
  onBeginMove: (e: ReactPointerEvent<Element>) => void
  onDragMove: (e: ReactPointerEvent<Element>) => void
  onDragEnd: () => void
}) {
  return (
    <g
      className={`note-ink${selected ? ' is-selected' : ''}`}
      transform={offset ? `translate(${offset.dx} ${offset.dy})` : undefined}
      onPointerDown={editable ? onBeginMove : undefined}
      onPointerMove={editable ? onDragMove : undefined}
      onPointerUp={editable ? onDragEnd : undefined}
      onPointerCancel={editable ? onDragEnd : undefined}
    >
      {selected && (
        <rect className="note-ink-bounds" x={block.x} y={block.y} width={block.w} height={block.h ?? 0} />
      )}
      {block.strokes.map((s) => (
        <g key={s.id}>
          {editable && (
            <path className="note-ink-hit" d={strokePath(s)} fill="none" stroke="transparent" strokeWidth={Math.max(12, s.width + 8)} strokeLinecap="round" strokeLinejoin="round" />
          )}
          <path
            d={strokePath(s)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width}
            strokeOpacity={s.opacity}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ))}
    </g>
  )
}
